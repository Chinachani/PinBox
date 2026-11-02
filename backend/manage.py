"""PinBox setup CLI. No inventory database is opened by these commands."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sys

import access


_KEYS = ('PINBOX_DEPLOYMENT_MODE', 'PINBOX_API_TOKEN')


def _env_read(path):
    raw = access.read_private(path) or ''
    values = {}
    for line in raw.splitlines():
        match = re.match(r'^\s*(?:export\s+)?(PINBOX_DEPLOYMENT_MODE|PINBOX_API_TOKEN)\s*=\s*(.*?)\s*$', line)
        if not match:
            continue
        key, value = match.groups()
        if key in values:
            raise access.AccessError(f'Duplicate {key} in environment file; resolve it before continuing.')
        if value.startswith(('"', "'")):
            quote = value[0]
            closing = value.find(quote, 1)
            if closing < 0 or (value[closing + 1:].strip() and not value[closing + 1:].strip().startswith('#')):
                raise access.AccessError(f'Unsupported quoted {key}; use a single-line literal value.')
            value = value[1:closing]
        else:
            value = re.split(r'\s+#', value, 1)[0].strip()
        if any(ch.isspace() for ch in value) or any(ch in value for ch in '$\\\r\n\"\''):
            raise access.AccessError(f'Unsupported {key}; use a literal value without whitespace or interpolation.')
        values[key] = value
    return raw, values


def _env_result(path, mode=None, reset=False):
    if os.path.abspath(path) == os.path.abspath(access.config_path()):
        raise access.AccessError('The Compose .env and access.json must be different files.')
    with access.locked(path):
        raw, values = _env_read(path)
        old = values.get('PINBOX_API_TOKEN', '')
        inherited = os.environ.get('PINBOX_API_TOKEN', '')
        if inherited and ((old and inherited != old) or (reset and not old)):
            raise access.AccessError('Current PINBOX_API_TOKEN differs from --env-file; unset the shell override before configuring this deployment.')
        saved_token = ''
        if not old and not inherited and access.config_path().exists():
            with access.locked(access.config_path()):
                saved = access._read()
                if saved and saved['mode'] == 'shared':
                    saved_token = saved.get('token', '')
        existing_mode = values.get('PINBOX_DEPLOYMENT_MODE') or 'shared'
        access._mode(existing_mode)
        if mode is None and not reset:
            token = old or inherited or saved_token
            return {'mode': existing_mode, 'token': token, 'created': False, 'source': 'env-file', 'path': str(path)}
        mode = access._mode(mode or existing_mode)
        inherited_mode = os.environ.get('PINBOX_DEPLOYMENT_MODE')
        if inherited_mode and inherited_mode != mode:
            raise access.AccessError('PINBOX_DEPLOYMENT_MODE overrides the requested mode; unset it before setup.')
        if mode == 'standalone' and inherited:
            raise access.AccessError('Remove the environment PINBOX_API_TOKEN before choosing standalone mode.')
        if reset and mode != 'shared':
            raise access.AccessError('Token reset applies only to shared mode.')
        token = old or inherited or saved_token
        generated = mode == 'shared' and (reset or not token)
        if generated:
            token = secrets.token_urlsafe(36)
        if mode == 'standalone':
            token = ''
        if any(ch.isspace() for ch in token) or any(ch in token for ch in '$\\\"\''):
            raise access.AccessError('The existing key cannot be safely serialized to Compose .env; configure a literal key without whitespace, quotes, backslashes or interpolation.')
        updates = {'PINBOX_DEPLOYMENT_MODE': mode, 'PINBOX_API_TOKEN': token}
        lines = []
        for line in raw.splitlines(keepends=True):
            match = re.match(r'^\s*(?:export\s+)?(PINBOX_DEPLOYMENT_MODE|PINBOX_API_TOKEN)\s*=', line)
            if match:
                key = match.group(1)
                # Quote literals so Compose cannot treat punctuation as comments.
                comment = re.search(r'\s+(#.*)$', line.rstrip('\r\n'))
                suffix = ' ' + comment.group(1) if comment else ''
                lines.append(f"{key}='{updates.pop(key)}'{suffix}\n")
            else:
                lines.append(line)
        text = ''.join(lines)
        if text and not text.endswith('\n'):
            text += '\n'
        for key, value in updates.items():
            text += f"{key}='{value}'\n"
        if reset:
            # Keep a formerly active file key from resurfacing if .env is lost.
            # Update the fallback first: the old environment remains active until restart.
            with access.locked(access.config_path()):
                saved = access._read()
                if saved and saved.get('token'):
                    saved['token'] = token
                    access.write_private(access.config_path(), json.dumps(saved, indent=2) + '\n')
                access.write_private(path, text)
        else:
            access.write_private(path, text)
        return {'mode': mode, 'token': token, 'created': generated, 'source': 'env-file', 'path': str(path)}


def _result(args, mode=None, reset=False):
    if args.env_file:
        return _env_result(Path(args.env_file).absolute(), mode, reset)
    return access.configure(mode, reset) if mode else access.current()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Configure PinBox without changing inventory.')
    commands = parser.add_subparsers(dest='command', required=True)
    setup = commands.add_parser('setup')
    setup.add_argument('--mode', choices=('standalone', 'shared'), required=True)
    setup.add_argument('--show-token', action='store_true', help='Explicitly reveal the connection key.')
    status = commands.add_parser('status')
    token = commands.add_parser('token')
    actions = token.add_subparsers(dest='action', required=True)
    show = actions.add_parser('show')
    reset = actions.add_parser('reset')
    reset.add_argument('--yes', action='store_true', help='Confirm all other devices must reconnect.')
    for sub in (setup, status, show, reset):
        sub.add_argument('--env-file', help='Docker Compose .env file to inspect or update.')
        sub.add_argument('--json', action='store_true', help='Output metadata only; never a secret.')
    args = parser.parse_args(argv)
    try:
        if args.command == 'setup':
            result = _result(args, args.mode)
        elif args.command == 'token' and args.action == 'reset':
            if not args.yes:
                raise access.AccessError('Reset disconnects other devices. Repeat with --yes to confirm.')
            result = _result(args, mode='shared', reset=True)
        else:
            result = _result(args)
        reveal = args.command == 'token' and args.action == 'show'
        reveal = reveal or (args.command == 'setup' and (args.show_token or (result.get('created') and sys.stdin.isatty() and sys.stdout.isatty())))
        metadata = {key: value for key, value in result.items() if key != 'token'}
        metadata.update(auth_enabled=bool(result['token']), configured=True)
        metadata.setdefault('path', str(access.config_path()))
        if args.json:
            print(json.dumps(metadata))
        elif reveal:
            if not result['token']:
                raise access.AccessError('No connection key is configured for this deployment.')
            print(result['token'])
        else:
            print(f"Mode: {result['mode']}\nAuthentication: {'enabled' if result['token'] else 'disabled (local only)'}\nConfiguration: {metadata['path']}")
            if args.command == 'token' and args.action == 'reset':
                print('Connection key reset. Restart/recreate the service and reconnect all devices; use token show to reveal it.')
                if args.env_file and os.environ.get('PINBOX_API_TOKEN'):
                    print('The current process still has the old environment key. Unset the shell override before recreating the service.')
        return 0
    except (access.AccessError, OSError, UnicodeError) as exc:
        print(f'PinBox setup failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
