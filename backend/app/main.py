from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import references

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "bench.sqlite3"
DEPTHS = {"Quick": (8, 1, 4), "Standard": (50, 1, 12), "Rigorous": (150, 3, 30)}
CATEGORIES = ["Coding", "Engineering", "Logic", "Knowledge", "Instructions", "Context", "Writing"]
SAMPLE_QUESTIONS: list[tuple[str, str, str, str, str]] = [
    ("Coding", "Write a Python function `solve()` that returns the exact value of 1 + 1. Return only Python code.", "2", "code", "Smoke-test arithmetic"),
    ("Coding", "Write a Python function `solve()` that returns the sum of [3, 5]. Return only Python code.", "8", "code", "Smoke-test sum"),
    ("Engineering", "An ideal 10 ohm resistor carries 2 amps. What is its voltage in volts? Return the number only.", "20", "number", "Ohm's law"),
    ("Engineering", "A 100 W load runs for 2 hours. How many watt-hours of energy does it use? Return the number only.", "200", "number", "Energy calculation"),
    ("Logic", "Ada is older than Ben. Ben is older than Cy. Who is youngest? Return the name only.", "Cy", "text", "Ordering"),
    ("Logic", "A is before B and B is before C. Which letter is last? Return the letter only.", "C", "text", "Ordering"),
    ("Knowledge", "How many sides does a triangle have? Answer with the integer only.", "3", "number", "Basic fact"),
    ("Knowledge", "What is the chemical symbol for oxygen? Answer with the symbol only.", "O", "text", "Basic fact"),
    ("Instructions", "Return exactly the JSON object {\"ready\": true}. No prose or code fence.", '{"ready":true}', "json", "Exact JSON"),
    ("Instructions", "Answer with exactly one word, lowercase: What color is a clear daytime sky commonly described as?", "blue", "text", "Length and case"),
    ("Context", "Read: The museum opened in 1964 and houses 12 galleries. What year did it open? Return the year only.", "1964", "number", "Source retrieval"),
    ("Context", "Read: Mira bought 7 pears, gave away 3, then bought 2 more. How many pears does she have? Return the integer only.", "6", "number", "Grounded arithmetic"),
    ("Writing", "Using these facts only: The park has 4 entrances. It closes at sunset. Write one clear sentence including both facts.", "park writing rubric", "essay", "Grounded summary"),
    ("Writing", "Explain why testing a bridge design before construction matters. Write two concise sentences and distinguish evidence from assumption.", "engineering explanation", "essay", "Technical writing"),
]

def connect_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db

def initialize() -> None:
    with connect_db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created TEXT NOT NULL, depth TEXT NOT NULL,
          state TEXT NOT NULL, config TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
          total INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}', error TEXT);
        CREATE TABLE IF NOT EXISTS results (run_id TEXT NOT NULL, endpoint TEXT NOT NULL,
          model TEXT NOT NULL, category TEXT NOT NULL, question TEXT NOT NULL, response TEXT,
          score REAL, elapsed REAL, tokens INTEGER, status TEXT NOT NULL, reason TEXT,
          FOREIGN KEY(run_id) REFERENCES runs(id));
        CREATE INDEX IF NOT EXISTS results_run ON results(run_id);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bench_models (endpoint TEXT NOT NULL, model TEXT NOT NULL, updated TEXT NOT NULL,
          run_id TEXT NOT NULL, run_created TEXT NOT NULL, run_depth TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY (endpoint, model));
        """)
        db.execute("UPDATE runs SET state='interrupted' WHERE state IN ('queued','running')")
        completed = [row['id'] for row in db.execute("SELECT id FROM runs WHERE state='completed' ORDER BY created ASC")]
    # Runs completed before this table existed keep feeding the saved bench,
    # so a restart never loses benched models.
    for run_id in completed:
        publish_to_bench(run_id)

class Endpoint(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=8, max_length=500)
    models: list[str] = Field(min_length=1)

    @field_validator('url')
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urlsplit(value.rstrip('/'))
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Enter an http(s) Ollama /v1 base URL without embedded credentials.')
        if not parsed.path.rstrip('/').endswith('/v1'):
            raise ValueError('Endpoint must end in /v1.')
        return value.rstrip('/')

class RunRequest(BaseModel):
    endpoints: list[Endpoint] = Field(min_length=1)
    depth: str = 'Quick'
    categories: list[str] = CATEGORIES
    @field_validator('depth')
    @classmethod
    def check_depth(cls, value: str) -> str:
        if value not in DEPTHS:
            raise ValueError('Choose Quick, Standard, or Rigorous.')
        return value

class ConnectRequest(BaseModel):
    name: str = 'Ollama'
    url: str
    @field_validator('url')
    @classmethod
    def check_url(cls, value: str) -> str:
        return Endpoint.validate_url(value)

class FoundModel(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    owned_by: str = Field(default='', max_length=200)

class SetupEndpoint(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=8, max_length=500)
    models: list[str] = Field(default_factory=list, max_length=500)
    found: list[FoundModel] = Field(default_factory=list, max_length=500)

    @field_validator('url')
    @classmethod
    def validate_url(cls, value: str) -> str:
        return Endpoint.validate_url(value)

    @field_validator('models')
    @classmethod
    def check_models(cls, value: list[str]) -> list[str]:
        if any(not model or len(model) > 200 for model in value):
            raise ValueError('Model IDs must be 1 to 200 characters.')
        return list(dict.fromkeys(value))

class BenchSetup(BaseModel):
    endpoints: list[SetupEndpoint] = Field(default_factory=list, max_length=24)
    depth: str = 'Quick'
    categories: list[str] = Field(default_factory=lambda: list(CATEGORIES))

    @field_validator('depth')
    @classmethod
    def check_depth(cls, value: str) -> str:
        if value not in DEPTHS:
            raise ValueError('Choose Quick, Standard, or Rigorous.')
        return value

    @field_validator('categories')
    @classmethod
    def check_categories(cls, value: list[str]) -> list[str]:
        if not value or any(category not in CATEGORIES for category in value):
            raise ValueError('Select at least one supported category.')
        return list(dict.fromkeys(value))

def safe_error(err: Exception) -> str:
    if isinstance(err, httpx.HTTPStatusError):
        try:
            detail = err.response.json().get('error')
            if isinstance(detail, dict):
                detail = detail.get('message')
            if isinstance(detail, str) and detail.strip():
                return f'HTTP {err.response.status_code}: {detail}'[:240]
        except (ValueError, AttributeError):
            pass
    return (str(err) or err.__class__.__name__)[:240]

async def models_for(url: str) -> list[dict[str, Any]]:
    timeout = httpx.Timeout(connect=4, read=20, write=10, pool=4)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        response = await client.get(url + '/models')
        response.raise_for_status()
        items = response.json().get('data', [])
        models = []
        # The OpenAI model list includes embedding-only models. Ollama's native
        # metadata identifies which models can serve chat completion requests.
        show_url = url.removesuffix('/v1') + '/api/show'
        for item in items:
            if not isinstance(item, dict) or not item.get('id'):
                continue
            metadata = await client.post(show_url, json={'model': item['id']})
            # Some compatible servers/proxies expose only /v1, and older Ollama
            # versions omit capabilities. Preserve discovery when unknown.
            if metadata.status_code not in (404, 405):
                metadata.raise_for_status()
                capabilities = metadata.json().get('capabilities')
                if isinstance(capabilities, list) and 'completion' not in capabilities:
                    continue
            models.append({'id': item['id'], 'owned_by': item.get('owned_by', 'unknown')})
        return models

def normalized(text: str) -> str:
    return re.sub(r'\s+', '', text).lower()

def grade(category: str, text: str, answer: str, mode: str) -> tuple[float | None, str | None]:
    if mode == 'essay':
        return None, 'Requires blinded human rubric review. Automatic essay scores are not enabled.'
    candidate = text.strip()
    if mode == 'code':
        match = re.search(r'(?m)^\s*(?:return\s+)?(-?\d+)\s*$', candidate)
        if not match:
            match = re.search(r"return\s+['\"]?(-?\d+)['\"]?", candidate)
        score = 1.0 if match and match.group(1) == answer else 0.0
    elif mode == 'json':
        try:
            score = 1.0 if json.loads(candidate.split('```')[-1].split('```')[0].strip()) == {"ready": True} else 0.0
        except (ValueError, TypeError):
            score = 0.0
    elif mode == 'number':
        match = re.search(r'-?\d+(?:\.\d+)?', candidate)
        score = 1.0 if match and math.isclose(float(match.group()), float(answer), rel_tol=1e-6, abs_tol=1e-6) else 0.0
    else:
        score = 1.0 if normalized(candidate.strip(' .!`"')) == normalized(answer) else 0.0
    return score, None

def rollup_results(config: dict, run_state: str, progress: int, total: int, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-model, per-category rollup shared by the run view, Datasets and the saved bench."""
    models = config['models']
    summary = []
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault((row['endpoint'], row['model']), []).append(row)
    # Config order first, then any endpoint/model pair that appears only in the rows.
    entries = [(model['endpoint'], model['model']) for model in models]
    for key in grouped:
        if key not in entries: entries.append(key)
    for endpoint, model_id in entries:
        items = grouped.get((endpoint, model_id), [])
        for category in CATEGORIES:
            relevant = [r for r in items if r['category'] == category]
            graded = [r for r in relevant if r['score'] is not None]
            summary.append({'endpoint': endpoint, 'model': model_id, 'category': category,
                'score': round(sum(r['score'] for r in graded) / len(graded) * 100, 1) if graded else None,
                'coverage': len(graded), 'total': len(relevant),
                'elapsed': round(sum(r['elapsed'] or 0 for r in relevant), 2),
                'tokens': sum(r['tokens'] or 0 for r in relevant),
                'ungraded': sum(1 for r in relevant if r['score'] is None)})
    complete = run_state == 'completed' and progress == total and all(
        sum(1 for x in summary if x['endpoint'] == e['endpoint'] and x['model'] == e['model'] and x['category'] != 'Writing' and x['coverage'] == x['total'] and x['total']) == 6
        for e in models)
    composites = {}
    if complete:
        for e in models:
            composites[e['endpoint'] + '/' + e['model']] = round(sum(x['score'] for x in summary if x['endpoint'] == e['endpoint'] and x['model'] == e['model'] and x['category'] != 'Writing') / 6, 1)
    errors: dict[str, int] = {}
    for row in rows:
        if row['status'] == 'error':
            key = f"{row['endpoint']}/{row['model']}/{row['category']}"
            errors[key] = errors.get(key, 0) + 1
    return {'models': models, 'categories': config.get('categories', CATEGORIES),
            'summary': summary, 'composites': composites, 'complete': complete, 'errors': errors}

def serialize_run(run_id: str) -> dict[str, Any]:
    with connect_db() as db:
        run = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
        if not run:
            raise HTTPException(404, 'Run not found.')
        data = json.loads(run['data'])
        rows = [dict(r) for r in db.execute('SELECT * FROM results WHERE run_id=? ORDER BY rowid', (run_id,))]
        rollup = rollup_results(json.loads(run['config']), run['state'], run['progress'], run['total'], rows)
    return {'id': run['id'], 'created': run['created'], 'depth': run['depth'], 'state': run['state'],
            'progress': run['progress'], 'total': run['total'], 'models': rollup['models'],
            'categories': rollup['categories'], 'results': rows, 'summary': rollup['summary'],
            'composites': rollup['composites'], 'complete': rollup['complete'],
            'events': data.get('events', [])[-20:], 'error': run['error']}

def publish_to_bench(run_id: str) -> None:
    """Copy a completed run's per-model rollup into the saved bench.

    One entry per endpoint and model: benching the same model again replaces its
    entry instead of adding a duplicate. The run's own data stays untouched, and
    a rerun that produced no graded answers is skipped so errors never wipe
    good bench data.
    """
    with connect_db() as db:
        run = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
    if not run or run['state'] != 'completed': return
    with connect_db() as db:
        rows = [dict(r) for r in db.execute('SELECT endpoint,model,category,score,elapsed,tokens,status FROM results WHERE run_id=?', (run_id,))]
    rollup = rollup_results(json.loads(run['config']), run['state'], run['progress'], run['total'], rows)
    updates = []
    for entry in rollup['models']:
        model_rows = [r for r in rows if r['endpoint'] == entry['endpoint'] and r['model'] == entry['model']]
        if not any(r['score'] is not None for r in model_rows): continue
        payload = {'composite': rollup['composites'].get(entry['endpoint'] + '/' + entry['model']),
                   'summary': [x for x in rollup['summary'] if x['endpoint'] == entry['endpoint'] and x['model'] == entry['model']],
                   'errors': {}}
        for row in model_rows:
            if row['status'] == 'error':
                key = row['category']
                payload['errors'][key] = payload['errors'].get(key, 0) + 1
        updates.append((entry['endpoint'], entry['model'], utc_now(), run['id'], run['created'], run['depth'], json.dumps(payload)))
    with connect_db() as db:
        db.executemany('INSERT INTO bench_models(endpoint,model,updated,run_id,run_created,run_depth,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(endpoint,model) DO UPDATE SET updated=excluded.updated, run_id=excluded.run_id, run_created=excluded.run_created, run_depth=excluded.run_depth, data=excluded.data', updates)

def read_bench() -> dict[str, Any]:
    with connect_db() as db:
        entries = db.execute('SELECT endpoint,model,updated,run_id,run_created,run_depth,data FROM bench_models ORDER BY updated DESC').fetchall()
    models = []
    for entry in entries:
        payload = json.loads(entry['data'])
        models.append({'endpoint': entry['endpoint'], 'model': entry['model'], 'updated': entry['updated'],
                       'run_id': entry['run_id'], 'run_created': entry['run_created'], 'run_depth': entry['run_depth'],
                       'composite': payload.get('composite'), 'summary': payload.get('summary', []),
                       'errors': payload.get('errors', {})})
    return {'models': models}

def read_datasets() -> list[dict[str, Any]]:
    """A copy of each run's rollup, without the full per-attempt responses."""
    datasets = []
    with connect_db() as db:
        runs = db.execute('SELECT id,created,depth,state,progress,total,config,error FROM runs ORDER BY created DESC LIMIT 100').fetchall()
        for run in runs:
            rows = [dict(r) for r in db.execute('SELECT endpoint,model,category,score,elapsed,tokens,status FROM results WHERE run_id=?', (run['id'],))]
            rollup = rollup_results(json.loads(run['config']), run['state'], run['progress'], run['total'], rows)
            datasets.append({'id': run['id'], 'created': run['created'], 'depth': run['depth'], 'state': run['state'],
                             'progress': run['progress'], 'total': run['total'], 'error': run['error'],
                             'models': rollup['models'], 'categories': rollup['categories'], 'summary': rollup['summary'],
                             'composites': rollup['composites'], 'complete': rollup['complete'], 'errors': rollup['errors']})
    return datasets

async def execute_run(run_id: str) -> None:
    with connect_db() as db:
        run = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
    if not run: return
    config = json.loads(run['config'])
    tasks = [t for t in SAMPLE_QUESTIONS if t[0] in config['categories']]
    count, repeats, writing_count = DEPTHS[run['depth']]
    rng_seed = int(uuid.UUID(run_id))
    import random
    rng = random.Random(rng_seed)
    planned = []
    by_cat: dict[str, list[tuple[str, str, str, str, str]]] = {}
    for task in tasks:
        by_cat.setdefault(task[0], []).append(task)
    for category in config['categories']:
        pool = by_cat.get(category, [])
        target = writing_count if category == 'Writing' else count
        if pool:
            chosen = [rng.choice(pool) for _ in range(target)]
            planned.extend(chosen)
    total = len(planned) * sum(len(endpoint['models']) for endpoint in config['endpoints']) * repeats
    with connect_db() as db:
        db.execute("UPDATE runs SET state='running',total=?,progress=0 WHERE id=?", (total, run_id))
    with connect_db() as db:
        progress = db.execute('SELECT progress FROM runs WHERE id=?', (run_id,)).fetchone()['progress']
    attempt_index = 0
    for endpoint in config['endpoints']:
        # Serialize endpoint calls so selected models on one host do not contend.
        for model in endpoint['models']:
            for question in planned:
                for repetition in range(repeats):
                    with connect_db() as db:
                        state = db.execute('SELECT state FROM runs WHERE id=?', (run_id,)).fetchone()['state']
                    if state in ('cancelled', 'pausing', 'paused'):
                        if state == 'pausing':
                            with connect_db() as db: db.execute("UPDATE runs SET state='paused' WHERE id=?", (run_id,))
                        return
                    attempt_index += 1
                    if attempt_index <= progress:
                        continue
                    category, prompt, answer, mode, _name = question
                    started = time.monotonic()
                    content = None; score = None; reason = None; tokens = None; status = 'error'
                    try:
                        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=5, read=240, write=20, pool=5), follow_redirects=False) as client:
                            response = await client.post(endpoint['url'] + '/chat/completions', json={
                                'model': model, 'messages': [{'role': 'user', 'content': prompt}],
                                'temperature': 0, 'seed': repetition, 'max_tokens': 384, 'stream': True,
                                'stream_options': {'include_usage': True}})
                            response.raise_for_status()
                            content = ''; first_token_at = None
                            async for line in response.aiter_lines():
                                if not line.startswith('data:'): continue
                                payload = line[5:].strip()
                                if not payload or payload == '[DONE]': continue
                                chunk = json.loads(payload)
                                usage = chunk.get('usage')
                                if usage and isinstance(usage.get('completion_tokens'), int): tokens = usage['completion_tokens']
                                for choice in chunk.get('choices', []):
                                    delta = choice.get('delta', {}) or {}
                                    text = delta.get('content')
                                    if isinstance(text, str) and text:
                                        first_token_at = first_token_at or time.monotonic()
                                        content += text
                                        if len(content) > 100_000: raise ValueError('Response exceeded 100 KB limit.')
                        elapsed = time.monotonic() - started
                        if mode != 'essay': score, reason = grade(category, content or '', answer, mode)
                        status = 'ok'
                    except Exception as err:
                        elapsed = time.monotonic() - started
                        reason = safe_error(err)
                        status = 'error'
                        content = content or ''
                    progress += 1
                    with connect_db() as db:
                        db.execute('INSERT INTO results(run_id,endpoint,model,category,question,response,score,elapsed,tokens,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                                   (run_id, endpoint['name'], model, category, prompt, content, score, elapsed, tokens, status, reason))
                        db.execute('UPDATE runs SET progress=? WHERE id=?', (progress, run_id))
    with connect_db() as db:
        db.execute("UPDATE runs SET state='completed' WHERE id=?", (run_id,))
    publish_to_bench(run_id)

AA_KEY = os.getenv('AA_API_KEY', '').strip()
def refresh_seconds() -> int:
    try:
        minutes = int(os.getenv('AA_REFRESH_MINUTES', '180'))
    except ValueError:
        minutes = 180
    return min(1440, max(60, minutes)) * 60

AA_INTERVAL = refresh_seconds()
AA_STALE_SECONDS = 24 * 3600
aa_log = logging.getLogger('bench.aa')

def utc_now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
def read_setting(key: str) -> Any:
    with connect_db() as db:
        row = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    return json.loads(row['value']) if row else None

def write_settings(pairs: list[tuple[str, Any]]) -> None:
    # One transaction, so a changed snapshot and its status land together.
    with connect_db() as db:
        for key, value in pairs:
            db.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, json.dumps(value)))

def clear_reference_settings() -> None:
    with connect_db() as db:
        db.execute("DELETE FROM settings WHERE key IN ('aa_snapshot','aa_status')")

async def refresh_once(api_key: str) -> None:
    now = time.time()
    stamp = utc_now()
    status = read_setting('aa_status') or {}
    previous = read_setting('aa_snapshot')
    try:
        fetched = await references.fetch_snapshot(api_key)
        rows = fetched['rows']
        references.check_size(len(previous['rows']) if previous else None, rows)
        digest = references.checksum(rows, fetched['version'])
        if previous and previous.get('checksum') == digest:
            write_settings([('aa_status', {'checked': stamp, 'error': None, 'not_before': None, 'next_due': now + AA_INTERVAL})])
            return
        snapshot = {'rows': rows, 'checksum': digest, 'retrieved': stamp, 'changed': stamp,
                    'index_version': fetched['version'], 'tier': fetched['tier']}
        write_settings([('aa_snapshot', snapshot), ('aa_status', {'checked': stamp, 'error': None, 'not_before': None, 'next_due': now + AA_INTERVAL})])
        aa_log.info('AA snapshot updated: %d rows', len(rows))
    except references.RefreshError as err:
        retry = err.retry_after
        write_settings([('aa_status', {'checked': status.get('checked'), 'error': str(err),
                                       'not_before': now + retry if retry else None,
                                       'next_due': now + (retry or AA_INTERVAL)})])
        aa_log.warning('AA refresh did not complete: %s', err)

async def aa_loop(api_key: str) -> None:
    # Due times are stored, so a restart does not spend quota on an early fetch.
    while True:
        status = read_setting('aa_status') or {}
        wait = float(status.get('next_due') or 0) - time.time()
        if wait > 0:
            await asyncio.sleep(min(wait, 600))
            continue
        try:
            await refresh_once(api_key)
        except Exception as err:
            aa_log.warning('AA refresh failed unexpectedly (%s)', type(err).__name__)
            write_settings([('aa_status', {'checked': (read_setting('aa_status') or {}).get('checked'),
                                           'error': 'The refresh failed unexpectedly. It will be retried later.',
                                           'not_before': None, 'next_due': time.time() + AA_INTERVAL})])

@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize()
    app.state.tasks = set()
    if AA_KEY:
        task = asyncio.create_task(aa_loop(AA_KEY)); app.state.tasks.add(task); task.add_done_callback(app.state.tasks.discard)
    else:
        # Removing the key also removes stored AA data, so a licence end can be met by restarting.
        clear_reference_settings()
    yield
    for task in app.state.tasks: task.cancel()

app = FastAPI(title='LocalModel Bench', version='0.1.0', lifespan=lifespan)
app.mount('/assets', StaticFiles(directory='/app/frontend/assets', check_dir=False), name='assets')

@app.get('/api/health')
async def health(): return {'status': 'ok', 'version': app.version}

@app.post('/api/models')
async def discover(request: ConnectRequest):
    try:
        models = await models_for(request.url)
        return {'name': request.name, 'url': request.url, 'models': models}
    except (httpx.HTTPError, ValueError, KeyError) as err:
        raise HTTPException(502, f'Ollama request failed: {safe_error(err)}') from err

@app.post('/api/runs', status_code=202)
async def create_run(payload: RunRequest, request: Request):
    categories = list(dict.fromkeys(payload.categories))
    if not categories or any(category not in CATEGORIES for category in categories):
        raise HTTPException(422, 'Select at least one supported category.')
    models = [{'endpoint': e.name, 'model': m} for e in payload.endpoints for m in e.models]
    if len(models) != len({(x['endpoint'], x['model']) for x in models}): raise HTTPException(422, 'Duplicate model selection.')
    # Verify IDs against the live discovered endpoint before accepting a run.
    for endpoint in payload.endpoints:
        known = {item['id'] for item in await models_for(endpoint.url)}
        unknown = set(endpoint.models) - known
        if unknown: raise HTTPException(422, f"Model(s) unavailable or do not support chat at {endpoint.name}: {', '.join(sorted(unknown))}")
    run_id = str(uuid.uuid4()); created = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    config = {'endpoints': [e.model_dump() for e in payload.endpoints], 'models': models, 'categories': categories}
    with connect_db() as db:
        db.execute('INSERT INTO runs(id,created,depth,state,config) VALUES(?,?,?,?,?)', (run_id, created, payload.depth, 'queued', json.dumps(config)))
    task = asyncio.create_task(execute_run(run_id)); app.state.tasks.add(task); task.add_done_callback(app.state.tasks.discard)
    return {'id': run_id, 'state': 'queued'}

@app.get('/api/runs')
async def list_runs():
    with connect_db() as db: rows = db.execute('SELECT id,created,depth,state,progress,total,error FROM runs ORDER BY created DESC LIMIT 100').fetchall()
    return [dict(row) for row in rows]

@app.get('/api/runs/{run_id}')
async def get_run(run_id: str): return serialize_run(run_id)

@app.get('/api/datasets')
async def get_datasets(): return read_datasets()

@app.get('/api/bench')
async def get_bench(): return read_bench()

@app.get('/api/bench/setup')
async def get_bench_setup():
    stored = read_setting('bench_setup')
    if stored is None:
        return {'endpoints': [], 'depth': 'Quick', 'categories': CATEGORIES}
    return stored

@app.put('/api/bench/setup')
async def put_bench_setup(setup: BenchSetup):
    payload = {'endpoints': [endpoint.model_dump() for endpoint in setup.endpoints],
               'depth': setup.depth, 'categories': setup.categories}
    write_settings([('bench_setup', payload)])
    return {'saved': True}

@app.post('/api/runs/{run_id}/{action}')
async def control_run(run_id: str, action: str):
    if action not in ('pause','resume','cancel'): raise HTTPException(404,'Unknown run action.')
    with connect_db() as db:
        run = db.execute('SELECT state FROM runs WHERE id=?',(run_id,)).fetchone()
        if not run: raise HTTPException(404,'Run not found.')
        current=run['state']
        if action=='pause' and current=='running': new='pausing'
        elif action=='resume' and current=='paused': new='queued'
        elif action=='cancel' and current in ('queued','running','pausing','paused'): new='cancelled'
        else: raise HTTPException(409,f'Cannot {action} a {current} run.')
        db.execute('UPDATE runs SET state=? WHERE id=?',(new,run_id))
    if action=='resume':
        task=asyncio.create_task(execute_run(run_id));app.state.tasks.add(task);task.add_done_callback(app.state.tasks.discard)
    return {'id':run_id,'state':new}

@app.get('/api/runs/{run_id}/events')
async def run_events(run_id:str,request:Request):
    async def stream():
        previous=None
        while True:
            if await request.is_disconnected(): return
            try: data=serialize_run(run_id)
            except HTTPException: yield 'event: error\ndata: {"error":"Run not found."}\n\n'; return
            compact={'id':data['id'],'state':data['state'],'progress':data['progress'],'total':data['total'],'summaries':data['summary'],'composites':data['composites']}
            serialized=json.dumps(compact,separators=(',',':'))
            if serialized!=previous:
                yield f'id: {data["progress"]}\nevent: progress\ndata: {serialized}\n\n';previous=serialized
            if data['state'] in ('completed','failed','cancelled','interrupted'): return
            yield ': keepalive\n\n'; await asyncio.sleep(1)
    return StreamingResponse(stream(),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

def stamp_age(value: str) -> float:
    return time.time() - datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp()

@app.get('/api/references')
async def lab_references(model: list[str] = Query(default=[])):
    """Stored Artificial Analysis data only. This route never calls AA and never returns the key."""
    ids: list[str] = []
    for value in model:
        if not value or len(value) > 200 or value in ids: continue
        ids.append(value)
        if len(ids) == 8: break
    status = read_setting('aa_status') or {}
    snapshot = read_setting('aa_snapshot')
    configured = bool(AA_KEY)
    if not configured: state = 'not_configured'
    elif snapshot is None: state = 'error' if status.get('error') else 'pending'
    else: state = 'ready'
    checked = status.get('checked')
    stale = configured and (not checked or stamp_age(checked) > AA_STALE_SECONDS)
    rows = snapshot['rows'] if snapshot else []
    labs, missing = references.select_labs(rows) if snapshot else ([], [])
    return {'configured': configured, 'state': state, 'checked': checked,
            'changed': snapshot.get('changed') if snapshot else None, 'stale': stale,
            'error': status.get('error'), 'index_version': snapshot.get('index_version') if snapshot else None,
            'labs': labs, 'missing_labs': missing,
            'matches': {model_id: references.match_local(model_id, rows) if snapshot else None for model_id in ids}}

@app.get('/')
async def root(): return FileResponse('/app/frontend/index.html')
