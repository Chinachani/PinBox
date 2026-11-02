"""Private access configuration, independent of inventory initialization."""
import json
import os
from pathlib import Path
import secrets
import stat
import sys
import tempfile
from contextlib import contextmanager

import database


class AccessError(RuntimeError):
    pass


def _mode(value):
    if value not in ('standalone', 'shared'):
        raise AccessError('Deployment mode must be standalone or shared.')
    return value


def config_path():
    return Path(database.DB_DIR) / 'access.json'


def _check(path):
    path = Path(path)
    # Credential and lock files must never follow symlinks, including parents.
    for item in (path, *path.parents):
        if item.is_symlink():
            raise AccessError(f'Refusing symlink in credential path: {item}')
    if path.exists():
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise AccessError(f'Credential path is not a private regular file: {path}')
    return path


@contextmanager
def locked(path):
    path = _check(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = _check(str(path) + '.lock')
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(lock_path, flags, 0o600)
    try:
        info = os.fstat(fd)
        current_info = _check(lock_path).stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_dev, info.st_ino) != (current_info.st_dev, current_info.st_ino):
            raise AccessError('Credential lock is not a private regular file.')
        if os.name == 'nt':
            import msvcrt
            if os.fstat(fd).st_size == 0:
                os.write(fd, b'0')
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        info = os.fstat(fd)
        current_info = _check(lock_path).stat()
        if (info.st_dev, info.st_ino) != (current_info.st_dev, current_info.st_ino):
            raise AccessError('Credential lock changed during configuration.')
        _check(path)
        yield path
    finally:
        os.close(fd)


def read_private(path):
    path = _check(path)
    if not path.exists():
        return None
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'r', encoding='utf-8') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise AccessError('Credential configuration must be a regular private file.')
        if info.st_size > 1024 * 1024:
            raise AccessError('Credential configuration is too large.')
        return stream.read()


def write_private(path, text):
    path = _check(path)
    if path.exists() and not path.stat().st_mode & 0o222:
        raise AccessError(f'Credential configuration is read-only: {path}')
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            os.chmod(name, 0o600)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        _check(path)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _read():
    raw = read_private(config_path())
    if raw is None:
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get('version') != 1:
            raise ValueError()
        _mode(data.get('mode'))
        token = data.get('token', '')
        if not isinstance(token, str) or any(ch.isspace() for ch in token):
            raise ValueError()
        return data
    except (ValueError, TypeError) as exc:
        raise AccessError('Invalid access.json; refusing to disable authentication. Restore or repair the private configuration.') from exc


def _effective(data, default_mode='shared'):
    mode = _mode(os.environ.get('PINBOX_DEPLOYMENT_MODE') or (data or {}).get('mode') or default_mode)
    env_token = os.environ.get('PINBOX_API_TOKEN', '')
    token = env_token or ((data or {}).get('token', '') if mode == 'shared' else '')
    return {'mode': mode, 'token': token, 'source': 'environment' if env_token else ('file' if token else 'none')}


def initialize(default_mode='shared'):
    _mode(default_mode)
    with locked(config_path()):
        data = _read()
        if data is not None:
            os.chmod(config_path(), 0o600)
        result = _effective(data, default_mode)
        created = data is None
        if data is None:
            data = {'version': 1, 'mode': result['mode'], 'token': ''}
        generated = result['mode'] == 'shared' and not result['token']
        if generated:
            data['token'] = secrets.token_urlsafe(36)
        if created or generated:
            write_private(config_path(), json.dumps(data, indent=2) + '\n')
        result = _effective(data, default_mode)
        result['created'] = generated
        return result


def current():
    if not config_path().exists():
        return initialize(default_mode="standalone" if getattr(sys, "frozen", False) else "shared")
    with locked(config_path()):
        data = _read()
        if data is None:
            raise AccessError('Access configuration is not initialized.')
        result = _effective(data)
        if result['mode'] == 'shared' and not result['token']:
            raise AccessError('Shared mode requires an initialized connection key. Restart or run setup.')
        result['created'] = False
        return result


def status():
    result = current()
    return {'configured': True, 'mode': result['mode'], 'auth_enabled': bool(result['token']),
            'source': result['source'], 'path': str(config_path())}


def configure(mode, reset=False):
    mode = _mode(mode)
    env_mode = os.environ.get('PINBOX_DEPLOYMENT_MODE')
    if env_mode and env_mode != mode:
        raise AccessError('PINBOX_DEPLOYMENT_MODE overrides this setting; change the service environment first.')
    if reset and os.environ.get('PINBOX_API_TOKEN'):
        raise AccessError('PINBOX_API_TOKEN is provided by the environment. Use --env-file or change the service environment and restart.')
    if mode == 'standalone' and os.environ.get('PINBOX_API_TOKEN'):
        raise AccessError('Remove PINBOX_API_TOKEN from the service environment before selecting standalone mode.')
    with locked(config_path()):
        data = _read() or {'version': 1, 'token': ''}
        data['mode'] = mode
        created = False
        if mode == 'shared' and not os.environ.get('PINBOX_API_TOKEN') and (reset or not data.get('token')):
            data['token'] = secrets.token_urlsafe(36)
            created = True
        write_private(config_path(), json.dumps(data, indent=2) + '\n')
        result = _effective(data)
        result['created'] = created
        return result
