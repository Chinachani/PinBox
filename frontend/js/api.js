const APP_VERSION = '1.0.26';

function isStandaloneApp() {
  return !!window.Capacitor?.isNativePlatform?.() || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isNativeHttpAvailable() {
  return !!(window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.CapacitorHttp);
}

function resolveSyncBase(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('请输入不含账号、查询参数的 HTTP/HTTPS 服务器地址');
  // Never silently downgrade TLS or guess a different server port.
  if (!isNativeHttpAvailable() && location.protocol === 'https:' && url.protocol === 'http:')
    throw new Error('HTTPS 页面不能访问 HTTP 服务器，请填写可信的 HTTPS 地址');
  return url.toString().replace(/\/+$/, '');
}

function serverHeaders(extra = {}) {
  const headers = new Headers(extra);
  const token = DataLayer.token;
  if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
  return Object.fromEntries(headers);
}

async function nativeRequest(method, url, body, extra = {}) {
  const opts = { url, method: method.toUpperCase(), headers: serverHeaders(extra.headers), connectTimeout: 5000, readTimeout: 30000, responseType: extra.responseType || 'json' };
  if (body instanceof FormData) {
    const boundary = 'pinbox-' + newOperationId();
    opts.headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
    opts.dataType = 'formData';
    opts.data = await Promise.all([...body.entries()].map(async ([key, value]) => {
      if (typeof value === 'string') return { key, type: 'string', value };
      const encoded = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(value);
      });
      return { key, type: 'base64File', value: encoded, fileName: value.name, contentType: value.type || 'application/octet-stream' };
    }));
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.data = typeof body === 'string' ? JSON.parse(body) : body;
  }
  const result = await window.Capacitor.Plugins.CapacitorHttp.request(opts);
  const headers = new Headers(result.headers || {});
  let data = result.data;
  if (extra.responseType === 'blob' && !headers.get('content-type')?.includes('json')) {
    data = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  } else if (typeof data !== 'string') {
    data = JSON.stringify(data);
  }
  return new Response(data, { status: result.status, headers });
}

async function serverRequest(base, path, opts = {}) {
  if (isNativeHttpAvailable()) return nativeRequest(opts.method || 'GET', base + path, opts.body, opts);
  const { responseType, ...fetchOpts } = opts;
  return fetch(base + path, { ...fetchOpts, headers: serverHeaders(opts.headers), signal: opts.signal || AbortSignal.timeout(30000) });
}

const DATA_SETTINGS_KEY = 'wms-data-settings';
function readDataSettings() {
  const defaultMode = isStandaloneApp() ? 'local' : 'server';
  const raw = localStorage.getItem(DATA_SETTINGS_KEY);
  if (raw !== null) {
    try {
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || !['server', 'local'].includes(saved.mode) ||
          typeof saved.serverUrl !== 'string' || typeof saved.token !== 'string') throw new Error();
      return { mode: saved.mode, serverUrl: saved.serverUrl, token: saved.token, settingsError: '' };
    } catch (_) {
      // Never fall back to stale credentials if the authoritative record is damaged.
      return { mode: defaultMode, serverUrl: '', token: '', settingsError: '保存的连接设置已损坏，请重新选择使用方式；库存与待推送数据未改动。' };
    }
  }
  return { mode: localStorage.getItem('wms-mode') || defaultMode,
    serverUrl: localStorage.getItem('wms-server-url') || '',
    token: localStorage.getItem('wms-api-token') || '', settingsError: '' };
}

let dataWritesInFlight = 0;
const DataLayer = {
  ...readDataSettings(),
  setSettings({ mode = this.mode, url = this.serverUrl, token = this.token }) {
    if (!['server', 'local'].includes(mode)) throw new Error('无效数据模式');
    const saved = { version: 1, mode, serverUrl: resolveSyncBase(url), token: String(token || '').trim() };
    // One atomic storage write commits the address/key pair before changing live requests.
    try { localStorage.setItem(DATA_SETTINGS_KEY, JSON.stringify(saved)); }
    catch (_) { throw new Error('无法保存连接设置，可能是浏览器存储空间不足或禁止写入。原连接保持不变，请勿清空库存数据。'); }
    Object.assign(this, { mode: saved.mode, serverUrl: saved.serverUrl, token: saved.token, settingsError: '' });
  },
  setMode(mode) { this.setSettings({ mode }); },
  setServerUrl(url) { this.setSettings({ url }); },
  setToken(token) { this.setSettings({ token }); },
  async api(path, opts = {}) {
    if (this.settingsError) throw new Error(this.settingsError);
    const run = () => {
      if (this.mode === 'local') return LocalAPI.handle(opts.method || 'GET', path, opts);
      if (opts.method?.toUpperCase() === 'POST' && /^\/api\/materials\/[^/]+\/stock$/.test(path))
        return durableStockRequest(path, opts);
      return serverRequest(resolveSyncBase(this.serverUrl), path, opts);
    };
    if (!opts.method || ['GET', 'HEAD'].includes(opts.method.toUpperCase())) return run();
    dataWritesInFlight++;
    try {
      return await (navigator.locks ? navigator.locks.request('pinbox-data-write', { mode: 'shared' }, run) : run());
    } finally { dataWritesInFlight--; }
  }
};

async function api(path, opts = {}) {
  return DataLayer.api(path, opts);
}

function syncBase() {
  if (DataLayer.settingsError) throw new Error(DataLayer.settingsError);
  return resolveSyncBase(DataLayer.serverUrl) || (isNativeHttpAvailable() ? '' : location.origin);
}

async function syncTestConnection(rawBase = DataLayer.serverUrl, token = DataLayer.token) {
  try {
    const base = resolveSyncBase(rawBase) || (isNativeHttpAvailable() ? '' : location.origin);
    if (!base) throw new Error('请先填写服务器地址');
    const res = await serverRequest(base, '/api/stats', { headers: { Authorization: token ? 'Bearer ' + token : '' } });
    const data = await res.json();
    if (!res.ok || !Number.isInteger(data.total_sku)) throw new Error(data.detail || `HTTP ${res.status}`);
    return { ok: true, msg: `连接成功：${data.total_sku} 款物料 / ${data.total_pieces} 件` };
  } catch (error) { return { ok: false, msg: '连接失败：' + error.message }; }
}

let syncInFlight = false;
async function withSyncLock(callback) {
  if (syncInFlight) return { ok: false, msg: '同步正在进行，请等待完成' };
  syncInFlight = true;
  try {
    if (navigator.locks) return await navigator.locks.request('pinbox-sync', callback);
    return await callback();
  } finally { syncInFlight = false; }
}

async function syncPushOps() {
  return withSyncLock(async () => {
    let pushed = 0;
    try {
      const base = syncBase();
      if (!base) throw new Error('请先填写服务器地址');
      const meta = await LocalDB.get('meta', 'sync_server');
      const generation = (await LocalDB.get('meta', 'generation'))?.value;
      if (meta?.value && meta.value !== base) throw new Error('本机队列属于另一台服务器，请先备份并核对');
      let dataset = await LocalDB.get('meta', 'dataset_id');
      if (!dataset?.value) {
        const stateRes = await serverRequest(base, '/api/sync/state');
        const state = await stateRes.json();
        if (!stateRes.ok || !state.dataset_id) throw new Error(state.detail || '服务器不支持安全同步，请先升级服务器');
        dataset = { key: 'dataset_id', value: state.dataset_id };
      }
      const ops = await LocalDB.transaction(['meta', 'pending_ops'], async db => {
        if ((await db.get('meta', 'generation'))?.value !== generation) throw new Error('本机数据在连接期间已变化，请重新核对');
        const pending = (await db.getAll('pending_ops')).sort((a, b) => a.id - b.id);
        await db.put('meta', dataset);
        if (pending.length) await db.put('meta', { key: 'sync_server', value: base });
        return pending;
      });
      for (const op of ops) {
        if ((await LocalDB.get('meta', 'generation'))?.value !== generation) throw new Error('本机数据已恢复或清空，已停止推送，请重新核对');
        if (!op.op_id) {
          throw new Error('旧版待同步操作缺少操作号，请先导出本地备份并核对是否已入账，再处理队列');
        }
        const res = await serverRequest(base, '/api/sync/op', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: op, dataset_id: dataset?.value || null })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        await LocalDB.transaction(['pending_ops', 'meta'], async db => {
          const current = await db.get('pending_ops', op.id);
          if ((await db.get('meta', 'generation'))?.value !== generation || !current || current.op_id !== op.op_id)
            throw new Error('本机数据已变化，未删除新队列；请核对服务器已收到的操作');
          await db.delete('pending_ops', op.id);
        });
        pushed++;
      }
      return { ok: true, pushed, msg: `推送完成：成功 ${pushed} 条；可拉取服务器快照核对最新库存` };
    } catch (error) {
      return { ok: false, pushed, msg: `已推送 ${pushed} 条；剩余操作已保留：${error.message}` };
    }
  });
}

async function syncPullSnapshot() {
  return withSyncLock(async () => {
    try {
      const base = syncBase();
      if (!base) throw new Error('请先填写服务器地址');
      if (await LocalDB.count('pending_ops')) throw new Error('尚有未推送操作，请先推送或导出备份处理冲突');
      const generation = (await LocalDB.get('meta', 'generation'))?.value;
      const res = await serverRequest(base, '/api/backup');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      await LocalDB.transaction(['materials', 'logs', 'locations', 'meta', 'pending_ops'], async db => {
        // A stock operation may have arrived while the HTTP request was in flight.
        if (await db.count('pending_ops')) throw new Error('拉取期间产生了新操作，已取消覆盖');
        if ((await db.get('meta', 'generation'))?.value !== generation) throw new Error('拉取期间本机数据已恢复或清空，已取消覆盖');
        await createLocalAPI(db).restoreSnapshot(data);
        await db.put('meta', { key: 'sync_server', value: base });
      });
      return { ok: true, msg: `拉取成功：${data.materials.length} 款物料 / ${(data.stock_logs || []).length} 条流水` };
    } catch (error) { return { ok: false, msg: '拉取失败：' + error.message }; }
  });
}

async function syncPendingCount() {
  return LocalDB.count('pending_ops');
}

async function withReplacementGuard(callback) {
  if (syncInFlight) throw new Error('同步正在进行，不能恢复或清空本机数据');
  if (navigator.locks) return navigator.locks.request('pinbox-sync', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('其他窗口正在同步，不能恢复或清空本机数据');
    return callback();
  });
  return callback();
}

let stockRequestBusy = false;
async function durableStockRequest(path, opts) {
  if (stockRequestBusy) throw new Error('上一笔库存操作尚未返回，请勿重复提交');
  stockRequestBusy = true;
  const run = async () => {
    const base = syncBase();
    if (!base) throw new Error('请先设置服务器地址');
    const payload = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    const signature = JSON.stringify([path, payload.delta, payload.reason || '', payload.project || '']);
    let pending = await LocalDB.get('online_ops', base);
    if (pending && pending.signature !== signature) throw new Error('有结果未确认的库存操作，请在数据中心「核对在线操作」中重试原操作');
    if (!pending) {
      const res = await serverRequest(base, '/api/sync/state');
      const data = await res.json();
      if (!res.ok || !data.dataset_id) throw new Error(data.detail || '服务器不支持安全记账，请先升级');
      pending = await LocalDB.transaction(['online_ops'], async db => {
        const existing = await db.get('online_ops', base);
        if (existing) {
          if (existing.signature !== signature) throw new Error('另一窗口有未确认操作，请先核对');
          return existing;
        }
        const record = { server: base, path, signature, payload: { ...payload, op_id: newOperationId(), dataset_id: data.dataset_id }, created_at: new Date().toISOString() };
        await db.add('online_ops', record);
        return record;
      });
    }
    try {
      const res = await serverRequest(base, pending.path, { ...opts, method: 'POST', body: JSON.stringify(pending.payload) });
      // Parse before deleting the durable request: a truncated success response is uncertain.
      const data = await res.clone().json();
      if (res.ok || [400, 404, 422].includes(res.status)) {
        await LocalDB.transaction(['online_ops'], async db => {
          const current = await db.get('online_ops', base);
          if (current?.payload.op_id === pending.payload.op_id) await db.delete('online_ops', base);
        });
      }
      return new Response(JSON.stringify(data), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      throw new Error('结果尚未确认，操作号已保留；重试原操作不会重复记账。' + error.message);
    }
  };
  try { return navigator.locks ? await navigator.locks.request('pinbox-online-stock', run) : await run(); }
  finally { stockRequestBusy = false; }
}
