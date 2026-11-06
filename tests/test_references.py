import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from backend.app import main, references

KEY = 'test-key-not-real'


def item(name, slug, creator, index, cost=None, tps=None, **extra):
    data = {
        'name': name, 'slug': slug, 'release_date': None,
        'model_creator': {'name': creator},
        'evaluations': {'artificial_analysis_intelligence_index': index, 'artificial_analysis_coding_index': None},
        'artificial_analysis_intelligence_index_cost': {'cost_per_task': {'total_cost': cost}} if cost is not None else None,
        'performance_v3': {'mean_output_tokens_per_second': tps},
        'pricing': {'price_1m_input_tokens': 1.0, 'price_1m_output_tokens': 2.0},
        'future_field': {'anything': True},
    }
    data.update(extra)
    return data


def page_response(items, page, total, remaining='100'):
    return httpx.Response(200, json={
        'tier': 'free', 'intelligence_index_version': 5, 'data': items,
        'pagination': {'page': page, 'page_size': 200, 'total_pages': total, 'has_more': page < total},
    }, headers={'X-RateLimit-Remaining': remaining})


def transport_for(handler):
    calls = []

    def wrapped(request):
        assert request.headers['x-api-key'] == KEY
        calls.append(int(request.url.params.get('page', '1')))
        return handler(int(request.url.params.get('page', '1')), request)

    return httpx.MockTransport(wrapped), calls


def temp_db():
    directory = tempfile.TemporaryDirectory()
    return directory, patch.object(main, 'DB_PATH', Path(directory.name) / 'test.sqlite3')


class FetchTests(unittest.TestCase):
    def test_pagination_collects_every_page(self):
        pages = {1: [item('Alpha One', 'alpha-one', 'OpenAI', 50.0)],
                 2: [item('Beta Two', 'beta-two', 'Anthropic', 40.0)],
                 3: [item('Gamma Three', 'gamma-three', 'SpaceXAI', 30.0)]}
        transport, calls = transport_for(lambda page, request: page_response(pages[page], page, 3))
        snapshot = asyncio.run(references.fetch_snapshot(KEY, transport=transport))
        self.assertEqual(calls, [1, 2, 3])
        self.assertEqual([row['slug'] for row in snapshot['rows']], ['alpha-one', 'beta-two', 'gamma-three'])
        self.assertEqual(snapshot['version'], 5)

    def test_rejected_key_message_never_contains_the_key(self):
        transport, _ = transport_for(lambda page, request: httpx.Response(401, json={'detail': 'no'}))
        with self.assertRaises(references.RefreshError) as caught:
            asyncio.run(references.fetch_snapshot(KEY, transport=transport))
        self.assertIn('AA_API_KEY', str(caught.exception))
        self.assertNotIn(KEY, str(caught.exception))

    def test_rate_limit_reports_retry_after(self):
        transport, _ = transport_for(lambda page, request: httpx.Response(429, headers={'Retry-After': '900'}))
        with self.assertRaises(references.RefreshError) as caught:
            asyncio.run(references.fetch_snapshot(KEY, transport=transport))
        self.assertEqual(caught.exception.retry_after, 900)

    def test_server_error_is_retried_once(self):
        attempts = {'n': 0}

        def handler(page, request):
            attempts['n'] += 1
            if attempts['n'] == 1:
                return httpx.Response(500)
            return page_response([item('Alpha One', 'alpha-one', 'OpenAI', 50.0)], 1, 1)

        transport, _ = transport_for(handler)
        with patch.object(references.asyncio, 'sleep', AsyncMock()):
            snapshot = asyncio.run(references.fetch_snapshot(KEY, transport=transport))
        self.assertEqual(attempts['n'], 2)
        self.assertEqual(len(snapshot['rows']), 1)

    def test_partial_failure_returns_nothing(self):
        def handler(page, request):
            if page == 1:
                return page_response([item('Alpha One', 'alpha-one', 'OpenAI', 50.0)], 1, 2)
            return httpx.Response(404)

        transport, _ = transport_for(handler)
        with self.assertRaises(references.RefreshError):
            asyncio.run(references.fetch_snapshot(KEY, transport=transport))

    def test_low_quota_defers_before_fetching_more_pages(self):
        transport, calls = transport_for(lambda page, request: page_response([item('Alpha One', 'alpha-one', 'OpenAI', 50.0)], 1, 5, remaining='1'))
        with self.assertRaises(references.RefreshError):
            asyncio.run(references.fetch_snapshot(KEY, transport=transport))
        self.assertEqual(calls, [1])


class NormaliseTests(unittest.TestCase):
    def test_nulls_stay_null_and_unknown_fields_are_dropped(self):
        row = references.normalise_row(item('Test Model 8B', 'test-model-8b', 'OpenAI', None))
        self.assertIsNone(row['intelligence_index'])
        self.assertIsNone(row['cost_per_task'])
        self.assertIsNone(row['output_tps'])
        self.assertNotIn('future_field', row)
        self.assertNotIn('coding', json.dumps(row).lower())

    def test_zero_or_negative_speed_is_unavailable(self):
        self.assertIsNone(references.normalise_row(item('Test Model 8B', 'test-model-8b', 'OpenAI', 40.0, tps=0))['output_tps'])
        self.assertEqual(references.normalise_row(item('Test Model 8B', 'test-model-8b', 'OpenAI', 40.0, tps=72.5))['output_tps'], 72.5)

    def test_rows_without_identity_are_skipped(self):
        self.assertIsNone(references.normalise_row({'name': '', 'slug': 'x'}))
        self.assertIsNone(references.normalise_row({'name': 'Only name'}))
        self.assertIsNone(references.normalise_row('not a dict'))


class SelectionTests(unittest.TestCase):
    def rows(self):
        return [references.normalise_row(x) for x in [
            item('Alpha One (max)', 'alpha-one-max', 'OpenAI', 60.0),
            item('Alpha One (high)', 'alpha-one-high', 'OpenAI', 58.0),
            item('Alpha Two', 'alpha-two', 'OpenAI', 50.0),
            item('Alpha Three', 'alpha-three', 'OpenAI', 45.0),
            item('Alpha Four', 'alpha-four', 'OpenAI', 40.0),
            item('Beta Two', 'beta-two', 'Anthropic', 55.0),
            item('Gamma Three', 'gamma-three', 'SpaceXAI', 35.0),
            item('Gamma Missing', 'gamma-missing', 'SpaceXAI', None),
        ]]

    def test_top_three_per_lab_with_variants_grouped(self):
        labs, missing = references.select_labs(self.rows())
        openai = [row['name'] for row in labs if row['lab'] == 'OpenAI']
        self.assertEqual(openai, ['Alpha One (max)', 'Alpha Two', 'Alpha Three'])
        self.assertNotIn('Alpha One (high)', openai)

    def test_space_xai_alias_maps_to_xai_and_missing_lab_is_reported(self):
        labs, missing = references.select_labs(self.rows())
        self.assertEqual([row['name'] for row in labs if row['lab'] == 'xAI'], ['Gamma Three'])
        self.assertEqual(missing, [])
        labs, missing = references.select_labs([row for row in self.rows() if row['lab'] != 'Anthropic'])
        self.assertEqual(missing, ['Anthropic'])

    def test_selected_rows_never_carry_internal_fields(self):
        labs, _ = references.select_labs(self.rows())
        self.assertTrue(all('variant' not in row for row in labs))


class MatchTests(unittest.TestCase):
    def rows(self):
        return [references.normalise_row(x) for x in [
            item('Test Model 8B', 'test-model-8b', 'OpenAI', 40.0),
            item('Twin Model', 'twin-a', 'OpenAI', 30.0),
            item('Twin Model', 'twin-b', 'Anthropic', 31.0),
        ]]

    def test_exact_and_quantised_tags_match(self):
        self.assertEqual(references.match_local('testmodel:8b', self.rows())['slug'], 'test-model-8b')
        self.assertEqual(references.match_local('library/testmodel:8b-q4_K_M', self.rows())['slug'], 'test-model-8b')

    def test_near_miss_and_ambiguous_names_do_not_match(self):
        self.assertIsNone(references.match_local('testmodel:9b', self.rows()))
        self.assertIsNone(references.match_local('twinmodel', self.rows()))

    def test_checksum_is_stable_and_sensitive_to_change(self):
        rows = self.rows()
        self.assertEqual(references.checksum(rows, 5), references.checksum(list(rows), 5))
        self.assertNotEqual(references.checksum(rows, 5), references.checksum(rows[:2], 5))


class StorageTests(unittest.TestCase):
    def test_unchanged_refresh_updates_checked_only(self):
        directory, patcher = temp_db()
        with directory, patcher:
            main.initialize()
            rows = [references.normalise_row(item('Test Model 8B', 'test-model-8b', 'OpenAI', 40.0))]
            fetched = {'rows': rows, 'version': 5, 'tier': 'free'}
            with patch.object(main.references, 'fetch_snapshot', AsyncMock(return_value=fetched)), patch.object(main, 'utc_now', return_value='2026-11-06T10:00:00Z'):
                asyncio.run(main.refresh_once(KEY))
            first = main.read_setting('aa_snapshot')
            with patch.object(main.references, 'fetch_snapshot', AsyncMock(return_value=fetched)), patch.object(main, 'utc_now', return_value='2026-11-06T13:00:00Z'):
                asyncio.run(main.refresh_once(KEY))
            second = main.read_setting('aa_snapshot')
            self.assertEqual(first, second)
            self.assertEqual(main.read_setting('aa_status')['checked'], '2026-11-06T13:00:00Z')

    def test_changed_refresh_replaces_snapshot_and_changed_time(self):
        directory, patcher = temp_db()
        with directory, patcher:
            main.initialize()
            old = [references.normalise_row(item('Test Model 8B', 'test-model-8b', 'OpenAI', 40.0))]
            new = [references.normalise_row(item('Test Model 8B', 'test-model-8b', 'OpenAI', 41.0))]
            with patch.object(main.references, 'fetch_snapshot', AsyncMock(return_value={'rows': old, 'version': 5, 'tier': 'free'})), patch.object(main, 'utc_now', return_value='2026-11-06T10:00:00Z'):
                asyncio.run(main.refresh_once(KEY))
            with patch.object(main.references, 'fetch_snapshot', AsyncMock(return_value={'rows': new, 'version': 5, 'tier': 'free'})), patch.object(main, 'utc_now', return_value='2026-11-06T16:00:00Z'):
                asyncio.run(main.refresh_once(KEY))
            snapshot = main.read_setting('aa_snapshot')
            self.assertEqual(snapshot['rows'][0]['intelligence_index'], 41.0)
            self.assertEqual(snapshot['changed'], '2026-11-06T16:00:00Z')

    def test_failed_or_shrunken_refresh_keeps_previous_snapshot(self):
        directory, patcher = temp_db()
        with directory, patcher:
            main.initialize()
            full = [references.normalise_row(item(f'Model {i}', f'model-{i}', 'OpenAI', 40.0)) for i in range(10)]
            with patch.object(main.references, 'fetch_snapshot', AsyncMock(return_value={'rows': full, 'version': 5, 'tier': 'free'})):
                asyncio.run(main.refresh_once(KEY))
            before = main.read_setting('aa_snapshot')
            with patch.object(main.references, 'fetch_snapshot', AsyncMock(side_effect=references.RefreshError('boom'))):
                asyncio.run(main.refresh_once(KEY))
            self.assertEqual(main.read_setting('aa_snapshot'), before)
            self.assertEqual(main.read_setting('aa_status')['error'], 'boom')
            small = full[:3]
            with patch.object(main.references, 'fetch_snapshot', AsyncMock(return_value={'rows': small, 'version': 5, 'tier': 'free'})):
                asyncio.run(main.refresh_once(KEY))
            self.assertEqual(main.read_setting('aa_snapshot'), before)
            self.assertIn('kept', main.read_setting('aa_status')['error'])

    def test_no_key_at_startup_deletes_stored_rows(self):
        directory, patcher = temp_db()
        with directory, patcher:
            main.initialize()
            main.write_settings([('aa_snapshot', {'rows': []}), ('aa_status', {'checked': None})])
            with patch.object(main, 'AA_KEY', ''):
                async def start():
                    async with main.lifespan(main.app):
                        pass
                asyncio.run(start())
            self.assertIsNone(main.read_setting('aa_snapshot'))
            self.assertIsNone(main.read_setting('aa_status'))

    def test_refresh_interval_is_clamped(self):
        with patch.dict(os.environ, {'AA_REFRESH_MINUTES': '5'}):
            self.assertEqual(main.refresh_seconds(), 3600)
        with patch.dict(os.environ, {'AA_REFRESH_MINUTES': '99999'}):
            self.assertEqual(main.refresh_seconds(), 1440 * 60)
        with patch.dict(os.environ, {'AA_REFRESH_MINUTES': 'soon'}):
            self.assertEqual(main.refresh_seconds(), 180 * 60)


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.directory, self.patcher = temp_db()
        self.patcher.start()
        main.initialize()
        rows = [references.normalise_row(x) for x in [
            item('Test Model 8B', 'test-model-8b', 'OpenAI', 40.0, cost=1.2, tps=80.0),
            item('Other Model', 'other-model', 'Anthropic', 50.0, cost=3.0, tps=60.0),
            item('Unrelated Fixture', 'unrelated', 'Mistral', 20.0),
        ]]
        main.write_settings([('aa_snapshot', {'rows': rows, 'checksum': 'x', 'retrieved': '2026-11-06T10:00:00Z', 'changed': '2026-11-06T10:00:00Z', 'index_version': 5, 'tier': 'free'}),
                             ('aa_status', {'checked': main.utc_now(), 'error': None, 'not_before': None, 'next_due': 0})])

    def tearDown(self):
        self.patcher.stop()
        self.directory.cleanup()

    def test_route_returns_only_requested_matches_and_never_calls_aa(self):
        client = TestClient(main.app)
        with patch.object(main, 'AA_KEY', KEY), patch.object(main.references, 'fetch_snapshot', AsyncMock(side_effect=AssertionError('AA must not be called by the route'))):
            response = client.get('/api/references', params={'model': ['testmodel:8b']})
        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body['state'], 'ready')
        self.assertEqual(set(body['matches']), {'testmodel:8b'})
        self.assertEqual(body['matches']['testmodel:8b']['slug'], 'test-model-8b')
        self.assertEqual({row['lab'] for row in body['labs']}, {'OpenAI', 'Anthropic'})
        self.assertEqual(body['missing_labs'], ['xAI'])
        self.assertNotIn(KEY, response.text)
        self.assertNotIn('variant', response.text)

    def test_route_reports_not_configured_without_key(self):
        with patch.object(main, 'AA_KEY', ''):
            body = TestClient(main.app).get('/api/references').json()
        self.assertEqual(body['state'], 'not_configured')
        self.assertFalse(body['configured'])

    def test_route_reports_pending_with_key_and_no_snapshot(self):
        with main.connect_db() as db:
            db.execute("DELETE FROM settings WHERE key='aa_snapshot'")
        with patch.object(main, 'AA_KEY', KEY):
            body = TestClient(main.app).get('/api/references', params={'model': ['x']}).json()
        self.assertEqual(body['state'], 'pending')
        self.assertIsNone(body['matches']['x'])

    def test_route_caps_model_ids_and_ignores_long_values(self):
        ids = [f'model-{i}' for i in range(12)] + ['x' * 300]
        with patch.object(main, 'AA_KEY', KEY):
            body = TestClient(main.app).get('/api/references', params=[('model', value) for value in ids]).json()
        self.assertEqual(len(body['matches']), 8)
        self.assertNotIn('x' * 300, body['matches'])


if __name__ == '__main__':
    unittest.main()
