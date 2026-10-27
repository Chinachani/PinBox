// ============================================================
// PinBox 引脚仓 WORKBENCH V3.0 前端应用
// ============================================================

const state = {
  materials: [],
  categories: [],
  locations: [],
  stats: {},
  activeCategory: '',
  searchQuery: '',
  quickFilter: '',        // '' | 'low_stock' | 'zero_stock' | 'unassigned'
  locationFilter: '',     // 按库位精确过滤
  selectMode: false,
  selectedCodes: new Set(),
  currentDetail: null,
  locAssignContext: null, // { type: 'single', code } | { type: 'batch' }
  editingMaterialCode: null,
  editingLoc: null,
  lastScan: null,         // 最近一次扫码的完整响应
  scanHistory: [],        // 本次会话扫码记录（仅前端内存）
  scanMode: 'normal',     // normal | in | out
  batchStats: { count: 0, pieces: 0, fail: 0 },
  bomState: { items: [], summary: null },
  deferredPrompt: null,
  stockPage: 1,
  stockTotalPages: 1,
  logsPage: 1,
  logsTotalPages: 1,
  logsType: '',
  logsDays: '',
  html5QrCode: null,
  isCameraRunning: false,
  initialLoaded: false
};

// ---------- 基础工具 ----------
function $(id) { return document.getElementById(id); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(t) {
  if (!t) return '';
  return String(t).replace('T', ' ').slice(0, 16);
}

function fmtNum(n) {
  return (n === null || n === undefined) ? '0' : Number(n).toLocaleString('zh-CN');
}

function fmtMoney(n) {
  const v = Number(n || 0);
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 中文输入法全角字符 → 半角归一化（０-９／＋－．），避免 parseInt/parseFloat 解析失败
function toHalfWidth(s) {
  return String(s ?? '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/＋/g, '+')
    .replace(/－/g, '-')
    .replace(/—/g, '-')
    .replace(/．/g, '.')
    .trim();
}

function parseIntSafe(s) {
  const cleaned = toHalfWidth(s).replace(/[^0-9+\-]/g, '');
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? NaN : n;
}

function parseFloatSafe(s) {
  const cleaned = toHalfWidth(s).replace(/[^0-9+.\-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? NaN : n;
}

let toastTimer = null;
function showToast(msg, type = 'success', duration = 2200) {
  const toast = $('toast');
  toast.innerText = msg;
  toast.className = `toast show ${type}`;
  if (navigator.vibrate) navigator.vibrate(type === 'error' ? [60, 40, 60] : 30);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, duration);
}

// ---------- 弹窗管理 ----------
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

function closeAllModals() {
  $$('.modal-overlay').forEach(m => m.classList.remove('show'));
}

// 通用确认框：返回 Promise<boolean>
let confirmResolve = null;
function showConfirm(title, msg, okText = '确认') {
  $('confirm-title').innerText = title;
  $('confirm-msg').innerText = msg;
  $('btn-confirm-ok').innerText = okText;
  openModal('confirm-modal');
  return new Promise(resolve => { confirmResolve = resolve; });
}

// ---------- 主题 ----------
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function initTheme() {
  const saved = localStorage.getItem('wms-theme');
  if (saved) applyTheme(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme')
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('wms-theme', next);
}

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(() => console.log('PWA Service Worker Registered'))
      .catch(err => console.log('SW Registration failed', err));
  });
}

// ---------- WebSocket 实时同步 ----------
let wsConn = null;
let wsReconnectTimer = null;
let wsRefreshTimer = null;

function initLiveSync() {
  if (DataLayer.mode === 'local') return;   // 离线模式不需要
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = DataLayer.mode === 'server' && DataLayer.serverUrl
      ? DataLayer.serverUrl.replace(/^http/, 'ws')
      : `${proto}://${location.host}`;
    wsConn = new WebSocket(`${base}/ws`);

    wsConn.onopen = () => {
      const dot = document.querySelector('#header-stat .dot');
      if (dot) dot.style.background = 'var(--accent)';
    };
    wsConn.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // 500ms 防抖合并多次变更；当前正在输入/弹窗打开时不打扰
      clearTimeout(wsRefreshTimer);
      wsRefreshTimer = setTimeout(() => {
        loadStats();
        if (!$('#search-box-container') || $('#search-box-container').style.display === 'none') return;
        loadMaterials();
        loadCategories();
      }, 500);
      const code = msg.code || '';
      const action = { stock: '库存变动', create: '新料建档', update: '档案更新', delete: '物料删除', batch_location: '批量归位' }[msg.type] || '数据更新';
      showToast(`🔄 ${action}${code ? ' ' + code : ''}（已同步）`, 'info', 1800);
    };
    wsConn.onclose = () => {
      const dot = document.querySelector('#header-stat .dot');
      if (dot) dot.style.background = 'var(--warning)';
      // 断线 5s 重连
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(initLiveSync, 5000);
    };
  } catch (e) { /* 浏览器不支持则忽略 */ }
}

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initNav();
  initSearch();
  initScanner();
  initModals();
  initImport();
  initToolbar();
  initBarcodeGunListener();
  initToolsTabs();

  $('btn-theme-toggle').addEventListener('click', toggleTheme);

  loadStats();
  loadCategories();
  loadLocations(true);
  loadMaterials();
  initLiveSync();
});

// ---------- 1. 导航 ----------
function initNav() {
  $$('.bottom-nav .nav-item').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });
  $$('.desktop-sidebar .sidebar-item').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });
}

function switchView(viewId) {
  $$('.bottom-nav .nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewId);
  });
  $$('.desktop-sidebar .sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewId);
  });
  $$('.view-container').forEach(view => {
    view.classList.toggle('active', view.id === viewId);
  });

  const searchContainer = $('search-box-container');
  const catChips = $('cat-chips');
  if (viewId === 'view-stock') {
    searchContainer.style.display = 'flex';
    catChips.style.display = 'flex';
  } else {
    searchContainer.style.display = 'none';
    catChips.style.display = 'none';
  }

  if (viewId !== 'view-scan' && state.isCameraRunning) {
    stopCamera();
  }

  if (viewId === 'view-location') {
    loadLocations();
  } else if (viewId === 'view-tools') {
    loadStats();
    loadDashboard();
    loadRecentLogs();
    loadRestock();
    loadProjectStats();
  }
}

// ---------- 管理页 4 大分栏 Tab 切换 ----------
function initToolsTabs() {
  const tabBtns = $$('.tools-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      $$('.tools-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === targetTab));
      $$('.tools-tab-pane').forEach(p => p.classList.toggle('active', p.id === `pane-${targetTab}`));
    });
  });
}

// ---------- 2. 统计 ----------
async function loadStats() {
  try {
    const res = await api('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    state.stats = data;

    const valText = data.total_asset_value ? ` · ￥${fmtMoney(data.total_asset_value)}` : '';
    const summaryText = `${fmtNum(data.total_sku)} 款 · ${fmtNum(data.total_pieces)} 件${valText}`;
    const modeTag = DataLayer.mode === 'local' ? ' · 本地离线' : '';
    const headerStat = $('header-stat-text');
    if (headerStat) headerStat.innerText = summaryText + modeTag;
    const netDot = document.querySelector('#header-stat .dot');
    if (netDot) netDot.style.background = DataLayer.mode === 'local' ? 'var(--warning)' : 'var(--accent)';
    const netState = $('sidebar-net-state');
    if (netState) {
      netState.innerText = DataLayer.mode === 'local' ? '本地离线' : '在线';
      netState.style.color = DataLayer.mode === 'local' ? 'var(--warning)' : 'var(--accent)';
    }
    // 侧栏拆两行显示，避免折行难看
    const sideStat = $('sidebar-stat-val');
    if (sideStat) sideStat.innerText = `${fmtNum(data.total_sku)} 款 · ${fmtNum(data.total_pieces)} 件`;
    const sideAsset = $('sidebar-stat-asset');
    if (sideAsset) sideAsset.innerText = `￥${fmtMoney(data.total_asset_value)}`;

    $('stat-sku').innerText = fmtNum(data.total_sku);
    $('stat-pieces').innerText = fmtNum(data.total_pieces);
    $('stat-assigned').innerText = fmtNum(data.assigned_locations);
    $('stat-unassigned').innerText = fmtNum(data.unassigned_locations);
    $('stat-lowstock').innerText = fmtNum(data.low_stock);
    const assetEl = $('stat-asset-val');
    if (assetEl) assetEl.innerText = `￥${fmtMoney(data.total_asset_value)}`;
  } catch (e) {
    console.error('Failed to load stats', e);
  }
}

// ---------- 3. 分类 ----------
async function loadCategories() {
  try {
    const res = await api('/api/categories');
    if (!res.ok) return;
    const cats = await res.json();
    state.categories = cats;

    const container = $('cat-chips');
    container.innerHTML = `<div class="cat-chip ${state.activeCategory === '' ? 'active' : ''}" data-cat="">全部品类</div>`;

    cats.forEach(c => {
      const chip = document.createElement('div');
      chip.className = `cat-chip ${state.activeCategory === c.category ? 'active' : ''}`;
      chip.dataset.cat = c.category;
      chip.innerText = `${c.category} (${c.count})`;
      chip.addEventListener('click', () => {
        $$('.cat-chip').forEach(el => el.classList.remove('active'));
        chip.classList.add('active');
        state.activeCategory = c.category;
        state.stockPage = 1;
        loadMaterials();
      });
      container.appendChild(chip);
    });

    container.querySelector('.cat-chip[data-cat=""]').addEventListener('click', () => {
      $$('.cat-chip').forEach(el => el.classList.remove('active'));
      container.querySelector('.cat-chip[data-cat=""]').classList.add('active');
      state.activeCategory = '';
      state.stockPage = 1;
      loadMaterials();
    });

    // 分类下拉数据
    const dl = $('category-datalist');
    if (dl) dl.innerHTML = cats.map(c => `<option value="${escapeHtml(c.category)}">`).join('');
  } catch (e) {
    console.error('Failed to load categories', e);
  }
}

// ---------- 4. 搜索与快捷筛选 ----------
function initSearch() {
  const catScroll = $('cat-chips');
  if (catScroll) {
    catScroll.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        catScroll.scrollLeft += e.deltaY;
      }
    }, { passive: false });
  }

  const input = $('search-input');
  const clearBtn = $('btn-clear-search');

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearBtn.style.display = input.value.trim() ? 'flex' : 'none';
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.searchQuery = input.value.trim();
      state.stockPage = 1;
      loadMaterials();
    }, 200);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    state.searchQuery = '';
    state.stockPage = 1;
    loadMaterials();
    input.focus();
  });

  // 快捷筛选 chips
  $$('#quick-filters .qfilter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#quick-filters .qfilter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.quickFilter = btn.dataset.filter;
      state.stockPage = 1;
      loadMaterials();
    });
  });

  // 电脑端快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) {
      const isInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (!isInput) {
        e.preventDefault();
        switchView('view-stock');
        input.focus();
      }
    }
    if (e.key === 'Escape') {
      closeAllModals();
    }
  });
}

// 库位过滤 chip（动态插入快捷筛选行首）
function renderLocFilterChip() {
  let chip = $('loc-filter-chip');
  if (state.locationFilter) {
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'loc-filter-chip';
      chip.className = 'qfilter active';
      chip.title = '点击清除库位过滤';
      chip.addEventListener('click', () => {
        state.locationFilter = '';
        state.stockPage = 1;
        renderLocFilterChip();
        loadMaterials();
      });
      $('quick-filters').prepend(chip);
    }
    chip.textContent = `库位: ${state.locationFilter} ✕`;
  } else if (chip) {
    chip.remove();
  }
}

// ---------- 5. 物料列表 ----------
async function loadMaterials() {
  const listEl = $('material-list');
  const emptyEl = $('stock-empty');

  let url = `/api/materials?page=${state.stockPage}&page_size=24`;
  if (state.searchQuery) url += `&q=${encodeURIComponent(state.searchQuery)}`;
  if (state.activeCategory) url += `&category=${encodeURIComponent(state.activeCategory)}`;
  if (state.locationFilter) url += `&location=${encodeURIComponent(state.locationFilter)}`;
  if (state.quickFilter === 'low_stock') url += '&low_stock=true';
  if (state.quickFilter === 'zero_stock') url += '&zero_stock=true';
  if (state.quickFilter === 'unassigned') url += '&unassigned=true';

  try {
    if (!state.initialLoaded) {
      listEl.innerHTML = Array.from({ length: 6 }).map(() => `
        <div class="skeleton-card">
          <div class="skeleton-line" style="width: 45%;"></div>
          <div class="skeleton-line" style="width: 85%;"></div>
          <div class="skeleton-line" style="width: 60%;"></div>
          <div class="skeleton-line" style="width: 30%;"></div>
        </div>
      `).join('');
    }

    const res = await api(url);
    if (!res.ok) return;
    const resp = await res.json();
    const items = resp.items || [];
    state.materials = items;
    state.stockTotalPages = resp.total_pages || 1;
    state.initialLoaded = true;

    const pageIndicator = $('stock-page-indicator');
    if (pageIndicator) pageIndicator.innerText = `第 ${resp.page} / ${resp.total_pages || 1} 页 (共 ${fmtNum(resp.total)} 款)`;

    const prevBtn = $('btn-stock-prev');
    const nextBtn = $('btn-stock-next');
    if (prevBtn) prevBtn.disabled = resp.page <= 1;
    if (nextBtn) nextBtn.disabled = resp.page >= resp.total_pages;
    const paginationEl = $('stock-pagination');
    if (paginationEl) paginationEl.style.display = resp.total_pages > 1 ? 'flex' : 'none';

    if (items.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'none';
      // 找料模式：本地检索无结果 → 规格引擎反查
      if (state.searchQuery && !state.locationFilter && !state.quickFilter && !state.activeCategory) {
        await renderFindResults(state.searchQuery);
        if (paginationEl) paginationEl.style.display = 'none';
        return;
      }
      emptyEl.style.display = 'flex';
      if (paginationEl) paginationEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.innerHTML = items.map(it => renderMaterialCard(it)).join('');
    bindMaterialCardEvents();
    renderLocFilterChip();
  } catch (e) {
    console.error('Failed to load materials', e);
  }
}

// ---------- 找料模式渲染 ----------
async function renderFindResults(query) {
  const listEl = $('material-list');
  const emptyEl = $('stock-empty');
  try {
    const res = await api(`/api/find?q=${encodeURIComponent(query)}`);
    if (!res.ok) { emptyEl.style.display = 'flex'; return; }
    const data = await res.json();
    if (!data.results || !data.results.length) {
      emptyEl.style.display = 'flex';
      return;
    }
    // 顶部说明条：解析出的规格原子
    const spec = data.spec || {};
    const specBits = [
      spec.package && `封装 ${spec.package}`,
      spec.res_values.length && `阻值 ${spec.res_values.slice(0, 2).join('/')}`,
      spec.cap_values.length && `容值 ${spec.cap_values.slice(0, 2).join('/')}`,
      spec.ind_values.length && `感量 ${spec.ind_values[0]}`,
    ].filter(Boolean).join(' · ');

    const banner = `
      <div style="grid-column: 1 / -1; background: var(--primary-light); border: 1px solid var(--primary); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 12px; color: var(--primary); margin-bottom: 2px;">
        🔍 找料引擎：本地无精确匹配，为你解读规格${specBits ? `（${specBits}）` : ''}并匹配库存 ${data.results.length} 款
      </div>`;

    listEl.innerHTML = banner + data.results.map(m => renderMaterialCard(m)).join('');
    bindMaterialCardEvents();
    showToast(`找到 ${data.results.length} 款相似库存`, 'info');
  } catch (e) {
    emptyEl.style.display = 'flex';
  }
}

function isLow(it) {
  return it.quantity === 0 || (it.min_stock > 0 && it.quantity <= it.min_stock);
}

function renderMaterialCard(it) {
  const low = isLow(it);
  const lowBadge = (it.min_stock > 0 && it.quantity <= it.min_stock && it.quantity > 0)
    ? `<span class="card-low-badge">低于预警 ${it.min_stock}</span>` : '';

  const locDisplay = it.location
    ? `<span class="card-location assigned" data-act="loc" data-code="${escapeHtml(it.code)}" title="点击修改库位"># ${escapeHtml(it.location)}</span>`
    : `<span class="card-location unassigned" data-act="loc" data-code="${escapeHtml(it.code)}" title="点击设置库位">+ 设库位</span>`;

  const selected = state.selectedCodes.has(it.code) ? ' selected' : '';

  return `
    <div class="material-card${low ? (it.quantity === 0 ? ' is-zero' : ' is-low') : ''}${selected}" data-code="${escapeHtml(it.code)}">
      <input type="checkbox" class="card-select-box" data-code="${escapeHtml(it.code)}" ${state.selectedCodes.has(it.code) ? 'checked' : ''} title="选择">
      <div class="card-top">
        <span class="card-code">${escapeHtml(it.code)}</span>
        <div class="card-top-right">
          ${lowBadge}
          ${locDisplay}
        </div>
      </div>
      <div class="card-title">${escapeHtml(it.model)}</div>
      <div class="card-meta">
        ${it.brand ? `<span class="meta-tag">${escapeHtml(it.brand)}</span>` : ''}
        ${it.package && it.package !== '-' ? `<span class="meta-tag font-mono">${escapeHtml(it.package)}</span>` : ''}
        <span class="meta-tag">${escapeHtml(it.category)}</span>
        ${it.price > 0 ? `<span class="meta-tag price">￥${it.price}</span>` : ''}
      </div>
      ${it.use_case ? `<div class="card-use">${escapeHtml(it.use_case)}</div>` : ''}
      <div class="card-bottom">
        <div class="stock-display">
          <span class="stock-num ${it.quantity === 0 ? 'zero' : (low ? 'low' : '')}" id="stock-val-${escapeHtml(it.code)}">${it.quantity}</span>
          <span class="stock-unit">${escapeHtml(it.unit || '个')}</span>
        </div>
        <div class="quick-actions">
          <button class="btn-stock btn-minus" data-act="minus" data-code="${escapeHtml(it.code)}" title="快速领料 -1">−</button>
          <button class="btn-stock btn-plus" data-act="plus" data-code="${escapeHtml(it.code)}" title="快速入库 +1">＋</button>
        </div>
      </div>
    </div>
  `;
}

function bindMaterialCardEvents() {
  // 整卡点击 → 详情
  $$('#material-list .material-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-stock') || e.target.closest('.card-select-box') || e.target.closest('.card-location')) return;
      openDetailModal(card.dataset.code);
    });
  });

  $$('#material-list .card-location').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openLocAssignSingle(el.dataset.code);
    });
  });

  $$('#material-list .btn-minus').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      adjustStockQuick(btn.dataset.code, -1);
    });
  });

  $$('#material-list .btn-plus').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      adjustStockQuick(btn.dataset.code, 1);
    });
  });

  $$('#material-list .card-select-box').forEach(box => {
    box.addEventListener('change', () => {
      if (box.checked) state.selectedCodes.add(box.dataset.code);
      else state.selectedCodes.delete(box.dataset.code);
      const card = box.closest('.material-card');
      if (card) card.classList.toggle('selected', box.checked);
      updateBatchBar();
    });
  });
}

// ---------- 6. 库存增减 ----------
// 读当前库存（用于出库闸门判断），找不到返回 null
function peekCurrentQty(code) {
  if (state.currentDetail && state.currentDetail.code === code) return state.currentDetail.quantity;
  if (state.lastScan && state.lastScan.material && state.lastScan.material.code === code) return state.lastScan.material.quantity;
  const m = state.materials.find(x => x.code === code);
  return m ? m.quantity : null;
}

// 出库撤销条（5 秒内可撤）
let undoTimer = null;
let lastUndoOp = null;
function showUndoBar(code, delta, remaining) {
  lastUndoOp = { code, delta };
  const bar = $('undo-bar');
  if (!bar) return;
  $('undo-text').innerText = `已出库 ${Math.abs(delta)} 个 · ${code}（现存 ${remaining}）`;
  bar.style.display = 'flex';
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoBar, 5000);
}

function hideUndoBar() {
  const bar = $('undo-bar');
  if (bar) bar.style.display = 'none';
  clearTimeout(undoTimer);
}

async function adjustStockQuick(code, delta, opts = {}) {
  // 出库确认闸门：一次出超过现存一半，弹确认（连续批量模式跳过，数量来自标签本身）
  if (delta < 0 && !opts.skipGate) {
    const cur = peekCurrentQty(code);
    const need = Math.abs(delta);
    if (cur !== null && need * 2 > cur) {
      const ok = await showConfirm('出库确认',
        `即将出库 ${need} 个，超过现存 ${cur} 的一半。\n确定要继续吗？`, '继续出库');
      if (!ok) return { ok: false, cancelled: true };
    }
  }
  try {
    const res = await api(`/api/materials/${code}/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delta,
        reason: opts.reason || (delta > 0 ? '快捷入库' : '领料出库'),
        project: opts.project || ''
      })
    });

    const result = await res.json();
    if (!res.ok) {
      showToast(result.detail || '调整失败', 'error');
      return { ok: false, error: result.detail };
    }

    const valEl = $(`stock-val-${code}`);
    if (valEl) {
      valEl.innerText = result.current;
      valEl.classList.toggle('zero', result.current === 0);
    }
    // 扫码结果卡同步
    if (state.lastScan && state.lastScan.material && state.lastScan.material.code === code) {
      state.lastScan.material.quantity = result.current;
      const resQtyEl = $('res-qty');
      if (resQtyEl) resQtyEl.innerText = result.current;
    }
    // 详情弹窗同步
    if (state.currentDetail && state.currentDetail.code === code) {
      state.currentDetail.quantity = result.current;
    }
    if (!opts.silent) {
      if (delta < 0) showUndoBar(code, delta, result.current);
      else showToast(`${code} 入库 ${Math.abs(delta)}，现存 ${result.current}`, 'success', 1600);
    }
    loadStats();
    return { ok: true, result };
  } catch (e) {
    showToast('网络请求失败', 'error');
    return { ok: false };
  }
}

// ---------- 7. 批量模式 ----------
function initToolbar() {
  $('btn-select-mode').addEventListener('click', toggleSelectMode);
  $('btn-batch-cancel').addEventListener('click', toggleSelectMode);

  $('batch-select-all').addEventListener('change', (e) => {
    const checked = e.target.checked;
    $$('#material-list .card-select-box').forEach(box => {
      box.checked = checked;
      if (checked) state.selectedCodes.add(box.dataset.code);
      else state.selectedCodes.delete(box.dataset.code);
      const card = box.closest('.material-card');
      if (card) card.classList.toggle('selected', checked);
    });
    updateBatchBar();
  });

  $('btn-batch-location').addEventListener('click', () => {
    if (state.selectedCodes.size === 0) {
      showToast('请先勾选要归位的物料', 'info');
      return;
    }
    openLocModalBatch();
  });

  $('btn-add-material').addEventListener('click', () => openMaterialModal('create'));

  // 统计卡跳转
  $('stat-lowstock-card').addEventListener('click', () => {
    switchView('view-stock');
    setQuickFilter('low_stock');
  });
  $('stat-unassigned-card').addEventListener('click', () => {
    switchView('view-stock');
    setQuickFilter('unassigned');
  });
}

function setQuickFilter(filter) {
  state.quickFilter = filter;
  $$('#quick-filters .qfilter').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  state.stockPage = 1;
  loadMaterials();
}

function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  if (!state.selectMode) {
    state.selectedCodes.clear();
  }
  $('batch-bar').style.display = state.selectMode ? 'flex' : 'none';
  $('material-list').classList.toggle('select-mode', state.selectMode);
  $('batch-select-all').checked = false;
  updateBatchBar();
  // 重新渲染以同步勾选状态
  if (state.materials.length) {
    $('material-list').innerHTML = state.materials.map(it => renderMaterialCard(it)).join('');
    bindMaterialCardEvents();
  }
}

function updateBatchBar() {
  $('batch-count').innerText = state.selectedCodes.size;
}

// ---------- 8. 扫码中心 ----------
function initScanner() {
  $('btn-start-camera').addEventListener('click', () => {
    if (state.isCameraRunning) stopCamera();
    else startCamera();
  });

  $('btn-photo-scan').addEventListener('click', () => $('camera-file-input').click());

  $('camera-file-input').addEventListener('change', async (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    e.target.value = '';
    showToast('正在解析包装袋二维码…', 'info');

    // 双引擎：先前端极速识别，失败后回退后端多尺度增强
    let text = null;
    try {
      // 立创包装袋是二维码：构造时限定 QR_CODE，避免先跑一维条形码拖慢识别
      const qrScanner = new Html5Qrcode('qr-reader', {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE]
      });
      text = await qrScanner.scanFile(file, false);
    } catch (err) { /* 继续后端识别 */ }

    if (text) {
      handleScanText(text);
      return;
    }

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api('/api/scan-image', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.decoded) {
        handleScanResultData(data);
      } else if (data.detail && data.detail.includes('离线')) {
        showToast(data.detail, 'error', 3200);
      } else {
        showToast('未识别到二维码，建议更平整靠近拍摄', 'error');
      }
    } catch (err) {
      showToast('识别处理出错，请重试', 'error');
    }
  });

  // 手动输入解析
  $('btn-manual-parse').addEventListener('click', () => {
    const v = $('manual-code-input').value.trim();
    if (!v) return;
    handleScanText(v);
  });
  $('manual-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = $('manual-code-input').value.trim();
      if (v) handleScanText(v);
    }
  });

  // 连续模式切换
  $$('#scan-mode-seg button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#scan-mode-seg button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.scanMode = btn.dataset.mode;
      if (state.scanMode === 'normal') {
        $('batch-session-bar').style.display = 'none';
        $('batch-records').style.display = 'none';
      } else {
        $('batch-session-bar').style.display = 'flex';
        $('batch-records').style.display = 'flex';
        clearBatchRecords();
        state.batchStats = { count: 0, pieces: 0, fail: 0 };
        updateBatchSessionBar();
        showToast(state.scanMode === 'in'
          ? '连续入库模式：每扫一袋按标签数量自动入库（同袋 10 秒内不重复计）'
          : '连续出库模式：每扫一袋按标签数量自动出库', 'info', 3200);
      }
    });
  });
  $('btn-batch-finish').addEventListener('click', () => {
    const s = state.batchStats;
    showToast(`本次连续${state.scanMode === 'out' ? '出库' : '入库'}结束：${s.count} 款 / ${Math.abs(s.pieces)} 件` + (s.fail ? ` / 异常 ${s.fail}` : ''), 'success', 3600);
    state.batchStats = { count: 0, pieces: 0, fail: 0 };
    clearBatchRecords();
    updateBatchSessionBar();
  });

  // 清空扫码记录
  const clearHistBtn = $('btn-clear-scan-history');
  if (clearHistBtn) {
    clearHistBtn.addEventListener('click', () => {
      state.scanHistory = [];
      renderScanHistory();
    });
  }

  // 结果卡出入库
  $('btn-res-minus').addEventListener('click', () => {
    if (!state.lastScan || !state.lastScan.material) return;
    const count = parseIntSafe($('res-custom-qty').value) || 1;
    adjustStockQuick(state.lastScan.material.code, -Math.abs(count));
  });
  $('btn-res-plus').addEventListener('click', () => {
    if (!state.lastScan || !state.lastScan.material) return;
    const count = parseIntSafe($('res-custom-qty').value) || 1;
    adjustStockQuick(state.lastScan.material.code, Math.abs(count));
  });
  $('btn-res-detail').addEventListener('click', () => {
    if (state.lastScan && state.lastScan.material) openDetailModal(state.lastScan.material.code);
  });

  // 未建档 → 一键建档
  $('btn-scan-create').addEventListener('click', () => {
    if (!state.lastScan) return;
    const p = state.lastScan.parsed || {};
    openMaterialModal('create', {
      code: p.code || '',
      model: p.model || '',
      quantity: p.quantity || ''
    });
  });
}

async function startCamera() {
  const placeholder = $('camera-placeholder');
  const laserLine = $('scanner-laser-line');
  const btn = $('btn-start-camera');

  try {
    state.html5QrCode = new Html5Qrcode('qr-reader', {
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE]
    });
    placeholder.style.display = 'none';
    if (laserLine) laserLine.style.display = 'block';

    let lastScanTime = 0;
    let lastScanContent = '';

    await state.html5QrCode.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        // 识别区取画面短边 62% 的正方形：二维码占框更满，远距离小码更容易命中
        qrbox: (vf) => {
          const s = Math.round(Math.min(vf.width, vf.height) * 0.62);
          return { width: s, height: s };
        },
        // 视觉取景框同步缩小到 62%（CSS 用 176px 固定值，这里用变量对齐）
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }
      },
      (decodedText) => {
        const now = Date.now();
        const batch = state.scanMode !== 'normal';
        if (decodedText === lastScanContent && now - lastScanTime < (batch ? 10000 : 3000)) return;
        if (now - lastScanTime < (batch ? 1500 : 1000)) return;
        lastScanTime = now;
        lastScanContent = decodedText;
        handleScanText(decodedText);
      },
      () => {}
    );

    state.isCameraRunning = true;
    $('camera-box').classList.add('running');
    btn.innerHTML = '<span>停止扫码</span>';
  } catch (err) {
    placeholder.style.display = 'flex';
    if (laserLine) laserLine.style.display = 'none';
    $('camera-box').classList.remove('running');
    console.error('Camera start failed', err);
    showToast('摄像头不可用（HTTP 下浏览器限制），请使用【拍照/选图识别】或访问 HTTPS 端口', 'error', 3500);
  }
}

function stopCamera() {
  const laserLine = $('scanner-laser-line');
  if (state.html5QrCode && state.isCameraRunning) {
    state.html5QrCode.stop().then(() => {
      state.html5QrCode.clear();
      state.isCameraRunning = false;
      $('camera-box').classList.remove('running');
      $('camera-placeholder').style.display = 'flex';
      if (laserLine) laserLine.style.display = 'none';
      $('btn-start-camera').innerHTML = '<span>实时扫码</span>';
    }).catch(err => console.error(err));
  }
}

function gotoLocationFilter(locName) {
  if (!locName) return;
  showToast(`识别到库位「${locName}」，正在跳转…`, 'info');
  switchView('view-stock');
  state.locationFilter = locName;
  state.searchQuery = '';
  $('search-input').value = '';
  state.quickFilter = '';
  $$('#quick-filters .qfilter').forEach(b => b.classList.toggle('active', b.dataset.filter === ''));
  state.stockPage = 1;
  renderLocFilterChip();
  loadMaterials();
}

async function handleScanText(rawText) {
  const text = (rawText || '').trim();
  if (!text) return;

  // 库位标签：完整 URL 带 ?loc= 参数（打印标签上的二维码内容，手机相机可直接扫）
  let locMatch = text.match(/[?&]loc=([^&\s]+)/);
  if (locMatch) {
    const locName = decodeURIComponent(locMatch[1]);
    gotoLocationFilter(locName);
    return;
  }

  // 库位标签：纯 LOC:<name> 文本（兼容旧标签/手输）
  if (text.toUpperCase().startsWith('LOC:')) {
    const locName = text.slice(4).trim();
    gotoLocationFilter(locName);
    return;
  }

  try {
    const res = await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    handleScanResultData(data);
  } catch (e) {
    showToast('解析请求失败', 'error');
  }
}

function handleScanResultData(data) {
  state.lastScan = data;
  const foundCard = $('scan-result-card');
  const newCard = $('scan-new-card');
  foundCard.classList.remove('show');
  newCard.classList.remove('show');
  const hintEl = $('res-hint');
  if (hintEl) hintEl.style.display = 'none';

  if (data.found && data.material) {
    const it = data.material;
    pushScanHistory({ code: it.code, model: it.model, found: true });
    $('res-code').innerText = it.code;
    const locEl = $('res-location');
    locEl.innerText = it.location ? `# ${it.location}` : '待归位';
    locEl.className = 'card-location ' + (it.location ? 'assigned' : 'unassigned');
    $('res-title').innerText = it.model;
    $('res-brand').innerText = it.brand || '原厂';
    $('res-pkg').innerText = it.package || '-';
    $('res-cat').innerText = it.category;
    $('res-qty').innerText = it.quantity;
    $('res-unit').innerText = it.unit || '个';
    const hintEl = $('res-hint');
    if (hintEl) {
      if (it.last_in) {
        const days = Math.floor((Date.now() - new Date(it.last_in.replace(' ', 'T')).getTime()) / 86400000);
        hintEl.innerText = `上次入库 ${formatTime(it.last_in).slice(5, 10)}${days >= 1 ? `（${days} 天前）` : '（今天）'} · 本次入库为并入`;
        hintEl.style.display = 'block';
      } else {
        hintEl.style.display = 'none';
      }
    }
    const customQtyInput = $('res-custom-qty');
    if (customQtyInput) {
      customQtyInput.value = data.parsed && data.parsed.quantity ? data.parsed.quantity : 1;
    }
    foundCard.classList.add('show');
    foundCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    showToast(`已识别: ${it.code} (${it.model})`, 'success', 1600);
    // 连续模式：识别即按标签数量自动出入库
    if (state.scanMode !== 'normal') {
      const qty = (data.parsed && data.parsed.quantity) || 1;
      const delta = state.scanMode === 'in' ? Math.abs(qty) : -Math.abs(qty);
      autoBatchStock(it.code, delta, it);
    }
  } else if (data.parsed && data.parsed.code) {
    $('new-code').innerText = data.parsed.code;
    $('new-model').innerText = data.parsed.model || '标签未含型号，可在建档时补充';
    $('new-qty-hint').innerText = `标签数量: ${data.parsed.quantity || '--'} · 库中暂无该编号，一键建档后即可出入库`;
    newCard.classList.add('show');
    newCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (navigator.vibrate) navigator.vibrate(40);
    pushScanHistory({ code: data.parsed.code, model: data.parsed.model || '', found: false });
    showToast(`识别到新料 ${data.parsed.code}，可一键建档`, 'info', 2400);
  } else {
    const raw = (data.raw_text || '').slice(0, 40);
    showToast(raw ? `识别内容: ${raw}` : '未识别到有效编号', 'info');
  }
}

// ---------- 8.5 连续扫码批量出入库 ----------
async function autoBatchStock(code, delta, material) {
  const r = await adjustStockQuick(code, delta, {
    reason: delta > 0 ? '连续扫码批量入库' : '连续扫码批量出库',
    silent: true,
    skipGate: true
  });
  const s = state.batchStats;
  if (r.ok) {
    s.count += 1;
    s.pieces += Math.abs(delta);
    showToast(`${code} ${delta > 0 ? '+' : ''}${delta} → 现存 ${r.result.current}`, 'success', 1400);
    addBatchRecord({ code, model: material ? material.model : '', delta, ok: true, remaining: r.result.current });
  } else {
    s.fail += 1;
    addBatchRecord({ code, model: material ? material.model : '', delta, ok: false, error: r.error });
  }
  updateBatchSessionBar();
}

// 逐笔记录：新记录插最上面，保留全部历史
function addBatchRecord({ code, model, delta, ok, remaining, error }) {
  const box = $('batch-records');
  if (!box) return;
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const cls = ok ? (delta > 0 ? 'in' : 'out') : 'fail';
  const div = document.createElement('div');
  div.className = `batch-record-item ${cls}`;
  div.innerHTML = ok
    ? `<span class="bri-code">${escapeHtml(code)}</span>
       <span class="bri-model">${escapeHtml(model || '')}</span>
       <span class="bri-delta ${cls}">${delta > 0 ? '+' : ''}${delta}</span>
       <span style="font-size: 10px; color: var(--muted); flex-shrink: 0;">现存${remaining}</span>
       <span class="bri-time">${time}</span>`
    : `<span class="bri-code">${escapeHtml(code)}</span>
       <span class="bri-model">${escapeHtml(error || '操作失败')}</span>
       <span class="bri-delta fail">失败</span>
       <span class="bri-time">${time}</span>`;
  box.prepend(div);
}

function clearBatchRecords() {
  const box = $('batch-records');
  if (box) box.innerHTML = '';
}

function updateBatchSessionBar() {
  const s = state.batchStats;
  $('bs-count').innerText = s.count;
  $('bs-pieces').innerText = Math.abs(s.pieces);
  $('bs-fail').innerText = s.fail;
  $('bs-fail-box').style.display = s.fail ? 'flex' : 'none';
}

// ---------- 9. 扫码枪全局监听 ----------
function pushScanHistory(entry) {
  // 同一编号连续重复扫描只刷新时间不重复占行
  const existing = state.scanHistory.find(h => h.code === entry.code);
  if (existing) {
    existing.time = Date.now();
    existing.found = entry.found;
  } else {
    state.scanHistory.unshift({ ...entry, time: Date.now() });
    if (state.scanHistory.length > 10) state.scanHistory.pop();
  }
  renderScanHistory();
}

function renderScanHistory() {
  const el = $('scan-history');
  if (!el) return;
  if (!state.scanHistory.length) {
    el.innerHTML = '<div class="dash-empty">暂无记录，扫一个试试</div>';
    return;
  }
  el.innerHTML = state.scanHistory.map(h => `
    <div class="scan-history-item" data-code="${escapeHtml(h.code)}">
      <span class="shi-code">${escapeHtml(h.code)}</span>
      <span class="shi-model">${escapeHtml(h.model || '未识别型号')}</span>
      <span class="shi-status ${h.found ? 'ok' : 'new'}">${h.found ? '在库' : '新料'}</span>
    </div>
  `).join('');
  el.querySelectorAll('.scan-history-item').forEach(item => {
    item.addEventListener('click', () => {
      const code = item.dataset.code;
      const h = state.scanHistory.find(x => x.code === code);
      if (h && h.found) {
        openDetailModal(code);
      } else {
        openMaterialModal('create', { code, model: h ? h.model : '' });
      }
    });
  });
}

function initBarcodeGunListener() {
  let buffer = '';
  let lastTime = 0;

  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const isInput = ['INPUT', 'TEXTAREA'].includes(active.tagName);
    if (isInput && active.id !== 'manual-code-input') return;

    const now = Date.now();
    if (now - lastTime > 150) buffer = '';
    lastTime = now;

    if (e.key === 'Enter') {
      if (buffer.length >= 4) {
        const content = buffer;
        buffer = '';
        handleScanText(content);
      }
    } else if (e.key.length === 1) {
      buffer += e.key;
    }
  });
}

// ---------- 10. 库位看板 ----------
async function loadLocations(silent = false) {
  try {
    const res = await api('/api/locations');
    if (!res.ok) return;
    const locs = await res.json();
    state.locations = locs;
    if (!silent) renderLocationGrid(locs);
    // 库位下拉数据
    const dl = $('loc-datalist');
    if (dl) {
      dl.innerHTML = locs
        .filter(l => l.name !== '未分配库位')
        .map(l => `<option value="${escapeHtml(l.name)}">`).join('');
    }
  } catch (e) {
    console.error('Failed to load locations', e);
  }
}

function renderLocationGrid(locs) {
  const grid = $('location-grid');
  if (!grid) return;

  grid.innerHTML = locs.map(l => {
    const unassigned = !!l.unassigned;
    const actions = unassigned ? '' : `
      <div class="loc-actions">
        <button class="loc-action-btn" data-act="edit" data-id="${l.id}" title="编辑/重命名">✎</button>
        <button class="loc-action-btn" data-act="print" data-name="${escapeHtml(l.name)}" title="打印标签">🖨</button>
        <button class="loc-action-btn danger" data-act="del" data-id="${l.id}" title="删除">✕</button>
      </div>`;
    return `
      <div class="loc-card${unassigned ? ' unassigned-card' : ''}${l.sku_count === 0 ? ' empty-loc' : ''}" data-loc="${escapeHtml(l.name)}">
        ${actions}
        <div class="loc-title">
          <span class="loc-glyph">
            <svg style="width: 13px; height: 13px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
          </span>
          <span>${escapeHtml(l.name)}</span>
        </div>
        ${l.note ? `<div class="loc-note" title="${escapeHtml(l.note)}">${escapeHtml(l.note)}</div>` : ''}
        <div class="loc-badge">${l.sku_count} <span class="loc-badge-unit">款物料</span></div>
        <div class="loc-stat">共计 ${fmtNum(l.pieces)} 件元件</div>
      </div>
    `;
  }).join('');

  // 卡片点击 → 库存页按库位过滤
  grid.querySelectorAll('.loc-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.loc-action-btn')) return;
      const loc = card.dataset.loc;
      switchView('view-stock');
      state.locationFilter = loc === '未分配库位' ? '' : loc;
      if (loc === '未分配库位') setQuickFilter('unassigned');
      else {
        setQuickFilter('');
        state.locationFilter = loc;
        renderLocFilterChip();
        loadMaterials();
      }
    });
  });

  // 卡片操作
  grid.querySelectorAll('.loc-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      const loc = locs.find(l => String(l.id) === btn.dataset.id || l.name === btn.dataset.name);
      if (!loc) return;
      if (act === 'edit') openLocManageModal(loc);
      else if (act === 'print') printLocationLabels([loc]);
      else if (act === 'del') deleteLocationFlow(loc);
    });
  });

  // 工具栏按钮
  $('btn-create-location').onclick = () => openLocManageModal(null);
  $('btn-print-all-labels').onclick = () => {
    const realLocs = state.locations.filter(l => !l.unassigned);
    if (!realLocs.length) {
      showToast('还没有任何库位，先新建一个吧', 'info');
      return;
    }
    printLocationLabels(realLocs);
  };
  $('btn-filter-unassigned').onclick = () => {
    switchView('view-stock');
    setQuickFilter('unassigned');
  };
}

// 库位新建/编辑
function openLocManageModal(loc) {
  state.editingLoc = loc;
  $('loc-manage-title').innerText = loc ? '编辑库位' : '新建库位';
  $('lm-name').value = loc ? loc.name : '';
  $('lm-note').value = loc ? (loc.note || '') : '';
  $('btn-delete-location').style.display = loc ? 'flex' : 'none';
  openModal('loc-manage-modal');
  setTimeout(() => $('lm-name').focus(), 80);
}

function deleteLocationFlow(loc) {
  showConfirm('删除库位', `确定删除库位「${loc.name}」吗？其下 ${loc.sku_count} 款物料将变为「待归位」。`, '强制删除').then(ok => {
    if (!ok) return;
    api(`/api/locations/${loc.id}?force=true`, { method: 'DELETE' })
      .then(res => res.json())
      .then(data => {
        if (data.message) {
          showToast(data.message, 'success');
          loadLocations();
          loadStats();
        } else {
          showToast(data.detail || '删除失败', 'error');
        }
      })
      .catch(() => showToast('删除请求失败', 'error'));
  });
}

// ---------- 11. 库位归位弹窗（单个/批量） ----------
async function openLocAssignSingle(code) {
  const item = state.materials.find(m => m.code === code) || state.lastScan?.material;
  if (!item) return;
  state.locAssignContext = { type: 'single', code };
  $('loc-modal-title').innerText = '物料归位设置';
  $('loc-modal-items-box').innerHTML = `
    <div class="lm-title">${escapeHtml(item.model)}</div>
    <div class="lm-code">${escapeHtml(item.code)} · 当前: ${item.location ? '# ' + escapeHtml(item.location) : '待归位'}</div>
  `;
  $('input-new-location').value = item.location || '';
  await fillQuickLocTags();
  openModal('location-modal');
  setTimeout(() => $('input-new-location').focus(), 80);
}

async function openLocModalBatch() {
  state.locAssignContext = { type: 'batch', codes: Array.from(state.selectedCodes) };
  $('loc-modal-title').innerText = '批量归位';
  $('loc-modal-items-box').innerHTML = `
    <div class="lm-title">已选择 ${state.selectedCodes.size} 款物料</div>
    <div class="lm-more">${Array.from(state.selectedCodes).slice(0, 8).map(escapeHtml).join('、')}${state.selectedCodes.size > 8 ? ' …' : ''}</div>
  `;
  $('input-new-location').value = '';
  await fillQuickLocTags();
  openModal('location-modal');
  setTimeout(() => $('input-new-location').focus(), 80);
}

async function fillQuickLocTags() {
  if (!state.locations.length) await loadLocations(true);
  const container = $('quick-loc-tags');
  const existingLocs = (state.locations || [])
    .map(l => l.name)
    .filter(name => name && name !== '未分配库位');

  if (existingLocs.length > 0) {
    container.innerHTML = existingLocs.map(t =>
      `<span class="quick-tag" data-loc="${escapeHtml(t)}">${escapeHtml(t)}</span>`
    ).join('');
    container.querySelectorAll('.quick-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        $('input-new-location').value = tag.dataset.loc;
      });
    });
  } else {
    container.innerHTML = '<span style="font-size: 11px; color: var(--muted);">暂无已创建库位，可直接输入新盒号（保存后自动登记）</span>';
  }
}

// ---------- 12. 弹窗初始化与动作 ----------
function initModals() {
  // 点击遮罩关闭
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('show');
    });
  });

  // 关闭按钮
  $('btn-close-loc-modal').addEventListener('click', () => closeModal('location-modal'));
  $('btn-close-material-modal').addEventListener('click', () => closeModal('material-modal'));
  $('btn-close-loc-manage').addEventListener('click', () => closeModal('loc-manage-modal'));
  $('btn-close-detail-modal').addEventListener('click', () => closeModal('detail-modal'));
  $('btn-close-confirm').addEventListener('click', () => {
    closeModal('confirm-modal');
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  });

  // 确认框
  $('btn-confirm-cancel').addEventListener('click', () => {
    closeModal('confirm-modal');
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  });
  $('btn-confirm-ok').addEventListener('click', () => {
    closeModal('confirm-modal');
    if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
  });

  // 保存归位
  $('btn-save-location').addEventListener('click', saveLocationAssign);
  $('input-new-location').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveLocationAssign();
  });

  // 跳转库位管理
  $('btn-goto-manage-loc').addEventListener('click', () => {
    closeModal('location-modal');
    switchView('view-location');
  });

  // 库位管理弹窗保存/删除
  $('btn-save-loc-manage').addEventListener('click', saveLocManage);
  $('btn-delete-location').addEventListener('click', () => {
    if (!state.editingLoc) return;
    closeModal('loc-manage-modal');
    deleteLocationFlow(state.editingLoc);
  });

  // 物料表单提交
  $('material-form').addEventListener('submit', submitMaterialForm);
  $('btn-delete-material').addEventListener('click', async () => {
    const code = state.editingMaterialCode;
    if (!code) return;
    closeModal('material-modal');
    const ok = await showConfirm('删除物料', `确定删除 ${code} 吗？其出入库流水将一并删除，且不可恢复！`, '删除');
    if (!ok) return;
    try {
      const res = await api(`/api/materials/${code}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        showToast(data.message || '已删除', 'success');
        closeModal('detail-modal');
        loadMaterials();
        loadCategories();
        loadStats();
        loadLocations(true);
      } else {
        showToast(data.detail || '删除失败', 'error');
      }
    } catch (e) {
      showToast('删除请求失败', 'error');
    }
  });

  // 详情弹窗动作
  $('btn-detail-edit').addEventListener('click', () => {
    if (state.currentDetail) {
      closeModal('detail-modal');
      openMaterialModal('edit', state.currentDetail);
    }
  });
  $('btn-detail-loc').addEventListener('click', () => {
    if (state.currentDetail) {
      closeModal('detail-modal');
      openLocAssignSingle(state.currentDetail.code);
    }
  });
  $('btn-detail-print').addEventListener('click', () => {
    if (state.currentDetail) printMaterialLabel(state.currentDetail);
  });

  $('btn-lcsc-price').addEventListener('click', async () => {
    if (!state.currentDetail) return;
    const code = state.currentDetail.code;
    const local = state.currentDetail.price > 0 ? `你的记录价 ￥${state.currentDetail.price}` : '未记录采购价';
    try {
      const res = await api(`/api/lcsc/price/${code}`);
      const data = await res.json();
      if (data.ok && data.url) {
        window.open(data.url, '_blank', 'noopener');
        showToast(`${local} · 已打开立创页面查看实时价`, 'info', 3000);
      } else {
        showToast(data.message || '请用「立创页面」按钮查看', 'error', 3000);
      }
    } catch (e) {
      showToast('请求失败', 'error');
    }
  });

  $('btn-apply-stock-delta').addEventListener('click', async () => {
    if (!state.currentDetail) return;
    const delta = parseIntSafe($('detail-delta-input').value);
    if (isNaN(delta) || delta === 0) {
      showToast('请输入有效的数量数值（如 +5 或 -2）', 'error');
      return;
    }
    const code = state.currentDetail.code;
    const project = ($('detail-project-input').value || '').trim();
    await adjustStockQuick(code, delta, { project, reason: project ? `项目领料 [${project}]` : undefined });
    $('detail-delta-input').value = '';
    openDetailModal(code);
  });
  $('detail-delta-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-apply-stock-delta').click();
  });

  $('btn-save-price').addEventListener('click', async () => {
    if (!state.currentDetail) return;
    const priceVal = parseFloatSafe($('detail-price-input').value);
    if (isNaN(priceVal) || priceVal < 0) {
      showToast('请输入有效的单价（如 2.36）', 'error');
      return;
    }
    const code = state.currentDetail.code;
    try {
      const res = await api(`/api/materials/${code}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price: priceVal })
      });
      if (res.ok) {
        showToast(`已更新 ${code} 定价为 ￥${priceVal}`, 'success');
        state.currentDetail.price = priceVal;
        openDetailModal(code);
        loadMaterials();
        loadStats();
      }
    } catch (e) {
      showToast('更新失败', 'error');
    }
  });

  // 库存分页
  $('btn-stock-prev').onclick = () => {
    if (state.stockPage > 1) {
      state.stockPage--;
      loadMaterials();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
  $('btn-stock-next').onclick = () => {
    if (state.stockPage < state.stockTotalPages) {
      state.stockPage++;
      loadMaterials();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // 流水分页与搜索
  $('btn-logs-prev').onclick = () => { if (state.logsPage > 1) loadRecentLogs(state.logsPage - 1); };
  $('btn-logs-next').onclick = () => { if (state.logsPage < state.logsTotalPages) loadRecentLogs(state.logsPage + 1); };
  $('btn-logs-search').onclick = () => loadRecentLogs(1);
  $('logs-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadRecentLogs(1);
  });

  // 出库撤销条
  $('btn-undo').addEventListener('click', () => {
    if (!lastUndoOp) return;
    adjustStockQuick(lastUndoOp.code, -lastUndoOp.delta, {
      reason: '撤销出库', skipGate: true, silent: true
    });
    hideUndoBar();
  });
  $('btn-undo-close').addEventListener('click', hideUndoBar);

  // BOM / 补货 / 项目 / PWA / 备份
  initBom();
  initToolPanels();

  // 库位页工具栏：事件委托兜底（renderLocationGrid 重渲染间隙 onclick 为空也不怕）
  $('btn-create-location').addEventListener('click', () => {
    // renderLocationGrid 的 onclick 正常时它自己会触发；这里仅兜底
    setTimeout(() => {
      if (!document.getElementById('loc-manage-modal').classList.contains('show')
          && !document.getElementById('location-modal').classList.contains('show')
          && typeof state.editingLoc === 'undefined' || state.editingLoc === null) {
        // 若 onclick 未生效（网格未渲染），直接打开
        if (!$('btn-create-location').onclick) openLocManageModal(null);
      }
    }, 0);
  });

  // 流水类型 / 时间筛选
  $$('#logs-type-chips .qfilter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#logs-type-chips .qfilter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.logsType = btn.dataset.type;
      loadRecentLogs(1);
    });
  });
  $('logs-time-select').addEventListener('change', (e) => {
    state.logsDays = e.target.value;
    loadRecentLogs(1);
  });
}

async function saveLocationAssign() {
  const ctx = state.locAssignContext;
  if (!ctx) return;
  const newLoc = $('input-new-location').value.trim();

  try {
    let res;
    if (ctx.type === 'single') {
      res = await api(`/api/materials/${ctx.code}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: newLoc })
      });
    } else {
      res = await api('/api/batch-location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: ctx.codes, location: newLoc })
      });
    }
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || (newLoc ? `已归位到「${newLoc}」` : '已移出库位'), 'success');
      closeModal('location-modal');
      loadMaterials();
      loadStats();
      loadLocations(true);
      // 批量后退出选择模式
      if (ctx.type === 'batch' && state.selectMode) toggleSelectMode();
    } else {
      showToast(data.detail || '保存失败', 'error');
    }
  } catch (e) {
    showToast('保存请求失败', 'error');
  }
}

async function saveLocManage() {
  const name = $('lm-name').value.trim();
  const note = $('lm-note').value.trim();
  if (!name) {
    showToast('库位名称不能为空', 'error');
    return;
  }
  try {
    let res;
    if (state.editingLoc) {
      res = await api(`/api/locations/${state.editingLoc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, note })
      });
    } else {
      res = await api('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, note })
      });
    }
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || '已保存', 'success');
      closeModal('loc-manage-modal');
      loadLocations();
      loadStats();
    } else {
      showToast(data.detail || '保存失败', 'error');
    }
  } catch (e) {
    showToast('保存请求失败', 'error');
  }
}

// ---------- 13. 物料建档/编辑 ----------
async function openMaterialModal(mode, prefill) {
  state.editingMaterialCode = null;
  const form = $('material-form');
  form.reset();

  if (mode === 'edit' && prefill) {
    state.editingMaterialCode = prefill.code;
    $('material-modal-title').innerText = `编辑物料档案 · ${prefill.code}`;
    $('mf-code').value = prefill.code;
    $('mf-code').disabled = true;
    $('mf-model').value = prefill.model || '';
    $('mf-category').value = prefill.category || '';
    $('mf-brand').value = prefill.brand || '';
    $('mf-package').value = prefill.package || '';
    $('mf-unit').value = prefill.unit || '个';
    $('mf-price').value = prefill.price > 0 ? prefill.price : '';
    $('mf-min-stock').value = prefill.min_stock || 0;
    $('mf-location').value = prefill.location || '';
    $('mf-use').value = prefill.use_case || '';
    $('mf-remark').value = prefill.remark || '';
    // 编辑模式：数量由出入库流水管理，锁定
    $('mf-quantity').value = prefill.quantity;
    $('mf-quantity').disabled = true;
    $('mf-quantity').placeholder = '在详情弹窗中调整库存';
    $('btn-delete-material').style.display = 'flex';
  } else {
    $('material-modal-title').innerText = '新建物料档案';
    $('mf-code').disabled = false;
    $('mf-quantity').disabled = false;
    $('mf-quantity').placeholder = '0';
    $('btn-delete-material').style.display = 'none';
    if (prefill) {
      $('mf-code').value = prefill.code || '';
      $('mf-model').value = prefill.model || '';
      $('mf-quantity').value = prefill.quantity || '';
    }
  }

  if (!state.locations.length) await loadLocations(true);
  openModal('material-modal');
  setTimeout(() => $('mf-code').focus(), 80);
}

async function submitMaterialForm(e) {
  e.preventDefault();
  const code = $('mf-code').value.trim().toUpperCase();
  const model = $('mf-model').value.trim();
  if (!code) { showToast('C 编号不能为空', 'error'); return; }
  if (!model) { showToast('型号/名称不能为空', 'error'); return; }

  const payload = {
    code,
    model,
    category: $('mf-category').value.trim() || '未分类',
    brand: $('mf-brand').value.trim(),
    package: $('mf-package').value.trim(),
    unit: $('mf-unit').value.trim() || '个',
    price: parseFloatSafe($('mf-price').value) || 0,
    min_stock: parseIntSafe($('mf-min-stock').value) || 0,
    location: $('mf-location').value.trim(),
    use_case: $('mf-use').value.trim(),
    remark: $('mf-remark').value.trim()
  };

  try {
    let res;
    if (state.editingMaterialCode) {
      res = await api(`/api/materials/${state.editingMaterialCode}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      payload.quantity = parseIntSafe($('mf-quantity').value) || 0;
      payload.batch = '手动建档';
      res = await api('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    const data = await res.json();
    if (res.ok) {
      showToast(state.editingMaterialCode ? '档案已更新' : `建档成功: ${code}`, 'success');
      closeModal('material-modal');
      if (state.currentDetail && state.currentDetail.code === code) openDetailModal(code);
      loadMaterials();
      loadCategories();
      loadStats();
      loadLocations(true);
    } else {
      showToast(data.detail || '保存失败', 'error');
      // 新建档撞号 → 引导直接入库（去重提醒）
      if (!state.editingMaterialCode && data.detail && data.detail.includes('已存在')) {
        closeModal('material-modal');
        const ok = await showConfirm('编号已存在',
          `${code} 已在库中，无需重复建档。要直接为它入库吗？`, '去入库');
        if (ok) {
          switchView('view-scan');
          $('manual-code-input').value = code;
          handleScanText(code);
        }
      }
    }
  } catch (err) {
    showToast('保存请求失败', 'error');
  }
}

// ---------- 14. 详情弹窗 ----------
async function openDetailModal(code) {
  try {
    const res = await api(`/api/materials/${code}`);
    if (!res.ok) { showToast('获取详情失败', 'error'); return; }
    const it = await res.json();
    state.currentDetail = it;

    $('detail-code').innerText = it.code;
    const locEl = $('detail-location');
    locEl.innerText = it.location ? `# ${it.location}` : '待归位';
    locEl.className = 'card-location ' + (it.location ? 'assigned' : 'unassigned');
    $('detail-title').innerText = it.model;
    const lcscLink = $('detail-lcsc-link');
    if (lcscLink) lcscLink.href = `https://so.szlcsc.com/global.html?k=${it.code}`;
    const projInput = $('detail-project-input');
    if (projInput) projInput.value = '';

    const lowTag = isLow(it) ? `<span class="meta-tag" style="color: var(--warning); font-weight: 700;">⚠ 低库存</span>` : '';
    $('detail-meta').innerHTML = `
      ${it.brand ? `<span class="meta-tag">品牌: ${escapeHtml(it.brand)}</span>` : ''}
      ${it.package ? `<span class="meta-tag font-mono">封装: ${escapeHtml(it.package)}</span>` : ''}
      <span class="meta-tag">分类: ${escapeHtml(it.category)}</span>
      <span class="meta-tag" style="color: var(--primary); font-weight: 600;">在库: ${fmtNum(it.quantity)} ${escapeHtml(it.unit || '个')}</span>
      ${it.min_stock > 0 ? `<span class="meta-tag">预警线: ${it.min_stock}</span>` : ''}
      ${it.price > 0 ? `<span class="meta-tag price">单价: ￥${it.price}</span>` : ''}
      ${it.batch ? `<span class="meta-tag">批次: ${escapeHtml(it.batch)}</span>` : ''}
      ${lowTag}
    `;

    $('detail-use').innerText = it.use_case ? `实验用途: ${it.use_case}` : '暂无特定用途描述';
    const priceInput = $('detail-price-input');
    if (priceInput) priceInput.value = it.price > 0 ? it.price : '';

    const logsEl = $('detail-logs');
    if (it.logs && it.logs.length > 0) {
      logsEl.innerHTML = it.logs.map(l => `
        <div class="detail-log-row">
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(l.reason || '变动')}${l.project ? ' · 📦 ' + escapeHtml(l.project) : ''} <b class="detail-log-delta ${l.delta > 0 ? 'in' : (l.delta < 0 ? 'out' : 'neutral')}">(${l.delta > 0 ? '+' : ''}${l.delta})</b></span>
          <span style="color: var(--muted); flex-shrink: 0;">${formatTime(l.created_at)}</span>
        </div>
      `).join('');
    } else {
      logsEl.innerHTML = '<div style="color: var(--muted); padding: 8px 0;">暂无出入库流水</div>';
    }

    openModal('detail-modal');
  } catch (e) {
    showToast('获取详情失败', 'error');
  }
}

// ---------- 15. 标签打印 ----------
function qrSvgTag(text) {
  // 中文必须走 UTF-8 字节模式，否则扫出乱码
  qrcode.stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// 库位二维码内容：完整 URL（手机相机扫码直接打开 App 并筛选该收纳盒）
function locQrText(locName) {
  const base = DataLayer.mode === 'server' && DataLayer.serverUrl
    ? DataLayer.serverUrl
    : window.location.origin;
  return `${base}/?loc=${encodeURIComponent(locName)}`;
}

async function printLocationLabels(locs) {
  showToast('正在生成标签（含盒内清单）…', 'info');
  // 并行拉取每个库位的物料清单，标签上直接印内容预览
  const withItems = await Promise.all(locs.map(async l => {
    try {
      const res = await api(`/api/materials?location=${encodeURIComponent(l.name)}&page_size=5&sort_by=code_asc`);
      const d = await res.json();
      return { loc: l, items: d.items || [], total: d.total || 0 };
    } catch (e) {
      return { loc: l, items: [], total: 0 };
    }
  }));

  // 打印时间戳（说明清单数据时点）
  const printTs = formatTime(new Date().toLocaleString('sv-SE').replace('T', ' '));

  const labels = withItems.map(({ loc, items, total }) => {
    const rows = items.length
      ? items.map(m => {
          // 每款料标注最近一次出入库时间，久未动的好识别
          const lastTouched = m.updated_at ? formatTime(m.updated_at) : '';
          const staleDays = m.updated_at ? Math.floor((Date.now() - new Date(m.updated_at.replace(' ', 'T'))) / 86400000) : null;
          const staleTag = staleDays !== null && staleDays >= 30 ? `<span class="li-stale">${staleDays}天未动</span>` : '';
          return `
          <div class="li-row">
            <span class="li-code">${escapeHtml(m.code)}</span>
            <span class="li-model">${escapeHtml((m.model || '').slice(0, 14))}${staleTag}</span>
            <span class="li-qty">x${m.quantity}</span>
            <span class="li-time">${lastTouched.slice(5, 10)}</span>
          </div>`;}).join('') + (total > items.length ? `<div class="li-more">…等共 ${total} 款</div>` : '')
      : '<div class="li-empty">空盒 · 待归位</div>';
    return `
      <div class="label">
        <div class="label-head">
          <div class="label-qr">${qrSvgTag(locQrText(loc.name))}</div>
          <div class="label-head-info">
            <div class="label-name">${escapeHtml(loc.name)}</div>
            <div class="label-sub">${escapeHtml(loc.note || '元件收纳盒')}</div>
            <div class="label-stat">${total} 款 · ${loc.pieces || 0} 件</div>
          </div>
        </div>
        <div class="label-list">
          <div class="li-title">盒内物料</div>
          ${rows}
        </div>
        <div class="label-foot"><span>PinBox 引脚仓 · 扫码查本盒清单</span><span class="foot-ts">打印于 ${printTs}</span></div>
      </div>
    `;
  }).join('');
  openPrintWindow(labels);
}

function printMaterialLabel(m) {
  const labels = `
    <div class="label">
      <div class="label-qr">${qrSvgTag(m.code)}</div>
      <div class="label-info">
        <div class="label-name">${escapeHtml(m.code)}</div>
        <div class="label-sub">${escapeHtml(m.model)}</div>
        <div class="label-foot">${m.location ? '库位 ' + escapeHtml(m.location) + ' · ' : ''}PinBox 引脚仓</div>
      </div>
    </div>
  `;
  openPrintWindow(labels);
}

function openPrintWindow(labelsHtml) {
  // 使用隐藏 iframe 打印：不依赖弹窗权限，移动端 PWA 内同样可用
  const oldFrame = document.getElementById('print-frame');
  if (oldFrame) oldFrame.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'print-frame';
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>标签打印 - PinBox 引脚仓</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; padding: 16px; background: #fff; }
  h2 { font-size: 15px; color: #1f2328; margin-bottom: 8px; }
  .tip { font-size: 11px; color: #656d76; margin-bottom: 14px; line-height: 1.5; }
  .labels { display: grid; grid-template-columns: repeat(auto-fill, 300px); gap: 14px; justify-content: center; }
  .label {
    width: 300px;
    border: 2px solid #1f2328;
    border-radius: 10px;
    background: #fff;
    page-break-inside: avoid;
    overflow: hidden;
  }
  .label-head {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 12px 14px 10px;
    border-bottom: 1.5px dashed #c9d1d9;
  }
  .label .label-qr { width: 88px; height: 88px; flex-shrink: 0; }
  .label .label-qr svg { width: 88px; height: 88px; display: block; }
  .label-head-info { min-width: 0; }
  .label-name { font-family: ui-monospace, Menlo, monospace; font-size: 20px; font-weight: 800; color: #1f2328; word-break: break-all; line-height: 1.2; }
  .label-sub { font-size: 12px; color: #57606a; margin-top: 4px; }
  .label-stat { font-size: 12px; font-weight: 700; color: #0969da; margin-top: 6px; font-family: ui-monospace, Menlo, monospace; }
  .label-list { padding: 8px 14px 10px; }
  .li-title { font-size: 10px; font-weight: 700; color: #8c959f; letter-spacing: 1px; margin-bottom: 4px; }
  .li-row { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; border-bottom: 1px solid #f0f2f4; }
  .li-row:last-of-type { border-bottom: none; }
  .li-code { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; font-weight: 700; color: #0969da; flex-shrink: 0; }
  .li-model { font-size: 11px; color: #1f2328; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .li-qty { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #57606a; flex-shrink: 0; }
  .li-more { font-size: 10px; color: #8c959f; padding-top: 3px; }
  .li-empty { font-size: 11px; color: #9a6700; padding: 2px 0 4px; }
  .li-time { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: #8c959f; flex-shrink: 0; }
  .li-stale { font-size: 9px; font-weight: 700; color: #9a6700; background: #fff8c5; border-radius: 3px; padding: 0 3px; margin-left: 4px; }
  .label-foot { display: flex; justify-content: space-between; align-items: center; }
  .foot-ts { font-family: ui-monospace, Menlo, monospace; }
  .label-foot { padding: 6px 14px; background: #f6f8fa; border-top: 1.5px solid #1f2328; font-size: 10px; color: #656d76; }
  @media print {
    body { padding: 0; }
    h2, .tip { display: none; }
    .labels { gap: 10px; }
    .label { border-radius: 6px; }
  }
</style>
</head>
<body>
  <h2>PinBox 引脚仓 · 标签打印</h2>
  <div class="tip">物料标签扫码即调出物料；库位标签为「打开本系统的链接」，手机相机扫码直达该收纳盒清单。</div>
  <div class="labels">${labelsHtml}</div>
</body>
</html>`);
  doc.close();

  const doPrint = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      showToast('当前环境不支持直接打印，可截图或用电脑浏览器打开', 'error', 3200);
    }
  };
  // 等二维码 SVG 图全部加载完成再打印
  const imgs = Array.from(doc.images || []);
  if (imgs.length) {
    Promise.all(imgs.map(img => img.complete ? Promise.resolve() :
      new Promise(res => { img.onload = img.onerror = res; })))
      .then(() => setTimeout(doPrint, 250));
  } else {
    setTimeout(doPrint, 400);
  }
  showToast('已生成打印预览，请在打印对话框中确认', 'info', 2600);
}

// ---------- 16. 导入与恢复 ----------
function initImport() {
  const triggerBtn = $('btn-trigger-import');
  const fileInput = $('import-file-input');

  triggerBtn.addEventListener('click', () => fileInput.click());
  triggerBtn.addEventListener('dragover', (e) => { e.preventDefault(); triggerBtn.style.borderColor = 'var(--primary)'; });
  triggerBtn.addEventListener('dragleave', () => { triggerBtn.style.borderColor = 'var(--border)'; });
  triggerBtn.addEventListener('drop', (e) => {
    e.preventDefault();
    triggerBtn.style.borderColor = 'var(--border)';
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      fileInput.dispatchEvent(new Event('change'));
    }
  });

  fileInput.addEventListener('change', async (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('file', file);

    triggerBtn.disabled = true;
    triggerBtn.innerHTML = `<span>⏳ 正在智能解析订单表格…</span>`;
    showToast('正在解析并导入立创对账单…', 'info');
    try {
      const res = await api('/api/import', { method: 'POST', body: formData });
      const data = await res.json();
      triggerBtn.disabled = false;
      triggerBtn.innerHTML = `<svg style="width: 16px; height: 16px; color: var(--muted);" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg><span>选择或拖拽对账单文件上传</span>`;
      if (res.ok) {
        const skipText = data.skipped ? `，跳过 ${data.skipped} 条无效记录` : '';
        showToast(`导入成功: 新增 ${data.newly_added} 款，累加 ${data.stock_updated} 款${skipText}`, 'success', 3200);
        loadStats();
        loadMaterials();
        loadCategories();
        loadLocations(true);
      } else {
        showToast(data.detail || '导入失败', 'error', 3200);
      }
    } catch (e) {
      triggerBtn.disabled = false;
      triggerBtn.innerHTML = `<span>选择或拖拽对账单文件上传</span>`;
      showToast('上传处理失败', 'error');
    }
  });

  // 备份恢复
  $('btn-restore').addEventListener('click', () => $('restore-file-input').click());
  $('restore-file-input').addEventListener('change', async (e) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    const ok = await showConfirm('恢复备份',
      '恢复操作会【清空并覆盖】当前全部物料、流水与库位数据！确定要继续吗？', '覆盖恢复');
    if (!ok) { e.target.value = ''; return; }
    const formData = new FormData();
    formData.append('file', file);
    showToast('正在恢复备份…', 'info');
    try {
      const res = await api('/api/restore?confirm=yes', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        showToast(`恢复完成: ${data.materials} 款物料 / ${data.locations} 个库位 / ${data.logs} 条流水`, 'success', 3200);
        state.initialLoaded = false;
        loadStats();
        loadMaterials();
        loadCategories();
        loadLocations();
        loadDashboard();
        loadRecentLogs();
      } else {
        showToast(data.detail || '恢复失败', 'error', 3200);
      }
    } catch (err) {
      showToast('恢复请求失败', 'error');
    } finally {
      e.target.value = '';
    }
  });
}

// ---------- 17. 流水 ----------
async function loadRecentLogs(page = 1) {
  state.logsPage = page;
  const q = ($('logs-search-input')?.value || '').trim();
  try {
    let url = `/api/logs?page=${page}&page_size=15`;
    if (q) url += `&q=${encodeURIComponent(q)}`;
    if (state.logsType) url += `&type=${state.logsType}`;
    if (state.logsDays) url += `&days=${state.logsDays}`;
    const res = await api(url);
    if (!res.ok) return;
    const resp = await res.json();
    const logs = resp.logs || [];
    state.logsTotalPages = resp.total_pages || 1;

    const ind = $('logs-page-indicator');
    if (ind) ind.innerText = `第 ${resp.page} / ${resp.total_pages || 1} 页 (共 ${fmtNum(resp.total)} 条)`;

    const prevBtn = $('btn-logs-prev');
    const nextBtn = $('btn-logs-next');
    if (prevBtn) prevBtn.disabled = resp.page <= 1;
    if (nextBtn) nextBtn.disabled = resp.page >= resp.total_pages;

    const logsEl = $('recent-logs');
    if (logs.length === 0) {
      logsEl.innerHTML = '<div style="color: var(--muted); padding: 8px 0;">暂无出入库记录</div>';
      return;
    }

    logsEl.innerHTML = logs.map(l => {
      const deltaClass = l.delta > 0 ? 'in' : (l.delta < 0 ? 'out' : 'neutral');
      const deltaText = l.delta > 0 ? `+${l.delta}` : `${l.delta}`;
      return `
      <div class="log-item">
        <div class="log-item-main">
          <div class="log-item-title"><span class="log-code">${escapeHtml(l.material_code)}</span> · ${escapeHtml(l.model || '')}</div>
          <div class="log-item-sub">${escapeHtml(l.reason || '变动')}${l.project ? ' · 📦 ' + escapeHtml(l.project) : ''} · 现存 ${l.remaining}${escapeHtml(l.unit || '个')} · ${formatTime(l.created_at)}</div>
        </div>
        <div class="log-item-delta ${deltaClass}">${deltaText}</div>
      </div>
    `;
    }).join('');
  } catch (e) {
    console.error('Failed to load recent logs', e);
  }
}

// ---------- 18. 数据看板 ----------
async function loadDashboard() {
  try {
    const res = await api('/api/dashboard');
    if (!res.ok) return;
    const data = await res.json();
    renderCategoryBars(data.categories || []);
    renderTrend(data.trend || []);
  } catch (e) {
    console.error('Failed to load dashboard', e);
  }
}

function renderCategoryBars(cats) {
  const el = $('dash-cat-bars');
  if (!cats.length) {
    el.innerHTML = '<div class="dash-empty">暂无分类数据</div>';
    return;
  }
  // 优先按资产价值排序展示；若全部无价格则按数量
  const totalValue = cats.reduce((s, c) => s + (c.value || 0), 0);
  const metricKey = totalValue > 0 ? 'value' : 'pieces';
  const maxVal = Math.max(...cats.map(c => c[metricKey] || 0), 1);

  el.innerHTML = cats.map(c => {
    const val = c[metricKey] || 0;
    const pct = Math.max(2, Math.round((val / maxVal) * 100));
    const label = metricKey === 'value' ? `￥${fmtMoney(c.value)} · ${fmtNum(c.pieces)}件` : `${fmtNum(c.pieces)} 件 · ${c.sku}款`;
    return `
      <div class="dash-bar-row">
        <span class="dash-bar-name" title="${escapeHtml(c.category)}">${escapeHtml(c.category)}</span>
        <div class="dash-bar-track"><div class="dash-bar-fill" style="width: ${pct}%;"></div></div>
        <span class="dash-bar-val">${label}</span>
      </div>
    `;
  }).join('');
}

function renderTrend(trend) {
  const el = $('dash-trend');
  if (!trend.length) {
    el.innerHTML = '<div class="dash-empty">近 7 天暂无出入库记录</div>';
    return;
  }
  // 补齐最近 7 天，缺数据的日期补 0
  const byDay = {};
  trend.forEach(t => { byDay[t.day] = t; });
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({
      day: key,
      label: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
      in_qty: (byDay[key] && byDay[key].in_qty) || 0,
      out_qty: (byDay[key] && byDay[key].out_qty) || 0
    });
  }

  const maxQty = Math.max(...days.map(d => Math.max(d.in_qty, d.out_qty)), 1);
  el.innerHTML = days.map(d => {
    const inH = d.in_qty ? Math.max(6, Math.round((d.in_qty / maxQty) * 80)) : 2;
    const outH = d.out_qty ? Math.max(6, Math.round((d.out_qty / maxQty) * 80)) : 2;
    const vals = (d.in_qty || d.out_qty)
      ? `<div class="trend-val" style="color: var(--accent);">${d.in_qty > 0 ? '+' + fmtNum(d.in_qty) : ''}</div><div class="trend-val" style="color: var(--danger);">${d.out_qty > 0 ? '-' + fmtNum(d.out_qty) : ''}</div>`
      : '<div class="trend-val">&nbsp;</div>';
    return `
      <div class="trend-day">
        ${vals}
        <div class="trend-cols">
          <div class="trend-col in" style="height: ${inH}px;" title="入库 ${d.in_qty}"></div>
          <div class="trend-col out" style="height: ${outH}px;" title="出库 ${d.out_qty}"></div>
        </div>
        <div class="trend-day-label">${d.label}</div>
      </div>
    `;
  }).join('');
}

// ---------- 19. BOM 一键核对 ----------
function initBom() {
  $('btn-bom-check').addEventListener('click', async () => {
    const content = $('bom-text').value.trim();
    if (!content) {
      showToast('请先粘贴 BOM 文本或上传文件', 'info');
      return;
    }
    await runBomCheck({ content });
  });

  $('btn-bom-file').addEventListener('click', () => $('bom-file-input').click());
  $('bom-file-input').addEventListener('change', async (e) => {
    if (!e.target.files || !e.target.files.length) return;
    const file = e.target.files[0];
    e.target.value = '';
    if (file.name.toLowerCase().endsWith('.txt')) {
      const text = await file.text();
      $('bom-text').value = text;
      await runBomCheck({ content: text.trim() });
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    await runBomCheck(null, fd, file.name);
  });

  $('btn-bom-export').addEventListener('click', exportBomCsv);
  $('btn-bom-copy-missing').addEventListener('click', copyBomMissing);
}

async function runBomCheck(jsonBody, formData, fileName) {
  const btn = $('btn-bom-check');
  btn.disabled = true;
  showToast('正在解析 BOM 并匹配库存…', 'info');
  try {
    let res;
    if (formData) {
      res = await api('/api/bom/check', { method: 'POST', body: formData });
    } else {
      res = await api('/api/bom/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: jsonBody.content })
      });
    }
    const data = await res.json();
    if (!res.ok) {
      showToast(data.detail || 'BOM 核对失败', 'error', 3200);
      return;
    }
    state.bomState = { items: data.items, summary: data.summary };
    renderBomSummary(data.summary);
    renderBomResults(data.items);
    $('bom-summary-panel').style.display = 'block';
    showToast(`核对完成：${data.summary.lines} 行，命中 ${data.summary.ok + data.summary.insufficient}，未找到 ${data.summary.none}`, 'success', 3000);
  } catch (e) {
    showToast('BOM 核对请求失败', 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderBomSummary(s) {
  $('bom-summary').innerHTML = `
    <div class="stat-card"><div class="stat-label">BOM 总行数</div><div class="stat-val">${s.lines}</div></div>
    <div class="stat-card"><div class="stat-label">库存充足</div><div class="stat-val accent">${s.ok}</div></div>
    <div class="stat-card"><div class="stat-label">库存不足</div><div class="stat-val warning">${s.insufficient}</div></div>
    <div class="stat-card"><div class="stat-label">未找到</div><div class="stat-val" style="color: var(--danger);">${s.none}</div></div>
    <div class="stat-card"><div class="stat-label">BOM 物料总成本</div><div class="stat-val accent">￥${fmtMoney(s.total_cost)}</div></div>
    <div class="stat-card"><div class="stat-label">缺料补齐成本</div><div class="stat-val warning">￥${fmtMoney(s.shortfall_cost)}</div></div>
  `;
}

const TIER_TEXT = { code: '编号直击', exact: '型号精确', norm: '归一化', contains: '包含匹配', spec: '规格匹配', token: '关键词', candidate: '候选' };

function renderBomResults(items) {
  const tbody = $('bom-results');
  tbody.innerHTML = items.map((it, i) => {
    const candidates = it.candidates || [];
    let matchCell;
    if (candidates.length === 0) {
      matchCell = '<span style="color: var(--muted); font-size: 11px;">无匹配 · 可点击右侧状态一键建档</span>';
    } else {
      const opts = ['<option value="">— 不匹配 —</option>']
        .concat(candidates.map(c =>
          `<option value="${escapeHtml(c.code)}" ${it.matched_code === c.code ? 'selected' : ''}>${escapeHtml(c.code)} ${escapeHtml(c.model)} · 在库${c.quantity} ${c.price > 0 ? '￥' + c.price : ''}</option>`
        )).join('');
      matchCell = `
        <select class="bom-match-select" data-idx="${i}">${opts}</select>
        <div class="bom-tier">${TIER_TEXT[it.match_tier] || ''}${it.matched_price > 0 ? ' · ￥' + it.matched_price + '/件' : ''}</div>`;
    }
    const statusText = { ok: '✓ 够用', insufficient: `⚠ 缺 ${it.shortfall}`, none: '✗ 未找到' }[it.status];
    const subtotal = it.matched_price > 0 ? `￥${fmtMoney(it.matched_price * it.qty)}` : '-';
    return `
      <tr class="row-${it.status}">
        <td>${i + 1}</td>
        <td><div class="bom-model">${escapeHtml(it.model)}</div>${it.ref ? `<div class="bom-ref">${escapeHtml(it.ref)}</div>` : ''}</td>
        <td><b>${it.qty}</b></td>
        <td>${matchCell}</td>
        <td style="font-family: var(--font-mono);">${it.matched_code ? it.stock_qty : '-'}</td>
        <td><span class="bom-status ${it.status}">${statusText}</span></td>
        <td class="bom-subtotal" id="bom-subtotal-${i}">${subtotal}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.bom-match-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx);
      const item = state.bomState.items[idx];
      const chosen = (item.candidates || []).find(c => c.code === sel.value) || null;
      if (chosen) {
        item.matched_code = chosen.code;
        item.matched_model = chosen.model;
        item.matched_price = chosen.price;
        item.stock_qty = chosen.quantity;
        item.shortfall = Math.max(0, item.qty - chosen.quantity);
        item.status = chosen.quantity < item.qty ? 'insufficient' : 'ok';
        item.match_tier = 'candidate';
      } else {
        item.matched_code = null;
        item.matched_model = null;
        item.matched_price = 0;
        item.stock_qty = 0;
        item.shortfall = item.qty;
        item.status = 'none';
      }
      const tr = sel.closest('tr');
      tr.className = `row-${item.status}`;
      tr.querySelector('.bom-status').className = `bom-status ${item.status}`;
      tr.querySelector('.bom-status').innerText = { ok: '✓ 够用', insufficient: `⚠ 缺 ${item.shortfall}`, none: '✗ 未找到' }[item.status];
      $(`bom-subtotal-${idx}`).innerText = item.matched_price > 0 ? `￥${fmtMoney(item.matched_price * item.qty)}` : '-';
      state.bomState.summary = bomSummarize(state.bomState.items);
      renderBomSummary(state.bomState.summary);
    });
  });

  // 未找到行点击状态徽章 → 打开建档
  tbody.querySelectorAll('tr.row-none .bom-status').forEach(badge => {
    badge.style.cursor = 'pointer';
    badge.title = '点击建档此物料';
    badge.addEventListener('click', () => {
      const tr = badge.closest('tr');
      const idx = Array.from(tbody.querySelectorAll('tr')).indexOf(tr);
      const item = state.bomState.items[idx];
      openMaterialModal('create', { code: item.code || '', model: item.model, quantity: item.qty });
    });
  });
}

function bomSummarize(items) {
  let ok = 0, insufficient = 0, none = 0, total_cost = 0, shortfall_cost = 0;
  items.forEach(it => {
    if (it.status === 'ok') ok++;
    else if (it.status === 'insufficient') insufficient++;
    else none++;
    if (it.matched_price > 0) {
      total_cost += it.matched_price * it.qty;
      if (it.status !== 'ok') shortfall_cost += it.matched_price * (it.shortfall || 0);
    }
  });
  return { lines: items.length, ok, insufficient, none, total_cost: Math.round(total_cost * 100) / 100, shortfall_cost: Math.round(shortfall_cost * 100) / 100 };
}

function exportBomCsv() {
  const items = state.bomState.items;
  if (!items.length) return;
  const rows = [['BOM型号', '位号', '需求', '匹配C编号', '匹配型号', '在库', '状态', '缺口', '单价', '小计']];
  items.forEach(it => {
    rows.push([
      it.model, it.ref || '', it.qty,
      it.matched_code || '', it.matched_model || '', it.matched_code ? it.stock_qty : '',
      { ok: '库存充足', insufficient: '库存不足', none: '未找到' }[it.status],
      it.status === 'ok' ? 0 : (it.shortfall || it.qty),
      it.matched_price || 0,
      it.matched_price > 0 ? (it.matched_price * it.qty).toFixed(2) : '0.00'
    ]);
  });
  const s = state.bomState.summary;
  rows.push([]);
  rows.push(['合计', '', '', '', '', '', `命中${s.ok + s.insufficient}/${s.lines}`, `缺料成本￥${s.shortfall_cost}`, '', `总成本￥${s.total_cost}`]);
  const csv = '\ufeff' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bom核对_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyBomMissing() {
  const items = state.bomState.items.filter(it => it.status !== 'ok');
  if (!items.length) {
    showToast('全部物料库存充足，无需补货 🎉', 'success');
    return;
  }
  const lines = ['缺料清单（PinBox 引脚仓 BOM 核对）:', ''];
  items.forEach(it => {
    const need = it.status === 'none' ? it.qty : (it.shortfall || 0);
    lines.push(`${it.matched_code || it.model}  ${it.matched_model || ''}  需 ${need}${it.matched_price > 0 ? '  约￥' + (it.matched_price * need).toFixed(2) : ''}`);
  });
  const text = lines.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast('缺料清单已复制到剪贴板', 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('缺料清单已复制到剪贴板', 'success');
  }
}

// ---------- 20. 管理页工具面板 ----------
function initToolPanels() {
  $('btn-restock-refresh').addEventListener('click', loadRestock);
  $('btn-restock-copy').addEventListener('click', copyRestockList);
  $('btn-backup-now').addEventListener('click', async () => {
    try {
      const res = await api('/api/backups/run', { method: 'POST' });
      const data = await res.json();
      showToast(data.message || '备份完成', res.ok ? 'success' : 'error');
      loadBackupsInfo();
    } catch (e) {
      showToast('备份请求失败', 'error');
    }
  });

  // PWA 安装
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPrompt = e;
    const b = $('btn-install-pwa');
    if (b && window.matchMedia('(display-mode: standalone)').matches === false) b.style.display = 'flex';
  });
  const installBtn = $('btn-install-pwa');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!state.deferredPrompt) {
        showToast('当前浏览器不支持一键安装，请使用浏览器菜单「安装/添加到主屏幕」', 'info', 3200);
        return;
      }
      state.deferredPrompt.prompt();
      const { outcome } = await state.deferredPrompt.userChoice;
      if (outcome === 'accepted') showToast('安装成功，可在桌面打开', 'success');
      state.deferredPrompt = null;
      installBtn.style.display = 'none';
    });
  }

  loadRestock();
  loadProjectStats();
  loadBackupsInfo();
  initModeUI();
  bindLocalExports();
}

// ---------- 21. 数据中心：离线模式与同步 ----------
function initModeUI() {
  const seg = $('data-mode-seg');
  if (!seg) return;
  seg.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === DataLayer.mode);
    b.onclick = async () => {
      const target = b.dataset.mode;
      if (target === DataLayer.mode) return;
      if (target === 'local') {
        const ok = await showConfirm('切换到本地离线模式', '将使用本机浏览器 IndexedDB 存储数据。若本机库为空，建议先「从服务器拉取」。确定切换？', '切换');
        if (!ok) return;
      } else {
        const ok = await showConfirm('切换到服务器在线模式', '将直接读写服务器数据库（当前局域网）。确定切换？', '切换');
        if (!ok) return;
      }
      DataLayer.setMode(target);
      window.location.reload();
    };
  });

  $('input-server-url').value = DataLayer.serverUrl || '';
  $('btn-sync-test').onclick = async () => {
    DataLayer.setServerUrl($('input-server-url').value);
    const r = await syncTestConnection();
    setSyncStatus(r.msg, r.ok);
  };
  $('btn-sync-pull').onclick = async () => {
    DataLayer.setServerUrl($('input-server-url').value);
    if (DataLayer.mode === 'server') {
      setSyncStatus('当前已是服务器模式，无需拉取', false);
      return;
    }
    const ok = await showConfirm('从服务器拉取', '将用服务器数据【覆盖】本机离线库，未推送的离线变更会被清除！建议先推送。继续？', '拉取');
    if (!ok) return;
    setSyncStatus('正在拉取…', true);
    const r = await syncPullSnapshot();
    setSyncStatus(r.msg, r.ok);
    if (r.ok) {
      state.initialLoaded = false;
      loadStats(); loadCategories(); loadMaterials(); loadLocations(); loadDashboard(); loadRecentLogs(); loadRestock(); loadProjectStats();
    }
  };
  $('btn-sync-push').onclick = async () => {
    DataLayer.setServerUrl($('input-server-url').value);
    setSyncStatus('正在推送离线变更…', true);
    const r = await syncPushOps();
    setSyncStatus(r.msg, r.ok);
    updatePendingCount();
  };
  updatePendingCount();
}

function setSyncStatus(msg, ok) {
  const el = $('sync-status');
  if (el) {
    el.innerText = msg;
    el.style.color = ok ? 'var(--accent)' : 'var(--danger)';
  }
}

async function updatePendingCount() {
  const n = await syncPendingCount();
  const el = $('pending-count');
  if (el) el.innerText = n;
}

function bindLocalExports() {
  const excelLink = $('a-export-excel');
  const csvLink = $('a-export-csv');
  if (DataLayer.mode !== 'local' && excelLink) {
    excelLink.addEventListener('click', (e) => {
      // 保持 <a> 默认下载，仅提示
      showToast('正在生成 Excel 报表…', 'info', 1600);
    });
  }
  const jsonLink = $('a-export-json');
  if (DataLayer.mode !== 'local') return;
  if (csvLink) csvLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const res = await api('/api/export?format=csv');
    const data = await res.json();
    const mats = data.materials || [];
    const headers = ['code','category','brand','model','package','quantity','unit','price','location','use_case','batch','min_stock','remark'];
    const rows = [headers.join(',')].concat(mats.map(m => headers.map(h => `"${String(m[h] ?? '').replace(/"/g, '""')}"`).join(',')));
    downloadBlob('\ufeff' + rows.join('\n'), `lcsc_inventory_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv');
  });
  if (jsonLink) jsonLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const res = await api('/api/backup');
    const data = await res.json();
    downloadBlob(JSON.stringify(data, null, 1), `lcsc_backup_${new Date().toISOString().slice(0,16).replace(/[:T]/g,'')}.json`, 'application/json');
  });
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function loadRestock() {
  try {
    const res = await api('/api/restock');
    if (!res.ok) return;
    const data = await res.json();
    state.restockItems = data.items || [];
    $('restock-summary').innerText = state.restockItems.length
      ? `共 ${state.restockItems.length} 款需补货 · 建议采购总成本约 ￥${fmtMoney(data.total_cost)}（目标 = 预警线×2）`
      : '当前库存全部高于目标水位（预警线×2），无需补货 🎉';
    const el = $('restock-list');
    if (!state.restockItems.length) {
      el.innerHTML = '<div class="dash-empty">无待补货物料</div>';
      return;
    }
    el.innerHTML = state.restockItems.map(m => `
      <div class="restock-item" data-code="${escapeHtml(m.code)}">
        <span class="ri-code">${escapeHtml(m.code)}</span>
        <span class="ri-model" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span>
        <span style="font-family: var(--font-mono); color: var(--muted); flex-shrink: 0;">${m.quantity} → ${m.target}</span>
        <span class="ri-nums">补 ${m.suggest}</span>
      </div>
    `).join('');
  } catch (e) {
    console.error('restock load failed', e);
  }
}

function copyRestockList() {
  const items = state.restockItems || [];
  if (!items.length) {
    showToast('暂无待补货物料', 'info');
    return;
  }
  const lines = ['补货清单（PinBox 引脚仓）:', ''];
  let total = 0;
  items.forEach(m => {
    total += (m.price || 0) * m.suggest;
    lines.push(`${m.code}  ${m.model}  采购 ${m.suggest}${m.unit || '个'}${m.price > 0 ? '  约￥' + ((m.price * m.suggest).toFixed(2)) : ''}`);
  });
  lines.push('', `预估合计: ￥${total.toFixed(2)}`);
  const text = lines.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast('补货清单已复制，可粘贴到立创购物车', 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('补货清单已复制', 'success');
  }
}

async function loadProjectStats() {
  try {
    const res = await api('/api/projects');
    if (!res.ok) return;
    const rows = await res.json();
    const el = $('project-stats');
    if (!rows.length || (rows.length === 1 && rows[0].project === '(未关联项目)')) {
      el.innerHTML = '<div class="dash-empty">暂无带项目标签的出库记录 · 在详情弹窗「库存微调」可填写项目名</div>';
      return;
    }
    const maxVal = Math.max(...rows.map(r => r.out_pieces || 0), 1);
    el.innerHTML = rows.map(r => {
      const pct = Math.max(2, Math.round(((r.out_pieces || 0) / maxVal) * 100));
      return `
        <div class="project-bar-row">
          <span class="pb-name" title="${escapeHtml(r.project)}">${escapeHtml(r.project)}</span>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="width: ${pct}%; background: linear-gradient(90deg, var(--danger), #fbbf24);"></div></div>
          <span class="pb-val">${fmtNum(r.out_pieces)}件 · ￥${fmtMoney(r.out_cost)}</span>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('project stats failed', e);
  }
}

async function loadBackupsInfo() {
  if (DataLayer.mode === 'local') {
    $('auto-backup-info').innerText = '离线模式：数据保存在本机浏览器，可用「下载本地备份」导出 JSON';
    return;
  }
  try {
    const res = await api('/api/backups');
    if (!res.ok) return;
    const data = await res.json();
    const n = (data.backups || []).length;
    $('auto-backup-info').innerText = n
      ? `每日 03:00 自动备份 · 服务器已有 ${n} 份（data/backups/，保留 30 份）`
      : '每日 03:00 自动备份到服务器 data/backups/（保留 30 份）';
  } catch (e) { /* 静默 */ }
}
