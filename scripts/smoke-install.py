"""Exercise the real Docker installer with disposable files, ports and inventory."""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import urllib.error
import urllib.request
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    workspace = Path(tempfile.mkdtemp(prefix='pinbox-install-smoke-'))
    name = 'pinbox-smoke-' + uuid4().hex[:12]
    image = name + ':test'
    env = {key: value for key, value in os.environ.items() if not key.startswith('PINBOX_')}
    env.update(PINBOX_IMAGE=image, COMPOSE_PROJECT_NAME=name)
    port, tls_port = free_port(), free_port()
    for directory in ('backend', 'frontend'):
        shutil.copytree(ROOT / directory, workspace / directory, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for filename in ('Dockerfile', '.dockerignore', 'docker-compose.yml', 'package.json', 'init_data.py', 'update_use_cases.py', 'install.sh'):
        shutil.copy(ROOT / filename, workspace / filename)
    compose = workspace / 'docker-compose.yml'
    compose.write_text(compose.read_text().replace('container_name: lcsc-stock-mobile', 'container_name: ' + name)
                       .replace('"8088:8088"', f'"127.0.0.1:{port}:8088"')
                       .replace('"8089:8089"', f'"127.0.0.1:{tls_port}:8089"'))

    def run(*args):
        result = subprocess.run(args, cwd=workspace, env=env, capture_output=True, text=True, timeout=900)
        if result.returncode:
            # Keep diagnostics private: never echo a CLI buffer that may contain credentials.
            log = workspace / 'failure.log'
            log.write_text(result.stdout + result.stderr)
            log.chmod(0o600)
            raise RuntimeError('Installer smoke command failed; private diagnostics: ' + str(log))
        return result.stdout + result.stderr

    def read_key():
        text = (workspace / '.env').read_text()
        match = re.search(r"^PINBOX_API_TOKEN='([^']+)'$", text, re.M)
        assert match and len(match[1]) >= 40
        return match[1]

    def request(path, token='', body=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(f'http://127.0.0.1:{port}' + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    success = False
    try:
        output = run('sh', 'install.sh')
        key = read_key()  # A normal Docker-group user must be able to read Compose's .env.
        assert key not in output
        if os.name != 'nt':
            assert (workspace / '.env').stat().st_uid == os.getuid()
            assert (workspace / '.env').stat().st_mode & 0o777 == 0o600
        assert request('/api/instance')[1]['auth_required'] is True
        assert request('/api/stats')[0] == 401
        assert request('/api/materials', key, {'code': 'C123', 'model': 'SMOKE-ONLY', 'quantity': 7})[0] == 200
        before = request('/api/backup', key)[1]
        assert key not in run('sh', 'install.sh', 'update')
        assert read_key() == key
        assert request('/api/materials/C123', key)[1]['quantity'] == 7
        output = run('sh', 'install.sh', 'token', 'reset', '--yes')
        new_key = read_key()
        assert new_key != key and key not in output and new_key not in output
        assert request('/api/stats', key)[0] == 401
        after = request('/api/backup', new_key)[1]
        for field in ('materials', 'stock_logs', 'locations', 'dataset_id', 'import_receipts'):
            assert before.get(field) == after.get(field), field
        assert new_key not in run('sh', 'install.sh', 'status')
        success = True
        print('Docker installer smoke passed: private key generation, user-owned config, authenticated startup, update persistence, key reset, unchanged inventory.')
    finally:
        subprocess.run(['docker', 'compose', 'down', '--volumes', '--remove-orphans'], cwd=workspace, env=env, capture_output=True)
        # Only the disposable data/certs mounts may contain root-owned files.
        subprocess.run(['docker', 'run', '--rm', '--entrypoint', 'python', '-v', str(workspace) + ':/cleanup', image,
                        '-c', 'import shutil; [shutil.rmtree("/cleanup/"+n, ignore_errors=True) for n in ("data", "certs")]'],
                       env=env, capture_output=True)
        if success:
            shutil.rmtree(workspace)


if __name__ == '__main__':
    main()
