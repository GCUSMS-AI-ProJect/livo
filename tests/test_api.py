"""Integration checks use isolated accounts and never the production database."""
import http.client
from contextlib import closing
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from livo import api as livo


class LivoChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='livo-check-')
        cls.server = livo.make_server(0, cls.tmp.name)
        cls.server.extra_origins.update({'http://127.0.0.1:8083', 'https://livo.workstudioai.top'})
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.admin = cls.server.store.register({'username': 'test_admin', 'password': 'test-only-password'})
        with cls.server.store.connect() as db:
            db.execute("UPDATE users SET role='admin' WHERE id=?", (cls.admin,))
        cls.admin_token = cls.server.store.issue_session(cls.admin)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(5); cls.tmp.cleanup()

    def request(self, path, data=None, token=None, headers=None, raw=False):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=15)
        fields = {'Origin': 'http://127.0.0.1:8083', 'Content-Type': 'application/json'}
        if token:
            fields['Cookie'] = 'livo_session=' + token
            fields['X-CSRF-Token'] = self.server.store.session(token)['csrf']
        fields.update(headers or {})
        connection.request('GET' if data is None else 'POST', path, body=None if data is None else json.dumps(data), headers=fields)
        response = connection.getresponse()
        content = response.read()
        result = response.status, content if raw else json.loads(content), dict(response.getheaders())
        connection.close()
        return result

    def test_01_permissions(self):
        self.assertEqual(self.request('/api/admin/regions')[0], 401)
        uid = self.server.store.register({'username': 'test_user', 'password': 'test-only-password'})
        token = self.server.store.issue_session(uid)
        self.assertEqual(self.request('/api/admin/regions', token=token)[0], 403)
        self.assertEqual(self.request('/api/admin', token=token)[0], 403)
        status, data, _ = self.request('/api/admin', token=self.admin_token)
        self.assertEqual(status, 200)
        self.assertFalse(any('password' in key for row in data['members'] for key in row))

    def test_02_success_only_and_no_refresh_events(self):
        before = self.server.store.regions()['summary']['logins']
        status, _, _ = self.request('/api/login', {'username': 'test_admin', 'password': 'incorrect'})
        self.assertEqual(status, 401)
        with patch.object(livo, 'location', return_value=dict(country='中国', countryCode='CN', region='广东省', city='深圳市')):
            status, data, headers = self.request('/api/login', {'username': 'test_admin', 'password': 'test-only-password'}, headers={'CF-Connecting-IP': '8.8.8.8', 'CF-IPCountry': 'CN', 'User-Agent': 'Chrome/130'})
        self.assertEqual(status, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        cookie = headers['Set-Cookie'].split(';')[0].split('=', 1)[1]
        for _ in range(2):
            self.assertEqual(self.request('/api/session', token=cookie)[0], 200)
        report = self.server.store.regions()
        self.assertEqual(report['summary']['logins'], before + 1)
        self.assertEqual(report['records'][0]['city'], '深圳市')
        self.assertEqual(report['records'][0]['ip_mask'], '8.8.*.*')
        self.assertNotIn('8.8.8.8', json.dumps(report))
        self.assertNotIn('csrf', report['records'][0])

    def test_03_cloudflare_headers_and_fallback(self):
        fake = dict(country='中国', countryCode='CN', region='广东省', city='深圳市')
        with patch.object(livo, 'location', return_value=fake):
            # Never accept forwarded country/IP from a non-loopback caller.
            place = livo.login_location('8.8.4.4', {'CF-Connecting-IP': '1.1.1.1', 'CF-IPCountry': 'US'})
            self.assertEqual(place['ip_mask'], '8.8.*.*')
            self.assertEqual(place['country_code'], 'CN')
            # No invented province when Cloudflare country disagrees with offline data.
            place = livo.login_location('127.0.0.1', {'CF-Connecting-IP': '8.8.8.8', 'CF-IPCountry': 'US'})
            self.assertEqual((place['country_code'], place['region'], place['city']), ('US', '', ''))
            headers = {'CF-Connecting-IP': '8.8.8.8', 'CF-IPCountry': 'CN', 'CF-IPCity': '北京市'.encode().decode('latin1')}
            self.assertEqual(livo.login_location('127.0.0.1', headers)['city'], '深圳市')
            self.assertEqual(livo.login_location('127.0.0.1', headers, True)['city'], '北京市')
        self.assertEqual(livo.login_location('127.0.0.1', {})['source'], 'unknown')
        self.assertEqual(livo.login_location('127.0.0.1', {'CF-Connecting-IP': 'garbage'})['source'], 'unknown')
        self.assertIn('/48', livo.login_location('127.0.0.1', {'CF-Connecting-IP': '2606:4700:4700::1111'})['ip_mask'])

    def test_04_checkin_idempotence_and_notes(self):
        uid = self.server.store.register({'username': 'note_user', 'password': 'test-only-password'})
        token = self.server.store.issue_session(uid)
        self.assertEqual(self.request('/api/checkin', {}, token, {'X-CSRF-Token': 'wrong'})[0], 403)
        status, data, _ = self.request('/api/checkin', {}, token)
        self.assertEqual(status, 200); self.assertTrue(data['created'])
        self.assertFalse(self.request('/api/checkin', {}, token)[1]['created'])
        note = '<script>literal, never HTML</script>'
        self.assertEqual(self.request('/api/note', {'day': livo.base.day_at(), 'note': note}, token)[0], 200)
        calendar = self.request('/api/calendar', token=token)[1]
        self.assertEqual(calendar['total'], 1)
        self.assertEqual(calendar['records'][livo.base.day_at()]['note'], note)
        self.assertEqual(self.request('/api/note', {'day': '2000-01-01', 'note': note}, token)[0], 400)
        self.assertEqual(self.request('/api/note', {'day': livo.base.day_at(), 'note': 'x' * 501}, token)[0], 400)

    def test_05_origin_session_and_pagination(self):
        self.assertEqual(self.request('/api/login', {'username': 'test_admin', 'password': 'test-only-password'}, headers={'Origin': 'https://other.example'})[0], 403)
        self.assertEqual(self.request('/api/admin/regions?days=8', token=self.admin_token)[0], 400)
        uid = self.server.store.register({'username': 'temp_user', 'password': 'test-only-password'})
        token = self.server.store.issue_session(uid)
        self.assertEqual(self.request('/api/logout', {}, token)[0], 200)
        self.assertIsNone(self.server.store.session(token))
        for i in range(22):
            self.server.store.record_login(self.admin, '127.0.0.1', {}, 'login')
        report = self.server.store.regions(page=2)
        self.assertEqual(report['pages'], 2)
        self.assertGreater(len(report['records']), 0)
        with self.server.store.connect() as db:
            db.execute('UPDATE login_events SET created=?', (time.time() - 31 * 86400,))
        self.assertEqual(self.server.store.regions(30)['summary']['logins'], 0)
        self.assertEqual(Path(self.server.store.db).stat().st_mode & 0o777, 0o600)

    def test_06_email_identifier(self):
        data = {'username': 'livo-test@example.com', 'password': 'test-only-password'}
        uid = self.server.store.register(data)
        self.assertEqual(self.server.store.login(data), uid)

    def test_07_password_change_revokes_other_sessions(self):
        uid = self.server.store.register({'username': 'password_user', 'password': 'original-test-password'})
        current = self.server.store.issue_session(uid)
        other = self.server.store.issue_session(uid)
        self.assertEqual(self.request('/api/password', {'current': 'wrong', 'password': 'replacement-password'}, current)[0], 400)
        self.assertIsNotNone(self.server.store.session(other))
        self.assertEqual(self.request('/api/password', {'current': 'original-test-password', 'password': 'short'}, current)[0], 400)
        self.assertEqual(self.request('/api/password', {'current': 'original-test-password', 'password': 'replacement-password'}, current)[0], 200)
        self.assertIsNotNone(self.server.store.session(current))
        self.assertIsNone(self.server.store.session(other))
        with self.assertRaises(livo.base.APIError):
            self.server.store.login({'username': 'password_user', 'password': 'original-test-password'})
        self.assertEqual(self.server.store.login({'username': 'password_user', 'password': 'replacement-password'}), uid)

    def test_08_account_isolation_and_expiry(self):
        first = self.server.store.register({'username': 'private_first', 'password': 'test-only-password'})
        second = self.server.store.register({'username': 'private_second', 'password': 'test-only-password'})
        first_token = self.server.store.issue_session(first)
        second_token = self.server.store.issue_session(second)
        self.request('/api/checkin', {}, first_token)
        self.request('/api/note', {'day': livo.base.day_at(), 'note': 'private record'}, first_token)
        other_calendar = self.request('/api/calendar', token=second_token)[1]
        self.assertEqual(other_calendar['records'], {})
        self.assertIn('now', other_calendar)
        self.assertEqual(self.request('/api/note', {'day': livo.base.day_at(), 'note': 'cannot edit'}, second_token)[0], 400)
        with self.server.store.connect() as db:
            db.execute('UPDATE sessions SET expires=? WHERE token_hash=?', (time.time() - 1, livo.base.hashlib.sha256(second_token.encode()).hexdigest()))
        self.assertEqual(self.request('/api/calendar', headers={'Cookie': 'livo_session=' + second_token})[0], 401)
        self.assertIsNone(self.request('/api/session', headers={'Cookie': 'livo_session=' + second_token})[1]['user'])

    def test_09_unified_auth_creates_once_and_never_replaces_password(self):
        data = {'username': 'unified_account', 'password': 'unified-test-password'}
        before = self.server.store.regions()['summary']['logins']
        status, created, headers = self.request('/api/auth', data, headers={'Origin': 'https://livo.workstudioai.top', 'Host': 'livo.workstudioai.top'})
        self.assertEqual(status, 200)
        self.assertEqual(created['user']['role'], 'user')
        self.assertIn('__Host-livo_session=', headers['Set-Cookie'])
        self.assertIn('; Secure', headers['Set-Cookie'])
        status, signed_in, _ = self.request('/api/auth', data)
        self.assertEqual(status, 200)
        self.assertEqual(created['user']['id'], signed_in['user']['id'])
        self.assertEqual(self.request('/api/auth', {**data, 'password': 'wrong-password'})[0], 401)
        self.assertEqual(self.server.store.login(data), created['user']['id'])
        self.assertEqual(self.server.store.regions()['summary']['logins'], before + 2)
        with self.server.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM users WHERE username=?', (data['username'],)).fetchone()[0], 1)
        self.assertEqual(self.request('/api/auth', {'username': 'bad!', 'password': 'valid-password'})[0], 400)

    def test_10_background_preferences_follow_account_and_are_private(self):
        data = {'username': 'background_user', 'password': 'background-test-password'}
        status, profile, headers = self.request('/api/auth', data)
        self.assertEqual(status, 200)
        token = headers['Set-Cookie'].split(';')[0].split('=', 1)[1]
        self.assertEqual(profile['user']['background'], 'cloud')
        self.assertEqual(self.request('/api/preferences')[0], 401)
        self.assertEqual(self.request('/api/preferences', {'background': 'sea'}, token, {'X-CSRF-Token': 'wrong'})[0], 403)
        self.assertEqual(self.request('/api/preferences', {'background': ['sea']}, token)[0], 400)
        self.assertEqual(self.request('/api/preferences', {'background': 'unknown'}, token)[0], 400)
        status, saved, _ = self.request('/api/preferences', {'background': 'sea'}, token)
        self.assertEqual(status, 200)
        self.assertGreater(saved['background_updated'], 0)
        # A fresh device has no copied browser state: only credentials are reused.
        status, fresh, _ = self.request('/api/auth', data)
        self.assertEqual(status, 200)
        self.assertEqual(fresh['user']['background'], 'sea')
        self.assertEqual(self.request('/api/session', token=token)[1]['user']['background'], 'sea')
        self.assertEqual(self.request('/api/preferences', token=self.admin_token)[1]['background'], 'cloud')
        self.request('/api/preferences', {'background': 'forest', 'user_id': self.admin}, token)
        self.assertEqual(self.request('/api/preferences', token=self.admin_token)[1]['background'], 'cloud')
        self.assertEqual(self.request('/api/preferences', token=token)[1]['background'], 'forest')
        with self.server.store.connect() as db:
            db.execute('DELETE FROM users WHERE id=?', (profile['user']['id'],))
            self.assertEqual(db.execute('SELECT count(*) FROM preferences WHERE user_id=?', (profile['user']['id'],)).fetchone()[0], 0)

    def test_11_custom_background_is_validated_private_and_replaces_old_image(self):
        import base64
        import io
        from PIL import Image
        user = self.server.store.register({'username': 'photo_user', 'password': 'photo-test-password'})
        token = self.server.store.issue_session(user)
        self.assertEqual(self.request('/api/preferences', {'background': 'custom'}, token)[0], 400)
        self.assertEqual(self.request('/api/background-image', raw=True)[0], 401)
        def encoded(color, size=(1600, 900)):
            output = io.BytesIO()
            exif = Image.Exif(); exif[270] = 'private-metadata-must-not-be-kept'
            Image.new('RGB', size, color).save(output, format='JPEG', exif=exif)
            return 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode()
        self.assertEqual(self.request('/api/background-image', {'image': encoded('red')}, token, {'X-CSRF-Token': 'bad'})[0], 403)
        self.assertEqual(self.request('/api/background-image', {'image': encoded('red', (640, 360))}, token)[0], 400)
        self.assertEqual(self.request('/api/background-image', {'image': 'data:image/jpeg;base64,not-an-image'}, token)[0], 400)
        self.assertEqual(self.request('/api/background-image', {'image': 'data:image/svg+xml;base64,PHN2Zy8+'}, token)[0], 400)
        self.assertEqual(self.request('/api/background-image', {'image': 'data:image/jpeg;base64,' + base64.b64encode(b'x' * (livo.IMAGE_LIMIT + 1)).decode()}, token)[0], 400)
        status, first, _ = self.request('/api/background-image', {'image': encoded('red')}, token)
        self.assertEqual(status, 200); self.assertEqual(first['background'], 'custom')
        status, content, headers = self.request('/api/background-image?v=' + first['background_image_version'], token=token, raw=True)
        self.assertEqual(status, 200); self.assertEqual(headers['Content-Type'], 'image/jpeg')
        self.assertEqual(headers['Cache-Control'], 'no-store'); self.assertLessEqual(len(content), livo.IMAGE_LIMIT)
        with Image.open(io.BytesIO(content)) as image:
            self.assertEqual(image.size, (1600, 900)); self.assertFalse(image.getexif())
        self.assertNotIn(b'private-metadata', content)
        self.assertEqual(self.request('/api/background-image', token=self.admin_token, raw=True)[0], 404)
        second = self.request('/api/background-image', {'image': encoded('blue')}, token)[1]
        self.assertNotEqual(first['background_image_version'], second['background_image_version'])
        self.assertEqual(self.request('/api/background-image?v=' + first['background_image_version'], token=token, raw=True)[0], 404)
        self.assertEqual(self.request('/api/session', token=token)[1]['user']['background_image_version'], second['background_image_version'])
        self.request('/api/preferences', {'background': 'sea'}, token)
        self.assertTrue(self.request('/api/preferences', token=token)[1]['background_image_version'])
        with self.server.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM background_images WHERE user_id=?', (user,)).fetchone()[0], 1)
        removed = self.request('/api/background-image/delete', {}, token)[1]
        self.assertEqual(removed['background'], 'sea'); self.assertEqual(removed['background_image_version'], '')
        self.assertEqual(self.request('/api/background-image', token=token, raw=True)[0], 404)
        self.request('/api/background-image', {'image': encoded('green')}, token)
        self.assertEqual(self.request('/api/background-image/delete', {}, token)[1]['background'], 'cloud')
        self.request('/api/background-image', {'image': encoded('yellow')}, token)
        with self.server.store.connect() as db:
            db.execute('DELETE FROM users WHERE id=?', (user,))
            self.assertEqual(db.execute('SELECT count(*) FROM background_images WHERE user_id=?', (user,)).fetchone()[0], 0)

    def test_12_verified_backup_restores_accounts(self):
        import importlib.util
        import base64
        import io
        from PIL import Image
        uid = self.server.store.register({'username': 'snapshot_image_user', 'password': 'snapshot-test-password'})
        image = io.BytesIO(); Image.new('RGB', (1600, 900), '#a4bddf').save(image, format='JPEG')
        self.server.store.save_background_image(uid, {'image': 'data:image/jpeg;base64,' + base64.b64encode(image.getvalue()).decode()})
        spec = importlib.util.spec_from_file_location('livo_backup', Path(__file__).resolve().parents[1] / 'tools/livo-backup.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        snapshot = module.backup(self.tmp.name)
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
        with self.server.store.connect() as current, closing(livo.base.sqlite3.connect(snapshot)) as restored:
            self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            for table in ('users', 'checkins', 'notes', 'preferences', 'background_images'):
                self.assertEqual(current.execute('SELECT count(*) FROM ' + table).fetchone()[0], restored.execute('SELECT count(*) FROM ' + table).fetchone()[0])
            self.assertEqual(tuple(current.execute('SELECT image,version FROM background_images WHERE user_id=?', (uid,)).fetchone()), restored.execute('SELECT image,version FROM background_images WHERE user_id=?', (uid,)).fetchone())


    def test_13_standalone_assets_and_private_paths(self):
        for path, fragment in [('/', b'promotion.js'), ('/about', '今天'.encode()), ('/promotion.js', b'toBlob'), ('/about.css', b'font-face')]:
            status, content, headers = self.request(path, raw=True)
            self.assertEqual(status, 200, path)
            self.assertIn(fragment, content)
            self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        for path in ('/../server.py', '/%2e%2e/server.py', '/.env', '/var/checkin.sqlite3', '/fonts/../../server.py'):
            self.assertEqual(self.request(path)[0], 404, path)

    def test_14_claude_preview_is_separate_from_default(self):
        status, current, _ = self.request('/', raw=True)
        self.assertEqual(status, 200)
        status, preview, _ = self.request('/claude', raw=True)
        self.assertEqual(status, 200)
        self.assertNotIn(b'claude-preview.css', current)
        self.assertIn(b'claude-preview.css?v=1', preview)
        self.assertIn(b'noindex,nofollow', preview)
        injection = b'<meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="claude-preview.css?v=1">'
        self.assertEqual(preview.replace(injection, b'', 1), current)
        self.assertEqual(self.request('/claude-preview.css', raw=True)[0], 200)

if __name__ == '__main__':
    unittest.main(verbosity=2)
