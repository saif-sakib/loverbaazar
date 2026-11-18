"""Maintenance safety checks; all network/provider responses are isolated fixtures."""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('maintenance-check.py'))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)
NOW = datetime(2026, 11, 19, tzinfo=timezone.utc)
COMMIT = 'a' * 40


class PublicChecks(unittest.TestCase):
    def test_only_database_free_public_gets_and_no_redirects(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.command, self.path, self.headers.get('X-Admin-Token')))
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/api/admin/orders')
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write({
                    '/api/health': b'ok',
                    '/api/ready': json.dumps({'ready': True, 'version': COMMIT}).encode(),
                    '/release.json': json.dumps({'environment': 'production', 'commit': COMMIT}).encode(),
                }.get(self.path, b'private'))

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            site = f'http://127.0.0.1:{server.server_port}'
            self.assertTrue(all(c['status'] == 'pass' for c in maintenance.public_checks(site, 2)))
            self.assertEqual(302, maintenance.public_get(site, '/redirect', 2)[0])
            self.assertEqual(requests, [('GET', path, None) for path in (
                '/api/health', '/api/ready', '/release.json', '/redirect')])
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_unready_malformed_mismatched_and_html_responses_fail(self):
        for health, ready, release in (
            (b'<html>loading</html>', {'ready': True, 'version': COMMIT}, {'environment': 'production', 'commit': COMMIT}),
            (b'ok', {'ready': False, 'version': COMMIT}, {'environment': 'production', 'commit': COMMIT}),
            (b'ok', {'ready': True, 'version': COMMIT}, {'environment': 'production', 'commit': 'b' * 40}),
            (b'ok', [], {'environment': 'production', 'commit': COMMIT}),
            (b'ok', {'ready': True, 'version': COMMIT}, {'environment': 'preview', 'commit': COMMIT}),
        ):
            with self.subTest(ready=ready, release=release):
                values = [(200, health, 5), (200, json.dumps(ready).encode(), 5), (200, json.dumps(release).encode(), 5)]
                with patch.object(maintenance, 'public_get', side_effect=values):
                    self.assertTrue(any(c['status'] == 'action' for c in maintenance.public_checks('https://example.test', 2)))


class BackupChecks(unittest.TestCase):
    def setUp(self):
        self.run = {'id': 123, 'status': 'completed', 'conclusion': 'success',
                    'created_at': (NOW - timedelta(hours=2)).isoformat(), 'html_url': 'https://github.com/example/run/123'}
        self.artifact = {'name': 'loverbaazar-verified-backup-123-1', 'size_in_bytes': 500,
                         'expired': False, 'expires_at': (NOW + timedelta(days=7)).isoformat()}
        self.workflows = {'workflows': [{'path': '.github/workflows/' + name, 'state': 'active'}
                                       for name in ('backup.yml', 'backup-watch.yml')]}

    def checks(self, runs=None, artifact=None):
        values = [self.workflows, {'workflow_runs': runs or [self.run]},
                  {'artifacts': [self.artifact if artifact is None else artifact]}, {'workflow_runs': [self.run]}]
        with patch.object(maintenance, 'gh', side_effect=values) as api:
            checks = maintenance.backup_checks('owner/repo', NOW)
            self.assertTrue(all(call.args[0].startswith('repos/owner/repo/actions/') for call in api.call_args_list))
            return checks

    def test_fresh_success_with_artifact_and_freshness_watch(self):
        self.assertTrue(all(c['status'] == 'pass' for c in self.checks()))

    def test_expired_empty_wrong_and_expiring_artifact_fail(self):
        for change in ({'expired': True}, {'size_in_bytes': 0}, {'name': 'other'}, {'expires_at': NOW.isoformat()}):
            checks = self.checks(artifact={**self.artifact, **change})
            self.assertEqual('action', next(c['status'] for c in checks if c['check'] == 'verified-backup'))

    def test_stale_backup_and_disabled_schedule_fail(self):
        self.workflows['workflows'][0]['state'] = 'disabled_inactivity'
        self.run['created_at'] = (NOW - timedelta(hours=26)).isoformat()
        with patch.object(maintenance, 'gh', side_effect=[self.workflows, {'workflow_runs': [self.run]}]):
            checks = maintenance.backup_checks('owner/repo', NOW)
        self.assertTrue(all(c['status'] == 'action' for c in checks if c['check'] in ('verified-backup', 'backup.yml-enabled')))

    def test_new_failure_is_not_hidden_by_old_success(self):
        failed = {**self.run, 'id': 124, 'conclusion': 'failure'}
        self.assertIn({'check': 'latest-backup', 'status': 'action', 'reason': 'Latest backup failed; earlier success does not clear it'},
                      self.checks(runs=[failed, self.run]))

    def test_provider_error_never_prints_credentials(self):
        with patch.object(maintenance, 'gh', side_effect=subprocess.CalledProcessError(1, ['gh'], stderr='secret-token')):
            checks = maintenance.backup_checks('owner/repo', NOW)
        self.assertEqual('unknown', checks[-1]['status'])
        self.assertNotIn('secret-token', json.dumps(checks))

    def test_github_uses_only_get_and_fixed_host(self):
        with patch.object(maintenance.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{}')) as command:
            maintenance.gh('repos/owner/repo/actions/workflows')
        self.assertEqual(command.call_args.args[0], ['gh', 'api', '--method', 'GET', '--hostname', 'github.com', 'repos/owner/repo/actions/workflows'])


class UsageChecks(unittest.TestCase):
    def row(self, used=0, observed=None):
        return {'used': used, 'limit': 100, 'period': 'day', 'observedAt': (observed or NOW).isoformat()}

    def test_unknown_is_not_zero(self):
        checks = maintenance.usage_checks({}, NOW)
        self.assertEqual(len(maintenance.METRICS), len(checks))
        self.assertTrue(all(c['status'] == 'unknown' for c in checks))

    def test_thresholds(self):
        for used, state, urgent in ((0, 'pass', False), (69.9, 'pass', False), (70, 'warning', False),
                                    (85, 'action', False), (95, 'action', True), (101, 'action', True)):
            row = maintenance.usage_checks({'cloudflare.requests': self.row(used)}, NOW)[0]
            self.assertEqual((state, urgent), (row['status'], row['urgent']))

    def test_old_and_future_readings_are_unknown(self):
        for stamp in (NOW - timedelta(hours=27), NOW + timedelta(seconds=1)):
            self.assertEqual('unknown', maintenance.usage_checks({'cloudflare.requests': self.row(observed=stamp)}, NOW)[0]['status'])

    def test_invalid_values_periods_and_fields_are_refused(self):
        for changes in ({'used': -1}, {'used': True}, {'used': float('nan')}, {'used': float('inf')},
                        {'limit': 0}, {'period': 'month'}, {'observedAt': '2026-11-19'}, {'token': 'do-not-print'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                maintenance.usage_checks({'cloudflare.requests': {**self.row(), **changes}}, NOW)
        with self.assertRaises(ValueError):
            maintenance.usage_checks({'unexpected': None}, NOW)


if __name__ == '__main__':
    unittest.main()
