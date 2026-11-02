"""Deploy a committed release without copying inventory or credentials into the image.

The remote service is stopped only after the new image has built successfully.
Private credentials, before/after snapshots and the deployment log stay ignored.
"""
import hashlib
import json
import os
import secrets
import shlex
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOST = 'root@192.168.1.219'
APP = '/mnt/data_sdc1/lcsc-stock-mobile'
BASE = 'http://192.168.1.219:8088'
PRIVATE = ROOT / '.deployment'


def run(*args, capture=False):
    return subprocess.run(args, check=True, cwd=ROOT, text=True, stdout=subprocess.PIPE if capture else None).stdout


def ssh(command, capture=False):
    return run('ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, command, capture=capture)


def private_write(path, content):
    path.write_text(content)
    path.chmod(0o600)


def request(path, token):
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=headers), timeout=20) as response:
        return json.load(response)


def business(snapshot):
    data = {k: snapshot.get(k) for k in ['materials', 'stock_logs', 'locations', 'dataset_id', 'import_receipts']}
    # v1.0.22 adds nullable historical cost, without changing historical transactions.
    data['stock_logs'] = [{k: v for k, v in row.items() if k != 'unit_price' or v is not None} for row in data['stock_logs']]
    for key in ['materials', 'stock_logs', 'locations', 'import_receipts']:
        data[key] = sorted(data[key], key=lambda row: json.dumps(row, sort_keys=True))
    return data


def main():
    os.umask(0o077)
    if run('git', 'status', '--porcelain', capture=True).strip():
        raise SystemExit('Commit all reviewed changes before deployment; untracked data must remain ignored.')
    commit = run('git', 'rev-parse', 'HEAD', capture=True).strip()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    image = f'pinbox:{version}-{commit[:12]}'
    stage = f'/mnt/data_sdc1/pinbox-releases/{commit}'
    PRIVATE.mkdir(mode=0o700, exist_ok=True)
    archive = PRIVATE / f'release-{commit[:12]}.tar'
    run('git', 'archive', '--format=tar', '-o', str(archive), commit)
    ssh(f'mkdir -p {stage}/source && chmod 700 {stage}')
    run('scp', '-q', str(archive), f'{HOST}:{stage}/source.tar')
    ssh(f'tar -xf {stage}/source.tar -C {stage}/source && docker build -t {image} {stage}/source')

    old_env = ssh(f'if [ -f {APP}/.env ]; then cat {APP}/.env; fi', capture=True)
    env = dict(line.split('=', 1) for line in old_env.splitlines() if '=' in line and not line.startswith('#'))
    old_token = env.get('PINBOX_API_TOKEN', '').strip('"\'')
    if not old_token:
        # Preserve a token supplied through the existing container rather than a file.
        old_token = ssh("docker exec lcsc-stock-mobile python -c 'import os;print(os.getenv(\"PINBOX_API_TOKEN\",\"\"))'", capture=True).strip()
    request('/api/stats', old_token)  # Verify access before any service changes.
    env['PINBOX_API_TOKEN'] = old_token or secrets.token_urlsafe(36)
    env['PINBOX_IMAGE'] = image
    env.setdefault('PINBOX_ALLOWED_ORIGINS', 'http://127.0.0.1:8088,http://localhost:8088')
    private_write(PRIVATE / '219.env', ''.join(f'{k}={v}\n' for k, v in env.items()))
    run('scp', '-q', str(PRIVATE / '219.env'), f'{HOST}:{stage}/release.env')
    backup = f'/mnt/data_sdc1/pinbox-deploy-backups/before-{version}-{time.strftime("%Y%m%d-%H%M%S")}.tar.gz'
    # No database restore/reset is performed. Even on failure, preserve the live data.
    command = f'''set -eu
umask 077
mkdir -p /mnt/data_sdc1/pinbox-deploy-backups
docker stop lcsc-stock-mobile >/dev/null
tar -czf {backup} -C /mnt/data_sdc1 lcsc-stock-mobile
'''
    try:
        ssh(command)
        snapshot_code = "import sqlite3,json; c=sqlite3.connect('file:/data/inventory.db?mode=ro',uri=True); c.row_factory=sqlite3.Row; d={k:[dict(r) for r in c.execute('SELECT * FROM '+k)] for k in ['materials','stock_logs','locations']}; d['dataset_id']=c.execute(\"SELECT value FROM app_meta WHERE key='dataset_id'\").fetchone()[0]; d['import_receipts']=[dict(r) for r in c.execute(\"SELECT key,value FROM app_meta WHERE key LIKE 'import:%'\")]; print(json.dumps(d))"
        before = json.loads(ssh(f'docker run --rm --entrypoint python -v {APP}/data:/data:ro {image} -c {shlex.quote(snapshot_code)}', capture=True))
        private_write(PRIVATE / '219-before.json', json.dumps(before, ensure_ascii=False))
        ssh(f"set -eu; (tar -cf - -C {stage}/source .) | tar -xf - -C {APP}; cp {stage}/release.env {APP}/.env; chmod 600 {APP}/.env; cd {APP}; docker compose up -d --no-build")
        for attempt in range(30):
            try:
                data = request('/api/version', env['PINBOX_API_TOKEN'])
                if data.get('version') == version:
                    break
            except Exception:
                pass
            time.sleep(2)
        else:
            raise RuntimeError('New service did not become healthy')
        after = request('/api/backup', env['PINBOX_API_TOKEN'])
        private_write(PRIVATE / '219-after.json', json.dumps(after, ensure_ascii=False))
        unchanged = business(before) == business(after)
        if not unchanged:
            raise RuntimeError('Business data changed during deployment; snapshots retained for reconciliation, not overwritten')
        try:
            request('/api/stats', '')
        except urllib.error.HTTPError as exc:
            if exc.code != 401:
                raise
        else:
            raise RuntimeError('Anonymous API access was not rejected')
        tracked = run('git', 'ls-files', capture=True).splitlines()
        manifest = ''.join(f'{hashlib.sha256((ROOT / p).read_bytes()).hexdigest()}  {p}\n' for p in tracked if (ROOT / p).is_file())
        private_write(PRIVATE / 'source.sha256', manifest)
        run('scp', '-q', str(PRIVATE / 'source.sha256'), f'{HOST}:{stage}/source.sha256')
        ssh(f'cd {APP} && sha256sum -c {stage}/source.sha256 >/dev/null')
        report = {'commit': commit, 'version': version, 'image': image, 'backup': backup,
                  'business_data_unchanged': unchanged, 'materials': len(after['materials']),
                  'stock_logs': len(after['stock_logs']), 'locations': len(after['locations']),
                  'api_authentication': 'enabled', 'source_hashes': 'verified'}
        private_write(PRIVATE / '219-deployment.json', json.dumps(report, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
        print('Access token saved privately in .deployment/219.env; never commit or paste it into public logs.')
    except BaseException:
        print('Deployment requires inspection. Preserved rollback archive:', backup)
        raise


if __name__ == '__main__':
    main()
