"""Read-only Artificial Analysis (AA) reference data: fetch, normalise, select and match.

No FastAPI imports here. Storage and scheduling live in main.py.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
from typing import Any

import httpx

log = logging.getLogger('bench.references')

AA_BASE = 'https://artificialanalysis.ai/api/v2'
AA_FREE_PATH = '/language/models/free'
MAX_PAGES = 20
TOP_PER_LAB = 3
# Canonical lab -> creator names AA may report for it (lowercase alphanumerics).
LABS: list[tuple[str, frozenset[str]]] = [
    ('OpenAI', frozenset({'openai'})),
    ('Anthropic', frozenset({'anthropic'})),
    ('xAI', frozenset({'xai', 'spacexai'})),
]
LAB_BY_ALIAS = {alias: lab for lab, aliases in LABS for alias in aliases}
QUANT_SUFFIX = re.compile(r'-(q\d[a-z0-9_]*|fp16|fp32|bf16|gguf)$')
VARIANT_SUFFIX = re.compile(r'\s*\([^()]*\)\s*$')


class RefreshError(Exception):
    """A refresh failed. The message is user-safe: it never contains the key or raw responses."""

    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


def norm(text: str) -> str:
    return re.sub(r'[^a-z0-9]', '', str(text).lower())


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _positive(value: Any) -> float | None:
    number = _number(value)
    return number if number is not None and number > 0 else None


def base_name(name: str) -> str:
    """Group variants: 'Example 2 (max)' and 'Example 2 (high)' share one base."""
    return VARIANT_SUFFIX.sub('', name).strip()


def normalise_row(item: Any) -> dict[str, Any] | None:
    """Keep the fields this app charts. Missing values stay None; unknown fields are ignored."""
    if not isinstance(item, dict):
        return None
    name, slug = item.get('name'), item.get('slug')
    if not isinstance(name, str) or not isinstance(slug, str) or not name.strip() or not slug.strip():
        return None
    creator = item.get('model_creator')
    creator_name = creator.get('name') if isinstance(creator, dict) else None
    creator_name = creator_name if isinstance(creator_name, str) else None
    evaluations = item.get('evaluations') if isinstance(item.get('evaluations'), dict) else {}
    cost = item.get('artificial_analysis_intelligence_index_cost')
    cost_per_task = cost.get('cost_per_task') if isinstance(cost, dict) else None
    cost_total = cost_per_task.get('total_cost') if isinstance(cost_per_task, dict) else None
    performance = item.get('performance_v3') if isinstance(item.get('performance_v3'), dict) else {}
    pricing = item.get('pricing') if isinstance(item.get('pricing'), dict) else {}
    return {
        'slug': slug,
        'name': name,
        'creator': creator_name,
        'lab': LAB_BY_ALIAS.get(norm(creator_name or '')),
        'variant': base_name(name),
        'release_date': item.get('release_date') if isinstance(item.get('release_date'), str) else None,
        'intelligence_index': _number(evaluations.get('artificial_analysis_intelligence_index')),
        'cost_per_task': _positive(cost_total),
        'output_tps': _positive(performance.get('mean_output_tokens_per_second')),
        'price_input': _number(pricing.get('price_1m_input_tokens')),
        'price_output': _number(pricing.get('price_1m_output_tokens')),
    }


def public_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if key != 'variant'}


def select_labs(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Top rows per canonical lab by Intelligence Index, best variant of each. Returns (rows, missing labs)."""
    selected: list[dict[str, Any]] = []
    missing: list[str] = []
    for lab, _aliases in LABS:
        best: dict[str, dict[str, Any]] = {}
        for row in rows:
            if row['lab'] != lab or row['intelligence_index'] is None:
                continue
            current = best.get(row['variant'])
            if current is None or row['intelligence_index'] > current['intelligence_index']:
                best[row['variant']] = row
        top = sorted(best.values(), key=lambda row: (-row['intelligence_index'], row['name']))[:TOP_PER_LAB]
        if top:
            selected.extend(public_row(row) for row in top)
        else:
            missing.append(lab)
            log.info('No AA rows for %s (creator names seen: %s)', lab, sorted({row['creator'] for row in rows if row['creator']})[:20])
    return selected, missing


def local_key(model_id: str) -> str:
    """Last path segment, split on ':' into base and tag, with latest and quantisation tags removed."""
    tail = str(model_id).split('/')[-1].lower()
    base, _, tag = tail.partition(':')
    if tag == 'latest':
        tag = ''
    previous = None
    while previous != tag:
        previous, tag = tag, QUANT_SUFFIX.sub('', tag)
    return norm(base + tag)


def match_local(model_id: str, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Exact match first, then with the trailing parenthetical removed. Ambiguous or missing gives None."""
    key = local_key(model_id)
    if not key:
        return None
    exact = [row for row in rows if key in (norm(row['slug']), norm(row['name']))]
    if not exact:
        exact = [row for row in rows if key == norm(row['variant'])]
    if len({row['slug'] for row in exact}) != 1:
        return None
    return public_row(sorted(exact, key=lambda row: -(row['intelligence_index'] or -1))[0])


def checksum(rows: list[dict[str, Any]], version: Any) -> str:
    canonical = json.dumps({'rows': rows, 'version': version}, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode()).hexdigest()


def check_size(previous_count: int | None, rows: list[dict[str, Any]]) -> None:
    if previous_count and len(rows) < 0.5 * previous_count:
        raise RefreshError('The new data had far fewer models than the last good snapshot, so the previous data was kept.')


def _retry_after(response: httpx.Response) -> int:
    try:
        return max(60, int(response.headers.get('Retry-After', '3600')))
    except ValueError:
        return 3600


async def _get_page(client: httpx.AsyncClient, headers: dict[str, str], page: int) -> httpx.Response:
    for attempt in (1, 2):
        try:
            response = await client.get(AA_BASE + AA_FREE_PATH, params={'page': page}, headers=headers)
        except httpx.TimeoutException:
            if attempt == 2:
                raise RefreshError('Artificial Analysis did not respond in time.') from None
            await asyncio.sleep(2)
            continue
        except httpx.HTTPError as err:
            raise RefreshError(f'Could not reach Artificial Analysis ({type(err).__name__}).') from None
        status = response.status_code
        if status == 429:
            raise RefreshError('The Artificial Analysis request quota is used up for now.', retry_after=_retry_after(response))
        if status in (401, 403):
            raise RefreshError('Artificial Analysis rejected the API key. Check AA_API_KEY.')
        if status >= 500:
            if attempt == 2:
                raise RefreshError(f'Artificial Analysis returned HTTP {status}.')
            await asyncio.sleep(2)
            continue
        if status != 200:
            raise RefreshError(f'Artificial Analysis returned HTTP {status}.')
        return response
    raise RefreshError('Artificial Analysis could not be read.')


async def fetch_snapshot(api_key: str, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
    """Fetch every page or raise. Nothing is returned unless every page succeeded."""
    headers = {'x-api-key': api_key}
    timeout = httpx.Timeout(connect=5, read=30, write=10, pool=5)
    rows: list[dict[str, Any]] = []
    version = None
    tier = None
    page = 1
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=transport) as client:
        while True:
            response = await _get_page(client, headers, page)
            try:
                body = response.json()
            except ValueError:
                raise RefreshError('Artificial Analysis returned a response that is not JSON.') from None
            if not isinstance(body, dict) or not isinstance(body.get('data'), list):
                raise RefreshError('Artificial Analysis returned an unexpected response shape.')
            version = body.get('intelligence_index_version', version)
            tier = body.get('tier', tier)
            pagination = body.get('pagination') if isinstance(body.get('pagination'), dict) else {}
            total_pages = pagination.get('total_pages') if isinstance(pagination.get('total_pages'), int) else None
            if page == 1 and total_pages:
                try:
                    left = int(response.headers.get('X-RateLimit-Remaining', ''))
                except ValueError:
                    left = None
                if left is not None and left < total_pages - 1:
                    raise RefreshError('The request quota is too low for a full refresh. It will be retried later.', retry_after=3600)
            rows.extend(row for row in (normalise_row(item) for item in body['data']) if row)
            if not pagination.get('has_more'):
                break
            page += 1
            if page > MAX_PAGES:
                raise RefreshError('The refresh stopped at the safety limit on pages.')
    if not rows:
        raise RefreshError('Artificial Analysis returned no usable models.')
    return {'rows': rows, 'version': version, 'tier': tier}
