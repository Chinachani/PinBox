"""HTTP/WS access boundaries and startup paths, with isolated inventory fixtures."""
import json
import os
from pathlib import Path
import subprocess
import sys

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

import access
import main


def test_public_instance_metadata_contains_no_credentials(client, monkeypatch):
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'shared')
    key = access.initialize()['token']
    response = client.get('/api/instance')
    assert response.status_code == 200
    assert set(response.json()) == {'mode', 'auth_required', 'version'}
    assert response.json()['mode'] == 'shared' and response.json()['auth_required'] is True
    assert response.headers['cache-control'] == 'no-store'
    assert key not in response.text
    assert client.get('/api/stats').status_code == 401
    assert client.get('/api/stats', headers={'Authorization': 'Bearer ' + key}).status_code == 200
    assert access.initialize()['token'] == key
    assert client.post('/api/instance').status_code == 401


def test_instance_origin_checked_even_without_auth(client, monkeypatch):
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'shared')
    access.initialize()
    assert client.get('/api/instance', headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.get('/api/instance', headers={'Origin': 'https://localhost'}).status_code == 200
    monkeypatch.setenv('PINBOX_ALLOWED_ORIGINS', 'https://trusted.example')
    assert client.get('/api/instance', headers={'Origin': 'https://trusted.example'}).status_code == 200


@pytest.mark.parametrize('host', ['192.168.1.10', '10.0.0.1', '::ffff:192.168.1.10', 'testclient'])
def test_standalone_rejects_remote_http_and_ws_even_with_key(client, monkeypatch, host):
    monkeypatch.setenv('PINBOX_API_TOKEN', 'private-test-key')
    with TestClient(main.app, base_url="http://127.0.0.1", client=(host, 50000)) as remote:
        assert remote.get('/api/instance').status_code == 403
        assert remote.get('/api/stats', headers={'Authorization': 'Bearer private-test-key'}).status_code == 403
        with pytest.raises(WebSocketDisconnect) as failure:
            with remote.websocket_connect('ws://127.0.0.1/ws'):
                pass
        assert failure.value.code == 1008


@pytest.mark.parametrize('host', ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])
def test_standalone_accepts_loopback_peers(client, host):
    with TestClient(main.app, base_url="http://127.0.0.1", client=(host, 50000)) as local:
        response = local.get('/api/instance')
        assert response.status_code == 200
        assert response.json()['auth_required'] is False
        assert local.get('/api/stats').status_code == 200


def test_shared_disables_unauthenticated_websocket(client, monkeypatch):
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'shared')
    access.initialize()
    with pytest.raises(WebSocketDisconnect) as failure:
        with client.websocket_connect('ws://127.0.0.1/ws'):
            pass
    assert failure.value.code == 1008


def test_corrupt_configuration_fails_closed_without_leaking_content(client):
    client.get('/api/instance')
    private_marker = 'do-not-leak-corrupted-secret'
    access.config_path().write_text('{"token":"' + private_marker)
    for route in ('/api/instance', '/api/stats'):
        response = client.get(route)
        assert response.status_code == 503
        assert private_marker not in response.text
    with pytest.raises(WebSocketDisconnect) as failure:
        with client.websocket_connect('ws://127.0.0.1/ws'):
            pass
    assert failure.value.code == 1011


def test_config_io_failure_is_redacted(client, monkeypatch):
    def fail():
        raise OSError('do-not-leak-secret-path')
    monkeypatch.setattr(access, 'current', fail)
    response = client.get('/api/instance')
    assert response.status_code == 503
    assert 'do-not-leak-secret-path' not in response.text


def test_shared_remote_clients_require_key(client, monkeypatch):
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'shared')
    monkeypatch.setenv('PINBOX_API_TOKEN', 'existing-external-key')
    access.initialize()
    with TestClient(main.app, base_url="http://127.0.0.1", client=('192.168.1.10', 50000)) as remote:
        assert remote.get('/api/instance').status_code == 200
        assert remote.get('/api/stats').status_code == 401
        assert remote.get('/api/stats', headers={'Authorization': 'Bearer existing-external-key'}).status_code == 200
    assert access.current()['token'] == 'existing-external-key'


def test_listener_binding_applies_same_safe_host_for_both_protocols(client, monkeypatch):
    monkeypatch.delenv('PINBOX_HOST', raising=False)
    assert main.server_bind_host() == '127.0.0.1'
    monkeypatch.setenv('PINBOX_HOST', '::1')
    assert main.server_bind_host() == '::1'
    monkeypatch.setenv('PINBOX_HOST', '0.0.0.0')
    with pytest.raises(access.AccessError):
        main.server_bind_host()
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'shared')
    access.initialize()
    assert main.server_bind_host() == '0.0.0.0'
    monkeypatch.delenv('PINBOX_HOST')
    assert main.server_bind_host() == '0.0.0.0'
    source = Path(main.__file__).read_text()
    assert 'uvicorn.Config(app, host=bind_host, port=8089' in source
    assert 'uvicorn.run(app, host=bind_host, port=8088)' in source


def test_main_cli_setup_never_initializes_inventory(tmp_path):
    root = Path(__file__).resolve().parents[1]
    target = tmp_path / 'cli'
    env = {**os.environ, 'PINBOX_DATA_DIR': str(target), 'PINBOX_DEPLOYMENT_MODE': 'standalone'}
    env.pop('PINBOX_API_TOKEN', None)
    completed = subprocess.run([sys.executable, 'backend/main.py', 'setup', '--mode', 'standalone', '--json'],
                               cwd=root, env=env, capture_output=True, text=True, check=True, timeout=20)
    assert json.loads(completed.stdout)['mode'] == 'standalone'
    assert (target / 'access.json').exists()
    assert not (target / 'inventory.db').exists()


@pytest.mark.parametrize(('frozen', 'expected'), [(False, 'shared'), (True, 'standalone')])
def test_startup_defaults_and_restarts_preserve_configuration(tmp_path, frozen, expected):
    root = Path(__file__).resolve().parents[1]
    target = tmp_path / 'startup'
    env = {**os.environ, 'PINBOX_DATA_DIR': str(target)}
    env.pop('PINBOX_DEPLOYMENT_MODE', None)
    env.pop('PINBOX_API_TOKEN', None)
    code = f'import sys, runpy; sys.frozen={frozen!r}; runpy.run_path("backend/main.py", run_name="startup_test")'
    subprocess.run([sys.executable, '-c', code], cwd=root, env=env, check=True, timeout=20)
    first = json.loads((target / 'access.json').read_text())
    assert first['mode'] == expected
    assert bool(first['token']) == (expected == 'shared')
    subprocess.run([sys.executable, '-c', code], cwd=root, env=env, check=True, timeout=20)
    assert json.loads((target / 'access.json').read_text()) == first


@pytest.mark.parametrize('hostname', ['localhost', '127.0.0.1', '[::1]', '[::ffff:127.0.0.1]'])
def test_standalone_loopback_hostnames(client, hostname):
    assert client.get('/api/instance', headers={'Host': hostname + ':8088'}).status_code == 200


def test_standalone_dns_rebinding_and_forwarded_header_spoofs_rejected(client):
    for headers in ({'Host': 'evil.example:8088'},
                    {'Host': 'evil.example:8088', 'X-Forwarded-Host': 'localhost:8088'},
                    {'Host': 'localhost.evil.example:8088'}):
        assert client.get('/api/instance', headers=headers).status_code == 403
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('ws://127.0.0.1/ws', headers=headers):
                pass
    with TestClient(main.app, base_url='http://127.0.0.1', client=('192.168.1.10', 50000)) as remote:
        assert remote.get('/api/stats', headers={'X-Forwarded-For': '127.0.0.1'}).status_code == 403
        preflight = remote.options('/api/stats', headers={'Origin': 'https://localhost', 'Access-Control-Request-Method': 'GET'})
        assert preflight.status_code == 403
    preflight = client.options('/api/stats', headers={'Host': 'evil.example', 'Origin': 'https://localhost', 'Access-Control-Request-Method': 'GET'})
    assert preflight.status_code == 403


def test_deleted_access_configuration_recovers_safely(client, monkeypatch):
    assert client.get('/api/instance').status_code == 200
    access.config_path().unlink()
    monkeypatch.setenv('PINBOX_DEPLOYMENT_MODE', 'shared')
    response = client.get('/api/instance')
    assert response.status_code == 200 and response.json()['auth_required'] is True
    assert client.get('/api/stats').status_code == 401
    assert access.config_path().exists()
