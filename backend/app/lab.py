"""Execution lab: benchmarks whose artifacts run in a browser instead of being
graded as text. Entirely additive — existing endpoints, tables and graders in
main.py are untouched. Connects to the same SQLite database file via DATA_DIR.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import sqlite3
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from . import main as bench

DB_PATH = bench.DATA_DIR / "bench.sqlite3"
ARTIFACT_LIMIT = 300 * 1024
FIELDS = ["ui", "coding", "extras"]
LAB_LOG = logging.getLogger("bench.lab")

TABLES = """CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lab_runs (id TEXT PRIMARY KEY, created TEXT NOT NULL,
  state TEXT NOT NULL, config TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS lab_results (run_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  endpoint TEXT NOT NULL, model TEXT NOT NULL, field TEXT NOT NULL, task TEXT NOT NULL,
  prompt TEXT NOT NULL, html TEXT, elapsed REAL, tokens INTEGER, status TEXT NOT NULL, reason TEXT,
  wrapped INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
  auto TEXT NOT NULL DEFAULT '{}', review TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, attempt),
  FOREIGN KEY(run_id) REFERENCES lab_runs(id));
CREATE INDEX IF NOT EXISTS lab_results_run ON lab_results(run_id);
"""

JSON_ORDERS = [
    {"item": "apple", "qty": 3, "price": 1.5},
    {"item": "banana", "qty": 2, "price": 0.75},
    {"item": "apple", "qty": 1, "price": 1.0},
]

DASHBOARD_DATA = [
    {"city": "Berlin", "rain": 5.9, "days": 7},
    {"city": "Lisbon", "rain": 2.2, "days": 3},
    {"city": "Oslo", "rain": 4.4, "days": 6},
    {"city": "Athens", "rain": 0.8, "days": 1},
]

TASKS = [
    {
        "field": "ui", "key": "landing", "title": "Product landing page", "max_tokens": 2500,
        "prompt": (
            "Build a small landing page for a fictional plant-care product called Fernbloom. "
            "Return exactly one self-contained HTML document: all CSS and JavaScript inline, no "
            "external files, no network requests, no images from the internet.\n"
            "Required structure and behaviour:\n"
            "- A <header> with the product name and a nav with three links that scroll to sections.\n"
            "- A hero section with the headline 'Water less. Grow more.' and one paragraph.\n"
            "- A footer with the text 'Fernbloom is a fiction created for a benchmark.'\n"
            "- A pricing section with three buttons (Free, Starter, Pro). Clicking a button must "
            "show a visible status message on the page such as 'You chose the Free plan.' Do not "
            "use alert(), confirm() or prompt().\n"
            "- A features section with a list of three features.\n"
            "Interactivity must work standalone in an iframe. Keep the page under 200 lines."
        ),
    },
    {
        "field": "ui", "key": "widget", "title": "Interactive widget", "max_tokens": 2500,
        "prompt": (
            "Build one self-contained HTML page with all CSS and JavaScript inline: no external "
            "files, no network requests. It must contain these three components, each operable:\n"
            "1. A counter with an up button, a down button and a reset button; the current count is "
            "always visible.\n"
            "2. An accordion with at least two panels; clicking a panel header opens it and closes "
            "the other one.\n"
            "3. A tab bar with three tabs; clicking a tab shows its panel and hides the others.\n"
            "Every control must change visible page state when clicked. Do not use alert(), "
            "confirm() or prompt(). Keep the page under 200 lines."
        ),
    },
    {
        "field": "coding", "key": "game", "title": "Playable game", "max_tokens": 4096,
        "prompt": (
            "Build a playable Snake game in exactly one self-contained HTML document: all CSS and "
            "JavaScript inline, no external files, no network requests.\n"
            "Required:\n"
            "- A <canvas> game board at least 480 pixels wide.\n"
            "- An 8 by 8 grid. The snake starts with two cells and grows by one cell per food eaten.\n"
            "- Arrow keys control direction; the snake dies when it hits itself or the wall.\n"
            "- A visible score that increases on each food eaten.\n"
            "- A visible game-over state with a working 'Restart' button.\n"
            "- The game must animate itself with requestAnimationFrame or setInterval so it runs "
            "standalone in an iframe with no input. Keep the JavaScript in one script tag."
        ),
    },
    {
        "field": "coding", "key": "dashboard", "title": "Sort dashboard", "max_tokens": 2500,
        "prompt": (
            "Build one self-contained HTML page, all CSS and JavaScript inline, no external files "
            "or network requests. It renders this exact dataset:\n"
            + json.dumps(DASHBOARD_DATA, indent=2) + "\n"
            "Required:\n"
            "- A table with one row per city, four rows total, rendered from the data above by "
            "JavaScript. Do not write the rows directly into the HTML.\n"
            "- Two working sort buttons labelled 'Sort by rain' and 'Sort by days'. Each click "
            "re-renders the table rows in the sorted order; clicking the same button again "
            "reverses the order. The buttons must visibly rearrange rows.\n"
            "Keep the page under 150 lines."
        ),
    },
    {
        "field": "extras", "key": "json", "title": "JSON aggregation", "max_tokens": 512,
        "prompt": (
            "Aggregate this order data. Return only a JSON value with no prose and no markdown "
            "fence: group total quantity and total revenue (qty * price) per item, then the grand "
            "total revenue.\n"
            + json.dumps(JSON_ORDERS, indent=2) + "\n"
            "Exactly this shape: {\"items\": {\"<item>\": {\"qty\": number, \"revenue\": number}}, "
            "\"grand_total\": number}, with one entry per distinct item and every number rounded to "
            "exactly two decimal places."
        ),
    },
]
TASK_BY_KEY = {task['key']: task for task in TASKS}
HONEST_NOTE = ('Lab checks run generated web artifacts in your browser with limited coverage, and '
               'human verdicts come from a single reviewer looking at one attempt. These results are '
               'not a validated benchmark.')


def connect_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def initialize() -> None:
    with connect_db() as db:
        db.executescript(TABLES)
        # A clean stop between attempts stays resumable; anything else reports as interrupted.
        db.execute("UPDATE lab_runs SET state='interrupted' WHERE state IN ('queued','running','pausing')")


def utc_now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def read_setting(key: str) -> Any:
    with connect_db() as db:
        row = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    return json.loads(row['value']) if row else None


def write_settings(pairs: list[tuple[str, Any]]) -> None:
    with connect_db() as db:
        for key, value in pairs:
            db.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                       (key, json.dumps(value)))


# ---------------------------------- Grading ----------------------------------

def strip_doc(text: str) -> tuple[str, bool]:
    """Fence-lean artifact HTML plus whether a wrapper document was added."""
    candidate = (text or '').strip()
    fences = re.findall(r'```(?:html|htm)?[^\n]*\n(.*?)(?:```|$)', candidate, re.S | re.I)
    if fences:
        candidate = max(fences, key=len).strip()
    head = re.search(r'<!doctype|<html[\s>]', candidate, re.I)
    body = re.search(r'<body[\s>]|<canvas[\s>]|<header[\s>]|<main[\s>]|<section[\s>]', candidate, re.I)
    if head or body:
        return candidate, False
    wrapped = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"></head>'
               f'<body>{candidate}</body></html>')
    return wrapped, bool(candidate)


def close_enough(actual: Any, expected: Any) -> bool:
    if isinstance(actual, bool) or isinstance(expected, bool):
        return actual is expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return math.isclose(actual, expected, rel_tol=1e-6, abs_tol=1e-6)
    if isinstance(actual, dict) and isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(close_enough(actual[key], value) for key, value in expected.items())
    if isinstance(actual, list) and isinstance(expected, list):
        return len(actual) == len(expected) and all(close_enough(a, e) for a, e in zip(actual, expected))
    return actual == expected


def json_task_answer() -> dict:
    items: dict[str, dict[str, float]] = {}
    for order in JSON_ORDERS:
        entry = items.setdefault(order['item'], {'qty': 0.0, 'revenue': 0.0})
        entry['qty'] += order['qty']
        entry['revenue'] += order['qty'] * order['price']
    return {'items': {name: {'qty': round(entry['qty'], 2), 'revenue': round(entry['revenue'], 2)}
                      for name, entry in items.items()},
            'grand_total': round(sum(entry['revenue'] for entry in items.values()), 2)}


def task_score(field: str, text: str) -> float:
    """Deterministic 0/100 score. Only the extras field is auto-graded for now."""
    if field != 'extras':
        return 0.0
    candidate = (text or '').strip()
    fence = re.search(r'```(?:json)?[^\n]*\n(.*?)```', candidate, re.S)
    if fence:
        candidate = fence.group(1).strip()
    try:
        value = json.loads(candidate)
    except (ValueError, TypeError):
        return 0.0
    return 100.0 if close_enough(value, json_task_answer()) else 0.0

# ------------------------------ Auto scoring -------------------------------

def auto_checks(payload: dict, key: str) -> list[dict]:
    """Turn a harness payload into a display-ready pass/fail/skip checklist."""
    buttons = payload.get('buttons') if isinstance(payload.get('buttons'), list) else []
    wired_buttons = sum(1 for b in buttons if isinstance(b, dict) and b.get('changedDom') and not b.get('threwException'))
    button_count = payload.get('buttonCount') or len(buttons)
    has_buttons = button_count > 0
    errors = payload.get('errors', 0)
    checks = [
        {'name': 'Loads without uncaught errors', 'pass': False if errors else None if not payload else True,
         'detail': f'{errors} uncaught error{"s" if errors == 1 else ""}'},
        {'name': 'Buttons respond when clicked', 'pass': (wired_buttons == button_count) if has_buttons else None,
         'detail': f'{wired_buttons} of {button_count} responded'},
    ]
    if key == 'game':
        canvas = payload.get('canvas')
        animation = payload.get('animation')
        checks.append({'name': 'Canvas board present',
                       'pass': True if canvas else (False if canvas is False else None),
                       'detail': '' if canvas else 'no <canvas> found'})
        checks.append({'name': 'Animation loop detected', 'pass': True if animation else (False if animation is False else None),
                       'detail': 'frames kept advancing' if animation else 'no advancing frames measured'})
    if key == 'landing':
        structure = payload.get('structure')
        checks.append({'name': 'Header, hero, features and footer present',
                       'pass': True if structure else (False if structure is False else None), 'detail': ''})
    # Text input behaviour only shows when the harness actually met an input.
    if payload.get('inputFound') is True:
        checks.append({'name': 'Text input accepts typing', 'pass': bool(payload.get('inputTyped')),
                       'detail': 'changed on input event' if payload.get('inputTyped') else 'value or event ignored'})
    return checks


def auto_score(payload: dict, key: str) -> float | None:
    checks = [c for c in auto_checks(payload, key) if c['pass'] in (True, False)]
    if not checks:
        return None
    return round(100.0 * sum(1 for c in checks if c['pass'] is True) / len(checks), 1)

# --------------------------------- Rollup ----------------------------------

def rollup_lab_results(config: dict, attempts: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str, str], list[dict]] = {}
    for row in attempts:
        grouped.setdefault((row['endpoint'], row['model'], row['field']), []).append(row)
    entries = []
    for (endpoint, model, field), rows in grouped.items():
        scores = [row['autoScore'] for row in rows if row.get('autoScore') is not None]
        visuals = [row['review']['visuals'] for row in rows if row.get('review', {}).get('visuals') is not None]
        entries.append({
            'endpoint': endpoint, 'model': model, 'field': field, 'total': len(rows),
            'ok': sum(1 for row in rows if row['status'] == 'ok'),
            'failed': sum(1 for row in rows if row['status'] != 'ok'),
            'auto_score': round(sum(scores) / len(scores), 1) if scores else None,
            'auto_collected': len(scores),
            'buttons_ok': sum(1 for row in rows if row.get('review', {}).get('buttons') == 'yes'),
            'playable_ok': sum(1 for row in rows if row.get('review', {}).get('playable') == 'yes'),
            'visuals': round(sum(visuals) / len(visuals), 1) if visuals else None,
        })
    order = {(m['endpoint'], m['model']): index for index, m in enumerate(config.get('models', []))}
    return sorted(entries, key=lambda e: (order.get((e['endpoint'], e['model']), 99), FIELDS.index(e['field']) if e['field'] in FIELDS else 99))

# ------------------------------- Serialising -------------------------------

def attempt_row(row: dict) -> dict:
    attempt = dict(row)
    attempt.pop('html', None)
    auto = attempt.get('auto')
    review = attempt.get('review')
    attempt['auto'] = json.loads(auto) if isinstance(auto, str) else (auto or {})
    attempt['review'] = json.loads(review) if isinstance(review, str) else (review or {})
    task = TASK_BY_KEY.get(row['task'])
    attempt['title'] = task['title'] if task else row['task']
    return attempt


def serialize_lab_run(run_id: str) -> dict:
    with connect_db() as db:
        run = db.execute('SELECT * FROM lab_runs WHERE id=?', (run_id,)).fetchone()
    if not run:
        raise HTTPException(404, 'Lab run not found.')
    with connect_db() as db:
        rows = [dict(r) for r in db.execute('SELECT * FROM lab_results WHERE run_id=? ORDER BY attempt', (run_id,))]
    attempts = []
    for row in rows:
        item = attempt_row(row)
        if row['field'] == 'extras':
            item['autoScore'] = item['auto'].get('score') if isinstance(item['auto'].get('score'), (int, float)) else None
            item['autoChecks'] = [{'name': 'Deterministic schema check', 'pass': item['autoScore'] is not None and item['autoScore'] > 0,
                                   'detail': 'score stored at generation time'}]
        else:
            item['autoScore'] = auto_score(item['auto'], row['task'])
            item['autoChecks'] = auto_checks(item['auto'], row['task'])
        attempts.append(item)
    config = json.loads(run['config'])
    return {'id': run['id'], 'created': run['created'], 'state': run['state'], 'error': run['error'],
            'progress': run['progress'], 'total': run['total'], 'config': config, 'attempts': attempts,
            'rollup': rollup_lab_results(config, attempts)}

# -------------------------------- Executor ---------------------------------

async def complete_stream(url: str, model: str, prompt: str, max_tokens: int) -> dict:
    """One streaming chat completion, mirroring main.execute_run's request shape."""
    started = time.monotonic()
    body = ''
    tokens: int | None = None
    truncated = False
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=5, read=300, write=20, pool=5)) as client:
            response = await client.post(url + '/chat/completions', json={
                'model': model, 'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0, 'stream': True, 'max_tokens': max_tokens,
                'reasoning_effort': 'none',
                'stream_options': {'include_usage': True}})
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith('data:'):
                    continue
                payload = line[5:].strip()
                if not payload or payload == '[DONE]':
                    continue
                chunk = json.loads(payload)
                usage = chunk.get('usage')
                if usage and isinstance(usage.get('completion_tokens'), int):
                    tokens = usage['completion_tokens']
                for choice in chunk.get('choices', []):
                    text = (choice.get('delta') or {}).get('content')
                    if isinstance(text, str) and text:
                        body += text
                        if len(body) > ARTIFACT_LIMIT:
                            truncated = True
                            response.close()
                            break
                if truncated:
                    break
    except Exception as err:
        return {'status': 'error', 'reason': bench.safe_error(err), 'elapsed': time.monotonic() - started,
                'content': body, 'tokens': tokens, 'truncated': False}
    if not body.strip():
        return {'status': 'error', 'reason': 'The model returned no text.',
                'elapsed': time.monotonic() - started, 'content': '', 'tokens': tokens, 'truncated': truncated}
    return {'status': 'ok',
            'reason': f'Response stopped at the {ARTIFACT_LIMIT // 1024} KB artifact limit.' if truncated else None,
            'elapsed': time.monotonic() - started, 'content': body, 'tokens': tokens, 'truncated': truncated}


async def execute_lab_run(run_id: str) -> None:
    with connect_db() as db:
        run = db.execute('SELECT * FROM lab_runs WHERE id=?', (run_id,)).fetchone()
    if not run:
        return
    config = json.loads(run['config'])
    planned = [task for task in TASKS if task['field'] in config['fields']]
    # A queued run starts fresh; a running run is a resume and keeps its progress.
    # Cancelled or finished runs never resume.
    with connect_db() as db:
        state = db.execute('SELECT state FROM lab_runs WHERE id=?', (run_id,)).fetchone()['state']
    if state == 'queued':
        with connect_db() as db:
            db.execute("UPDATE lab_runs SET state='running',total=?,progress=0 WHERE id=? AND state='queued'",
                       (len(planned) * len(config['models']), run_id))
    elif state != 'running':
        return
    with connect_db() as db:
        progress = db.execute('SELECT progress FROM lab_runs WHERE id=?', (run_id,)).fetchone()['progress']
    attempt = 0
    for endpoint in config['endpoints']:
        # One host at a time, mirroring the bench runner's endpoint serialisation.
        for model in endpoint['models']:
            for task in planned:
                with connect_db() as db:
                    state = db.execute('SELECT state FROM lab_runs WHERE id=?', (run_id,)).fetchone()['state']
                if state not in ('running',):
                    return
                attempt += 1
                if attempt <= progress:
                    continue
                outcome = await complete_stream(endpoint['url'], model, task['prompt'], task['max_tokens'])
                grade = {}
                if task['field'] == 'extras' and outcome['status'] == 'ok':
                    grade = {'score': task_score('extras', outcome['content'])}
                if outcome['status'] == 'ok':
                    artifact, wrapped = strip_doc(outcome['content'])
                else:
                    artifact, wrapped = None, False
                progress += 1
                with connect_db() as db:
                    db.execute('INSERT INTO lab_results(run_id,attempt,endpoint,model,field,task,prompt,html,elapsed,tokens,status,reason,wrapped,truncated,auto,review) '
                               'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,attempt) DO NOTHING',
                               (run_id, attempt, endpoint['name'], model, task['field'], task['key'], task['prompt'],
                                artifact, outcome['elapsed'], outcome['tokens'], outcome['status'], outcome['reason'],
                                int(wrapped), int(outcome['truncated']), json.dumps(grade), '{}'))
                    db.execute('UPDATE lab_runs SET progress=? WHERE id=?', (progress, run_id))
    with connect_db() as db:
        if db.execute('SELECT state FROM lab_runs WHERE id=?', (run_id,)).fetchone()['state'] == 'running':
            db.execute("UPDATE lab_runs SET state='completed' WHERE id=?", (run_id,))
    LAB_LOG.info('Lab run %s finished with %d attempts', run_id, progress)


def insert_run(run_id: str, created: str, config: dict) -> None:
    tasks = sum(1 for task in TASKS if task['field'] in config['fields'])
    with connect_db() as db:
        db.execute('INSERT INTO lab_runs(id,created,state,config,total) VALUES(?,?,?,?,?)',
                   (run_id, created, 'queued', json.dumps(config), tasks * len(config['models'])))

# --------------------------------- Models -----------------------------------

class LabModelSelection(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=8, max_length=500)
    models: list[str] = Field(min_length=1)

    @field_validator('url')
    @classmethod
    def check_url(cls, value: str) -> str:
        return bench.Endpoint.validate_url(value)

    @field_validator('models')
    @classmethod
    def check_models(cls, value: list[str]) -> list[str]:
        if any(not model or len(model) > 200 for model in value):
            raise ValueError('Model IDs must be 1 to 200 characters.')
        return list(dict.fromkeys(value))


class LabSetup(BaseModel):
    models: list[LabModelSelection] = Field(default_factory=list, max_length=24)
    fields: list[str] = Field(default_factory=lambda: list(FIELDS))

    @field_validator('fields')
    @classmethod
    def check_fields(cls, value: list[str]) -> list[str]:
        if not value or any(field not in FIELDS for field in value):
            raise ValueError('Select at least one supported field.')
        return list(dict.fromkeys(value))


class LabRunRequest(BaseModel):
    endpoints: list[LabModelSelection] = Field(min_length=1)
    fields: list[str] = Field(min_length=1)

    @field_validator('fields')
    @classmethod
    def check_fields(cls, value: list[str]) -> list[str]:
        if not value or any(field not in FIELDS for field in value):
            raise ValueError('Select at least one supported field.')
        return list(dict.fromkeys(value))


class ReviewRequest(BaseModel):
    attempt: int = Field(ge=1)
    visuals: int | None = Field(default=None, ge=1, le=5)
    buttons: str | None = Field(default=None, pattern='^(yes|no)$')
    playable: str | None = Field(default=None, pattern='^(yes|no)$')


class CheckRequest(BaseModel):
    attempt: int = Field(ge=1)
    collected: bool = True
    errors: int = Field(default=0, ge=0, le=10_000)
    canvas: bool | None = None
    animation: bool | None = None
    structure: bool | None = None
    buttonCount: int = Field(default=0, ge=0, le=10_000)
    buttons: list[dict] = Field(default_factory=list, max_length=25)
    inputFound: bool | None = None
    inputTyped: bool | None = None


def clean_buttons(buttons: list) -> list[dict]:
    cleaned = []
    for item in buttons[:25]:
        if not isinstance(item, dict):
            continue
        cleaned.append({'label': str(item.get('label', ''))[:80],
                        'threwException': bool(item.get('threwException')),
                        'changedDom': bool(item.get('changedDom'))})
    return cleaned

# --------------------------------- Router -----------------------------------

router = APIRouter(prefix='/api/lab', tags=['lab'])


@router.get('/setup')
async def get_setup():
    stored = read_setting('lab_setup')
    return stored if stored is not None else {'models': [], 'fields': list(FIELDS)}


@router.put('/setup')
async def put_setup(setup: LabSetup):
    payload = {'models': [model.model_dump() for model in setup.models], 'fields': setup.fields}
    write_settings([('lab_setup', payload)])
    return {'saved': True}


def app_tasks(request: Request) -> set:
    tasks = getattr(request.app.state, 'tasks', None)
    if tasks is None:
        tasks = request.app.state.tasks = set()
    return tasks


def active_run_state() -> str | None:
    with connect_db() as db:
        row = db.execute("SELECT state FROM lab_runs WHERE state IN ('queued','running','pausing','paused') LIMIT 1").fetchone()
    return row['state'] if row else None


@router.post('/runs', status_code=202)
async def create_run(payload: LabRunRequest, request: Request):
    if active_run_state():
        raise HTTPException(409, 'A lab run is already active.')
    seen = set()
    for endpoint in payload.endpoints:
        for model in endpoint.models:
            if (endpoint.name, model) in seen:
                raise HTTPException(422, 'Duplicate model selection.')
            seen.add((endpoint.name, model))
    for endpoint in payload.endpoints:
        known = {item['id'] for item in await bench.models_for(endpoint.url)}
        unknown = set(endpoint.models) - known
        if unknown:
            raise HTTPException(422, f"Model(s) unavailable or do not support chat at {endpoint.name}: {', '.join(sorted(unknown))}")
    run_id = str(uuid.uuid4())
    config = {'endpoints': [model.model_dump() for model in payload.endpoints], 'fields': payload.fields,
              'models': [{'endpoint': e.name, 'model': m} for e in payload.endpoints for m in e.models]}
    insert_run(run_id, utc_now(), config)
    task = asyncio.create_task(execute_lab_run(run_id))
    tasks = app_tasks(request)
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return {'id': run_id, 'state': 'queued'}


@router.get('/runs')
async def list_runs():
    with connect_db() as db:
        rows = db.execute('SELECT id,created,state,progress,total,error FROM lab_runs ORDER BY created DESC LIMIT 100').fetchall()
    return [dict(row) for row in rows]


@router.get('/runs/{run_id}')
async def get_run(run_id: str):
    return serialize_lab_run(run_id)


@router.get('/runs/{run_id}/events')
async def run_events(run_id: str, request: Request):
    async def stream():
        previous = None
        while True:
            if await request.is_disconnected():
                return
            try:
                data = serialize_lab_run(run_id)
            except HTTPException:
                yield 'event: error\ndata: {"error":"Lab run not found."}\n\n'
                return
            compact = {'id': data['id'], 'state': data['state'], 'progress': data['progress'], 'total': data['total']}
            serialized = json.dumps(compact, separators=(',', ':'))
            if serialized != previous:
                yield f'id: {data["progress"]}\nevent: progress\ndata: {serialized}\n\n'
                previous = serialized
            if data['state'] in ('completed', 'failed', 'cancelled', 'interrupted'):
                return
            yield ': keepalive\n\n'
            await asyncio.sleep(1)
    return StreamingResponse(stream(), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@router.post('/runs/{run_id}/checks')
async def put_checks(run_id: str, payload: CheckRequest):
    with connect_db() as db:
        row = db.execute('SELECT attempt FROM lab_results WHERE run_id=? AND attempt=?', (run_id, payload.attempt)).fetchone()
        if not row:
            raise HTTPException(404, 'Attempt not found.')
        data = {'collected': payload.collected, 'errors': payload.errors, 'buttonCount': payload.buttonCount,
                'canvas': payload.canvas, 'animation': payload.animation, 'structure': payload.structure,
                'inputFound': payload.inputFound, 'inputTyped': payload.inputTyped,
                'buttons': clean_buttons(payload.buttons)}
        db.execute('UPDATE lab_results SET auto=? WHERE run_id=? AND attempt=?',
                   (json.dumps(data), run_id, payload.attempt))
    return {'saved': True}


@router.post('/runs/{run_id}/review')
async def put_review(run_id: str, payload: ReviewRequest):
    with connect_db() as db:
        row = db.execute('SELECT field, task, review FROM lab_results WHERE run_id=? AND attempt=?', (run_id, payload.attempt)).fetchone()
        if not row:
            raise HTTPException(404, 'Attempt not found.')
        if payload.buttons is not None and row['field'] != 'ui':
            raise HTTPException(422, 'The buttons verdict only applies to UI tasks.')
        if payload.playable is not None and row['task'] != 'game':
            raise HTTPException(422, 'The playable verdict only applies to the game task.')
        review = json.loads(row['review'] or '{}')
        if payload.visuals is not None:
            review['visuals'] = payload.visuals
        if payload.buttons is not None:
            review['buttons'] = payload.buttons
        if payload.playable is not None:
            review['playable'] = payload.playable
        db.execute('UPDATE lab_results SET review=? WHERE run_id=? AND attempt=?',
                   (json.dumps(review), run_id, payload.attempt))
    return {'saved': True, 'review': review}


@router.post('/runs/{run_id}/{action}')
async def control_run(run_id: str, action: str, request: Request):
    if action not in ('pause', 'resume', 'cancel'):
        raise HTTPException(404, 'Unknown lab run action.')
    with connect_db() as db:
        run = db.execute('SELECT state FROM lab_runs WHERE id=?', (run_id,)).fetchone()
        if not run:
            raise HTTPException(404, 'Lab run not found.')
        current = run['state']
        if action == 'pause' and current == 'running':
            new = 'pausing'
        elif action == 'resume' and current in ('paused',):
            new = 'running'
        elif action == 'cancel' and current in ('queued', 'running', 'pausing', 'paused'):
            new = 'cancelled'
        else:
            raise HTTPException(409, f'Cannot {action} a {current} lab run.')
        db.execute('UPDATE lab_runs SET state=? WHERE id=?', (new, run_id))
    if action == 'resume':
        task = asyncio.create_task(execute_lab_run(run_id))
        tasks = app_tasks(request)
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    return {'id': run_id, 'state': new}

# ---------------------------- Artifact serving ------------------------------

def load_artifact(run_id: str, attempt: int) -> str:
    with connect_db() as db:
        row = db.execute('SELECT html FROM lab_results WHERE run_id=? AND attempt=?', (run_id, attempt)).fetchone()
    if not row or not row['html']:
        raise HTTPException(404, 'No artifact for this attempt.')
    return row['html']


@router.get('/runs/{run_id}/artifacts/{attempt}')
async def artifact_preview(run_id: str, attempt: int):
    """The stored artifact with one harness script tag, used by the sandboxed iframe.
    The stored artifact itself is never modified."""
    html = load_artifact(run_id, attempt)
    harness = b'<script src="/assets/lab-harness.js"></script>'
    encoded = html.encode('utf-8', 'replace')
    if re.search(rb'</body>', encoded, re.I):
        encoded = re.sub(rb'</body>', harness + b'</body>', encoded, count=1, flags=re.I)
    else:
        encoded += harness
    return HTMLResponse(encoded, headers={'Content-Security-Policy': 'sandbox allow-scripts'})


@router.get('/artifacts/{run_id}/{attempt}/raw')
async def artifact_raw(run_id: str, attempt: int):
    """The stored artifact exactly as generated, for the full-preview new tab."""
    html = load_artifact(run_id, attempt)
    return HTMLResponse(html.encode('utf-8', 'replace'), headers={'Content-Security-Policy': 'sandbox allow-scripts'})
