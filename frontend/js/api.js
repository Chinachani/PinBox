// ============================================================
// DataLayer - 服务器/离线双模式数据层 + 同步
// ============================================================
// 独立运行环境判定：Capacitor 原生壳（APK）或 PWA standalone（安装到桌面）
function isStandaloneApp() {
  try {
    if (window.Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform()) return true;
  } catch (e) { /* 非 Capacitor 环境 */ }
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;   // iOS Safari 添加到主屏
}

// App 内原生 HTTP：走原生 HttpURLConnection，绕开 WebView 的混合内容/CORS 限制
function isNativeHttpAvailable() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
      && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp);
  } catch (e) { return false; }
}

async function nativeRequest(method, url, bodyObj) {
  const CHttp = window.Capacitor.Plugins.CapacitorHttp;
  const opts = {
    url,
    method: method.toUpperCase(),
    headers: { 'Content-Type': 'application/json' }
  };
  if (bodyObj !== undefined) opts.data = bodyObj;
  const r = await CHttp.request(opts);
  let data = r.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { /* 保留原始字符串 */ }
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => data };
}

// 同步地址解析：
//   - 浏览器 PWA（https 页面）禁止请求 http 接口 → 自动升级为 https 并换 8089 口
//   - Capacitor 原生壳按原样使用（已开启 cleartext，走 http 8088）
function resolveSyncBase(raw) {
  let url = (raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (window.location.protocol === 'https:' && url.startsWith('http://')) {
    url = 'https://' + url.slice(7).replace(':8088', ':8089');
  }
  return url;
}

// 与 package.json 同步的版本号（发版时一起改）
const APP_VERSION = '1.0.12';
// 用户自己的服务器（独立端首次使用时预置，免手填）
const DEFAULT_SERVER_URL = 'http://192.168.1.219:8088';

// 独立端首次启动：预置服务器地址，让「拉取/推送」开箱即用
if (isStandaloneApp() && !localStorage.getItem('wms-server-url')) {
  localStorage.setItem('wms-server-url', DEFAULT_SERVER_URL);
}

const DataLayer = {
  // 独立端（APK/桌面 PWA）默认本地离线模式；网页访问默认服务器模式。
  // 用户手动切换过则尊重 localStorage 的选择。
  mode: localStorage.getItem('wms-mode')
    || (isStandaloneApp() ? 'local' : 'server'),
  serverUrl: (localStorage.getItem('wms-server-url') || '').replace(/\/+$/, ''),

  setMode(mode) {
    this.mode = mode;
    localStorage.setItem('wms-mode', mode);
  },

  setServerUrl(url) {
    this.serverUrl = (url || '').trim().replace(/\/+$/, '');
    localStorage.setItem('wms-server-url', this.serverUrl);
  },

  // 统一请求入口：返回 Response-like 对象 {ok,status,json()}
  async api(path, opts = {}) {
    if (this.mode === 'local') {
      return LocalAPI.handle(opts.method || 'GET', path, opts);
    }
    const base = this.mode === 'server' && this.serverUrl ? this.serverUrl : '';
    const res = await fetch(base + path, opts);
    return res;
  }
};

async function api(path, opts = {}) {
  return DataLayer.api(path, opts);
}

// ---------- 同步功能 ----------

async function syncTestConnection() {
  const base = resolveSyncBase(DataLayer.serverUrl);
  if (!base) return { ok: false, msg: '请先填写服务器地址' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    let res;
    if (isNativeHttpAvailable()) {
      res = await nativeRequest('GET', base + '/api/stats');
    } else {
      res = await fetch(base + '/api/stats', { signal: ctrl.signal });
    }
    clearTimeout(timer);
    if (res.ok) {
      const d = await res.json();
      return { ok: true, msg: `连接成功（${base.replace(/^https?:\/\//, '')}）：${d.total_sku} 款物料 / ${d.total_pieces} 件` };
    }
    return { ok: false, msg: `服务器响应异常 (HTTP ${res.status})` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, msg: '连接失败：' + (e.message || '网络不可达') + '。请确认手机连的是家里 WiFi（4G 访问不到局域网地址）' };
  }
}

// 把本地离线操作推送到服务器
async function syncPushOps() {
  const base = resolveSyncBase(DataLayer.serverUrl);
  if (!base) return { ok: false, msg: '请先填写服务器地址' };
  const ops = await LocalDB.getAll('pending_ops');
  if (!ops.length) return { ok: true, msg: '没有待推送的离线变更', pushed: 0 };
  ops.sort((a, b) => a.id - b.id);

  const useNative = isNativeHttpAvailable();
  let pushed = 0, failed = 0, failMsg = '';
  for (const op of ops) {
    let res, data;
    try {
      switch (op.kind) {
        case 'stock':
          res = useNative
            ? await nativeRequest('POST', `${base}/api/materials/${op.code}/stock`, { delta: op.delta, reason: (op.reason || '') + '（离线同步）', project: op.project || '' })
            : await fetch(`${base}/api/materials/${op.code}/stock`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ delta: op.delta, reason: (op.reason || '') + '（离线同步）', project: op.project || '' })
              });
          break;
        case 'create':
          res = useNative
            ? await nativeRequest('POST', `${base}/api/materials`, op.payload)
            : await fetch(`${base}/api/materials`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(op.payload)
              });
          break;
        case 'update':
          res = useNative
            ? await nativeRequest('PUT', `${base}/api/materials/${op.code}`, op.payload)
            : await fetch(`${base}/api/materials/${op.code}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(op.payload)
              });
          break;
        case 'delete':
          res = useNative
            ? await nativeRequest('DELETE', `${base}/api/materials/${op.code}`)
            : await fetch(`${base}/api/materials/${op.code}`, { method: 'DELETE' });
          break;
        case 'location_create':
          res = useNative
            ? await nativeRequest('POST', `${base}/api/locations`, { name: op.name, note: op.note })
            : await fetch(`${base}/api/locations`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: op.name, note: op.note })
              });
          break;
        case 'location_update':
          res = useNative
            ? await nativeRequest('PUT', `${base}/api/locations/${op.id}`, op.payload)
            : await fetch(`${base}/api/locations/${op.id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(op.payload)
              });
          break;
        case 'location_delete':
          res = useNative
            ? await nativeRequest('DELETE', `${base}/api/locations/${op.id}?force=true`)
            : await fetch(`${base}/api/locations/${op.id}?force=true`, { method: 'DELETE' });
          break;
        case 'batch_location':
          res = useNative
            ? await nativeRequest('POST', `${base}/api/batch-location`, { codes: op.codes, location: op.location })
            : await fetch(`${base}/api/batch-location`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codes: op.codes, location: op.location })
              });
          break;
        default:
          failed++; failMsg = `未知操作类型 ${op.kind}`;
          continue;
      }
      data = await res.json().catch(() => ({}));
      if (res.ok) {
        await LocalDB.delete('pending_ops', op.id);
        pushed++;
      } else if (res.status === 400 && /已存在/.test(data.detail || '')) {
        // 建档冲突：转为更新
        if (op.kind === 'create' && op.payload && op.payload.code) {
          const { code, ...payload } = op.payload;
          const r2 = useNative
            ? await nativeRequest('PUT', `${base}/api/materials/${code}`, payload)
            : await fetch(`${base}/api/materials/${code}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });
          if (r2.ok) { await LocalDB.delete('pending_ops', op.id); pushed++; continue; }
        }
        // 其他 400（如库存不足）视为业务性失败，丢弃该条避免死循环
        await LocalDB.delete('pending_ops', op.id);
        failed++; failMsg = data.detail || '';
      } else {
        failed++; failMsg = data.detail || `HTTP ${res.status}`;
        break; // 网络/服务器异常时保留剩余操作，下次再推
      }
    } catch (e) {
      failed++; failMsg = '网络错误';
      break;
    }
  }
  return { ok: failed === 0, msg: `推送完成：成功 ${pushed} 条` + (failed ? `，失败 ${failed} 条（${failMsg}）` : ''), pushed };
}

// 从服务器拉取全量快照覆盖本地
async function syncPullSnapshot() {
  const base = resolveSyncBase(DataLayer.serverUrl);
  if (!base) return { ok: false, msg: '请先填写服务器地址' };
  try {
    let res, data;
    if (isNativeHttpAvailable()) {
      res = await nativeRequest('GET', base + '/api/backup');
      data = await res.json();
    } else {
      res = await fetch(base + '/api/backup');
      if (!res.ok) return { ok: false, msg: `拉取失败 (HTTP ${res.status})` };
      data = await res.json();
    }
    if (!data.materials || !data.materials.length) return { ok: false, msg: '服务器上没有物料数据' };
    if (!data.materials || !data.materials.length) return { ok: false, msg: '服务器上没有物料数据' };
    await LocalAPI.restoreSnapshot(data);
    return { ok: true, msg: `拉取成功：${data.materials.length} 款物料 / ${(data.locations || []).length} 个库位 / ${(data.stock_logs || []).length} 条流水` };
  } catch (e) {
    return { ok: false, msg: '拉取失败：确认手机连的是家里 WiFi，且 App 端使用 http://…:8088 端口' };
  }
}

async function syncPendingCount() {
  return LocalDB.count('pending_ops');
}
