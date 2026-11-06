import asyncio
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from backend.app import main


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    def client_for(self, metadata, status=200):
        def respond(request):
            if request.url.path == '/v1/models':
                return httpx.Response(200, json={'data': [
                    {'id': 'embeddinggemma:latest'}, {'id': 'gemma3:1b'},
                ]})
            self.assertEqual(request.url.path, '/api/show')
            model = json.loads(request.content)['model']
            return httpx.Response(status, json=metadata[model])
        return httpx.AsyncClient(transport=httpx.MockTransport(respond))

    async def test_discovery_excludes_embedding_models(self):
        client = self.client_for({
            'embeddinggemma:latest': {'capabilities': ['embedding']},
            'gemma3:1b': {'capabilities': ['completion', 'vision']},
        })
        with patch.object(main.httpx, 'AsyncClient', return_value=client):
            models = await main.models_for('http://ollama:11434/v1')
        self.assertEqual([m['id'] for m in models], ['gemma3:1b'])

    async def test_stale_embedding_selection_is_rejected_before_run_creation(self):
        client = self.client_for({
            'embeddinggemma:latest': {'capabilities': ['embedding']},
            'gemma3:1b': {'capabilities': ['completion']},
        })
        payload = main.RunRequest(endpoints=[{
            'name': 'Ollama', 'url': 'http://ollama:11434/v1',
            'models': ['embeddinggemma:latest'],
        }])
        with patch.object(main.httpx, 'AsyncClient', return_value=client):
            with self.assertRaises(main.HTTPException) as caught:
                await main.create_run(payload, None)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn('do not support chat', caught.exception.detail)

    async def test_metadata_unavailable_preserves_compatible_servers(self):
        for status in (200, 404, 405):
            with self.subTest(status=status):
                client = self.client_for({'embeddinggemma:latest': {}, 'gemma3:1b': {}}, status)
                with patch.object(main.httpx, 'AsyncClient', return_value=client):
                    models = await main.models_for('http://ollama:11434/v1')
                self.assertEqual(len(models), 2)

    async def test_metadata_failure_is_not_suppressed(self):
        client = self.client_for({'embeddinggemma:latest': {'error': 'Server failed'}}, 500)
        with patch.object(main.httpx, 'AsyncClient', return_value=client):
            with self.assertRaises(httpx.HTTPStatusError):
                await main.models_for('http://ollama:11434/v1')


class ErrorTests(unittest.TestCase):
    def test_server_error_message_is_preserved(self):
        for detail in ('Model does not support chat', {'message': 'Model does not support chat'}):
            with self.subTest(detail=detail):
                response = httpx.Response(400, json={'error': detail}, request=httpx.Request('POST', 'http://ollama/v1/chat/completions'))
                with self.assertRaises(httpx.HTTPStatusError) as caught:
                    response.raise_for_status()
                self.assertEqual(main.safe_error(caught.exception), 'HTTP 400: Model does not support chat')

    def test_non_json_errors_keep_http_context(self):
        response = httpx.Response(502, text='Bad gateway', request=httpx.Request('POST', 'http://ollama/v1/chat/completions'))
        with self.assertRaises(httpx.HTTPStatusError) as caught:
            response.raise_for_status()
        self.assertIn('502 Bad Gateway', main.safe_error(caught.exception))


class GradingTests(unittest.TestCase):
    def test_smoke_task_answers(self):
        self.assertEqual(main.grade('Engineering', '20 volts', '20', 'number')[0], 1)
        self.assertEqual(main.grade('Logic', 'Cy.', 'Cy', 'text')[0], 1)
        self.assertEqual(main.grade('Instructions', '{"ready": true}', '{"ready":true}', 'json')[0], 1)
        self.assertEqual(main.grade('Engineering', '21', '20', 'number')[0], 0)
        self.assertIsNone(main.grade('Writing', 'Some text', 'rubric', 'essay')[0])

    def test_endpoint_requires_v1_and_rejects_credentials(self):
        self.assertEqual(main.Endpoint.validate_url('http://modelbox:11434/v1/'), 'http://modelbox:11434/v1')
        for url in ('https://user:pass@example.com/v1', 'file:///tmp/v1', 'http://host:11434/api'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                main.Endpoint.validate_url(url)


class StorageTests(unittest.TestCase):
    def test_partial_run_never_gets_composite(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(main, 'DB_PATH', Path(temporary) / 'test.db'):
            main.initialize()
            run_id = 'test-run'
            config = {'models': [{'endpoint': 'one', 'model': 'm'}], 'endpoints': [], 'categories': main.CATEGORIES}
            with main.connect_db() as db:
                db.execute("INSERT INTO runs(id,created,depth,state,config) VALUES(?,?,?,?,?)", (run_id, 'today', 'Quick', 'running', json.dumps(config)))
                db.execute("INSERT INTO results(run_id,endpoint,model,category,question,response,score,elapsed,tokens,status) VALUES(?,?,?,?,?,?,?,?,?,?)", (run_id, 'one', 'm', 'Coding', '?', '2', 1, .1, 1, 'ok'))
            self.assertEqual(main.serialize_run(run_id)['composites'], {})

    def test_same_model_on_two_endpoints_keeps_separate_rows(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(main, 'DB_PATH', Path(temporary) / 'test.db'):
            main.initialize()
            run_id = 'two-endpoints'
            with main.connect_db() as db:
                db.execute("INSERT INTO runs(id,created,depth,state,config) VALUES(?,?,?,?,?)", (run_id, 'today', 'Quick', 'running', json.dumps({'models': [], 'endpoints': [], 'categories': main.CATEGORIES})))
                for endpoint in ('lab-a', 'lab-b'):
                    db.execute("INSERT INTO results(run_id,endpoint,model,category,question,response,score,elapsed,tokens,status) VALUES(?,?,?,?,?,?,?,?,?,?)", (run_id, endpoint, 'qwen3:8b', 'Knowledge', '?', '3', 1, .1, 1, 'ok'))
            summary = main.serialize_run(run_id)['summary']
            scored = [row for row in summary if row['total']]
            self.assertEqual({row['endpoint'] for row in scored}, {'lab-a', 'lab-b'})
            self.assertEqual([row['score'] for row in scored], [100, 100])


class FrontendAssetTests(unittest.TestCase):
    def test_every_local_asset_reference_exists(self):
        frontend = Path(__file__).resolve().parent.parent / 'frontend'
        references = re.findall(r'(?:href|src)="(/assets/[^"]+)"', (frontend / 'index.html').read_text())
        self.assertGreaterEqual(len(references), 3)
        for reference in references:
            with self.subTest(reference=reference):
                self.assertTrue((frontend / reference.lstrip('/')).is_file())
        stylesheet = (frontend / 'assets' / 'app.css').read_text()
        for reference in re.findall(r'url\("([^"]+)"\)', stylesheet):
            with self.subTest(reference=reference):
                self.assertTrue((frontend / 'assets' / reference).is_file())


if __name__ == '__main__':
    unittest.main()
