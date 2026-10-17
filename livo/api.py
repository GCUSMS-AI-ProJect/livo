#!/usr/bin/env python3
"""Private Livo accounts and successful-login geography behind the tunnel."""
import argparse
import base64
import binascii
from datetime import datetime, timedelta
import hmac
import ipaddress
import io
import json
import os
import re
import time
from PIL import Image, UnidentifiedImageError
from urllib.parse import parse_qs, urlsplit
from http.cookies import SimpleCookie, CookieError
from http.server import ThreadingHTTPServer

from . import core as base
from .geo import client_ip, location

STATE = base.STATE
BACKGROUNDS = {'cloud', 'dawn', 'forest', 'sea', 'dusk', 'paper', 'custom'}
IMAGE_LIMIT = 700 * 1024


def login_location(peer, headers, trust_location_headers=False):
    ip = client_ip(peer, headers)
    result = dict(country='', country_code='', region='', city='', ip_mask='', source='unknown')
    if not ip:
        return result
    address = ipaddress.ip_address(ip)
    result['ip_mask'] = '.'.join(ip.split('.')[:2]) + '.*.*' if address.version == 4 else str(ipaddress.ip_network(ip + '/48', strict=False))
    geo = location(ip)
    result.update(country=geo['country'], country_code=geo['countryCode'], region=geo['region'], city=geo['city'])
    if any((result['country'], result['region'], result['city'])):
        result['source'] = 'ip2region'
    code = headers.get('CF-IPCountry', '').upper()
    trusted = ipaddress.ip_address(peer).is_loopback
    if trusted and re.fullmatch('[A-Z]{2}', code) and code not in ('XX', 'T1'):
        if code != result['country_code']:
            result.update(country='', region='', city='', source='cloudflare-country')
        result['country_code'] = code
        # Enable only after Cloudflare's managed transform overwrites these headers.
        if trust_location_headers:
            def value(name):
                raw = headers.get(name, '')[:240]
                try:
                    raw = raw.encode('latin1').decode('utf8')
                except (UnicodeError, ValueError):
                    pass
                return ''.join(c for c in raw if c.isprintable())[:80]
            region, city = value('CF-Region'), value('CF-IPCity')
            if region or city:
                result.update(region=region, city=city, source='cloudflare')
    return result


class Store(base.Store):
    def __init__(self, state=STATE, seed_admin=False):
        super().__init__(state, seed_admin)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS notes (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    day TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY(user_id,day));
                CREATE TABLE IF NOT EXISTS login_events (
                    id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created REAL NOT NULL, country TEXT NOT NULL, country_code TEXT NOT NULL,
                    region TEXT NOT NULL, city TEXT NOT NULL, ip_mask TEXT NOT NULL,
                    source TEXT NOT NULL, browser TEXT NOT NULL, device TEXT NOT NULL, kind TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS login_events_created ON login_events(created);
                CREATE TABLE IF NOT EXISTS preferences (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    background TEXT NOT NULL DEFAULT 'cloud', updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS background_images (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    image BLOB NOT NULL, version TEXT NOT NULL, updated REAL NOT NULL);
            ''')

    def preferences(self, uid):
        with self.connect() as db:
            row = db.execute('SELECT background,updated FROM preferences WHERE user_id=?', (uid,)).fetchone()
            image = db.execute('SELECT version FROM background_images WHERE user_id=?', (uid,)).fetchone()
        return {'background': row['background'] if row else 'cloud', 'background_updated': row['updated'] if row else 0,
                'background_image_version': image['version'] if image else ''}

    def profile(self, user):
        result = super().profile(user)
        if result:
            result.update(self.preferences(user['id']))
        return result

    def save_preferences(self, uid, data):
        background = data.get('background')
        if not isinstance(background, str) or background not in BACKGROUNDS:
            raise base.APIError(400, '请选择一种背景。')
        with self.connect() as db:
            if background == 'custom' and not db.execute('SELECT 1 FROM background_images WHERE user_id=?', (uid,)).fetchone():
                raise base.APIError(400, '请先上传背景图片。')
            db.execute('INSERT INTO preferences VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET background=excluded.background,updated=excluded.updated', (uid, background, time.time()))
        return self.preferences(uid)

    def save_background_image(self, uid, data):
        value = data.get('image')
        if not isinstance(value, str) or not value.startswith('data:image/jpeg;base64,'):
            raise base.APIError(400, '请上传裁剪后的 JPG 图片。')
        try:
            content = base64.b64decode(value.split(',', 1)[1], validate=True)
            if not 0 < len(content) <= IMAGE_LIMIT:
                raise ValueError()
            with Image.open(io.BytesIO(content)) as source:
                if source.format != 'JPEG' or source.size != (1600, 900):
                    raise ValueError()
                source.load()
                clean = source.convert('RGB')
                clean.info.clear()
                # Re-encode pixels only: no filename, EXIF, or untrusted metadata.
                for quality in (85, 78, 68, 56, 44):
                    output = io.BytesIO()
                    clean.save(output, format='JPEG', quality=quality, optimize=True)
                    content = output.getvalue()
                    if len(content) <= IMAGE_LIMIT:
                        break
                if len(content) > IMAGE_LIMIT:
                    raise ValueError()
        except (ValueError, OSError, binascii.Error, UnidentifiedImageError, Image.DecompressionBombError):
            raise base.APIError(400, '图片需为 1600×900 的 JPG，且不超过 700 KB。')
        version, now = base.hashlib.sha256(content).hexdigest()[:24], time.time()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO background_images VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET image=excluded.image,version=excluded.version,updated=excluded.updated', (uid, content, version, now))
            db.execute("INSERT INTO preferences VALUES(?,'custom',?) ON CONFLICT(user_id) DO UPDATE SET background='custom',updated=excluded.updated", (uid, now))
        return self.preferences(uid)

    def remove_background_image(self, uid):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM background_images WHERE user_id=?', (uid,))
            db.execute("UPDATE preferences SET background=CASE WHEN background='custom' THEN 'cloud' ELSE background END,updated=? WHERE user_id=?", (time.time(), uid))
        return self.preferences(uid)

    def register(self, data):
        # Email is an account identifier, not a claim of verified ownership.
        username = data.get('username', '')
        if isinstance(username, str) and re.fullmatch(r'[^\s@]{1,64}@[^\s@]{1,120}\.[A-Za-z]{2,24}', username) and len(username) <= 190:
            uid, now = base.secrets.token_hex(16), time.time()
            hashed = base.password_hash(self.check_password(data.get('password')))
            try:
                with self.connect() as db:
                    db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?)', (uid, username.lower(), username.split('@')[0][:24], hashed, 'user', now, now))
            except base.sqlite3.IntegrityError:
                raise base.APIError(409, '这个账号已经注册。')
            return uid
        return super().register(data)

    def login(self, data):
        username, password = data.get('username'), data.get('password')
        if not isinstance(username, str) or not isinstance(password, str) or len(username) > 190 or len(password) > 128:
            raise base.APIError(400, '请输入账号和密码。')
        with self.connect() as db:
            user = db.execute('SELECT * FROM users WHERE username=?', (username.strip(),)).fetchone()
            valid = base.password_matches(password, user['password_hash'] if user else self.dummy_hash)
            if not user or not valid:
                raise base.APIError(401, '账号或密码不正确。')
            db.execute('UPDATE users SET last_login=? WHERE id=?', (time.time(), user['id']))
        return user['id']

    def calendar(self, uid, month=None):
        result = super().calendar(uid, month)
        result['now'] = time.time()
        with self.connect() as db:
            result['records'] = {r['day']: {'note': r['note'] or ''} for r in db.execute(
                'SELECT c.day,n.note FROM checkins c LEFT JOIN notes n ON n.user_id=c.user_id AND n.day=c.day WHERE c.user_id=? ORDER BY c.day', (uid,))}
        return result

    def note(self, uid, data):
        note, day = data.get('note'), data.get('day')
        if not isinstance(note, str) or len(note) > 500 or day != base.day_at():
            raise base.APIError(400, '只能修改今日记录，最多 500 字。')
        with self.connect() as db:
            if not db.execute('SELECT 1 FROM checkins WHERE user_id=? AND day=?', (uid, day)).fetchone():
                raise base.APIError(400, '请先打卡。')
            db.execute('INSERT INTO notes VALUES(?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET note=excluded.note', (uid, day, note))

    def record_login(self, uid, peer, headers, kind, trust_location_headers=False):
        geo = login_location(peer, headers, trust_location_headers)
        agent = headers.get('User-Agent', '')[:500]
        browser = next((name for marker, name in [('Edg/', 'Edge'), ('OPR/', 'Opera'), ('Firefox/', 'Firefox'), ('Chrome/', 'Chrome'), ('Safari/', 'Safari')] if marker in agent), '其他浏览器')
        device = '移动设备' if re.search('Mobile|Android|iPhone|iPad', agent, re.I) else '电脑'
        now = time.time()
        with self.connect() as db:
            db.execute('DELETE FROM login_events WHERE created<?', (now - 30 * 86400,))
            db.execute('DELETE FROM login_events WHERE id <= COALESCE((SELECT id FROM login_events ORDER BY id DESC LIMIT 1 OFFSET 99998),0)')
            db.execute('INSERT INTO login_events(user_id,created,country,country_code,region,city,ip_mask,source,browser,device,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (uid, now, geo['country'], geo['country_code'], geo['region'], geo['city'], geo['ip_mask'], geo['source'], browser, device, kind))

    def regions(self, days=7, page=1):
        today = datetime.now(base.BEIJING).replace(hour=0, minute=0, second=0, microsecond=0)
        begin = (today - timedelta(days=days - 1)).timestamp()
        with self.connect() as db:
            # Retention is enforced on reads too, including quiet periods.
            db.execute('DELETE FROM login_events WHERE created<?', (time.time() - 30 * 86400,))
            summary = dict(db.execute('SELECT count(*) AS logins,count(DISTINCT user_id) AS users FROM login_events WHERE created>=?', (begin,)).fetchone())
            groups = [dict(r) for r in db.execute('SELECT country,country_code,region,city,count(*) AS count,count(DISTINCT user_id) AS users FROM login_events WHERE created>=? GROUP BY country,country_code,region,city ORDER BY count DESC,country_code,region,city', (begin,))]
            summary['places'] = sum(bool(r['country'] or r['country_code'] or r['region'] or r['city']) for r in groups)
            summary['unknown'] = sum(r['count'] for r in groups if not (r['country'] or r['country_code'] or r['region'] or r['city']))
            pages = max(1, (summary['logins'] + 19) // 20)
            page = min(max(1, page), pages)
            records = [dict(r) for r in db.execute('SELECT e.created,u.username,u.nickname,e.country,e.country_code,e.region,e.city,e.ip_mask,e.source,e.browser,e.device,e.kind FROM login_events e JOIN users u ON u.id=e.user_id WHERE e.created>=? ORDER BY e.created DESC,e.id DESC LIMIT 20 OFFSET ?', (begin, (page - 1) * 20))]
        return dict(summary=summary, regions=groups[:8], other=sum(r['count'] for r in groups[8:]), records=records, days=days, page=page, pages=pages, retention_days=30)


class Handler(base.Handler):
    server_version = 'Livo'

    def cookie_name(self):
        return 'livo_session' if self.headers.get('Host', '').split(':')[0] in ('localhost', '127.0.0.1') else '__Host-livo_session'

    def cookie(self, token='', clear=False):
        return f'{self.cookie_name()}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={0 if clear else base.SESSION_DAYS * 86400}' + ('; Secure' if self.cookie_name().startswith('__Host-') else '')

    def user(self, required=True):
        try:
            cookies = SimpleCookie(self.headers.get('Cookie', ''))
            name = self.cookie_name()
            token = cookies[name].value if name in cookies else ''
        except CookieError:
            token = ''
        user = self.store.session(token)
        if required and not user:
            raise base.APIError(401, '请先登录。')
        return user

    def get(self, head=False):
        parsed = urlsplit(self.path)
        if parsed.path == '/api/background-image':
            uid = self.user()['id']
            with self.store.connect() as db:
                image = db.execute('SELECT image,version FROM background_images WHERE user_id=?', (uid,)).fetchone()
            version = parse_qs(parsed.query).get('v', [None])[0]
            if not image or (version and version != image['version']):
                raise base.APIError(404, '背景图片不存在。')
            self.headers_out(200, 'image/jpeg', len(image['image']))
            if not head:
                self.wfile.write(image['image'])
            return
        if parsed.path == '/api/preferences':
            return self.reply(200, self.store.preferences(self.user()['id']))
        if parsed.path == '/api/health':
            with self.store.connect() as db:
                db.execute('SELECT 1').fetchone()
            return self.reply(200, {'ok': True, 'app': 'Livo', 'version': '1.1.0'})
        if parsed.path == '/api/admin/regions':
            user = self.user()
            if user['role'] != 'admin':
                raise base.APIError(403, '只有管理员可以查看登录来源。')
            query = parse_qs(parsed.query)
            try:
                days, page = int(query.get('days', ['7'])[0]), int(query.get('page', ['1'])[0])
                if days not in (7, 30):
                    raise ValueError()
            except ValueError:
                raise base.APIError(400, '时间范围或页码不正确。')
            return self.reply(200, self.store.regions(days, page))
        if not parsed.path.startswith('/api/'):
            from urllib.parse import unquote
            path = unquote(parsed.path)
            name = {'/': 'index.html', '/about': 'about.html', '/about/': 'about.html', '/claude': 'index.html'}.get(path, path.lstrip('/'))
            target = (base.ROOT / name).resolve()
            if not target.is_relative_to(base.ROOT) or any(part.startswith('.') for part in name.split('/')) or target.suffix not in {'.html', '.css', '.js', '.svg', '.woff2', '.txt', '.png', '.webmanifest'} or not target.is_file():
                raise base.APIError(404, '没有找到这个页面。')
            content = target.read_bytes()
            if path == '/claude':
                content = content.replace(b'</head>', b'<meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="claude-preview.css?v=1"></head>', 1)
            self.headers_out(200, base.mimetypes.guess_type(str(target))[0] or 'application/octet-stream', len(content))
            if not head:
                self.wfile.write(content)
            return
        return super().get(head)

    def post(self):
        allowed = self.server.extra_origins
        if self.headers.get('Origin') not in allowed or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise base.APIError(403, '请从本站提交操作。')
        if self.headers.get_content_type() != 'application/json' or self.headers.get('Transfer-Encoding'):
            raise base.APIError(415, '请求格式不正确。')
        try:
            length = int(self.headers.get('Content-Length', '0'))
            maximum = 1024 * 1024 if urlsplit(self.path).path == '/api/background-image' else 4096
            if not 0 < length <= maximum:
                raise ValueError()
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError()
        except (ValueError, TimeoutError):
            raise base.APIError(400, '请求格式不正确。')
        path = urlsplit(self.path).path
        if path in ('/api/login', '/api/register', '/api/auth'):
            peer = client_ip(self.client_address[0], self.headers) or self.client_address[0]
            bucket = base.hashlib.sha256(peer.encode()).hexdigest()
            self.store.limit('auth:' + bucket, 25)
            registering = path == '/api/register'
            if path == '/api/auth':
                username = data.get('username')
                if not isinstance(username, str) or len(username) > 190:
                    raise base.APIError(400, '请输入用户名或邮箱。')
                data['username'] = username.strip()
                with self.store.connect() as db:
                    registering = not db.execute('SELECT 1 FROM users WHERE username=?', (data['username'],)).fetchone()
            if registering:
                self.store.limit('register:' + bucket, 5, 3600)
                try:
                    uid = self.store.register(data)
                except base.APIError as error:
                    # Two simultaneous first logins must never replace a password.
                    if path != '/api/auth' or error.status != 409:
                        raise
                    uid = self.store.login(data)
                    registering = False
            else:
                uid = self.store.login(data)
            self.store.record_login(uid, self.client_address[0], self.headers, 'register' if registering else 'login', self.server.trust_location_headers)
            token = self.store.issue_session(uid)
            previous = self.user(False)
            if previous:
                with self.store.connect() as db:
                    db.execute('DELETE FROM sessions WHERE token_hash=?', (previous['token_hash'],))
            return self.reply(200, {'user': self.store.profile(self.store.session(token)), 'calendar': self.store.calendar(uid)}, self.cookie(token))
        user = self.user()
        if not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), user['csrf']):
            raise base.APIError(403, '页面已过期，请刷新后重试。')
        if path == '/api/background-image':
            self.store.limit('background-upload:' + user['id'], 20, 3600)
            return self.reply(200, self.store.save_background_image(user['id'], data))
        if path == '/api/background-image/delete':
            self.store.limit('background-delete:' + user['id'], 60)
            return self.reply(200, self.store.remove_background_image(user['id']))
        if path == '/api/note':
            self.store.limit('notes:' + user['id'], 240)
            self.store.note(user['id'], data)
            return self.reply(200, {'ok': True})
        if path == '/api/preferences':
            self.store.limit('preferences:' + user['id'], 60)
            return self.reply(200, self.store.save_preferences(user['id'], data))
        if path == '/api/checkin':
            return self.reply(200, self.store.checkin(user['id']))
        if path == '/api/logout':
            with self.store.connect() as db:
                db.execute('DELETE FROM sessions WHERE token_hash=?', (user['token_hash'],))
            return self.reply(200, {'ok': True}, self.cookie(clear=True))
        if path == '/api/password':
            self.store.limit('password:' + user['id'], 8)
            self.store.change_password(user, data)
            return self.reply(200, {'ok': True})
        raise base.APIError(404, '没有找到这个接口。')


def make_server(port=8085, state=STATE, seed_admin=False):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.store = Store(state, seed_admin)
    server.extra_origins = {f'http://{host}:{server.server_port}' for host in ('localhost', '127.0.0.1')} | set(filter(None, os.environ.get('LIVO_ORIGINS', '').split(',')))
    server.trust_location_headers = os.environ.get('LIVO_CF_LOCATION_HEADERS') == '1'
    return server
