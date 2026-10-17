#!/usr/bin/env python3
"""Small, account-based daily celebration. Standard library only."""
import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1] / 'web'
STATE = Path(os.environ.get('LIVO_STATE_DIR', str(ROOT.parent / 'var')))
BEIJING = timezone(timedelta(hours=8))
SESSION_DAYS = 30
COOKIE = '__Host-day_session'
LOCAL_COOKIE = 'day_session'


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def day_at(timestamp=None):
    return datetime.fromtimestamp(time.time() if timestamp is None else timestamp, BEIJING).date().isoformat()


def password_hash(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 300000).hex()
    return f'pbkdf2-sha256$300000${salt}${digest}'


def password_matches(password, stored):
    try:
        algo, rounds, salt, digest = stored.split('$')
        if algo != 'pbkdf2-sha256' or not 100000 <= int(rounds) <= 1000000:
            return False
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(rounds)).hex()
        return hmac.compare_digest(actual, digest)
    except (ValueError, TypeError):
        return False


class Connection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Store:
    def __init__(self, state=STATE, seed_admin=False):
        self.state = Path(state).resolve()
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.db = self.state / 'checkin.sqlite3'
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
                    nickname TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
                    created REAL NOT NULL, last_login REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    csrf TEXT NOT NULL, expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS checkins (
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    day TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(user_id,day));
                CREATE INDEX IF NOT EXISTS checkins_day ON checkins(day);
                CREATE TABLE IF NOT EXISTS attempts (bucket TEXT NOT NULL, created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS attempts_bucket ON attempts(bucket,created);
            ''')
        self.db.chmod(0o600)
        # Timing work on nonexistent accounts is comparable to a failed password.
        self.dummy_hash = password_hash(secrets.token_urlsafe(32))
        if seed_admin:
            self.bootstrap()

    def connect(self):
        db = sqlite3.connect(self.db, timeout=15, factory=Connection)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def bootstrap(self):
        raise RuntimeError('Use server.py init-admin to create an administrator explicitly.')

    def limit(self, bucket, maximum, period=900):
        now = time.time()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM attempts WHERE created<?', (now - 86400,))
            if db.execute('SELECT count(*) FROM attempts WHERE bucket=? AND created>?', (bucket, now - period)).fetchone()[0] >= maximum:
                raise APIError(429, '操作有点频繁，请稍后再试。')
            db.execute('INSERT INTO attempts VALUES(?,?)', (bucket, now))

    @staticmethod
    def check_password(value):
        if not isinstance(value, str) or not 6 <= len(value) <= 128:
            raise APIError(400, '密码需为 6–128 个字符。')
        return value

    def register(self, data):
        username = data.get('username', '')
        nickname = data.get('nickname', '')
        if not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9_]{3,32}', username):
            raise APIError(400, '账号需为 3–32 位字母、数字或下划线。')
        if not isinstance(nickname, str) or len(nickname.strip()) > 24:
            raise APIError(400, '昵称最多 24 个字符。')
        hashed = password_hash(self.check_password(data.get('password')))
        uid, now = secrets.token_hex(16), time.time()
        try:
            with self.connect() as db:
                db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?)', (uid, username, nickname.strip() or username, hashed, 'user', now, now))
        except sqlite3.IntegrityError:
            raise APIError(409, '这个账号已经有人用了，换一个试试。')
        return uid

    def login(self, data):
        username, password = data.get('username'), data.get('password')
        if not isinstance(username, str) or not isinstance(password, str) or len(username) > 32 or len(password) > 128:
            raise APIError(400, '请输入账号和密码。')
        with self.connect() as db:
            user = db.execute('SELECT * FROM users WHERE username=?', (username.strip(),)).fetchone()
            valid = password_matches(password, user['password_hash'] if user else self.dummy_hash)
            if not user or not valid:
                raise APIError(401, '账号或密码不正确。')
            db.execute('UPDATE users SET last_login=? WHERE id=?', (time.time(), user['id']))
        return user['id']

    def issue_session(self, uid):
        token, csrf, now = secrets.token_urlsafe(32), secrets.token_urlsafe(24), time.time()
        with self.connect() as db:
            db.execute('DELETE FROM sessions WHERE expires<?', (now,))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), uid, csrf, now + SESSION_DAYS * 86400))
        return token

    def session(self, token):
        if not token or len(token) > 100:
            return None
        with self.connect() as db:
            return db.execute('SELECT u.id,u.username,u.nickname,u.role,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?', (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()

    def profile(self, user):
        if not user:
            return None
        return {k: user[k] for k in ('id', 'username', 'nickname', 'role', 'csrf')}

    def calendar(self, uid, month=None):
        today = day_at()
        month = month or today[:7]
        try:
            parsed = datetime.strptime(month, '%Y-%m')
            if parsed.year < 2000 or parsed.year > 2100:
                raise ValueError()
        except (ValueError, TypeError):
            raise APIError(400, '月份格式不正确。')
        with self.connect() as db:
            days = [r[0] for r in db.execute('SELECT day FROM checkins WHERE user_id=? AND day LIKE ? ORDER BY day', (uid, month + '-%'))]
            total = db.execute('SELECT count(*) FROM checkins WHERE user_id=?', (uid,)).fetchone()[0]
            checked = db.execute('SELECT 1 FROM checkins WHERE user_id=? AND day=?', (uid, today)).fetchone() is not None
        return {'today': today, 'month': month, 'days': days, 'total': total, 'checked': checked}

    def checkin(self, uid):
        # The local day is computed by the server; no client-supplied dates.
        today = day_at()
        with self.connect() as db:
            inserted = db.execute('INSERT OR IGNORE INTO checkins VALUES(?,?,?)', (uid, today, time.time())).rowcount == 1
        return {'created': inserted, **self.calendar(uid)}

    def change_password(self, user, data):
        old = data.get('current', '')
        if not isinstance(old, str) or len(old) > 128:
            raise APIError(400, '请输入当前密码。')
        new = self.check_password(data.get('password'))
        with self.connect() as db:
            row = db.execute('SELECT password_hash FROM users WHERE id=?', (user['id'],)).fetchone()
            if not password_matches(old, row[0]):
                raise APIError(400, '当前密码不正确。')
            db.execute('UPDATE users SET password_hash=? WHERE id=?', (password_hash(new), user['id']))
            db.execute('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', (user['id'], user['token_hash']))

    def analytics(self, page=1, search=''):
        today = datetime.now(BEIJING).date()
        start = (today - timedelta(days=29)).isoformat()
        begin = datetime.combine(today, datetime.min.time(), BEIJING).timestamp()
        with self.connect() as db:
            total = db.execute('SELECT count(*) FROM users').fetchone()[0]
            new = db.execute('SELECT count(*) FROM users WHERE created>=?', (begin,)).fetchone()[0]
            checked = db.execute('SELECT count(*) FROM checkins WHERE day=?', (today.isoformat(),)).fetchone()[0]
            recent = db.execute('SELECT count(DISTINCT user_id) FROM checkins WHERE day>=?', ((today - timedelta(days=6)).isoformat(),)).fetchone()[0]
            cumulative = db.execute('SELECT count(*) FROM checkins').fetchone()[0]
            counts = {r[0]: r[1] for r in db.execute('SELECT day,count(*) FROM checkins WHERE day>=? GROUP BY day', (start,))}
            registrations = {r[0]: r[1] for r in db.execute("SELECT date(created,'unixepoch','+8 hours'),count(*) FROM users WHERE created>=? GROUP BY 1", (begin - 29 * 86400,))}
            returning = db.execute('SELECT count(*) FROM checkins c WHERE c.day=? AND EXISTS(SELECT 1 FROM checkins old WHERE old.user_id=c.user_id AND old.day<c.day)', (today.isoformat(),)).fetchone()[0]
            retention = {}
            # A cohort matures only after the target Beijing day has ended.
            for gap in (1, 7):
                row = db.execute("""SELECT count(*),coalesce(sum(EXISTS(SELECT 1 FROM checkins c WHERE c.user_id=u.id AND c.day=date(u.created,'unixepoch','+8 hours',?))),0)
                    FROM users u WHERE date(u.created,'unixepoch','+8 hours',?)<?""", (f'+{gap} days', f'+{gap} days', today.isoformat())).fetchone()
                retention[str(gap)] = {'eligible': row[0], 'returned': row[1], 'rate': round(row[1] / row[0] * 100, 1) if row[0] else None}
            match = '%' + search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
            condition = "u.username LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\'"
            filtered = db.execute('SELECT count(*) FROM users u WHERE ' + condition, (match, match)).fetchone()[0]
            pages = max(1, (filtered + 19) // 20)
            page = min(max(1, page), pages)
            users = [dict(row) for row in db.execute('SELECT u.id,u.username,u.nickname,u.role,u.created,u.last_login,(SELECT count(*) FROM checkins c WHERE c.user_id=u.id) AS total,(SELECT max(day) FROM checkins c WHERE c.user_id=u.id) AS last_day FROM users u WHERE ' + condition + ' ORDER BY u.created DESC,u.id LIMIT 20 OFFSET ?', (match, match, (page - 1) * 20))]
        trend = []
        for offset in range(29, -1, -1):
            day = (today - timedelta(days=offset)).isoformat()
            trend.append({'day': day, 'checkins': counts.get(day, 0), 'registrations': registrations.get(day, 0)})
        return {'today': today.isoformat(), 'users': total, 'new_users': new, 'checked_today': checked, 'active_7d': recent, 'total_checkins': cumulative, 'returning_today': returning, 'retention': retention, 'trend': trend, 'members': users, 'page': page, 'pages': pages, 'filtered': filtered}


class Handler(BaseHTTPRequestHandler):
    server_version = 'Day'

    def log_message(self, *args):
        pass

    @property
    def store(self):
        return self.server.store

    def headers_out(self, status, kind, length, cookie=None, cache='no-store'):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()

    def reply(self, status, value, cookie=None):
        blob = json.dumps(value, ensure_ascii=False).encode()
        self.headers_out(status, 'application/json; charset=utf-8', len(blob), cookie)
        self.wfile.write(blob)

    def cookie(self, token='', clear=False):
        secure = self.headers.get('Host', '').split(':')[0] not in ('localhost', '127.0.0.1')
        name = COOKIE if secure else LOCAL_COOKIE
        return f'{name}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={0 if clear else SESSION_DAYS * 86400}' + ('; Secure' if secure else '')

    def user(self, required=True):
        try:
            cookies = SimpleCookie(self.headers.get('Cookie', ''))
            secure = self.headers.get('Host', '').split(':')[0] not in ('localhost', '127.0.0.1')
            name = COOKIE if secure else LOCAL_COOKIE
            token = cookies[name].value if name in cookies else ''
        except CookieError:
            token = ''
        user = self.store.session(token)
        if required and not user:
            raise APIError(401, '请先登录，再为今天留个记号。')
        return user

    def get(self, head=False):
        parsed = urlsplit(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        if path == '/api/session':
            user = self.user(False)
            return self.reply(200, {'user': self.store.profile(user), 'today': day_at(), 'calendar': self.store.calendar(user['id']) if user else None})
        if path == '/api/calendar':
            user = self.user()
            return self.reply(200, self.store.calendar(user['id'], query.get('month', [None])[0]))
        if path == '/api/admin':
            user = self.user()
            if user['role'] != 'admin':
                raise APIError(403, '只有管理员可以查看汇总数据。')
            try:
                page = int(query.get('page', ['1'])[0])
            except ValueError:
                raise APIError(400, '页码格式不正确。')
            return self.reply(200, self.store.analytics(page, query.get('q', [''])[0][:64]))
        if path == '/api/health':
            return self.reply(200, {'ok': True, 'app': 'daily-celebration'})
        files = {'/': 'index.html', '/index.html': 'index.html', '/assets/day.css': 'assets/day.css', '/assets/day.js': 'assets/day.js', '/assets/day-mark.svg': 'assets/day-mark.svg'}
        target = files.get(path)
        if not target:
            raise APIError(404, '没有找到这个页面。')
        data = (self.server.root / target).read_bytes()
        kind = mimetypes.guess_type(target)[0] or 'application/octet-stream'
        if kind.startswith('text/') or target.endswith('.js'):
            kind += '; charset=utf-8'
        self.headers_out(200, kind, len(data), cache='no-cache')
        if not head:
            self.wfile.write(data)

    def post(self):
        origin = self.headers.get('Origin', '')
        allowed = self.server.extra_origins
        if origin not in allowed or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise APIError(403, '请从本站提交操作。')
        if self.headers.get_content_type() != 'application/json' or self.headers.get('Transfer-Encoding'):
            raise APIError(415, '请求格式不正确。')
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096:
                raise ValueError()
            self.connection.settimeout(10)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError()
        except (ValueError, TimeoutError):
            raise APIError(400, '请求格式不正确。')
        path = urlsplit(self.path).path
        if path in ('/api/login', '/api/register'):
            peer = self.client_address[0]
            if peer in ('127.0.0.1', '::1'):
                peer = self.headers.get('CF-Connecting-IP', peer)
            bucket = hashlib.sha256(peer.encode()).hexdigest()
            self.store.limit('auth:' + bucket, 25)
            if path == '/api/register':
                self.store.limit('register:' + bucket, 5, 3600)
                uid = self.store.register(data)
            else:
                uid = self.store.login(data)
            token = self.store.issue_session(uid)
            user = self.store.session(token)
            # Replace an existing local session instead of leaving it active.
            previous = self.user(False)
            if previous:
                with self.store.connect() as db:
                    db.execute('DELETE FROM sessions WHERE token_hash=?', (previous['token_hash'],))
            return self.reply(200, {'user': self.store.profile(user), 'today': day_at(), 'calendar': self.store.calendar(uid)}, self.cookie(token))
        user = self.user()
        if not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), user['csrf']):
            raise APIError(403, '页面已过期，请刷新后重试。')
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
        raise APIError(404, '没有找到这个接口。')

    def dispatch(self, action):
        try:
            action()
        except APIError as exc:
            self.reply(exc.status, {'error': exc.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            # Exception details must never expose credentials or private DB paths.
            import traceback
            traceback.print_exc()
            self.reply(500, {'error': '暂时没有保存成功，请稍后重试。'})

    def do_GET(self):
        self.dispatch(self.get)

    def do_HEAD(self):
        self.dispatch(lambda: self.get(True))

    def do_POST(self):
        self.dispatch(self.post)
