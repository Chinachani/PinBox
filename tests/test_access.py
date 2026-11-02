"""Credential lifecycle tests: all files live under pytest temporary directories."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

import access
import database
import manage


@pytest.fixture(autouse=True)
def private_config(tmp_path, monkeypatch):
    monkeypatch.setattr(database, 'DB_DIR', str(tmp_path / 'private'))
    monkeypatch.delenv('PINBOX_API_TOKEN', raising=False)
    monkeypatch.delenv('PINBOX_DEPLOYMENT_MODE', raising=False)


def test_shared_key_persists_without_inventory():
    first = access.initialize()
    assert first['mode'] == 'shared' and len(first['token']) == 48
    assert first['created'] is True
    assert access.initialize()['token'] == first['token']
    assert access.current()['token'] == first['token']
    assert not (Path(database.DB_DIR) / 'inventory.db').exists()
    if os.name != 'nt':
        assert access.config_path().stat().st_mode & 0o777 == 0o600


def test_standalone_is_saved_and_unauthenticated():
    assert access.initialize('standalone')['token'] == ''
    assert access.initialize()['mode'] == 'standalone'
    assert json.loads(access.config_path().read_text())['mode'] == 'standalone'


def test_environment_authority_and_saved_key_retained(monkeypatch):
    saved = access.initialize()['token']
    monkeypatch.setenv('PINBOX_API_TOKEN', 'environment-secret')
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'standalone')
    result = access.current()
    assert result['mode'] == 'standalone' and result['token'] == 'environment-secret'
    assert result['source'] == 'environment'
    monkeypatch.delenv('PINBOX_API_TOKEN')
    assert access.current()['token'] == ''
    monkeypatch.delenv('PINBOX_DEPLOYMENT_MODE')
    assert access.current()['token'] == saved


def test_missing_current_initializes_and_public_status_redacts(monkeypatch):
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'standalone')
    assert access.current()['mode'] == 'standalone'
    assert 'token' not in access.status()


@pytest.mark.parametrize('content', ['{broken', '[]', '{"version":1,"mode":"public"}', '{"version":1,"mode":"shared","token":42}'])
def test_malformed_fails_closed(content):
    access.config_path().parent.mkdir()
    access.config_path().write_text(content)
    with pytest.raises(access.AccessError):
        access.initialize()
    assert access.config_path().read_text() == content


def test_symlink_and_hardlink_rejected(tmp_path):
    access.config_path().parent.mkdir()
    target = tmp_path / 'target'
    target.write_text('do not touch')
    access.config_path().symlink_to(target)
    with pytest.raises(access.AccessError):
        access.initialize()
    access.config_path().unlink()
    os.link(target, access.config_path())
    with pytest.raises(access.AccessError):
        access.initialize()
    assert target.read_text() == 'do not touch'


def test_lock_symlink_rejected(tmp_path):
    access.config_path().parent.mkdir()
    target = tmp_path / 'target'
    target.write_text('safe')
    Path(str(access.config_path()) + '.lock').symlink_to(target)
    with pytest.raises(access.AccessError):
        access.initialize()
    assert target.read_text() == 'safe'


def test_concurrent_process_generation_uses_one_key():
    backend = str(Path(__file__).resolve().parents[1] / 'backend')
    env = dict(os.environ, PINBOX_DATA_DIR=database.DB_DIR, PYTHONPATH=backend)
    command = [sys.executable, '-c', 'import access; print(access.initialize()["token"])']
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: subprocess.check_output(command, env=env, text=True).strip(), range(12)))
    assert len(set(results)) == 1
    assert access.current()['token'] == results[0]


def test_cli_setup_json_and_status_never_print_secret(capsys):
    assert manage.main(['setup', '--mode', 'shared', '--json']) == 0
    metadata = json.loads(capsys.readouterr().out)
    assert metadata['created'] is True and metadata['auth_enabled'] is True
    key = access.current()['token']
    assert key not in json.dumps(metadata)
    assert manage.main(['status']) == 0
    assert key not in capsys.readouterr().out
    assert manage.main(['token', 'show']) == 0
    assert capsys.readouterr().out.strip() == key
    assert manage.main(['token', 'show', '--json']) == 0
    assert key not in capsys.readouterr().out


def test_cli_reset_requires_confirmation_and_preserves_inventory(capsys):
    key = access.initialize()['token']
    sentinel = Path(database.DB_DIR) / 'inventory.db'
    sentinel.write_bytes(b'existing inventory')
    assert manage.main(['token', 'reset']) == 1
    assert access.current()['token'] == key
    assert manage.main(['token', 'reset', '--yes']) == 0
    new = access.current()['token']
    assert new != key and new not in capsys.readouterr().out
    assert sentinel.read_bytes() == b'existing inventory'


def test_environment_reset_without_file_refused(monkeypatch, capsys):
    monkeypatch.setenv('PINBOX_API_TOKEN', 'external-secret')
    access.initialize()
    assert manage.main(['token', 'reset', '--yes']) == 1
    captured = capsys.readouterr()
    assert '--env-file' in captured.err and 'external-secret' not in captured.err
    assert access.current()['token'] == 'external-secret'


def test_env_setup_preserves_key_comments_and_fields(tmp_path, capsys):
    path = tmp_path / '.env'
    path.write_text('# keep comment\nOTHER=value\nPINBOX_API_TOKEN=old-key\n')
    assert manage.main(['setup', '--mode', 'shared', '--env-file', str(path), '--json']) == 0
    metadata = json.loads(capsys.readouterr().out)
    assert not metadata['created']
    content = path.read_text()
    assert content.startswith('# keep comment\nOTHER=value\n')
    assert "PINBOX_API_TOKEN='old-key'" in content
    assert "PINBOX_DEPLOYMENT_MODE='shared'" in content
    assert 'old-key' not in json.dumps(metadata)
    assert not access.config_path().exists()
    if os.name != 'nt':
        assert path.stat().st_mode & 0o777 == 0o600


def test_env_generation_show_and_rotation(tmp_path, capsys, monkeypatch):
    path = tmp_path / '.env'
    assert manage.main(['setup', '--mode', 'shared', '--env-file', str(path), '--json']) == 0
    metadata = json.loads(capsys.readouterr().out)
    assert metadata['created'] is True
    first = manage._env_read(path)[1]['PINBOX_API_TOKEN']
    monkeypatch.setenv('PINBOX_API_TOKEN', first)  # Compose helper inherits the old value.
    assert manage.main(['token', 'reset', '--yes', '--env-file', str(path)]) == 0
    second = manage._env_read(path)[1]['PINBOX_API_TOKEN']
    assert second != first and second not in capsys.readouterr().out
    # The service must be recreated; an unrelated shell override is not silently accepted.
    assert manage.main(['token', 'reset', '--yes', '--env-file', str(path)]) == 1
    monkeypatch.delenv('PINBOX_API_TOKEN')
    assert manage.main(['token', 'show', '--env-file', str(path)]) == 0
    assert capsys.readouterr().out.strip() == second


def test_readonly_env_and_unrelated_override_fail(tmp_path, monkeypatch, capsys):
    path = tmp_path / '.env'
    original = 'PINBOX_API_TOKEN=old-key\nOTHER=keep\n'
    path.write_text(original)
    path.chmod(0o400)
    assert manage.main(['token', 'reset', '--yes', '--env-file', str(path)]) == 1
    assert path.read_text() == original
    path.chmod(0o600)
    monkeypatch.setenv('PINBOX_API_TOKEN', 'other-key')
    assert manage.main(['setup', '--mode', 'shared', '--env-file', str(path)]) == 1
    assert path.read_text() == original
    assert 'other-key' not in capsys.readouterr().err


@pytest.mark.parametrize('content', ['PINBOX_API_TOKEN=a\nPINBOX_API_TOKEN=b\n', 'PINBOX_API_TOKEN=${OTHER}\n'])
def test_ambiguous_env_rejected(tmp_path, content, capsys):
    path = tmp_path / '.env'
    path.write_text(content)
    assert manage.main(['setup', '--mode', 'shared', '--env-file', str(path)]) == 1
    assert path.read_text() == content


def test_mode_override_cannot_be_silently_changed(monkeypatch, capsys):
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'shared')
    assert manage.main(['setup', '--mode', 'standalone']) == 1
    monkeypatch.delenv('PINBOX_DEPLOYMENT_MODE')
    monkeypatch.setenv('PINBOX_API_TOKEN', 'external-secret')
    assert manage.main(['setup', '--mode', 'standalone']) == 1
    assert 'external-secret' not in capsys.readouterr().err


def test_installer_shell_syntax():
    script = Path(__file__).resolve().parents[1] / 'install.sh'
    subprocess.run(['sh', '-n', str(script)], check=True)


def test_env_reset_cannot_replace_an_external_only_key(tmp_path, monkeypatch, capsys):
    path = tmp_path / '.env'
    path.write_text('OTHER=keep\n')
    monkeypatch.setenv('PINBOX_API_TOKEN', 'external-only')
    assert manage.main(['token', 'reset', '--yes', '--env-file', str(path)]) == 1
    assert path.read_text() == 'OTHER=keep\n'
    assert 'external-only' not in capsys.readouterr().err


def test_env_inline_comments_survive(tmp_path, capsys):
    path = tmp_path / '.env'
    path.write_text("PINBOX_API_TOKEN='old-key' # keep key private\n")
    assert manage.main(['setup', '--mode', 'shared', '--env-file', str(path)]) == 0
    assert "PINBOX_API_TOKEN='old-key' # keep key private\n" in path.read_text()


def test_installer_unattended_never_queries_or_prints_key(tmp_path):
    import shutil
    source = Path(__file__).resolve().parents[1] / 'install.sh'
    script = tmp_path / 'install.sh'
    shutil.copy(source, script)
    fake = tmp_path / 'docker'
    fake.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
case "$*" in
  *'setup --mode shared --json'*) printf '%s\\n' '{"created": true, "mode": "shared"}' ;;
  *'token show'*) printf '%s\\n' 'DO_NOT_PRINT_UNATTENDED' ;;
esac
''')
    fake.chmod(0o755)
    log = tmp_path / 'docker.log'
    env = dict(os.environ, PATH=str(tmp_path) + os.pathsep + os.environ['PATH'], TEST_DOCKER_LOG=str(log))
    result = subprocess.run(['sh', str(script)], env=env, capture_output=True, text=True, check=True)
    assert 'DO_NOT_PRINT_UNATTENDED' not in result.stdout + result.stderr
    assert 'token show' not in log.read_text()
    assert '--force-recreate' in log.read_text()
    assert '--env-file /project/.env' in log.read_text()
    reset = subprocess.run(['sh', str(script), 'token', 'reset'], env=env, capture_output=True, text=True)
    assert reset.returncode == 1


def test_installer_adopts_existing_direct_compose_key_without_rotation(tmp_path, capsys):
    original = access.initialize()['token']
    path = tmp_path / '.env'
    assert manage.main(['setup', '--mode', 'shared', '--env-file', str(path), '--json']) == 0
    metadata = json.loads(capsys.readouterr().out)
    assert metadata['created'] is False
    assert manage._env_read(path)[1]['PINBOX_API_TOKEN'] == original
    assert access.current()['token'] == original
    assert original not in json.dumps(metadata)


def test_frozen_admin_status_first_launch_defaults_to_standalone(monkeypatch, capsys):
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    assert manage.main(['status', '--json']) == 0
    metadata = json.loads(capsys.readouterr().out)
    assert metadata['mode'] == 'standalone' and metadata['auth_enabled'] is False


def test_installer_helper_passes_host_owner_and_preserves_private_permissions(tmp_path):
    import shutil
    script = tmp_path / 'install.sh'
    shutil.copy(Path(__file__).resolve().parents[1] / 'install.sh', script)
    fake = tmp_path / 'docker'
    fake.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DOCKER_LOG"
''')
    fake.chmod(0o755)
    log = tmp_path / 'docker.log'
    env = dict(os.environ, PATH=str(tmp_path) + os.pathsep + os.environ['PATH'], TEST_DOCKER_LOG=str(log))
    subprocess.run(['sh', str(script), 'status'], env=env, capture_output=True, text=True, check=True)
    invocation = log.read_text()
    assert f'{os.getuid()} {os.getgid()} status --env-file /project/.env' in invocation
    assert 'os.fchown(fd, uid, gid)' in invocation
    assert 'os.fchmod(fd, 0o600)' in invocation
    assert 'O_NOFOLLOW' in invocation and 'info.st_nlink != 1' in invocation
    assert '/proc/self/uid_map' in invocation and '/proc/self/gid_map' in invocation


def test_env_rotation_updates_inactive_fallback_without_touching_inventory(tmp_path, capsys, monkeypatch):
    first = access.initialize()['token']
    saved = json.loads(access.config_path().read_text())
    saved['operator_note'] = 'preserve this metadata'
    access.write_private(access.config_path(), json.dumps(saved))
    inventory = Path(database.DB_DIR) / 'inventory.db'
    inventory.write_bytes(b'original inventory sentinel')
    path = tmp_path / '.env'
    assert manage.main(['setup', '--mode', 'shared', '--env-file', str(path), '--json']) == 0
    monkeypatch.setenv('PINBOX_API_TOKEN', first)
    assert manage.main(['token', 'reset', '--yes', '--env-file', str(path)]) == 0
    second = manage._env_read(path)[1]['PINBOX_API_TOKEN']
    assert second != first
    assert first not in capsys.readouterr().out
    path.unlink()
    monkeypatch.delenv('PINBOX_API_TOKEN')
    assert access.current()['token'] == second
    updated = json.loads(access.config_path().read_text())
    assert updated['operator_note'] == saved['operator_note']
    assert updated['mode'] == saved['mode']
    assert inventory.read_bytes() == b'original inventory sentinel'


def test_env_rotation_validates_saved_configuration_before_writing(tmp_path, capsys):
    access.initialize()
    access.config_path().write_text('{bad configuration')
    path = tmp_path / '.env'
    original = 'PINBOX_API_TOKEN=old-key\nOTHER=preserve\n'
    path.write_text(original)
    assert manage.main(['token', 'reset', '--yes', '--env-file', str(path)]) == 1
    assert path.read_text() == original
    assert access.config_path().read_text() == '{bad configuration'
    assert not capsys.readouterr().out


@pytest.mark.parametrize('failed_file', ['private', 'env'])
def test_env_rotation_reports_partial_write_failure_without_success(tmp_path, monkeypatch, capsys, failed_file):
    first = access.initialize()['token']
    path = tmp_path / '.env'
    assert manage.main(['setup', '--mode', 'shared', '--env-file', str(path), '--json']) == 0
    capsys.readouterr()
    original_env = path.read_text()
    original_write = access.write_private
    failed_path = access.config_path() if failed_file == 'private' else path
    def write_or_fail(target, text):
        if Path(target) == failed_path:
            raise OSError('simulated write failure')
        return original_write(target, text)
    monkeypatch.setattr(access, 'write_private', write_or_fail)
    assert manage.main(['token', 'reset', '--yes', '--env-file', str(path)]) == 1
    captured = capsys.readouterr()
    assert not captured.out and 'failed' in captured.err
    assert path.read_text() == original_env
    if failed_file == 'private':
        assert access.current()['token'] == first
    else:
        assert access.current()['token'] != first  # Environment file still retains the active old key until retry/restart.


def test_environment_file_must_not_be_access_json(capsys):
    access.initialize()
    original = access.config_path().read_text()
    assert manage.main(['token', 'reset', '--yes', '--env-file', str(access.config_path())]) == 1
    assert access.config_path().read_text() == original
    assert 'different files' in capsys.readouterr().err
