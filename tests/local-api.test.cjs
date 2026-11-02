const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { IDBFactory } = require('fake-indexeddb');
const { webcrypto } = require('node:crypto');

function runtime() {
  const storage = new Map([['wms-mode', 'local']]);
  const context = vm.createContext({
    indexedDB: new IDBFactory(), crypto: webcrypto, Papa: require('papaparse'), sha256: require('js-sha256').sha256,
    URL, URLSearchParams, FormData, File, Blob, Headers, Response, AbortSignal, TextEncoder, TextDecoder,
    console: { log() {}, error() {} }, setTimeout, clearTimeout, structuredClone,
    navigator: {}, location: { protocol: 'http:', origin: 'http://server.test' },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  });
  context.window = context;
  for (const name of ['local-db', 'local-api', 'api']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js', name + '.js'), 'utf8'), context);
  }
  return { ctx: context, ...vm.runInContext('({ LocalAPI, LocalDB, DataLayer, syncPushOps, syncPullSnapshot })', context) };
}

async function request(runtime, method, url, body) {
  return runtime.LocalAPI.handle(method, url, { body: body === undefined ? undefined : JSON.stringify(body) });
}

async function create(runtime, fields = {}) {
  const response = await request(runtime, 'POST', '/api/materials', { code: 'C10001', model: 'TEST-123', quantity: 20, ...fields });
  assert.equal(response.ok, true, JSON.stringify(await response.json()));
}

function fileBody(name, text) {
  const data = new FormData();
  data.set('file', new File([text], name));
  return { body: data };
}

test('concurrent local stock requests keep quantity, logs, and pending queue consistent', async () => {
  const r = runtime();
  await create(r);
  const responses = await Promise.all(Array.from({ length: 30 }, () => request(r, 'POST', '/api/materials/C10001/stock', { delta: -1 })));
  assert.equal(responses.filter(r => r.ok).length, 20);
  assert.equal((await r.LocalDB.get('materials', 'C10001')).quantity, 0);
  assert.equal(await r.LocalDB.count('logs'), 21);
  assert.equal(await r.LocalDB.count('pending_ops'), 21);
});

test('invalid create, update, and stock quantities leave the database intact', async () => {
  const r = runtime();
  await create(r);
  for (const value of [-1, 1.5, '2', true]) {
    assert.equal((await request(r, 'PUT', '/api/materials/C10001', { quantity: value })).ok, false);
  }
  assert.equal((await request(r, 'POST', '/api/materials/C10001/stock', { delta: '2' })).ok, false);
  assert.equal((await r.LocalDB.get('materials', 'C10001')).quantity, 20);
  assert.equal(await r.LocalDB.count('pending_ops'), 1);
});

test('local CSV roundtrip handles multiline fields, zero stock, and all exported fields', async () => {
  const r = runtime();
  const csv = 'code,category,brand,model,package,quantity,unit,price,location,min_stock,remark\r\nC10001,resistor,brand,TEST,0603,0,pcs,1.25,A,12,"line 1\nline 2, quoted ""text"""\r\n';
  const response = await r.LocalAPI.handle('POST', '/api/import', fileBody('stock.csv', csv));
  assert.equal(response.ok, true, JSON.stringify(await response.json()));
  const material = await r.LocalDB.get('materials', 'C10001');
  assert.equal(material.quantity, 0);
  assert.equal(material.price, 1.25);
  assert.equal(material.location, 'A');
  assert.equal(material.min_stock, 12);
  assert.equal(material.remark, 'line 1\nline 2, quoted "text"');
  assert.equal(await r.LocalDB.count('pending_ops'), 1);
  assert.equal((await r.LocalAPI.handle('POST', '/api/import', fileBody('renamed.csv', csv))).status, 409);
});

test('failed local import rolls back materials, logs, and queued operations together', async () => {
  const r = runtime();
  const data = [{ code: 'C10001', model: 'ok', quantity: 2 }, { code: 'C10002', model: 'bad', quantity: -1 }];
  assert.equal((await r.LocalAPI.handle('POST', '/api/import', fileBody('stock.json', JSON.stringify(data)))).ok, false);
  assert.equal(await r.LocalDB.count('materials'), 0);
  assert.equal(await r.LocalDB.count('logs'), 0);
  assert.equal(await r.LocalDB.count('pending_ops'), 0);
});

test('both inventory JSON schemas import and retain batch history and sync operations', async () => {
  const r = runtime();
  const data = { today_orders: [{ 商品编号: 'C10001', '商品型号/名称': 'test', 采购数量: 2, 库存批次: 'batch-A' }], historical_inventory: [{ code: 'C10001', model: 'test', quantity: 3, source: 'batch-B' }] };
  assert.equal((await r.LocalAPI.handle('POST', '/api/import', fileBody('stock.json', JSON.stringify(data)))).ok, true);
  const material = await r.LocalDB.get('materials', 'C10001');
  assert.equal(material.quantity, 5);
  assert.match(material.batch, /batch-A.*batch-B/);
  const ops = await r.LocalDB.getAll('pending_ops');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'import');
  assert.equal(ops[0].records.length, 2);
});

test('local snapshot validation and transaction abort preserve previous data', async () => {
  const r = runtime();
  await create(r);
  const before = await r.LocalDB.get('materials', 'C10001');
  await assert.rejects(r.LocalAPI.restoreSnapshot({ materials: [{ code: 'C10002', model: 'bad', quantity: -1 }] }));
  assert.deepEqual(await r.LocalDB.get('materials', 'C10001'), before);
  // This fails after the old data has been cleared, exercising transaction rollback.
  await assert.rejects(r.LocalAPI.restoreSnapshot({ materials: [], local_meta: 123 }));
  assert.deepEqual(await r.LocalDB.get('materials', 'C10001'), before);
});

test('local backup roundtrip keeps pending operations and subsequent location IDs unique', async () => {
  const r = runtime();
  await create(r, { location: 'A' });
  await request(r, 'POST', '/api/materials/C10001/stock', { delta: -2, project: 'board-A' });
  const backup = await (await request(r, 'GET', '/api/backup')).json();
  await r.LocalAPI.restoreSnapshot(backup);
  assert.equal(await r.LocalDB.count('pending_ops'), 2);
  assert.equal((await r.LocalDB.getAll('logs')).at(-1).project, 'board-A');
  await request(r, 'POST', '/api/locations', { name: 'B' });
  assert.equal(await r.LocalDB.count('locations'), 2);
});

test('local BOM supports standard CSV, large quantities, and shared stock allocation', async () => {
  const r = runtime();
  await create(r, { quantity: 10 });
  assert.equal(r.LocalAPI.parseBomText('10k 0603 10000')[0].qty, 10000);
  assert.equal(r.LocalAPI.parseBomText('10k 0603 10')[0].model, '10k 0603');
  assert.ok(r.LocalAPI.decodeSpec('4K7').res_values.includes('4.7kΩ'));
  assert.ok(r.LocalAPI.decodeSpec('1µF').cap_values.includes('1uF'));
  const response = await r.LocalAPI.handle('POST', '/api/bom/check', fileBody('bom.csv', 'MPN,Qty,Designator\nTEST-123,6,U1\nTEST-123,6,U2\n'));
  assert.equal(response.ok, true);
  const items = (await response.json()).items;
  assert.equal(items[0].shortfall, 0);
  assert.equal(items[1].shortfall, 2);
});

test('scanner never truncates invalid label quantities into valid stock amounts', () => {
  const r = runtime();
  for (const label of ['1.5个', '-2PCS', 'qty:1e3', 'qty:-2个', '9999999999PCS', '0PCS']) {
    assert.equal(r.LocalAPI.parseLcscBarcode('C10001 ' + label).quantity, null, label);
  }
  assert.equal(r.LocalAPI.parseLcscBarcode('C10001 数量:12个').quantity, 12);
});

test('BOM ambiguous short models and conflicting packages remain manual candidates', async () => {
  const r = runtime();
  await create(r, { model: 'SS34 diode', package: 'SMA' });
  let items = await r.LocalAPI.matchBomItems([{ model: 'SS34', qty: 1, package: '' }]);
  assert.equal(items[0].matched_code, null);
  assert.ok(items[0].candidates.length);
  await request(r, 'PUT', '/api/materials/C10001', { model: 'SS34' });
  items = await r.LocalAPI.matchBomItems([{ model: 'SS34', qty: 1, package: 'SMB' }]);
  assert.equal(items[0].matched_code, null);
  items = await r.LocalAPI.matchBomItems([{ model: 'SS34', qty: 1, package: 'SMA' }]);
  assert.equal(items[0].matched_code, 'C10001');
  await create(r, { code: 'C10002', model: 'SS34', package: 'SMB' });
  items = await r.LocalAPI.matchBomItems([{ model: 'SS34', qty: 1, package: '' }]);
  assert.equal(items[0].matched_code, null);
  assert.equal(items[0].candidates.length, 2);
});

test('sync keeps a rejected operation and stops before its dependent operations', async () => {
  const r = runtime();
  await create(r);
  await request(r, 'POST', '/api/materials/C10001/stock', { delta: -1 });
  r.DataLayer.setServerUrl('http://server.test');
  let calls = 0;
  r.ctx.fetch = async url => {
    if (url.endsWith('/api/sync/state')) return Response.json({ dataset_id: 'dataset-A' });
    calls++;
    return Response.json({ detail: 'conflict' }, { status: 409 });
  };
  const result = await r.syncPushOps();
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(await r.LocalDB.count('pending_ops'), 2);
});

test('sync retries a lost response using the same persistent operation ID', async () => {
  const r = runtime();
  await create(r);
  r.DataLayer.setServerUrl('http://server.test');
  const ids = [];
  r.ctx.fetch = async (url, options) => {
    if (url.endsWith('/api/sync/state')) return Response.json({ dataset_id: 'dataset-A' });
    ids.push(JSON.parse(options.body).operation.op_id);
    if (ids.length === 1) throw new Error('response lost');
    return Response.json({ message: 'already applied' });
  };
  assert.equal((await r.syncPushOps()).ok, false);
  assert.equal((await r.syncPushOps()).ok, true);
  assert.equal(ids[0], ids[1]);
  assert.equal(await r.LocalDB.count('pending_ops'), 0);
});

test('pull accepts an empty server snapshot and refuses to discard pending changes', async () => {
  const r = runtime();
  r.DataLayer.setServerUrl('http://server.test');
  r.ctx.fetch = async () => Response.json({ materials: [], locations: [], stock_logs: [], dataset_id: 'dataset-A' });
  assert.equal((await r.syncPullSnapshot()).ok, true);
  await create(r);
  assert.equal((await r.syncPullSnapshot()).ok, false);
  assert.equal(await r.LocalDB.count('materials'), 1);
});

test('legacy queued operations are retained for reconciliation instead of possibly replaying twice', async () => {
  const r = runtime();
  await r.LocalDB.add('pending_ops', { kind: 'stock', code: 'C10001', delta: -1 });
  const backup = await (await request(r, 'GET', '/api/backup')).json();
  await r.LocalAPI.restoreSnapshot(backup);
  assert.equal((await r.LocalDB.getAll('pending_ops'))[0].op_id, undefined);
  r.DataLayer.setServerUrl('http://server.test');
  r.ctx.fetch = async url => {
    assert.ok(url.endsWith('/api/sync/state'));
    return Response.json({ dataset_id: 'dataset-A' });
  };
  assert.equal((await r.syncPushOps()).ok, false);
  assert.equal(await r.LocalDB.count('pending_ops'), 1);
});

test('native requests preserve HTTPS and return binary downloads as usable blobs', async () => {
  const r = runtime();
  let options;
  r.ctx.Capacitor = {
    isNativePlatform: () => true,
    Plugins: { CapacitorHttp: { request: async opts => {
      options = opts;
      return { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from('download-content').toString('base64') };
    } } }
  };
  r.ctx.atob = text => Buffer.from(text, 'base64').toString('binary');
  r.DataLayer.mode = 'server';
  r.DataLayer.setServerUrl('https://192.168.1.10:8089');
  const response = await r.DataLayer.api('/api/export/excel', { responseType: 'blob' });
  assert.equal(options.url, 'https://192.168.1.10:8089/api/export/excel');
  assert.equal(await (await response.blob()).text(), 'download-content');
});

test('restore during an in-flight push never acknowledges the replacement queue', async () => {
  const a = runtime(), b = runtime();
  await create(a);
  await create(b, { quantity: 30 });
  const backup = await (await request(b, 'GET', '/api/backup')).json();
  let release, entered;
  const started = new Promise(r => { entered = r; });
  a.ctx.fetch = async url => {
    if (url.endsWith('/api/sync/state')) return new Response(JSON.stringify({ dataset_id: 'test-dataset' }));
    entered();
    await new Promise(r => { release = r; });
    return new Response(JSON.stringify({ message: 'ok' }));
  };
  const push = a.syncPushOps();
  await started;
  await assert.rejects(a.LocalAPI.restoreSnapshot(backup), /同步正在进行/);
  // Simulate an older tab that bypasses the replacement lock. The generation check remains mandatory.
  a.ctx.replacementBackup = backup;
  await vm.runInContext("LocalDB.transaction(['materials','logs','locations','meta','pending_ops'], db => createLocalAPI(db).restoreSnapshot(replacementBackup))", a.ctx);
  release();
  const result = await push;
  assert.equal(result.ok, false);
  assert.equal(await a.LocalDB.count('pending_ops'), 1);
  assert.equal((await a.LocalDB.getAll('pending_ops'))[0].op_id, backup.pending_ops[0].op_id);
  assert.equal((await a.LocalDB.get('materials', 'C10001')).quantity, 30);
});

test('online lost-response retries persist the same operation across failure', async () => {
  const r = runtime();
  r.DataLayer.setMode('server');
  let quantity = 20, first = true;
  const receipts = new Map();
  r.ctx.fetch = async (url, options) => {
    if (url.endsWith('/api/sync/state')) return new Response(JSON.stringify({ dataset_id: 'test' }));
    const op = JSON.parse(options.body);
    if (!receipts.has(op.op_id)) { quantity += op.delta; receipts.set(op.op_id, { current: quantity }); }
    if (first) { first = false; throw new Error('response lost'); }
    return new Response(JSON.stringify(receipts.get(op.op_id)));
  };
  const options = { method: 'POST', body: JSON.stringify({ delta: -3 }) };
  await assert.rejects(r.DataLayer.api('/api/materials/C10001/stock', options), /结果尚未确认/);
  assert.equal(quantity, 17);
  assert.equal(await r.LocalDB.count('online_ops'), 1);
  await assert.rejects(r.DataLayer.api('/api/materials/C10002/stock', options), /未确认/);
  const response = await r.DataLayer.api('/api/materials/C10001/stock', options);
  assert.equal((await response.json()).current, 17);
  assert.equal(quantity, 17);
  assert.equal(await r.LocalDB.count('online_ops'), 0);
});

test('connection testing neither saves nor changes the live data source or token', async () => {
  const r = runtime();
  r.DataLayer.setServerUrl('http://original.test');
  r.ctx.localStorage.setItem('wms-api-token', 'original');
  let called;
  r.ctx.fetch = async (url, opts) => { called = { url, opts }; return new Response(JSON.stringify({ total_sku: 1, total_pieces: 2 })); };
  await vm.runInContext("syncTestConnection('http://other.test', 'draft')", r.ctx);
  assert.equal(r.DataLayer.serverUrl, 'http://original.test');
  assert.equal(r.ctx.localStorage.getItem('wms-api-token'), 'original');
  assert.equal(called.url, 'http://other.test/api/stats');
  assert.equal(called.opts.headers.authorization, 'Bearer draft');
});

test('local validation trims text and enforces server field lengths before queuing', async () => {
  const r = runtime();
  for (const fields of [{ code: 'C'.repeat(129) }, { model: 'x'.repeat(2001) }, { location: 'x'.repeat(257) }]) {
    assert.equal((await request(r, 'POST', '/api/materials', { code: 'C10001', model: 'test', ...fields })).ok, false);
  }
  assert.equal((await request(r, 'POST', '/api/locations', { name: 'x'.repeat(257) })).ok, false);
  const file = fileBody('stock.json', JSON.stringify([{ code: 'C10001', model: ' test ', brand: ' Brand ', quantity: 5 }]));
  assert.equal((await r.LocalAPI.handle('POST', '/api/import', file)).ok, true);
  await request(r, 'PUT', '/api/materials/C10001', { brand: 'Changed' });
  const ops = await r.LocalDB.getAll('pending_ops');
  assert.equal(ops[0].records[0].brand, 'Brand');
  assert.equal(ops[1].expected.brand, 'Brand');
});

test('backup protocol preserves import receipts at top level and all missing log IDs', async () => {
  const r = runtime();
  await create(r);
  const data = await (await request(r, 'GET', '/api/backup')).json();
  data.stock_logs = [ { ...data.stock_logs[0], id: undefined }, { ...data.stock_logs[0], id: 2 } ];
  await r.LocalAPI.restoreSnapshot(data);
  const logs = await r.LocalDB.getAll('logs');
  assert.deepEqual(logs.map(l => l.id), [2, 3]);
  await r.LocalDB.put('meta', { key: 'import:' + 'a'.repeat(64), value: 'time' });
  const backup = await (await request(r, 'GET', '/api/backup')).json();
  assert.equal(backup.backup_version, 2);
  assert.equal(backup.import_receipts.length, 1);
});

test('local BOM rejects decimals and ambiguous quantities without decimal value collisions', async () => {
  const r = runtime();
  await create(r, { model: '4.7K' });
  const data = await (await request(r, 'POST', '/api/bom/check', { content: '47K 2' })).json();
  assert.equal(data.items[0].matched_code, null);
  for (const content of ['C10001 1.5', 'C10001 -5', 'R1 10k 0603']) {
    assert.equal((await request(r, 'POST', '/api/bom/check', { content })).ok, false);
  }
  assert.equal(r.LocalAPI.parseBomText('C123 5')[0].code, 'C123');
});

test('local malformed import rows fail atomically instead of silently disappearing', async () => {
  const r = runtime();
  for (const bad of [{ model: 'bad', quantity: 3 }, { code: 'C10002', model: 'missing qty' }]) {
    const items = [{ code: 'C10001', model: 'ok', quantity: 2 }, bad];
    assert.equal((await r.LocalAPI.handle('POST', '/api/import', fileBody('stock.json', JSON.stringify(items)))).ok, false);
    assert.equal(await r.LocalDB.count('materials'), 0);
    assert.equal(await r.LocalDB.count('pending_ops'), 0);
  }
});

test('local project cost remains at transaction price after editing the current price', async () => {
  const r = runtime();
  await create(r, { price: 1 });
  await request(r, 'POST', '/api/materials/C10001/stock', { delta: -3, project: 'build' });
  await request(r, 'PUT', '/api/materials/C10001', { price: 10 });
  const projects = await (await request(r, 'GET', '/api/projects')).json();
  assert.equal(projects[0].out_cost, 3);
  const ops = await r.LocalDB.getAll('pending_ops');
  assert.equal(ops[1].unit_price, 1);
});

test('local detail logs break equal timestamps by newest ID', async () => {
  const r = runtime();
  await create(r);
  await r.LocalDB.clear('logs');
  for (let id = 1; id <= 36; id++) await r.LocalDB.put('logs', { id, material_code: 'C10001', created_at: '2026-11-03 12:00:00', delta: 1, remaining: id, change_type: 'in' });
  const data = await (await request(r, 'GET', '/api/materials/C10001')).json();
  assert.equal(data.logs[0].id, 36);
  assert.equal(data.logs.at(-1).id, 7);
});
