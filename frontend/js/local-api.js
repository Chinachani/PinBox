// ============================================================
// LocalAPI - 离线模式本地 API 层
// 与服务器 API 响应结构完全一致，app.js 无感知切换
// ============================================================
const createLocalAPI = (LocalDB) => {

  // ---------- 工具 ----------
  function nowLocal() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function dayLocal(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function shim(ok, status, data) {
    return { ok, status, json: async () => data, _data: data };
  }
  const okJson = (data) => shim(true, 200, data);
  const errJson = (status, detail) => shim(false, status, { detail });

  async function addPendingOp(op) {
    await LocalDB.add('pending_ops', { ...op, op_id: newOperationId(), ts: Date.now() });
  }

  function validateMaterial(data, partial = false) {
    for (const key of ['quantity', 'min_stock']) {
      if (data[key] !== undefined && (!Number.isInteger(data[key]) || data[key] < 0 || data[key] > 2147483647))
        throw new Error(`${key} 必须是有效非负整数`);
    }
    if (data.price !== undefined && (!Number.isFinite(data.price) || data.price < 0 || data.price > 1e12))
      throw new Error('单价必须是有限非负数');
    if (!partial && (typeof data.code !== 'string' || !data.code.trim() || /[/\x00-\x1f]/.test(data.code)))
      throw new Error('物料编号无效');
    if ((!partial || data.model !== undefined) && (typeof data.model !== 'string' || !data.model.trim()))
      throw new Error('型号不能为空');
    for (const key of ['category', 'brand', 'package', 'unit', 'location', 'use_case', 'batch', 'order_date', 'remark']) {
      if (data[key] !== undefined && typeof data[key] !== 'string') throw new Error(`${key} 必须是文本`);
    }
  }

  async function nextLocId() {
    const meta = (await LocalDB.get('meta', 'loc_seq')) || { key: 'loc_seq', value: 0 };
    meta.value = (meta.value || 0) + 1;
    await LocalDB.put('meta', meta);
    return meta.value;
  }

  async function addLog(code, type, delta, remaining, reason, project = '') {
    await LocalDB.add('logs', {
      material_code: code, change_type: type, delta, remaining,
      reason: reason || '', project: project || '', created_at: nowLocal()
    });
  }

  // ---------- 条码解析（与后端 parser.py 对齐） ----------
  function parseLcscBarcode(rawText) {
    rawText = String(rawText || '').trim();
    const result = { raw: rawText, code: null, quantity: null, model: null, matched: false };
    if (!rawText) return result;

    let m = rawText.match(/(?:pc|code|item_code)["']?\s*[:=]\s*["']?(C\d{1,9})(?!\d)/i);
    if (!m) m = rawText.match(/\b(C\d{1,9})(?!\d)/i);
    if (m) { result.code = m[1].toUpperCase(); result.matched = true; }

    m = rawText.match(/(?:pm|model|型号)["']?\s*[:=]\s*["']?([^,;\n}]+)/i);
    if (m) result.model = m[1].trim().replace(/["']$/, '');

    m = rawText.match(/(?:^|[^A-Za-z0-9_])(?:qty|数量|count|pcs|quantity)["']?\s*[:=]\s*["']?([^,;\s}"']*)/i);
    if (!m) m = rawText.match(/(?<![A-Za-z0-9_.+\-])([+\-]?\d[\d.,eE+\-]*)\s*(?:个|颗|支|块|条|套|PCS|只)(?![A-Za-z])/i);
    if (m) {
      const text = m[1].replace(/(?:个|颗|支|块|条|套|PCS|只)$/i, '');
      const value = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : 0;
      if (Number.isInteger(value) && value > 0 && value <= 2147483647) result.quantity = value;
    } else {
      const parts = rawText.split(/[,;|\n]/).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2 && parts[0].toUpperCase() === result.code && /^\d{1,7}$/.test(parts[1])) {
        result.quantity = Number(parts[1]) || null;
      }
    }
    return result;
  }

  // ---------- BOM 解析与规格解码（bom.py 的 JS 移植） ----------
  const PACKAGE_TOKENS = ["2512", "1812", "1210", "1206", "0805", "0603", "0402", "0201",
    "SOT-23", "SOT-89", "SOT-363", "SOT-223", "TO-220", "TO-252", "TO-263", "TO-92",
    "SMA", "SMB", "SMC", "SOD-123", "SOD-323", "SOP-8", "SOP-16", "TSSOP", "SSOP",
    "TQFP", "QFN", "DFN", "MSOP", "DIP", "SMD"];

  function detectPackage(text) {
    const t = String(text || '').toUpperCase();
    for (const p of PACKAGE_TOKENS) if (t.includes(p.toUpperCase())) return p;
    return "";
  }

  function numStr(f) {
    let s = f.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s === '' ? '0' : s;
  }

  function decodeDigitCode(digits) {
    if (/^\d{3}$/.test(digits)) return parseInt(digits.slice(0, 2)) * Math.pow(10, parseInt(digits[2]));
    if (/^\d{4}$/.test(digits)) return parseInt(digits.slice(0, 3)) * Math.pow(10, parseInt(digits[3]));
    return null;
  }

  function valueToText(val, kind) {
    const out = [];
    if (kind === 'res') {
      if (val >= 1e6) out.push(numStr(val / 1e6) + 'MΩ');
      else if (val >= 1e3) out.push(numStr(val / 1e3) + 'kΩ');
      else out.push(numStr(val) + 'Ω');
      out.push(out[0].replace('Ω', '').toUpperCase() + 'R');
      out.push(numStr(val) + 'R');
    } else if (kind === 'cap') {
      if (val >= 1e6) { out.push(numStr(val / 1e6) + 'uF'); out.push(numStr(val / 1e6) + 'µF'); }
      else if (val >= 1e3) out.push(numStr(val / 1e3) + 'nF');
      else out.push(numStr(val) + 'pF');
    } else if (kind === 'ind') {
      out.push(numStr(val) + 'uH');
      out.push(numStr(val) + 'UH');
    }
    return out;
  }

  function uniq(a) { return [...new Set(a)]; }

  function decodeSpec(line) {
    const res = { package: detectPackage(line), res_values: [], cap_values: [], ind_values: [], voltages: [], dims: [], pins: [] };
    if (!line) return res;
    const work = String(line).replace(/[µμ]/g, 'u');
    const up = work.toUpperCase();

    for (const m of up.matchAll(/(\d+(?:\.\d+)?)\s*(?:UH|µH)/g))
      res.ind_values.push(...valueToText(parseFloat(m[1]), 'ind'));
    for (const m of up.matchAll(/(\d+(?:\.\d+)?)\s*(UF|µF|NF|PF)/g)) {
      const v = parseFloat(m[1]); const unit = m[2];
      const pf = unit.startsWith('U') ? v * 1e6 : (unit.startsWith('N') ? v * 1e3 : v);
      res.cap_values.push(...valueToText(pf, 'cap'));
    }
    for (const m of up.matchAll(/(\d+(?:\.\d+)?)(R|K|M)(\d+)?\b/g)) {
      const a = parseFloat(m[1]); const unit = m[2]; const b = m[3];
      let val = a * (unit === 'R' ? 1 : (unit === 'K' ? 1e3 : 1e6));
      if (b) val = (a + parseFloat('0.' + b)) * (unit === 'R' ? 1 : unit === 'K' ? 1e3 : 1e6);
      res.res_values.push(...valueToText(val, 'res'));
    }
    for (const m of up.matchAll(/(\d+(?:\.\d+)?)\s*(Ω|OHM|KΩ|MΩ)/g)) {
      let val = parseFloat(m[1]);
      if (m[2] === 'MΩ') val *= 1e6; else if (m[2] === 'KΩ') val *= 1e3;
      res.res_values.push(...valueToText(val, 'res'));
    }

    let cleaned = up;
    if (res.package) cleaned = cleaned.split(res.package.toUpperCase()).join(' ');
    for (const m of cleaned.matchAll(/(\d+(?:\.\d+)?)V\b/g)) res.voltages.push(m[1] + 'V');
    for (const m of cleaned.matchAll(/\b(\d{1,3}X\d{1,3}(?:X\d{1,3})?)\b/g)) res.dims.push(m[1]);
    for (const m of cleaned.matchAll(/\b(\d{1,2}X\d{1,2}P|\d{1,2}P)\b/g)) res.pins.push(m[1]);

    for (const tok of cleaned.split(/[^0-9A-Za-z.\-]+/)) {
      if (!tok || tok.length > 20) continue;
      const m = tok.match(/^[A-Z]{0,4}(\d{3,4})([JKMZ])?$/);
      if (!m) continue;
      const val = decodeDigitCode(m[1]);
      if (!val || val <= 0) continue;
      if (val <= 1e8) res.cap_values.push(...valueToText(val, 'cap'));
      if (val <= 1e7) res.res_values.push(...valueToText(val, 'res'));
    }
    // 料号内嵌：数值+容差字母（105K / 330J）；容差字母+4位（J0103）
    for (const m of cleaned.matchAll(/(\d{3})([JKMZ])/g)) {
      const val = decodeDigitCode(m[1]);
      if (val && 0 < val && val <= 1e8) {
        res.cap_values.push(...valueToText(val, 'cap'));
        res.res_values.push(...valueToText(val, 'res'));
      }
    }
    for (const m of cleaned.matchAll(/([JKM])(\d{4})(?!\d)/g)) {
      const val = decodeDigitCode(m[2]);
      if (val && 0 < val && val <= 1e7) {
        res.res_values.push(...valueToText(val, 'res'));
        res.cap_values.push(...valueToText(val, 'cap'));
      }
    }
    for (const k of ["res_values", "cap_values", "ind_values", "voltages", "dims", "pins"]) res[k] = uniq(res[k]);
    return res;
  }

  function norm(s) { return String(s || '').replace(/[\s\-_()（）/\\.,·]+/g, '').toUpperCase(); }
  function tokenize(s) {
    return String(s || '').toUpperCase().split(/[^0-9A-Z\u4e00-\u9fff]+/).filter(t => t.length >= 2);
  }

  function parseBomText(content) {
    const items = [];
    const lines = String(content || '').replace(/\t/g, ' ').split('\n').map(l => l.trim());
    const headerRe = /(型号|数量|位号|规格| qty |quantity|value|designator|comment|manufacturer)/i;
    lines.forEach((line, idx) => {
      if (!line) return;
      if (idx <= 1 && headerRe.test(line) && !/C\d{4,9}/i.test(line)) return;
      const tokens = line.split(/[,;|]|\s{1,}/).filter(Boolean);
      if (!tokens.length) return;
      const cm = line.match(/\b(C\d{4,9})\b/i);
      const code = cm ? cm[1].toUpperCase() : null;
      let qty = 1;
      const quantity = tokens.at(-1).match(/^(?:[xX*×]|\+)?(\d{1,9})$/);
      if (tokens.length > 1 && quantity && (!PACKAGE_TOKENS.includes(tokens.at(-1)) || tokens.length > 2)) {
        qty = Number(quantity[1]);
        tokens.pop();
        if (qty < 1) throw new Error('BOM 数量必须是正整数');
      }
      let left = tokens.filter(t => t.toUpperCase() !== code);
      const refs = left.filter(t => /^(?:R|C|L|D|Q|U|J|P|LED|SW)\d+$/i.test(t));
      const model = left.filter(t => !refs.includes(t)).join(' ') || code || '';
      const ref = refs.join(' ');
      if (!model && !code) return;
      items.push({ raw: line, code, model, package: detectPackage(line), qty: qty > 0 ? qty : 1, ref });
    });
    return items;
  }

  async function matchBomItems(items) {
    const inv = await LocalDB.getAll('materials');
    for (const it of items) {
      it.candidates = [];
      let best = null;

      if (it.code) {
        const m = inv.find(x => x.code === it.code);
        if (m) best = { tier: 'code', m, score: 1.0 };
      }
      if (!best && it.model) {
        const um = it.model.trim().toUpperCase();
        const m = inv.find(x => (x.model || '').trim().toUpperCase() === um);
        if (m) best = { tier: 'exact', m, score: 0.98 };
      }
      if (!best && it.model) {
        const nm = norm(it.model);
        if (nm) {
          for (const m of inv) {
            const ninv = norm(m.model);
            if (!ninv) continue;
            if (ninv === nm) { best = { tier: 'norm', m, score: 0.95 }; break; }
            if (Math.min(nm.length, ninv.length) >= 5 && (ninv.includes(nm) || nm.includes(ninv))) {
              if (!best || best.score < 0.85) best = { tier: 'contains', m, score: 0.85 };
            }
          }
        }
      }
      if (!best && it.model) {
        const nm = norm(it.model);
        if (nm.length >= 3 && nm.length <= 12 && /^[A-Z0-9]+$/.test(nm)) {
          for (const m of inv) {
            if (tokenize((m.model || '') + ' ' + (m.brand || '')).includes(nm)) {
              best = { tier: 'mpn', m, score: 0.92 };
              break;
            }
          }
        }
      }
      if (!best && it.model) {
        const spec = decodeSpec(`${it.model} ${it.package || ''} ${it.ref || ''}`);
        const pkg = spec.package || (it.package || '');
        const catWords = [];
        if (spec.res_values.length) catWords.push(['电阻', spec.res_values]);
        if (spec.cap_values.length) catWords.push(['电容', spec.cap_values]);
        if (spec.ind_values.length) catWords.push(['电感', spec.ind_values]);
        const scored = [];
        for (const [cat, values] of catWords) {
          for (const m of inv) {
            const catText = (m.category || '') + (m.model || '');
            if (!catText.includes(cat)) continue;
            const hay = `${m.model || ''} ${m.package || ''}`.toUpperCase();
            if (pkg && !hay.includes(pkg)) continue;
            if (!values.some(v => hay.includes(v.toUpperCase()))) continue;
            let voltConflict = false;
            if (spec.voltages.length) {
              const invVolts = new Set([...hay.matchAll(/(\d+(?:\.\d+)?)V/g)].map(x => x[1]));
              const bomVolts = new Set(spec.voltages.map(v => v.slice(0, -1)));
              if (invVolts.size && ![...bomVolts].some(v => invVolts.has(v))) voltConflict = true;
            }
            const score = 0.75 + (pkg ? 0.05 : 0) - (voltConflict ? 0.15 : 0);
            scored.push({ tier: 'spec', m, score: Math.min(Math.max(score, 0.5), 0.9) });
          }
        }
        if (scored.length) {
          scored.sort((a, b) => b.score - a.score);
          best = scored[0];
        }
      }
      if (!best && it.model) {
        let bt = new Set(tokenize(it.model + ' ' + (it.package || '')));
        if (it.package) bt.delete(it.package.toUpperCase());
        if (bt.size >= 2) {
          const pool = [];
          for (const m of inv) {
            const mt = new Set(tokenize(`${m.model || ''} ${m.brand || ''} ${m.package || ''} ${m.category || ''}`));
            const inter = [...bt].filter(t => mt.has(t));
            if (!inter.length || Math.max(...inter.map(t => t.length)) < 3) continue;
            const score = inter.length / Math.max(bt.size, 1);
            if (score >= 0.5) pool.push({ tier: 'token', m, score: Math.round((0.4 + score * 0.3) * 100) / 100 });
          }
          pool.sort((a, b) => b.score - a.score);
          if (pool.length) best = pool[0];
        }
      }

      // 候选池
      const cand = {};
      if (it.model) {
        const spec = decodeSpec(`${it.model} ${it.package || ''}`);
        const catWords = [];
        if (spec.res_values.length) catWords.push(['电阻', spec.res_values]);
        if (spec.cap_values.length) catWords.push(['电容', spec.cap_values]);
        if (spec.ind_values.length) catWords.push(['电感', spec.ind_values]);
        for (const [cat, values] of catWords) {
          for (const m of inv) {
            const catText = (m.category || '') + (m.model || '');
            if (!catText.includes(cat)) continue;
            const hay = `${m.model || ''} ${m.package || ''}`.toUpperCase();
            if (spec.package && !hay.includes(spec.package)) continue;
            if (values.some(v => hay.includes(v.toUpperCase()))) {
              cand[m.code] = { code: m.code, model: m.model, brand: m.brand, package: m.package, quantity: m.quantity, price: m.price, score: 0.75 };
            }
          }
        }
        let bt = new Set(tokenize(it.model + ' ' + (it.package || '')));
        if (it.package) bt.delete(it.package.toUpperCase());
        if (bt.size >= 2) {
          for (const m of inv) {
            const mt = new Set(tokenize(`${m.model || ''} ${m.brand || ''} ${m.package || ''} ${m.category || ''}`));
            const inter = [...bt].filter(t => mt.has(t));
            if (!inter.length || Math.max(...inter.map(t => t.length)) < 3) continue;
            const score = inter.length / Math.max(bt.size, 1);
            if (score >= 0.45 && !cand[m.code]) {
              cand[m.code] = { code: m.code, model: m.model, brand: m.brand, package: m.package, quantity: m.quantity, price: m.price, score: Math.round(score * 100) / 100 };
            }
          }
        }
      }
      const modelMatches = inv.filter(m => it.model && norm(m.model) === norm(it.model) &&
        (!it.package || norm(m.package) === norm(it.package)));
      for (const m of modelMatches) {
        cand[m.code] = { code: m.code, model: m.model, brand: m.brand, package: m.package, quantity: m.quantity, price: m.price, score: 0.95 };
      }
      if (best) {
        cand[best.m.code] = { code: best.m.code, model: best.m.model, brand: best.m.brand, package: best.m.package, quantity: best.m.quantity, price: best.m.price, score: best.score };
      }
      it.candidates = Object.values(cand).sort((a, b) => Number(b.code === best?.m.code) - Number(a.code === best?.m.code) || b.score - a.score).slice(0, 3);

      const packageAgrees = !it.package || (best && norm(it.package) === norm(best.m.package));
      const chosen = best && ['code', 'exact', 'norm'].includes(best.tier) &&
        (best.tier === 'code' || (packageAgrees && modelMatches.length === 1)) && (!it.code || it.code === best.m.code)
        ? it.candidates.find(c => c.code === best.m.code) : null;
      if (chosen) {
        it.matched_code = chosen.code; it.matched_model = chosen.model;
        it.matched_brand = chosen.brand; it.matched_price = chosen.price;
        it.stock_qty = chosen.quantity;
        it.match_tier = best ? best.tier : 'candidate';
        it.shortfall = Math.max(0, it.qty - chosen.quantity);
        it.status = chosen.quantity < it.qty ? 'insufficient' : 'ok';
      } else {
        it.matched_code = null; it.matched_model = null; it.matched_price = 0;
        it.stock_qty = 0; it.match_tier = null; it.shortfall = it.qty; it.status = 'none';
      }
    }
    return allocateBomStock(items);
  }

  function bomSummarize(items) {
    let ok = 0, insufficient = 0, none = 0, total_cost = 0, shortfall_cost = 0;
    for (const it of items) {
      if (it.status === 'ok') ok++;
      else if (it.status === 'insufficient') insufficient++;
      else none++;
      if (it.matched_price > 0) {
        total_cost += it.matched_price * it.qty;
        if (it.status !== 'ok') shortfall_cost += it.matched_price * (it.shortfall || 0);
      }
    }
    return { lines: items.length, ok, insufficient, none, total_cost: Math.round(total_cost * 100) / 100, shortfall_cost: Math.round(shortfall_cost * 100) / 100 };
  }

  // ---------- CSV 导入（离线支持 CSV/JSON/TXT） ----------
  function parseCsv(text) {
    const result = Papa.parse(text.replace(/^\ufeff/, ''), { skipEmptyLines: 'greedy' });
    if (result.errors.some(e => e.type === 'Quotes')) throw new Error('CSV 引号未闭合');
    const rows = result.data;
    if (!rows.length) return [];
    const headerIdx = Math.max(0, rows.slice(0, 10).findIndex(row => row.some(c => /^(商品编号|C编号|立创编号|code|型号|model|MPN|Value)$/i.test(c.trim()))));
    const headers = rows[headerIdx].map(h => h.trim());
    return rows.slice(headerIdx + 1).map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])));
  }

  function rowsToMaterials(rows) {
    const items = [];
    for (const row of rows) {
      const pick = (...keys) => keys.map(k => row[k]).find(v => v !== undefined && v !== null && String(v).trim() !== '');
      const codeRaw = row['商品编号'] || row['code'] || row['C编号'] || row['立创编号'] || '';
      if (!String(codeRaw).trim()) continue;
      const qty = Number(String(pick('quantity', '订购数量', '采购数量', '数量', '实发数量', 'qty') ?? 1).replace(/,/g, ''));
      const price = Number(String(pick('price', '单价', '单价(元)', '含税单价') ?? 0).replace(/[￥¥,]/g, ''));
      items.push({
        code: String(codeRaw).trim().toUpperCase(),
        category: pick('category', '商品类型', '分类') || '导入物料',
        brand: pick('brand', '品牌') || '',
        model: pick('model', '商品型号', '商品型号/名称', '型号') || String(codeRaw),
        package: pick('package', '封装格式', '封装') || '',
        quantity: qty, unit: pick('unit', '商品单位', '单位') || '个',
        price, use_case: pick('use_case', '核心用途/实验场景', '商品名称', '用途') || '',
        batch: pick('batch', '库存批次', 'source') || '',
        order_date: pick('order_date', '订单日期') || '',
        location: pick('location', '库位') || '',
        min_stock: Number(pick('min_stock', '预警线') ?? 0),
        remark: pick('remark', '备注') || ''
      });
    }
    return items;
  }

  // ---------- 主分发器 ----------
  async function handle(method, path, opts = {}) {
    const u = new URL(path, 'http://local/');
    const p = u.pathname.replace(/\/$/, '');
    const q = u.searchParams;
    const body = opts.body;

    async function readBody() {
      if (!body) return null;
      if (typeof body === 'string') {
        try { return JSON.parse(body); } catch { return body; }
      }
      if (body instanceof FormData) {
        const file = body.get('file');
        if (!file) return null;
        const text = await file.text();
        return { __file: { name: file.name, text } };
      }
      return typeof body === 'object' ? body : null;
    }

    try {
      // ---- 统计 ----
      if (p === '/api/find' && method === 'GET') {
        const query = q.get('q') || '';
        const items = await matchBomItems([{ model: query, qty: 1, package: detectPackage(query) }]);
        const mats = await LocalDB.getAll('materials');
        return okJson({ query, spec: decodeSpec(query), results: items[0].candidates.map(c => ({ ...mats.find(m => m.code === c.code), score: c.score })), total: items[0].candidates.length });
      }
      if (p.startsWith('/api/lcsc/price/') && method === 'GET') {
        const code = decodeURIComponent(p.split('/').pop());
        return okJson({ ok: true, url: 'https://so.szlcsc.com/global.html?k=' + encodeURIComponent(code) });
      }
      if (p === '/api/stats' && method === 'GET') {
        const mats = await LocalDB.getAll('materials');
        const logs = await LocalDB.getAll('logs');
        const locs = await LocalDB.getAll('locations');
        const total_sku = mats.length;
        const total_pieces = mats.reduce((s, m) => s + (m.quantity || 0), 0);
        const assigned = mats.filter(m => m.location).length;
        const low = mats.filter(m => (m.min_stock > 0 && m.quantity <= m.min_stock) || m.quantity === 0).length;
        const zero = mats.filter(m => m.quantity === 0).length;
        return okJson({
          total_sku, total_pieces,
          total_categories: new Set(mats.map(m => m.category)).size,
          assigned_locations: assigned,
          unassigned_locations: total_sku - assigned,
          low_stock: low, zero_stock: zero,
          location_count: locs.length,
          total_asset_value: Math.round(mats.reduce((s, m) => s + (m.quantity || 0) * (m.price || 0), 0) * 100) / 100
        });
      }

      // ---- 分类 ----
      if (p === '/api/categories' && method === 'GET') {
        const mats = await LocalDB.getAll('materials');
        const agg = Object.create(null);
        for (const m of mats) {
          agg[m.category] = agg[m.category] || { category: m.category, count: 0, pieces: 0 };
          agg[m.category].count++; agg[m.category].pieces += m.quantity || 0;
        }
        return okJson(Object.values(agg).sort((a, b) => b.count - a.count));
      }

      // ---- 物料列表 ----
      if (p === '/api/materials' && method === 'GET') {
        let items = await LocalDB.getAll('materials');
        const s = q.get('q');
        if (s) {
          const kw = s.toLowerCase();
          items = items.filter(m =>
            [m.code, m.model, m.brand, m.package, m.use_case, m.location, m.remark]
              .some(v => (v || '').toLowerCase().includes(kw)));
        }
        if (q.get('category')) items = items.filter(m => m.category === q.get('category'));
        if (q.get('location')) items = items.filter(m => m.location === q.get('location'));
        if (q.get('unassigned') === 'true') items = items.filter(m => !m.location);
        if (q.get('unassigned') === 'false') items = items.filter(m => !!m.location);
        if (q.get('low_stock') === 'true') items = items.filter(m => (m.min_stock > 0 && m.quantity <= m.min_stock) || m.quantity === 0);
        if (q.get('zero_stock') === 'true') items = items.filter(m => m.quantity === 0);
        const sortMap = {
          updated_at: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''),
          quantity_desc: (a, b) => b.quantity - a.quantity,
          quantity_asc: (a, b) => a.quantity - b.quantity,
          code_asc: (a, b) => a.code.localeCompare(b.code),
          location_asc: (a, b) => (a.location || '').localeCompare(b.location || '')
        };
        items.sort(sortMap[q.get('sort_by')] || sortMap.updated_at);
        const total = items.length;
        const page = Number(q.get('page') || '1');
        const pageSize = Number(q.get('page_size') || '30');
        if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) return errJson(422, '分页参数无效');
        const totalPages = Math.ceil(total / pageSize);
        return okJson({ page, page_size: pageSize, total, total_pages: totalPages, items: items.slice((page - 1) * pageSize, page * pageSize) });
      }

      // ---- 建档 ----
      if (p === '/api/materials' && method === 'POST') {
        const d = await readBody();
        validateMaterial(d);
        const code = (d.code || '').trim().toUpperCase();
        if (!code) return errJson(400, '物料编号不能为空');
        if (!(d.model || '').trim()) return errJson(400, '型号/名称不能为空');
        const exists = await LocalDB.get('materials', code);
        if (exists) return errJson(400, `物料编码 ${code} 已存在，可直接入库`);
        const now = nowLocal();
        const mat = {
          code, category: (d.category || '未分类').trim() || '未分类',
          brand: d.brand || '', model: (d.model || '').trim(), package: d.package || '',
          quantity: d.quantity || 0, unit: d.unit || '个', price: d.price || 0,
          location: (d.location || '').trim(), use_case: d.use_case || '',
          batch: d.batch || '手动录入', order_date: d.order_date || '',
          min_stock: d.min_stock || 0, remark: d.remark || '',
          created_at: now, updated_at: now
        };
        if (mat.location) {
          const locs = await LocalDB.getAll('locations');
          if (!locs.some(l => l.name === mat.location)) {
            await LocalDB.put('locations', { id: await nextLocId(), name: mat.location, note: '', created_at: now });
          }
        }
        await LocalDB.put('materials', mat);
        if (mat.quantity > 0) await addLog(code, 'init', mat.quantity, mat.quantity, '初始建档录入');
        await addPendingOp({ kind: 'create', payload: { ...mat, quantity: mat.quantity } });
        return okJson({ message: '创建成功', code });
      }

      // ---- 物料详情 / 更新 / 删除 / 出入库 ----
      const matDetail = p.match(/^\/api\/materials\/([^/]+)$/);
      if (matDetail) {
        const code = decodeURIComponent(matDetail[1]).trim().toUpperCase();
        const mat = await LocalDB.get('materials', code);
        if (method === 'GET') {
          if (!mat) return errJson(404, '元器件不存在');
          const allLogs = await LocalDB.byIndex('logs', 'material_code', code);
          mat.logs = allLogs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 30);
          return okJson(mat);
        }
        if (method === 'PUT') {
          if (!mat) return errJson(404, '元器件不存在');
          const d = await readBody();
          validateMaterial(d, true);
          const changes = {};
          for (const k of ['category', 'brand', 'model', 'package', 'quantity', 'unit', 'price', 'location', 'use_case', 'batch', 'order_date', 'min_stock', 'remark']) {
            if (d[k] !== undefined && d[k] !== null) changes[k] = d[k];
          }
          if (!Object.keys(changes).length) return okJson({ message: '无内容更新' });
          if ('location' in changes) {
            changes.location = (changes.location || '').trim();
            if (changes.location) {
              const locs = await LocalDB.getAll('locations');
              if (!locs.some(l => l.name === changes.location)) {
                await LocalDB.put('locations', { id: await nextLocId(), name: changes.location, note: '', created_at: nowLocal() });
              }
            }
          }
          if ('quantity' in changes && changes.quantity !== mat.quantity) {
            await addLog(code, 'adjust', changes.quantity - mat.quantity, changes.quantity, '人工直接修正库存');
          }
          const expected = Object.fromEntries(Object.keys(changes).map(k => [k, mat[k]]));
          Object.assign(mat, changes, { updated_at: nowLocal() });
          await LocalDB.put('materials', mat);
          await addPendingOp({ kind: 'update', code, payload: changes, expected });
          return okJson({ message: '更新成功' });
        }
        if (method === 'DELETE') {
          if (!mat) return errJson(404, '元器件不存在');
          const allLogs = await LocalDB.byIndex('logs', 'material_code', code);
          for (const l of allLogs) await LocalDB.delete('logs', l.id);
          await LocalDB.delete('materials', code);
          await addPendingOp({ kind: 'delete', code, expected: Object.fromEntries(Object.entries(mat).filter(([k]) => !['logs', 'last_in', 'created_at', 'updated_at'].includes(k))) });
          return okJson({ message: `已删除物料 ${code}` });
        }
      }

      const matStock = p.match(/^\/api\/materials\/([^/]+)\/stock$/);
      if (matStock && method === 'POST') {
        const code = decodeURIComponent(matStock[1]).trim().toUpperCase();
        const mat = await LocalDB.get('materials', code);
        if (!mat) return errJson(404, '元器件不存在');
        const d = await readBody();
        const delta = d.delta;
        if (!Number.isInteger(delta) || Math.abs(delta) > 2147483647 || mat.quantity + delta > 2147483647)
          return errJson(400, '变动数量必须是有效整数');
        if (!delta) return errJson(400, '变动数量不能为 0');
        if (mat.quantity + delta < 0) return errJson(400, `库存不足，当前仅剩 ${mat.quantity} ${mat.unit || '个'}`);
        mat.quantity += delta;
        mat.updated_at = nowLocal();
        await LocalDB.put('materials', mat);
        await addLog(code, delta > 0 ? 'in' : 'out', delta, mat.quantity, d.reason || (delta > 0 ? '快速扫码入库' : '快速出库领料'), d.project || '');
        await addPendingOp({ kind: 'stock', code, delta, reason: d.reason || '', project: d.project || '' });
        return okJson({ message: '库存变动成功', code, previous: mat.quantity - delta, delta, current: mat.quantity });
      }

      // ---- 扫码解析 ----
      if (p === '/api/scan' && method === 'POST') {
        const d = await readBody();
        const parsed = parseLcscBarcode(d.text || '');
        let material = null;
        if (parsed.code) material = await LocalDB.get('materials', parsed.code) || null;
        if (material) {
          const logs = await LocalDB.byIndex('logs', 'material_code', material.code);
          const lastIn = logs.filter(l => l.delta > 0)
            .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
          material.last_in = lastIn ? lastIn.created_at : '';
        }
        return okJson({ decoded: !!d.text, raw_text: d.text || '', parsed, found: !!material, material });
      }
      if (p === '/api/scan-image') {
        return errJson(400, '离线模式不支持后端增强识别，请使用实时扫码或清晰拍照');
      }

      // ---- 库位 ----
      if (p === '/api/locations' && method === 'GET') {
        const locs = await LocalDB.getAll('locations');
        const mats = await LocalDB.getAll('materials');
        const result = locs.map(l => {
          const rel = mats.filter(m => m.location === l.name);
          return { id: l.id, name: l.name, note: l.note || '', sku_count: rel.length, pieces: rel.reduce((s, m) => s + (m.quantity || 0), 0) };
        }).sort((a, b) => a.name.localeCompare(b.name));
        const un = mats.filter(m => !m.location);
        result.push({ id: null, name: '未分配库位', note: '尚未贴标归位的物料', sku_count: un.length, pieces: un.reduce((s, m) => s + (m.quantity || 0), 0), unassigned: true });
        return okJson(result);
      }
      if (p === '/api/locations' && method === 'POST') {
        const d = await readBody();
        const name = (d.name || '').trim();
        if (!name) return errJson(400, '库位名称不能为空');
        const locs = await LocalDB.getAll('locations');
        if (locs.some(l => l.name === name)) return errJson(400, `库位 ${name} 已存在`);
        const id = await nextLocId();
        await LocalDB.put('locations', { id, name, note: d.note || '', created_at: nowLocal() });
        await addPendingOp({ kind: 'location_create', name, note: d.note || '' });
        return okJson({ message: '库位创建成功', id, name });
      }
      const locItem = p.match(/^\/api\/locations\/(\d+)$/);
      if (locItem) {
        const id = parseInt(locItem[1]);
        const locs = await LocalDB.getAll('locations');
        const loc = locs.find(l => l.id === id);
        if (!loc) return errJson(404, '库位不存在');
        if (method === 'PUT') {
          const d = await readBody();
          const originalName = loc.name;
          const expectedNote = loc.note || '';
          if (d.name !== undefined && !String(d.name).trim()) return errJson(400, '库位名称不能为空');
          const mats = await LocalDB.getAll('materials');
          if (d.name && d.name.trim() && d.name.trim() !== loc.name) {
            const newName = d.name.trim();
            if (locs.some(l => l.name === newName && l.id !== id)) return errJson(400, `库位 ${newName} 已存在`);
            for (const m of mats) {
              if (m.location === loc.name) {
                m.location = newName; m.updated_at = nowLocal();
                await LocalDB.put('materials', m);
              }
            }
            loc.name = newName;
          }
          if (d.note !== undefined && d.note !== null) loc.note = d.note;
          await LocalDB.put('locations', loc);
          await addPendingOp({ kind: 'location_update', original_name: originalName, expected_note: expectedNote, payload: { name: loc.name, note: loc.note } });
          return okJson({ message: '库位已更新' });
        }
        if (method === 'DELETE') {
          const force = q.get('force') === 'true';
          const mats = await LocalDB.getAll('materials');
          const used = mats.filter(m => m.location === loc.name);
          if (used.length && !force) return errJson(400, `该库位下仍有 ${used.length} 款物料，请先移走或使用强制删除`);
          for (const m of used) {
            m.location = ''; m.updated_at = nowLocal();
            await LocalDB.put('materials', m);
          }
          await LocalDB.delete('locations', id);
          await addPendingOp({ kind: 'location_delete', name: loc.name, expected_note: loc.note || '', force: true });
          return okJson({ message: `库位 ${loc.name} 已删除`, cleared_materials: used.length });
        }
      }
      if (p === '/api/batch-location' && method === 'POST') {
        const d = await readBody();
        const loc = (d.location || '').trim();
        if (loc) {
          const locs = await LocalDB.getAll('locations');
          if (!locs.some(l => l.name === loc)) {
            await LocalDB.put('locations', { id: await nextLocId(), name: loc, note: '', created_at: nowLocal() });
          }
        }
        let updated = 0;
        const expected = {};
        const codes = [];
        for (const raw of new Set(d.codes || [])) {
          const code = (raw || '').trim().toUpperCase();
          const mat = await LocalDB.get('materials', code);
          if (!mat) continue;
          expected[code] = mat.location || '';
          codes.push(code);
          mat.location = loc; mat.updated_at = nowLocal();
          await LocalDB.put('materials', mat);
          await addLog(code, 'adjust', 0, mat.quantity, `批量归位至「${loc || '未分配'}」`);
          updated++;
        }
        await addPendingOp({ kind: 'batch_location', codes, location: loc, expected });
        return okJson({ message: `已将 ${updated} 款物料归位到「${loc || '未分配'}」`, updated });
      }

      // ---- 流水 ----
      if (p === '/api/logs' && method === 'GET') {
        const mats = await LocalDB.getAll('materials');
        const matMap = Object.fromEntries(mats.map(m => [m.code, m]));
        let logs = await LocalDB.getAll('logs');
        const kw = (q.get('q') || '').trim().toLowerCase();
        if (kw) {
          logs = logs.filter(l => {
            const m = matMap[l.material_code] || {};
            return [l.material_code, l.reason, m.model, m.brand].some(v => (v || '').toLowerCase().includes(kw));
          });
        }
        const type = q.get('type');
        if (type === 'in') logs = logs.filter(l => l.delta > 0);
        else if (type === 'out') logs = logs.filter(l => l.delta < 0);
        else if (type === 'adjust') logs = logs.filter(l => l.change_type === 'adjust');
        const days = parseInt(q.get('days') || '0');
        if (days > 0) {
          const cutoff = dayLocal(-days + 1);
          logs = logs.filter(l => (l.created_at || '') >= cutoff);
        }
        logs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || (b.id - a.id));
        const total = logs.length;
        const page = Number(q.get('page') || '1');
        const pageSize = Number(q.get('page_size') || '20');
        if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) return errJson(422, '分页参数无效');
        const totalPages = Math.ceil(total / pageSize);
        const pageLogs = logs.slice((page - 1) * pageSize, page * pageSize).map(l => {
          const m = matMap[l.material_code] || {};
          return { ...l, model: m.model || '', brand: m.brand || '', unit: m.unit || '', location: m.location || '' };
        });
        return okJson({ page, page_size: pageSize, total, total_pages: totalPages, logs: pageLogs });
      }

      // ---- 仪表盘 ----
      if (p === '/api/dashboard' && method === 'GET') {
        const mats = await LocalDB.getAll('materials');
        const logs = await LocalDB.getAll('logs');
        const catAgg = Object.create(null);
        for (const m of mats) {
          catAgg[m.category] = catAgg[m.category] || { category: m.category, sku: 0, pieces: 0, value: 0 };
          catAgg[m.category].sku++;
          catAgg[m.category].pieces += m.quantity || 0;
          catAgg[m.category].value += (m.quantity || 0) * (m.price || 0);
        }
        const categories = Object.values(catAgg).map(c => ({ ...c, value: Math.round(c.value * 100) / 100 }))
          .sort((a, b) => b.value - a.value || b.pieces - a.pieces).slice(0, 12);
        const trendAgg = {};
        for (const l of logs) {
          const day = (l.created_at || '').slice(0, 10);
          if (!day || day < dayLocal(-6)) continue;
          trendAgg[day] = trendAgg[day] || { day, in_qty: 0, out_qty: 0 };
          if (l.delta > 0) trendAgg[day].in_qty += l.delta;
          else if (l.delta < 0) trendAgg[day].out_qty += -l.delta;
        }
        const trend = Object.values(trendAgg).sort((a, b) => a.day.localeCompare(b.day)).slice(-7);
        const locAgg = Object.create(null);
        for (const m of mats) {
          if (!m.location) continue;
          locAgg[m.location] = locAgg[m.location] || { name: m.location, sku_count: 0, pieces: 0 };
          locAgg[m.location].sku_count++; locAgg[m.location].pieces += m.quantity || 0;
        }
        const top_locations = Object.values(locAgg).sort((a, b) => b.pieces - a.pieces).slice(0, 8);
        return okJson({ categories, trend, top_locations });
      }

      // ---- 补货建议 ----
      if (p === '/api/restock' && method === 'GET') {
        const mats = await LocalDB.getAll('materials');
        const items = [];
        let total = 0;
        for (const m of mats) {
          if (!(m.min_stock > 0) || m.quantity >= m.min_stock * 2) continue;
          const target = m.min_stock * 2;
          const suggest = target - m.quantity;
          if (suggest <= 0) continue;
          const subtotal = Math.round((m.price || 0) * suggest * 10000) / 10000;
          total += subtotal;
          items.push({ ...m, target, suggest, subtotal: Math.round(subtotal * 100) / 100 });
        }
        items.sort((a, b) => b.suggest - a.suggest);
        return okJson({ items, total_cost: Math.round(total * 100) / 100 });
      }

      // ---- 项目统计 ----
      if (p === '/api/projects' && method === 'GET') {
        const mats = await LocalDB.getAll('materials');
        const matMap = Object.fromEntries(mats.map(m => [m.code, m]));
        const logs = await LocalDB.getAll('logs').then(ls => ls.filter(l => l.delta < 0));
        const agg = Object.create(null);
        for (const l of logs) {
          const name = l.project || '(未关联项目)';
          agg[name] = agg[name] || { project: name, materials: new Set(), out_pieces: 0, out_cost: 0 };
          agg[name].materials.add(l.material_code);
          agg[name].out_pieces += -l.delta;
          agg[name].out_cost += -l.delta * ((matMap[l.material_code] || {}).price || 0);
        }
        return okJson(Object.values(agg).map(r => ({
          project: r.project, materials: r.materials.size, out_pieces: r.out_pieces,
          out_cost: Math.round(r.out_cost * 100) / 100
        })).sort((a, b) => b.out_pieces - a.out_pieces).slice(0, 10));
      }

      // ---- BOM ----
      if (p === '/api/bom/check' && method === 'POST') {
        const d = await readBody();
        let items = [];
        if (d && d.__file) {
          const name = d.__file.name.toLowerCase();
          if (name.endsWith('.txt')) {
            items = parseBomText(d.__file.text);
          } else if (name.endsWith('.csv')) {
            items = parseCsv(d.__file.text).map(row => {
              const pick = (...keys) => keys.map(k => Object.entries(row).find(([h]) => h.toLowerCase() === k.toLowerCase())?.[1]).find(v => v !== undefined && v !== '');
              const model = pick('model', '型号', '商品型号', 'Value', 'Comment', 'MPN', 'Part Number') || '';
              const code = pick('code', 'C编号', '商品编号', '立创编号', 'LCSC') || null;
              const qty = Number(pick('qty', '数量', 'Quantity', '用量') ?? 1);
              if (!Number.isInteger(qty) || qty <= 0) throw new Error('BOM 数量必须是正整数');
              return { raw: model, code: code?.toUpperCase(), model, qty, package: pick('package', '封装', 'Footprint') || detectPackage(model), ref: pick('ref', '位号', 'Designator') || '' };
            }).filter(row => row.code || row.model);
          } else {
            return errJson(400, '离线模式仅支持 CSV/TXT 表格，xlsx 请切回服务器模式导入');
          }
        } else if (d && d.content) {
          items = parseBomText(d.content);
        } else {
          return errJson(400, '请提供 BOM 文本或文件');
        }
        if (!items.length) return errJson(400, '未从输入中解析出任何 BOM 行');
        items = await matchBomItems(items);
        return okJson({ items, summary: bomSummarize(items) });
      }

      // ---- 备份 / 恢复（本地） ----
      if (p === '/api/backup' && method === 'GET') {
        const data = {
          backup_version: 1,
          exported_at: nowLocal(),
          materials: await LocalDB.getAll('materials'),
          stock_logs: await LocalDB.getAll('logs'),
          locations: await LocalDB.getAll('locations')
        };
        data.pending_ops = await LocalDB.getAll('pending_ops');
        data.local_meta = await LocalDB.getAll('meta');
        return okJson(data);
      }
      if (p === '/api/restore' && method === 'POST') {
        const d = await readBody();
        if (!d || !d.__file) return errJson(400, '请上传备份 JSON 文件');
        let data;
        try { data = JSON.parse(d.__file.text); } catch { return errJson(400, '备份文件解析失败'); }
        if (q.get('confirm') !== 'yes') return errJson(400, '缺少确认参数');
        await restoreSnapshot(data);
        return okJson({ message: '恢复完成', materials: data.materials.length, locations: (data.locations || []).length, logs: (data.stock_logs || []).length });
      }

      // ---- 清空全部本地数据 ----
      if (p === '/api/wipe' && method === 'POST') {
        if (q.get('confirm') !== 'yes') return errJson(400, '缺少确认参数');
        await LocalDB.clear('logs');
        await LocalDB.clear('materials');
        await LocalDB.clear('locations');
        await LocalDB.clear('pending_ops');
        await LocalDB.clear('meta');
        return okJson({ message: '已清空本地数据', backup: null });
      }

      // ---- 导出 CSV（本地） ----
      if (p === '/api/export' && method === 'GET') {
        const mats = await LocalDB.getAll('materials');
        return okJson({ exported_at: nowLocal(), count: mats.length, materials: mats, __format: q.get('format') || 'json' });
      }

      // ---- 不支持的端点 ----
      if (p.startsWith('/api/backups')) {
        return errJson(400, '离线模式不使用服务器自动备份，请使用「下载本地备份」');
      }
      if (p === '/api/import') {
        const d = await readBody();
        if (d && d.__file) {
          const name = d.__file.name.toLowerCase();
          if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
            return errJson(400, '离线模式无法解析 Excel，请切回服务器模式或使用 CSV');
          }
          let items;
          if (name.endsWith('.json')) {
            const data = JSON.parse(d.__file.text);
            items = rowsToMaterials(Array.isArray(data) ? data : data.materials || [...(data.today_orders || []), ...(data.historical_inventory || [])]);
          } else if (name.endsWith('.csv')) {
            items = rowsToMaterials(parseCsv(d.__file.text));
          } else {
            return errJson(400, '离线导入仅支持 CSV / JSON');
          }
          if (!items.length) return errJson(400, '文件没有有效物料');
          const receipt = 'import:' + d.__file.hash;
          if (await LocalDB.get('meta', receipt)) return errJson(409, '此文件已导入，已阻止重复累计库存');
          let added = 0, updated = 0;
          for (const r of items) {
            validateMaterial(r);
            r.batch = r.batch || d.__file.name;
            const exist = await LocalDB.get('materials', r.code);
            if (exist) {
              if (exist.quantity + r.quantity > 2147483647) throw new Error('累计数量越界');
              exist.quantity += r.quantity; exist.updated_at = nowLocal();
              await addLog(r.code, 'import', r.quantity, exist.quantity, `离线订单导入累加 (${d.__file.name})`);
              const changes = { batch: [...new Set([exist.batch, r.batch].filter(Boolean))].join(' + ') };
              if (r.price > 0) changes.price = r.price;
              Object.assign(exist, changes);
              await LocalDB.put('materials', exist);
              updated++;
            } else {
              const material = { ...r, created_at: nowLocal(), updated_at: nowLocal() };
              if (r.location) {
                const locs = await LocalDB.getAll('locations');
                if (!locs.some(l => l.name === r.location)) await LocalDB.put('locations', { id: await nextLocId(), name: r.location, note: '', created_at: nowLocal() });
              }
              await LocalDB.put('materials', material);
              await addLog(r.code, 'init', r.quantity, r.quantity, `离线订单导入建档 (${r.batch})`);
              added++;
            }
          }
          await addPendingOp({ kind: 'import', records: items, receipt: d.__file.hash, filename: d.__file.name });
          await LocalDB.put('meta', { key: receipt, value: nowLocal() });
          return okJson({ message: '导入完成', total_parsed: items.length, newly_added: added, stock_updated: updated, skipped: 0 });
        }
        return errJson(400, '请上传文件');
      }

      return errJson(404, `离线模式暂不支持该接口: ${method} ${p}`);
    } catch (e) {
      console.error('LocalAPI error', e);
      return errJson(400, '本地数据处理出错: ' + e.message);
    }
  }

  // 快照恢复（供同步拉取与本地上传共用）
  async function restoreSnapshot(data) {
    if (!data || !Array.isArray(data.materials) || !Array.isArray(data.stock_logs || []) || !Array.isArray(data.locations || []))
      throw new Error('备份结构无效');
    const codes = new Set();
    for (const mat of data.materials) {
      validateMaterial(mat);
      mat.code = mat.code.trim().toUpperCase();
      if (codes.has(mat.code)) throw new Error('备份含重复物料编号');
      codes.add(mat.code);
    }
    const logIds = new Set();
    for (const log of data.stock_logs || []) {
      log.material_code = String(log.material_code || '').trim().toUpperCase();
      if (!codes.has(log.material_code) || !Number.isInteger(log.delta) || !Number.isInteger(log.remaining) || log.remaining < 0)
        throw new Error('备份流水无效');
      if (log.id !== undefined && (!Number.isInteger(log.id) || log.id < 1 || logIds.has(log.id))) throw new Error('流水 ID 无效');
      logIds.add(log.id);
    }
    const names = new Set(), ids = new Set();
    for (const loc of data.locations || []) {
      if (typeof loc.name !== 'string' || !loc.name.trim() || names.has(loc.name.trim())) throw new Error('库位名称无效或重复');
      loc.name = loc.name.trim();
      names.add(loc.name);
      if (loc.id !== undefined && (!Number.isInteger(loc.id) || loc.id < 1 || ids.has(loc.id))) throw new Error('库位 ID 无效');
      ids.add(loc.id);
    }
    await LocalDB.clear('materials');
    await LocalDB.clear('logs');
    await LocalDB.clear('locations');
    await LocalDB.clear('meta');
    let maxLocId = Math.max(0, ...[...ids].filter(Number.isInteger));
    for (const loc of (data.locations || [])) {
      if (!loc.name) continue;
      const id = loc.id || ++maxLocId;
      maxLocId = Math.max(maxLocId, id);
      await LocalDB.put('locations', { id, name: loc.name, note: loc.note || '', created_at: loc.created_at || nowLocal() });
    }
    for (const mat of data.materials) {
      if (mat.location && !names.has(mat.location)) {
        names.add(mat.location);
        await LocalDB.put('locations', { id: ++maxLocId, name: mat.location, note: '', created_at: nowLocal() });
      }
    }
    await LocalDB.put('meta', { key: 'loc_seq', value: maxLocId });
    await LocalDB.bulkPut('materials', (data.materials || []).filter(m => m.code));
    await LocalDB.bulkPut('logs', (data.stock_logs || []).filter(l => l.material_code));
    await LocalDB.put('meta', { key: 'last_sync', value: nowLocal() });
    await LocalDB.put('meta', { key: 'dataset_id', value: data.dataset_id || null });
    if (data.import_receipts !== undefined) {
      if (!Array.isArray(data.import_receipts)) throw new Error('导入记录无效');
      for (const receipt of data.import_receipts) {
        if (typeof receipt.key !== 'string' || !receipt.key.startsWith('import:')) throw new Error('导入记录无效');
        await LocalDB.put('meta', receipt);
      }
    }
    await LocalDB.clear('pending_ops');
    if (data.pending_ops !== undefined) {
      if (!Array.isArray(data.pending_ops)) throw new Error('待同步队列无效');
      for (const op of data.pending_ops) {
        // Legacy operations remain restorable, but sync refuses to replay them without an ID.
        if (!op || typeof op.kind !== 'string' || !op.kind ||
            (op.op_id !== undefined && (typeof op.op_id !== 'string' || !op.op_id)))
          throw new Error('待同步操作无效');
      }
      await LocalDB.bulkPut('pending_ops', data.pending_ops);
    }
    if (data.local_meta !== undefined) {
      if (!Array.isArray(data.local_meta)) throw new Error('本地元数据无效');
      await LocalDB.bulkPut('meta', data.local_meta);
    }
  }

  return { handle, parseLcscBarcode, restoreSnapshot, parseBomText, decodeSpec, matchBomItems };
};

function newOperationId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), v => v.toString(16).padStart(2, '0')).join('');
}

function allocateBomStock(items) {
  const used = new Map();
  for (const it of items) {
    if (!it.matched_code) continue;
    const available = Math.max(0, it.stock_qty - (used.get(it.matched_code) || 0));
    it.available_qty = available;
    it.shortfall = Math.max(0, it.qty - available);
    it.status = it.shortfall ? 'insufficient' : 'ok';
    used.set(it.matched_code, (used.get(it.matched_code) || 0) + it.qty);
  }
  return items;
}

const LocalAPI = {
  ...createLocalAPI(LocalDB),
  async handle(method, path, opts = {}) {
    if (opts.body instanceof FormData) {
      const file = opts.body.get('file');
      if (file) {
        if (file.size > 20 * 1024 * 1024) return { ok: false, status: 413, json: async () => ({ detail: '文件不能超过 20 MB' }) };
        const bytes = await file.arrayBuffer();
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { text = new TextDecoder('gb18030').decode(bytes); }
        const hash = sha256(bytes);
        opts = { ...opts, body: { __file: { name: file.name, text, hash } } };
      }
    }
    return LocalDB.transaction(['materials', 'logs', 'locations', 'meta', 'pending_ops'],
      db => createLocalAPI(db).handle(method.toUpperCase(), path, opts));
  },
  restoreSnapshot: data => LocalDB.transaction(['materials', 'logs', 'locations', 'meta', 'pending_ops'],
    db => createLocalAPI(db).restoreSnapshot(data))
};
