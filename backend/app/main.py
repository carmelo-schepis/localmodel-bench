from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

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
        """)
        db.execute("UPDATE runs SET state='interrupted' WHERE state IN ('queued','running')")

class Endpoint(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=8, max_length=500)
    models: list[str] = Field(min_length=1, max_length=10)

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
    endpoints: list[Endpoint] = Field(min_length=1, max_length=4)
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

def safe_error(err: Exception) -> str:
    return (str(err) or err.__class__.__name__)[:240]

async def models_for(url: str) -> list[dict[str, Any]]:
    timeout = httpx.Timeout(connect=4, read=20, write=10, pool=4)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        response = await client.get(url + '/models')
        response.raise_for_status()
        items = response.json().get('data', [])
        return [{'id': item['id'], 'owned_by': item.get('owned_by', 'unknown')} for item in items if isinstance(item, dict) and item.get('id')]

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

def serialize_run(run_id: str) -> dict[str, Any]:
    with connect_db() as db:
        run = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
        if not run:
            raise HTTPException(404, 'Run not found.')
        rows = [dict(r) for r in db.execute('SELECT * FROM results WHERE run_id=? ORDER BY rowid', (run_id,))]
    data = json.loads(run['data'])
    summaries = []
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(row['model'], []).append(row)
    for model, items in grouped.items():
        for category in CATEGORIES:
            relevant = [r for r in items if r['category'] == category]
            graded = [r for r in relevant if r['score'] is not None]
            summaries.append({'model': model, 'category': category,
                'score': round(sum(r['score'] for r in graded) / len(graded) * 100, 1) if graded else None,
                'coverage': len(graded), 'total': len(relevant),
                'elapsed': round(sum(r['elapsed'] or 0 for r in relevant), 2),
                'tokens': sum(r['tokens'] or 0 for r in relevant),
                'ungraded': sum(1 for r in relevant if r['score'] is None)})
    config = json.loads(run['config'])
    complete = run['state'] == 'completed' and run['progress'] == run['total'] and all(
        sum(1 for x in summaries if x['model'] == e['model'] and x['category'] != 'Writing' and x['coverage'] == x['total'] and x['total']) == 6
        for e in config['models'])
    composites = {}
    if complete:
        for e in config['models']:
            composites[e['model']] = round(sum(x['score'] for x in summaries if x['model'] == e['model'] and x['category'] != 'Writing') / 6, 1)
    return {'id': run['id'], 'created': run['created'], 'depth': run['depth'], 'state': run['state'],
            'progress': run['progress'], 'total': run['total'], 'models': config['models'],
            'categories': CATEGORIES, 'results': rows, 'summary': summaries, 'composites': composites,
            'complete': complete, 'events': data.get('events', [])[-20:], 'error': run['error']}

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

@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize()
    app.state.tasks = set()
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
    if len(models) > 8: raise HTTPException(422, 'Select no more than eight models per run.')
    if len(models) != len({(x['endpoint'], x['model']) for x in models}): raise HTTPException(422, 'Duplicate model selection.')
    # Verify IDs against the live discovered endpoint before accepting a run.
    for endpoint in payload.endpoints:
        known = {item['id'] for item in await models_for(endpoint.url)}
        unknown = set(endpoint.models) - known
        if unknown: raise HTTPException(422, f"Model(s) no longer available at {endpoint.name}: {', '.join(sorted(unknown))}")
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

@app.get('/')
async def root(): return FileResponse('/app/frontend/index.html')
