const APP_VERSION = '1.0.21';

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
  const token = localStorage.getItem('wms-api-token');
  if (token) headers.set('Authorization', 'Bearer ' + token);
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

const DataLayer = {
  mode: localStorage.getItem('wms-mode') || (isStandaloneApp() ? 'local' : 'server'),
  serverUrl: localStorage.getItem('wms-server-url') || '',
  setMode(mode) {
    if (!['server', 'local'].includes(mode)) throw new Error('无效数据模式');
    this.mode = mode;
    localStorage.setItem('wms-mode', mode);
  },
  setServerUrl(value) {
    this.serverUrl = resolveSyncBase(value);
    localStorage.setItem('wms-server-url', this.serverUrl);
  },
  async api(path, opts = {}) {
    if (this.mode === 'local') return LocalAPI.handle(opts.method || 'GET', path, opts);
    return serverRequest(resolveSyncBase(this.serverUrl), path, opts);
  }
};

async function api(path, opts = {}) {
  return DataLayer.api(path, opts);
}

function syncBase() {
  return resolveSyncBase(DataLayer.serverUrl) || (isNativeHttpAvailable() ? '' : location.origin);
}

async function syncTestConnection() {
  try {
    const base = syncBase();
    if (!base) throw new Error('请先填写服务器地址');
    const res = await serverRequest(base, '/api/stats');
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
      if (meta?.value && meta.value !== base) throw new Error('本机队列属于另一台服务器，请先备份并核对');
      let dataset = await LocalDB.get('meta', 'dataset_id');
      if (!dataset?.value) {
        const stateRes = await serverRequest(base, '/api/sync/state');
        const state = await stateRes.json();
        if (!stateRes.ok || !state.dataset_id) throw new Error(state.detail || '服务器不支持安全同步，请先升级服务器');
        dataset = { key: 'dataset_id', value: state.dataset_id };
        await LocalDB.put('meta', dataset);
      }
      const ops = (await LocalDB.getAll('pending_ops')).sort((a, b) => a.id - b.id);
      if (ops.length) await LocalDB.put('meta', { key: 'sync_server', value: base });
      for (const op of ops) {
        if (!op.op_id) {
          throw new Error('旧版待同步操作缺少操作号，请先导出本地备份并核对是否已入账，再处理队列');
        }
        const res = await serverRequest(base, '/api/sync/op', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: op, dataset_id: dataset?.value || null })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        await LocalDB.delete('pending_ops', op.id);
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
      const res = await serverRequest(base, '/api/backup');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      await LocalDB.transaction(['materials', 'logs', 'locations', 'meta', 'pending_ops'], async db => {
        // A stock operation may have arrived while the HTTP request was in flight.
        if (await db.count('pending_ops')) throw new Error('拉取期间产生了新操作，已取消覆盖');
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
