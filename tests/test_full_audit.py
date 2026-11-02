import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from uuid import uuid4

import pytest

import database
import main
from clock import now_local
from bom import parse_bom_text
from use_case_infer import infer_material_use_case


def stock(client, code, payload):
    return client.post(f"/api/materials/{code}/stock", json={
        "op_id": str(uuid4()), "dataset_id": client.get("/api/sync/state").json()["dataset_id"], **payload
    })


def create(client, **fields):
    response = client.post('/api/materials', json={'code': 'C123', 'model': 'TEST', 'quantity': 20, **fields})
    assert response.status_code == 200, response.text


def update(client, **fields):
    old = client.get('/api/materials/C123').json()
    return client.put('/api/materials/C123', json={**fields, 'expected': {k: old[k] for k in fields}})


def restore(client, data):
    return client.post('/api/restore?confirm=yes', files={'file': ('backup.json', json.dumps(data))})


def test_online_stock_retry_is_atomic_and_dataset_scoped(client):
    create(client)
    payload = {'delta': -3, 'op_id': str(uuid4()), 'dataset_id': client.get('/api/sync/state').json()['dataset_id']}
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: client.post('/api/materials/C123/stock', json=payload), range(6)))
    assert all(r.status_code == 200 for r in results)
    assert all(r.json() == results[0].json() for r in results)
    assert client.get('/api/materials/C123').json()['quantity'] == 17
    assert len(client.get('/api/materials/C123').json()['logs']) == 2
    assert stock(client, 'C123', {**payload, 'delta': -4}).status_code == 409
    assert client.post('/api/wipe?confirm=yes').status_code == 200
    assert client.post('/api/materials/C123/stock', json=payload).status_code == 409


def test_online_edit_conflicts_and_disjoint_fields(client):
    create(client, remark='old')
    assert update(client, remark='other user').status_code == 200
    assert client.put('/api/materials/C123', json={'remark': 'stale', 'expected': {'remark': 'old'}}).status_code == 409
    assert client.put('/api/materials/C123', json={'model': 'new', 'expected': {'model': 'TEST'}}).status_code == 200
    assert client.get('/api/materials/C123').json()['remark'] == 'other user'
    assert client.put('/api/materials/C123', json={'model': 'unguarded'}).status_code == 409


def test_decimal_bom_values_are_not_normalized_to_different_values(client):
    create(client, model='4.7K')
    item = client.post('/api/bom/check', json={'content': '47K 2'}).json()['items'][0]
    assert item['matched_code'] is None


@pytest.mark.parametrize('line', ['C10001 1.5', 'C10001 -5', 'R1 10k 0603', 'C10001 0', 'C123 2147483648'])
def test_bom_rejects_invalid_or_ambiguous_quantities(line):
    with pytest.raises(ValueError, match='第 1 行'):
        parse_bom_text(line)


def test_bom_accepts_short_codes_and_explicit_package_sized_quantity():
    assert parse_bom_text('C123 5')[0]['code'] == 'C123'
    assert parse_bom_text('R1 10k 0603 x603')[0]['qty'] == 603


def test_local_backup_receipts_migrate_to_server_and_pending_backups_are_rejected(client):
    content = json.dumps([{'code': 'C123', 'model': 'test', 'quantity': 5}])
    assert client.post('/api/import', files={'file': ('order.json', content)}).status_code == 200
    data = client.get('/api/backup').json()
    data['backup_version'] = 1
    data['local_meta'] = data.pop('import_receipts')
    assert restore(client, data).status_code == 200
    assert client.post('/api/import', files={'file': ('order.json', content)}).status_code == 409
    assert client.get('/api/materials/C123').json()['quantity'] == 5
    data['pending_ops'] = [{'id': 1, 'kind': 'stock', 'delta': 3}]
    assert restore(client, data).status_code == 400


@pytest.mark.parametrize('path', ['/api/wipe?confirm=yes', '/api/restore?confirm=yes'])
def test_destructive_backup_holds_write_lock(client, monkeypatch, path):
    create(client)
    original = main._run_backup
    locks = []

    def backup_with_competing_writer():
        def write():
            with sqlite3.connect(database.DB_PATH, timeout=0.05) as conn:
                try:
                    conn.execute("UPDATE materials SET quantity=28 WHERE code='C123'")
                except sqlite3.OperationalError as exc:
                    locks.append(str(exc))
        with ThreadPoolExecutor() as pool:
            pool.submit(write).result()
        return original()

    monkeypatch.setattr(main, '_run_backup', backup_with_competing_writer)
    response = client.post(path, files={'file': ('empty.json', '{"materials":[]}')}) if 'restore' in path else client.post(path)
    assert response.status_code == 200, response.text
    assert locks == ['database is locked']
    with sqlite3.connect(main.BACKUP_DIR + '/' + response.json()['backup']) as conn:
        assert conn.execute('SELECT quantity FROM materials').fetchone()[0] == 20


def test_today_uses_beijing_midnight(client):
    create(client)
    yesterday = datetime.fromisoformat(now_local()).replace(hour=0, minute=0, second=0) - timedelta(hours=1)
    with database.transaction() as conn:
        conn.execute('UPDATE stock_logs SET created_at=?', (str(yesterday),))
    assert client.get('/api/logs?days=1').json()['total'] == 0
    assert client.get('/api/logs?days=2').json()['total'] == 1


@pytest.mark.parametrize('bad', [{'model': 'missing code', 'quantity': 2}, {'code': 'C124', 'model': 'missing qty'}])
def test_invalid_import_row_fails_entire_file(client, bad):
    rows = [{'code': 'C123', 'model': 'valid', 'quantity': 5}, bad]
    response = client.post('/api/import', files={'file': ('bad.json', json.dumps(rows))})
    assert response.status_code == 400
    assert '第 2 条' in response.json()['detail']
    assert client.get('/api/stats').json()['total_sku'] == 0


def test_inventory_excel_reimports_and_preserves_batch(client):
    create(client, batch='test-batch')
    content = client.get('/api/export/excel').content
    client.post('/api/wipe?confirm=yes')
    response = client.post('/api/import', files={'file': ('inventory.xlsx', content)})
    assert response.status_code == 200, response.text
    assert client.get('/api/materials/C123').json()['batch'] == 'test-batch'
    assert client.get('/api/stats').json()['total_sku'] == 1


def test_token_error_is_readable_by_allowed_origin(client, monkeypatch):
    monkeypatch.setenv('PINBOX_API_TOKEN', 'test-only')
    response = client.get('/api/stats', headers={'Origin': 'https://localhost', 'Authorization': 'Bearer wrong'})
    assert response.status_code == 401
    assert response.headers['access-control-allow-origin'] == 'https://localhost'


def test_project_cost_is_recorded_not_revalued_and_old_prices_stay_unknown(client):
    create(client, price=1)
    stock(client, 'C123', {'delta': -3, 'project': 'build'})
    assert update(client, price=10).status_code == 200
    row = client.get('/api/projects').json()[0]
    assert row['out_cost'] == 3 and row['unpriced_pieces'] == 0
    data = client.get('/api/backup').json()
    for log in data['stock_logs']:
        log.pop('unit_price', None)
    assert restore(client, data).status_code == 200
    row = client.get('/api/projects').json()[0]
    assert row['out_cost'] == 0 and row['unpriced_pieces'] == 3


def test_use_case_value_heuristics_are_bounded_and_labelled():
    text = infer_material_use_case('C123', '贴片电阻', '', '150R')
    assert '0欧姆' not in text
    assert text.startswith('[自动推断/未核验]')


def test_legacy_online_stock_without_operation_id_is_rejected(client):
    create(client)
    assert client.post('/api/materials/C123/stock', json={'delta': -1}).status_code == 422
    assert client.get('/api/materials/C123').json()['quantity'] == 20


def test_old_receipt_remains_queryable_after_wipe_without_replaying(client):
    create(client)
    op = {'delta': -3, 'op_id': str(uuid4()), 'dataset_id': client.get('/api/sync/state').json()['dataset_id']}
    assert client.post('/api/materials/C123/stock', json=op).status_code == 200
    client.post('/api/wipe?confirm=yes')
    receipt = client.get('/api/sync/receipt/' + op['op_id']).json()
    assert receipt['applied'] is True
    assert receipt['result']['current'] == 17
    assert client.get('/api/stats').json()['total_sku'] == 0
