"""Scoring regressions use synthetic completions and isolated SQLite storage."""
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
from backend.app import main


class StaticEvaluationTests(unittest.TestCase):
    def test_correct_programs(self):
        for body, answer in [('return 2', '2'), ('return 1 + 1', '2'), ('return sum([3, 5])', '8'),
                             ('"doc"\n    x = [3, 5]\n    return sum(x)', '8'), ('return -(-2)', '2')]:
            code = 'def solve():\n    ' + body
            for source in (code, '```python\n' + code + '\n```'):
                with self.subTest(source=source): self.assertEqual(main.grade('Coding', source, answer, 'code'), (1, None))

    def test_wrong_or_invalid_programs_fail(self):
        for source in ['def solve():\n return 2+100', 'def solve(:\n return 2', '2', '# return 2',
                       'def solve():\n return "2"', 'def solve():\n return 4\n return 2',
                       'def solve():\n "return 2"', 'garbage return 2', 'def solve():\n return 1/0']:
            with self.subTest(source=source):
                score, reason = main.grade('Coding', source, '2', 'code')
                self.assertEqual(score, 0); self.assertTrue(reason)

    def test_unsupported_is_bounded_and_explicit(self):
        for source in ['import os\ndef solve():\n return 2', 'def solve():\n for x in [1]:\n  return 2',
                       'def solve():\n return solve()', 'def solve(x):\n return 2',
                       '@other\ndef solve():\n return 2', 'def solve():\n return 10**100',
                       'def solve():\n return ' + '+'.join(['1']*100), 'x'*5000,
                       'def solve():\n return 10000000000000', 'def solve():\n return sum([3,5])\n sum = 0']:
            with self.subTest(source=source[:80]):
                score, reason = main.grade('Coding', source, '2', 'code')
                self.assertIsNone(score); self.assertIn('limit', reason.lower())

    def test_strict_tasks(self):
        for text in ['BLUE', 'Blue', 'blue!', 'blue sky']:
            self.assertEqual(main.grade('Instructions', text, 'blue', 'text')[0], 0)
        for text in ['{"ready":1}', '{"ready":true,"ready":true}', '{"ready":true,"x":0}',
                     '```json\n{"ready":true}\n```', 'Here: {"ready":true}']:
            self.assertEqual(main.grade('Instructions', text, '{"ready":true}', 'json')[0], 0)
        self.assertEqual(main.grade('Instructions', '{"other":false}', '{"other":false}', 'json')[0], 1)
        self.assertEqual(main.grade('Knowledge', 'o', 'O', 'text')[0], 0)
        for text in ['+20.0', '2E1', '.20e2', ' 20 ']:
            self.assertEqual(main.grade('Engineering', text, '20', 'number')[0], 1)
        for text in ['20 but actually 21', '20 volts', '19, 20', 'NaN', '1e999']:
            self.assertEqual(main.grade('Engineering', text, '20', 'number')[0], 0)


class CompletionTests(unittest.IsolatedAsyncioTestCase):
    async def run_fixture(self, payload, expected_status, expected_score, contains='', progress=0):
        with tempfile.TemporaryDirectory() as temporary, patch.object(main, 'DB_PATH', Path(temporary)/'test.db'), \
             patch.object(main, 'DEPTHS', {'Quick': (2, 1, 1)}), \
             patch.object(main, 'SAMPLE_QUESTIONS', [('Engineering','Return 20','20','number','fixture')]):
            main.initialize()
            run_id = str(uuid.uuid4())
            config = {'endpoints':[{'name':'fixture','url':'http://fixture/v1','models':['m']}],
                      'models':[{'endpoint':'fixture','model':'m'}], 'categories':['Engineering'],
                      'grader_version':main.GRADER_VERSION,'task_policy_version':main.TASK_POLICY_VERSION}
            with main.connect_db() as db:
                db.execute('INSERT INTO runs(id,created,depth,state,config,progress) VALUES(?,?,?,?,?,?)',
                           (run_id,'today','Quick','queued',json.dumps(config),progress))
            transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=payload) if isinstance(payload, httpx.AsyncByteStream) else httpx.Response(200, text=payload))
            client_type = httpx.AsyncClient
            with patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kwargs: client_type(transport=transport)):
                await main.execute_run(run_id)
            result = main.serialize_run(run_id)
            self.assertEqual(len(result['results']), 2-progress)
            for row in result['results']:
                self.assertEqual(row['status'], expected_status)
                self.assertEqual(row['score'], expected_score)
                self.assertIn(contains, row['reason'] or '')
            self.assertFalse(result['complete'])
            with main.connect_db() as db:
                stored = json.loads(db.execute('SELECT data FROM runs WHERE id=?', (run_id,)).fetchone()['data'])
            evidence = list(stored['completion_evidence'].values())
            self.assertEqual(len(evidence), 2-progress)
            if expected_status == 'incomplete' and 'token limit' in contains:
                self.assertTrue(all(item['finish_reason'] == 'length' for item in evidence))
            return result

    async def test_stream_outcomes_and_optional_metadata(self):
        def stream(delta, finish=None):
            choice={'delta':delta}
            if finish: choice['finish_reason']=finish
            return 'data: '+json.dumps({'choices':[choice]})+'\n\ndata: [DONE]\n\n'
        await self.run_fixture(stream({'content':'20'}), 'ok', 1)
        await self.run_fixture(stream({'content':'21'}, 'stop'), 'ok', 0, 'Expected')
        result=await self.run_fixture(stream({'content':'20'}, 'length'), 'incomplete', None, 'token limit')
        self.assertEqual(result['results'][0]['response'], '20')
        await self.run_fixture(stream({'content':''}, 'stop'), 'incomplete', None, 'No final answer')
        result=await self.run_fixture(stream({'reasoning_content':'thinking'}, 'stop'), 'incomplete', None)
        self.assertIn('thinking', result['results'][0]['response'])
        await self.run_fixture('', 'error', None, 'no completion chunks')
        result=await self.run_fixture(stream({'content':'20'}).split('data: [DONE]')[0]+'data: broken\n\n', 'error', None, 'Malformed')
        self.assertEqual(result['results'][0]['response'], '20')
        await self.run_fixture('data: {"choices":"bad"}\n\n', 'error', None, 'Malformed')

    async def test_transport_failure_preserves_partial_answer(self):
        class BrokenStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'data: {"choices":[{"delta":{"content":"20"}}]}\n\n'
                raise httpx.ReadError('transport interrupted')
        result = await self.run_fixture(BrokenStream(), 'error', None, 'transport interrupted')
        self.assertEqual(result['results'][0]['response'], '20')

    async def test_grader_failure_is_ungraded(self):
        with patch.object(main, 'grade', side_effect=RuntimeError('grader unavailable')):
            await self.run_fixture('data: {"choices":[{"delta":{"content":"20"}}]}\n\n', 'error', None, 'grader unavailable')

    async def test_resume_keeps_progress(self):
        await self.run_fixture('data: {"choices":[{"delta":{"content":"20"}}]}\n\n', 'ok', 1, progress=1)

    async def test_legacy_resume_is_blocked_without_modifying_data(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(main, 'DB_PATH', Path(temporary)/'test.db'):
            main.initialize()
            with main.connect_db() as db:
                db.execute('INSERT INTO runs(id,created,depth,state,config,data) VALUES(?,?,?,?,?,?)', ('old','today','Quick','paused','{}','{"keep":true}'))
            with self.assertRaises(main.HTTPException) as error:
                await main.control_run('old','resume')
            self.assertEqual(error.exception.status_code,409)
            with main.connect_db() as db:
                row=db.execute('SELECT state,data FROM runs WHERE id="old"').fetchone()
            self.assertEqual(tuple(row), ('paused','{"keep":true}'))


class RollupTests(unittest.TestCase):
    def test_perfect_scores_and_mixed_coverage(self):
        config={'models':[{'endpoint':'e','model':'m'}]}
        rows=[{'endpoint':'e','model':'m','category':c,'score':1,'status':'ok','elapsed':1,'tokens':None} for c in main.CATEGORIES if c!='Writing']
        result=main.rollup_results(config,'completed',6,6,rows)
        self.assertEqual(result['composites'], {'e/m':100})
        failed_writing = dict(rows[0], category='Writing',score=None,status='incomplete')
        self.assertFalse(main.rollup_results(config,'completed',7,7,rows+[failed_writing])['complete'])
        rows += [dict(rows[0], score=None, status=status) for status in ('ok','error','incomplete')]
        result=main.rollup_results(config,'completed',9,9,rows)
        self.assertFalse(result['complete'])
        self.assertEqual(result['composites'], {})
        coding=result['summary'][0]
        self.assertEqual((coding['score'],coding['coverage'],coding['total']), (100,1,4))
