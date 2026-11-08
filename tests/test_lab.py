import json
import tempfile
import unittest
import httpx
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pydantic

from backend.app import lab


ARTIFACT = """<!doctype html><html><body>
<header>Fernbloom</header><h1>Water less</h1>
<ul><li>one</li><li>two</li></ul>
<button>Free</button><button>Starter</button><button>Pro</button>
<footer>Fernbloom is a fiction created for a benchmark.</footer>
<script>document.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  const m = document.createElement('p'); m.textContent = 'clicked ' + b.textContent; document.body.append(m);
}))</script>
</body></html>"""


class LabStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_artifact_requests_disable_reasoning_and_read_content(self):
        def respond(request):
            payload = json.loads(request.content)
            self.assertEqual(payload['reasoning_effort'], 'none')
            self.assertEqual(payload['max_tokens'], 512)
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n')
        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch.object(lab.httpx, 'AsyncClient', return_value=client):
            result = await lab.complete_stream('http://ollama/v1', 'qwen3.5:4b', 'Return JSON', 512)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['content'], '{}')


def run_config(depth='Quick'):
    return {'endpoints': [{'name': 'Ollama', 'url': 'http://ollama:11434/v1', 'models': ['gemma3:1b']}],
            'fields': list(lab.FIELDS), 'models': [{'endpoint': 'Ollama', 'model': 'gemma3:1b'}]}


class LabSetupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        patcher = patch.object(lab, 'DB_PATH', Path(self.temporary.name) / 'test.db')
        patcher.start()
        lab.initialize()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.temporary.cleanup)

    async def test_setup_roundtrip(self):
        default = await lab.get_setup()
        self.assertEqual(default, {'models': [], 'fields': list(lab.FIELDS)})
        await lab.put_setup(lab.LabSetup(models=[{'name': 'Hugo', 'url': 'http://ollama:11434/v1', 'models': ['gemma3:1b']}], fields=['ui']))
        stored = await lab.get_setup()
        self.assertEqual(stored['models'][0]['models'], ['gemma3:1b'])
        self.assertEqual(stored['fields'], ['ui'])
        with self.assertRaises(pydantic.ValidationError):
            lab.LabSetup(fields=['nope'])
        with self.assertRaises(pydantic.ValidationError):
            lab.LabSetup(fields=[])
        with self.assertRaises(pydantic.ValidationError):
            lab.LabSetup(models=[{'name': 'x', 'url': 'https://user:pass@example.com/v1', 'models': ['m']}])

    async def test_run_creation_rejects_bad_fields_and_duplicates(self):
        valid = {'name': 'Ollama', 'url': 'http://ollama:11434/v1', 'models': ['m']}
        with self.assertRaises(pydantic.ValidationError):
            lab.LabRunRequest(endpoints=[valid], fields=['nope'])
        with self.assertRaises(pydantic.ValidationError):
            lab.LabRunRequest(endpoints=[], fields=['ui'])
        with self.assertRaises(pydantic.ValidationError):
            lab.LabRunRequest(endpoints=[valid], fields=[])

    async def test_second_active_run_is_rejected(self):
        config = run_config()
        lab.insert_run('one', 'today', config)
        with lab.connect_db() as db:
            db.execute("UPDATE lab_runs SET state='running' WHERE id='one'")
        self.assertEqual(lab.active_run_state(), 'running')


class LabExecutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        patcher = patch.object(lab, 'DB_PATH', Path(self.temporary.name) / 'test.db')
        patcher.start()
        lab.initialize()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.temporary.cleanup)

    async def test_run_executes_every_task_and_stores_artifacts(self):
        config = run_config()
        config['fields'] = ['ui']
        lab.insert_run('run-1', '2026-11-07T00:00:00Z', config)
        with patch.object(lab, 'complete_stream', AsyncMock(return_value={
                'status': 'ok', 'reason': None, 'elapsed': 1.0, 'content': ARTIFACT, 'tokens': 40, 'truncated': False})):
            await lab.execute_lab_run('run-1')
        run = await lab.get_run('run-1')
        self.assertEqual(run['state'], 'completed')
        self.assertEqual(run['total'], 2)
        self.assertEqual([a['task'] for a in run['attempts']], ['landing', 'widget'])
        self.assertIsNone(run['attempts'][0].get('html'))
        artifact = lab.load_artifact('run-1', 1)
        self.assertIn('</body>', artifact)

    async def test_model_returning_nothing_is_marked_error(self):
        config = run_config()
        config['fields'] = ['extras']
        lab.insert_run('run-2', '2026-11-07T00:00:00Z', config)
        with patch.object(lab, 'complete_stream', AsyncMock(return_value={
                'status': 'error', 'reason': 'The model returned no text.', 'elapsed': 1.0, 'content': '', 'tokens': 0, 'truncated': False})):
            await lab.execute_lab_run('run-2')
        run = await lab.get_run('run-2')
        self.assertEqual(run['attempts'][0]['status'], 'error')

    async def test_fenced_and_fragmentary_output_is_normalised(self):
        fenced = f'```html\n{ARTIFACT}\n```'
        artifact, wrapped = lab.strip_doc(fenced)
        self.assertFalse(wrapped)
        self.assertIn('<header>', artifact)
        fragment = '<h1>Only a fragment</h1><p>No document tags here.</p>'
        artifact, wrapped = lab.strip_doc(fragment)
        self.assertTrue(wrapped)
        self.assertTrue(artifact.startswith('<!doctype html>'))

    async def test_truncation_is_recorded(self):
        config = run_config()
        config['fields'] = ['coding']
        lab.insert_run('run-3', '2026-11-07T00:00:00Z', config)
        content = '<html><body>' + 'x' * (lab.ARTIFACT_LIMIT + 1000) + '</body></html>'
        outcome = {'status': 'ok', 'reason': f'Response stopped at the {lab.ARTIFACT_LIMIT // 1024} KB artifact limit.',
                   'elapsed': 1.0, 'content': content[:lab.ARTIFACT_LIMIT + 1], 'tokens': 9999, 'truncated': True}
        with patch.object(lab, 'complete_stream', AsyncMock(return_value=outcome)):
            await lab.execute_lab_run('run-3')
        run = await lab.get_run('run-3')
        self.assertEqual(run['attempts'][0]['truncated'], 1)
        artifact = lab.load_artifact('run-3', 2)
        self.assertLessEqual(len(artifact), lab.ARTIFACT_LIMIT + 100)

    async def test_cancelled_state_stops_the_executor_before_any_attempt(self):
        config = run_config()
        lab.insert_run('cancelled-run', '2026-11-07T00:00:00Z', config)
        with lab.connect_db() as db:
            db.execute("UPDATE lab_runs SET state='cancelled' WHERE id='cancelled-run'")
        complete = AsyncMock(return_value={'status': 'ok', 'reason': None, 'elapsed': 1, 'content': ARTIFACT, 'tokens': 1, 'truncated': False})
        with patch.object(lab, 'complete_stream', complete):
            await lab.execute_lab_run('cancelled-run')
        complete.assert_not_called()
        with lab.connect_db() as db:
            state = db.execute("SELECT state, progress FROM lab_runs WHERE id='cancelled-run'").fetchone()
            self.assertEqual(state['state'], 'cancelled')
            self.assertEqual(state['progress'], 0)

    async def test_restart_marks_running_runs_interrupted(self):
        config = run_config()
        lab.insert_run('interrupt', '2026-11-07T00:00:00Z', config)
        with lab.connect_db() as db:
            db.execute("UPDATE lab_runs SET state='running' WHERE id='interrupt'")
        lab.initialize()
        with lab.connect_db() as db:
            self.assertEqual(db.execute("SELECT state FROM lab_runs WHERE id='interrupt'").fetchone()['state'], 'interrupted')


class ArtifactServingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        patcher = patch.object(lab, 'DB_PATH', Path(self.temporary.name) / 'test.db')
        patcher.start()
        lab.initialize()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.temporary.cleanup)
        lab.insert_run('serve', '2026-11-07T00:00:00Z', run_config())
        with lab.connect_db() as db:
            db.execute("UPDATE lab_runs SET state='completed', progress=1, total=5 WHERE id='serve'")
            db.execute('INSERT INTO lab_results(run_id,attempt,endpoint,model,field,task,prompt,html,status) '
                       "VALUES('serve',1,'Ollama','gemma3:1b','ui','landing','?',?, 'ok')", (ARTIFACT,))

    async def test_preview_injects_harness_and_sets_csp(self):
        response = await lab.artifact_preview('serve', 1)
        body = response.body.decode()
        self.assertEqual(response.media_type, 'text/html')
        self.assertEqual(response.headers.get('content-security-policy'), 'sandbox allow-scripts')
        self.assertIn('lab-harness.js', body)
        self.assertIn('</body></html>', body.replace(' ', ''))

    async def test_raw_serves_untouched_artifact(self):
        response = await lab.artifact_raw('serve', 1)
        body = response.body.decode()
        self.assertEqual(response.headers.get('content-security-policy'), 'sandbox allow-scripts')
        self.assertNotIn('lab-harness.js', body)
        self.assertNotIn('wrapped', body)  # injected text is absent
        self.assertIn('<button>Free</button>', body)

    async def test_missing_attempt_is_404(self):
        import fastapi
        with self.assertRaises(fastapi.HTTPException):
            await lab.artifact_preview('serve', 9)
        with self.assertRaises(fastapi.HTTPException):
            await lab.artifact_preview('nope', 1)


class ReviewAndCheckTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        patcher = patch.object(lab, 'DB_PATH', Path(self.temporary.name) / 'test.db')
        patcher.start()
        lab.initialize()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.temporary.cleanup)
        lab.insert_run('review', '2026-11-07T00:00:00Z', run_config())
        with lab.connect_db() as db:
            db.execute("UPDATE lab_runs SET state='completed', progress=5, total=5 WHERE id='review'")
            for attempt, field, task in ((1, 'ui', 'landing'), (2, 'coding', 'game'), (3, 'extras', 'json')):
                db.execute('INSERT INTO lab_results(run_id,attempt,endpoint,model,field,task,prompt,html,status,auto) '
                           "VALUES('review',?,'Ollama','gemma3:1b',?,?,?,?, 'ok', '{}')",
                           (attempt, field, task, '?', ARTIFACT if field != 'extras' else '{"items":{"apple":{"qty":4,"revenue":5.5},"banana":{"qty":2,"revenue":1.5}},"grand_total":7.0}'))

    async def test_review_merges_and_validates_field(self):
        result = await lab.put_review('review', lab.ReviewRequest(attempt=1, visuals=4, buttons='yes'))
        self.assertEqual(result['review'], {'visuals': 4, 'buttons': 'yes'})
        await lab.put_review('review', lab.ReviewRequest(attempt=1, buttons='no'))
        run = await lab.get_run('review')
        self.assertEqual(run['attempts'][0]['review']['buttons'], 'no')
        with self.assertRaises(pydantic.ValidationError):
            lab.ReviewRequest(attempt=1, visuals=9)
        with self.assertRaises(pydantic.ValidationError):
            lab.ReviewRequest(attempt=1, buttons='maybe')
        import fastapi
        with self.assertRaises(fastapi.HTTPException) as caught:
            await lab.put_review('review', lab.ReviewRequest(attempt=2, buttons='yes'))
        self.assertEqual(caught.exception.status_code, 422)
        with self.assertRaises(fastapi.HTTPException) as caught:
            await lab.put_review('review', lab.ReviewRequest(attempt=1, playable='yes'))
        self.assertEqual(caught.exception.status_code, 422)

    async def test_checks_persist_into_the_auto_column(self):
        payload = lab.CheckRequest(attempt=1, collected=True, errors=0, canvas=False, animation=None,
                                   structure=True, buttonCount=3,
                                   buttons=[{'label': 'Free', 'threwException': False, 'changedDom': True},
                                            {'label': 'x' * 500, 'threwException': True, 'changedDom': False}],
                                   inputFound=True, inputTyped=True)
        await lab.put_checks('review', payload)
        run = await lab.get_run('review')
        auto = run['attempts'][0]['auto']
        self.assertEqual(len(auto['buttons']), 2)
        self.assertEqual(len(auto['buttons'][1]['label']), 80)
        self.assertTrue(auto['inputTyped'])
        self.assertEqual(auto['buttonCount'], 3)

    async def test_rollup_keeps_auto_and_human_columns_separate(self):
        await lab.put_checks('review', lab.CheckRequest(attempt=1, collected=True, errors=0, structure=True,
                                                        buttonCount=2, buttons=[{'label': 'a', 'threwException': False, 'changedDom': True},
                                                                                 {'label': 'b', 'threwException': False, 'changedDom': True}]))
        await lab.put_review('review', lab.ReviewRequest(attempt=1, visuals=5, buttons='yes'))
        await lab.put_review('review', lab.ReviewRequest(attempt=2, visuals=2, playable='yes'))
        run = await lab.get_run('review')
        rollup = {(row['field'], row['task'] if 'task' in row else None): row for row in run['rollup']}
        ui = next(row for row in run['rollup'] if row['field'] == 'ui')
        self.assertEqual(ui['auto_score'], 100)
        self.assertEqual(ui['buttons_ok'], 1)
        self.assertEqual(ui['visuals'], 5)
        coding = next(row for row in run['rollup'] if row['field'] == 'coding')
        self.assertEqual(coding['playable_ok'], 1)
        self.assertEqual(coding['visuals'], 2)
        self.assertIsNone(coding['auto_score'])

    async def test_json_task_scores_deterministically(self):
        good = lab.task_score('extras', json.dumps({'items': {'apple': {'qty': 4, 'revenue': 5.5}, 'banana': {'qty': 2, 'revenue': 1.5}}, 'grand_total': 7.0}))
        self.assertEqual(good, 100.0)
        self.assertEqual(lab.task_score('extras', 'not json at all'), 0.0)
        self.assertEqual(lab.task_score('extras', '{"items":{"apple":{"qty":3,"revenue":5.5}},"grand_total":7.0}'), 0.0)
        self.assertEqual(lab.task_score('ui', ARTIFACT), 0.0)


class SerializationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        patcher = patch.object(lab, 'DB_PATH', Path(self.temporary.name) / 'test.db')
        patcher.start()
        lab.initialize()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.temporary.cleanup)

    def test_missing_run_is_404(self):
        import fastapi
        with self.assertRaises(fastapi.HTTPException) as caught:
            lab.serialize_lab_run('ghost')
        self.assertEqual(caught.exception.status_code, 404)


if __name__ == '__main__':
    unittest.main()
