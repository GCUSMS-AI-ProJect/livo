#!/usr/bin/env python3
"""Portable Livo entry point. Never seeds or copies existing credentials."""
import argparse
import getpass
import os

def main():
    parser = argparse.ArgumentParser(description='Livo check-in server')
    parser.add_argument('command', choices=['serve', 'init-admin'], nargs='?', default='serve')
    parser.add_argument('--port', type=int, default=int(os.environ.get('LIVO_PORT', '8085')))
    parser.add_argument('--state', default=os.environ.get('LIVO_STATE_DIR'))
    args = parser.parse_args()
    if args.state:
        os.environ['LIVO_STATE_DIR'] = os.path.abspath(args.state)
    from livo.api import Store, make_server, STATE
    state = args.state or STATE
    if args.command == 'init-admin':
        store = Store(state)
        with store.connect() as db:
            if db.execute("SELECT 1 FROM users WHERE role='admin'").fetchone():
                parser.error('Administrator already exists; use the account settings to change its password.')
        username = input('Administrator username or email: ').strip()
        password = getpass.getpass('Password (6–128 characters): ')
        if password != getpass.getpass('Confirm password: '):
            parser.error('Passwords do not match')
        uid = store.register(dict(username=username, password=password))
        with store.connect() as db:
            db.execute("UPDATE users SET role='admin' WHERE id=?", (uid,))
        print('Administrator created. No password was written to disk.')
        return
    with make_server(args.port, state) as server:
        print(f'Livo listening at http://127.0.0.1:{server.server_port}', flush=True)
        server.serve_forever()

if __name__ == '__main__':
    main()
