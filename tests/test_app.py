import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from backend.app import main


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


if __name__ == '__main__':
    unittest.main()
