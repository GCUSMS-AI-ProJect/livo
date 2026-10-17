#!/usr/bin/env python3
"""Consistent private SQLite backups; optionally preserve files before a release."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

STATE = Path(os.environ.get('LIVO_STATE_DIR', str(Path(__file__).resolve().parents[1] / 'var')))


def backup(state=STATE, release=False):
    state = Path(state)
    destination = state / 'backups'
    destination.mkdir(mode=0o700, exist_ok=True)
    destination.chmod(0o700)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = destination / (('release-' if release else 'daily-') + stamp + '.sqlite3')
    fd, temporary = tempfile.mkstemp(prefix='.backup-', dir=destination)
    os.close(fd)
    try:
        with closing(sqlite3.connect((state / 'checkin.sqlite3').as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(temporary)) as output:
            source.backup(output)
            if output.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup integrity check failed')
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    if release:
        archive = destination / ('release-' + stamp)
        archive.mkdir(mode=0o700)
        root = Path(__file__).resolve().parents[1]
        for name in ('web', 'livo', 'ip2region'):
            shutil.copytree(root / name, archive / name, ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(root / 'server.py', archive / 'server.py')
    # Only this script's dated daily snapshots are rotated. Release backups stay.
    daily = sorted(p for p in destination.glob('daily-*.sqlite3') if p.is_file() and not p.is_symlink())
    for old in daily[:-14]:
        old.unlink()
    print(f'Verified private backup: {target}')
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', action='store_true')
    args = parser.parse_args()
    backup(release=args.release)
