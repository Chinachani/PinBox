"""
BOM 表解析与库存智能匹配引擎
- 支持文本（空格/Tab/逗号分隔）与表格文件解析
- 匹配分层：C编号直击 → 型号精确 → 归一化包含 → 规格解码（阻值/容值/电感量+封装）→ 关键词评分
- 规格解码支持常见料号：0603WAJ0103T5E → 10kΩ 0603；CL10B104KB8NNNC → 100nF 0603；105 → 1uF 等
"""
import re
from typing import List, Dict, Any, Optional
from database import get_db_connection

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

PACKAGE_TOKENS = [
    "2512", "1812", "1210", "1206", "0805", "0603", "0402", "0201",
    "SOT-23", "SOT-89", "SOT-363", "SOT-223", "TO-220", "TO-252", "TO-263", "TO-92",
    "SMA", "SMB", "SMC", "SOD-123", "SOD-323", "SOP-8", "SOP-16", "TSSOP", "SSOP",
    "TQFP", "QFN", "DFN", "MSOP", "DIP", "SMD",
]

CAP_VENDOR_PREFIX = re.compile(
    r'^(CL|CC|GRM|CGA|TMK|KEM|0603B|0805B|0603X|0805X|CA|CT|ECU|ECJ|C\d{2})', re.I)

def detect_package(text: str) -> str:
    t = str(text).upper().replace('，', ',').replace('（', '(')
    for p in PACKAGE_TOKENS:
        if p.upper() in t:
            return p
    return ""

def _num_str(f: float) -> str:
    s = ('%.4f' % f).rstrip('0').rstrip('.')
    return s or '0'

# ---------------------------------------------------------------------------
# 规格解码：从料号/描述行提取「值 + 封装」原子
# ---------------------------------------------------------------------------

def _decode_digit_code(digits: str) -> Optional[float]:
    """3 位 105 → 10×10^5；4 位 0103 → 010×10^3。返回原始数值（电阻=Ω / 电容=pF）。"""
    if len(digits) == 3 and digits.isdigit():
        return int(digits[:2]) * (10 ** int(digits[2]))
    if len(digits) == 4 and digits.isdigit():
        return int(digits[:3]) * (10 ** int(digits[3]))
    return None

def _value_to_text(val: float, kind: str) -> List[str]:
    """把数值转成库存描述里常见的写法，返回多个等价写法用于 LIKE 匹配。"""
    out = []
    if kind == 'res':
        # val 单位 Ω
        if val >= 1e6:
            out.append(f"{_num_str(val/1e6)}MΩ")
        elif val >= 1e3:
            out.append(f"{_num_str(val/1e3)}kΩ")
        else:
            out.append(f"{_num_str(val)}Ω")
        out.append(out[0].replace('Ω', '').upper() + 'R')  # 10K 形式
        out.append(f"{_num_str(val)}R")
    elif kind == 'cap':
        # val 单位 pF
        if val >= 1e6:
            out.append(f"{_num_str(val/1e6)}uF")
            out.append(f"{_num_str(val/1e6)}µF")
        elif val >= 1e3:
            out.append(f"{_num_str(val/1e3)}nF")
        else:
            out.append(f"{_num_str(val)}pF")
    elif kind == 'ind':
        out.append(f"{_num_str(val)}uH")
        out.append(f"{_num_str(val)}UH")
    return out

def decode_spec(line: str) -> Dict[str, Any]:
    """
    从 BOM 行解码规格原子。返回:
      { package, res_values:[写法...], cap_values:[...], ind_values:[...], voltages:[] }
    解码是「多解释并存」的：同一串数字在电阻/电容语境下含义不同，
    由后续与库存的实际命中情况裁决。
    """
    res = {"package": detect_package(line), "res_values": [], "cap_values": [],
           "ind_values": [], "voltages": [], "dims": [], "pins": []}
    if not line:
        return res

    work = str(line).replace('µ', 'u').replace('μ', 'u')
    # 1) 显式电感
    for m in re.finditer(r'(\d+(?:\.\d+)?)\s*(?:UH|µH|UH)', work, re.I):
        res["ind_values"] += _value_to_text(float(m.group(1)), 'ind')
    # 2) 显式电容单位
    for m in re.finditer(r'(\d+(?:\.\d+)?)\s*(?:UF|µF|NF|PF)', work, re.I):
        v = float(m.group(1))
        unit = re.search(r'(UF|µF|NF|PF)', m.group(0), re.I).group(1).upper()
        pf = v * 1e6 if 'U' in unit else (v * 1e3 if 'N' in unit else v)
        res["cap_values"] += _value_to_text(pf, 'cap')
    # 3) 显式电阻单位（Ω/KΩ/MΩ/OHM，或 4R7 / 10K 形式）
    for m in re.finditer(r'(\d+(?:\.\d+)?)(R|K|M)(\d+)?\b', work, re.I):
        a = float(m.group(1)); unit = m.group(2).upper(); b = m.group(3)
        val = a * (1 if unit == 'R' else (1e3 if unit == 'K' else 1e6))
        if b:
            frac = float('0.' + b)
            val = (a + frac) * (1 if unit == 'R' else (1e3 if unit == 'K' else 1e6))
        res["res_values"] += _value_to_text(val, 'res')
    for m in re.finditer(r'(\d+(?:\.\d+)?)\s*(?:Ω|OHM|KΩ|MΩ)', work, re.I):
        t = m.group(0).upper()
        val = float(m.group(1))
        if 'MΩ' in t:
            val *= 1e6
        elif 'KΩ' in t:
            val *= 1e3
        res["res_values"] += _value_to_text(val, 'res')

    # 4) 从料号中剥离封装/供应商前缀后，尝试 3~4 位数字编码解读
    cleaned = work.upper()
    if res["package"]:
        cleaned = cleaned.replace(res["package"].upper(), ' ')
    # 电压（16V/50V/100V）
    for m in re.finditer(r'(\d+(?:\.\d+)?)(?:V)\b', cleaned):
        res["voltages"].append(m.group(1) + 'V')
    # 尺寸（10X20）、针脚（1X15P / 2P）
    for m in re.finditer(r'\b(\d{1,3}X\d{1,3}(?:X\d{1,3})?)\b', cleaned):
        res["dims"].append(m.group(1))
    for m in re.finditer(r'\b(\d{1,2}X\d{1,2}P|\d{1,2}P)\b', cleaned):
        res["pins"].append(m.group(1))

    # 逐 token 解数字编码（去掉已知封装、纯数量、含字母前缀较长的型号主体）
    for tok in re.split(r'[^0-9A-Za-z.\-]+', cleaned):
        if not tok or len(tok) > 20:
            continue
        # 去掉字母前缀（如 CL10B / 0603B 后的数字主体）；纯数字也接受
        m = re.match(r'^[A-Z]{0,4}(\d{3,4})([JKMZ])?$', tok.upper())
        if not m:
            continue
        digits = m.group(1)
        val = _decode_digit_code(digits)
        if val is None or val <= 0:
            continue
        # 电容解释（pF）与电阻解释（Ω）都记录，命中情况裁决
        if val <= 1e8:
            res["cap_values"] += _value_to_text(val, 'cap')
        if val <= 1e7:
            res["res_values"] += _value_to_text(val, 'res')

    # 料号内嵌模式的补充扫描（MPN 中容差字母前后都可能挂数值）：
    #   数值+容差字母 → 105K (CL10B104KB8NNNC) / 330J (0603WAF330JT5E → 33Ω)
    #   容差字母+4位数值 → J0103 (0603WAJ0103T5E → 10kΩ)
    for m in re.finditer(r'(\d{3})([JKMZ])', cleaned):
        val = _decode_digit_code(m.group(1))
        if val and 0 < val <= 1e8:
            res["cap_values"] += _value_to_text(val, 'cap')
            res["res_values"] += _value_to_text(val, 'res')
    for m in re.finditer(r'([JKM])(\d{4})(?!\d)', cleaned):
        val = _decode_digit_code(m.group(2))
        if val and 0 < val <= 1e7:
            res["res_values"] += _value_to_text(val, 'res')
            res["cap_values"] += _value_to_text(val, 'cap')

    # 去重保序
    for k in ("res_values", "cap_values", "ind_values", "voltages", "dims", "pins"):
        seen, uniq = set(), []
        for v in res[k]:
            if v not in seen:
                seen.add(v)
                uniq.append(v)
        res[k] = uniq
    return res

# ---------------------------------------------------------------------------
# BOM 行解析
# ---------------------------------------------------------------------------

def parse_bom_text(content: str) -> List[Dict[str, Any]]:
    """解析粘贴文本：每行 `型号 [封装...] 数量`，空格/Tab/逗号均可，支持空行与表头。"""
    items = []
    lines = [l.strip() for l in content.replace('\t', ' ').splitlines()]
    header_re = re.compile(r'(型号|数量|位号|规格| qty |quantity|value|designator|comment|manufacturer)', re.I)

    for lineno, line in enumerate(lines, 1):
        if not line:
            continue
        if lineno <= 2 and header_re.search(line) and not re.search(r'C\d{4,9}', line):
            continue  # 表头行
        tokens = [t for t in re.split(r'[,;|]|\s{1,}', line) if t]
        if not tokens:
            continue

        code = None
        cm = re.search(r'\b(C\d{4,9})\b', line, re.I)
        if cm:
            code = cm.group(1).upper()

        # Only the final token is a quantity; package codes remain part of the specification.
        qty = 1
        m = re.fullmatch(r'(?:[xX*×]|\+)?(\d{1,9})', tokens[-1])
        if len(tokens) > 1 and m and (tokens[-1] not in PACKAGE_TOKENS or len(tokens) > 2):
            qty = int(m.group(1))
            tokens.pop()
            if qty < 1:
                raise ValueError("BOM 数量必须是正整数")

        tokens_left = [t for t in tokens if t.upper() != (code or '')]
        refs = [t for t in tokens_left if re.fullmatch(r'(?:R|C|L|D|Q|U|J|P|LED|SW)\d+', t, re.I)]
        model = ' '.join(t for t in tokens_left if t not in refs) or (code or '')
        ref = ' '.join(refs)

        if not model and not code:
            continue
        items.append({
            "raw": line, "code": code, "model": model,
            "package": detect_package(line), "qty": int(qty) if qty > 0 else 1,
            "ref": ref,
        })
    return items

def parse_bom_file_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把表格文件的字典行归一化为 BOM 项。"""
    items = []
    key_model = ("型号", "商品型号", "值", "Value", "Comment", "名称", "物料型号", "Manufacturer Part", "MPN", "Part Number", "model")
    key_qty = ("数量", "Qty", "Quantity", "用量", "需求数量", "qty")
    key_pkg = ("封装", "Footprint", "Package", "封装格式", "package")
    key_ref = ("位号", "Reference", "Designator", "Ref", "ref")
    key_code = ("立创编号", "C编号", "商品编号", "LCSC", "Part No.", "code")

    def pick(row, keys):
        for k in keys:
            for rk in row:
                if rk and k.lower() == str(rk).strip().lower():
                    v = row[rk]
                    if v is not None and str(v).strip():
                        return str(v).strip()
        return ""

    for row in rows:
        model = pick(row, key_model)
        code_raw = pick(row, key_code)
        cm = re.search(r'\b(C\d{4,9})\b', code_raw or '', re.I)
        code = cm.group(1).upper() if cm else None
        if not model and not code:
            continue
        qty_raw = pick(row, key_qty)
        try:
            numeric = float(qty_raw) if qty_raw else 1.0
            if not numeric.is_integer() or numeric < 1 or numeric > 2147483647:
                raise ValueError("BOM 数量必须是正整数")
            qty = int(numeric)
        except (ValueError, OverflowError) as exc:
            raise ValueError("BOM 数量必须是正整数") from exc
        items.append({
            "raw": f"{model} x{qty}", "code": code, "model": model,
            "package": detect_package(pick(row, key_pkg) + ' ' + model),
            "qty": max(1, qty), "ref": pick(row, key_ref),
        })
    return items

# ---------------------------------------------------------------------------
# 库存匹配
# ---------------------------------------------------------------------------

def _norm(s: str) -> str:
    return re.sub(r'[\s\-_()（）/\\.,·]+', '', str(s or '')).upper()

def _tokenize(s: str) -> List[str]:
    return [t for t in re.split(r'[^0-9A-Za-z\u4e00-\u9fff]+', str(s or '').upper()) if len(t) >= 2]

def find_materials(query: str, limit: int = 12) -> Dict[str, Any]:
    """
    找料模式：自然描述反查库存。
    例："10k 0603 电阻" / "470uF 50V 电解" / "ESP32" / "SS34" / "100nF"
    返回规格解读 + 按相关度排序的库存候选。
    """
    conn = get_db_connection()
    inv = [dict(r) for r in conn.execute(
        "SELECT code, model, brand, category, package, quantity, price, location FROM materials").fetchall()]
    conn.close()

    spec = decode_spec(query)
    q_norm = _norm(query)
    q_tokens = set(_tokenize(query))

    # 类别判定（描述里有明确类别词则强过滤）
    cat_hints = []
    for word in ("电阻", "电容", "电感", "晶振", "MOS", "二极管", "三极管", "稳压", "传感器",
                 "连接器", "排针", "排母", "按键", "开关", "LED", "屏幕", "模块", "芯片", "保险", "天线"):
        if word in query:
            cat_hints.append(word)

    pkg = spec["package"]
    scored = []
    for m in inv:
        hay = f'{m["model"]} {m["package"] or ""} {m["brand"] or ""} {m["category"] or ""}'.upper()
        hay_norm = _norm(hay)
        score = 0.0

        # 1. C编号直击
        if q_norm and q_norm == _norm(m["code"]):
            score = 1.0
        # 2. 型号归一化命中
        elif q_norm and (q_norm in hay_norm or hay_norm in q_norm) and min(len(q_norm), len(hay_norm)) >= 4:
            score = 0.85

        # 3. 规格解码：值 + 封装 + 类别
        values = spec["res_values"] + spec["cap_values"] + spec["ind_values"]
        val_hits = sum(1 for v in values if v.upper() in hay)
        if val_hits:
            score = max(score, 0.6 + 0.08 * min(val_hits, 2))
        if pkg and pkg in hay:
            score += 0.12
        if cat_hints:
            if any(c in (m["category"] or "") or c in (m["model"] or "") for c in cat_hints):
                score += 0.15
            else:
                score -= 0.2   # 描述明确指定类别但物料不符 → 降权

        # 4. token 覆盖
        if q_tokens:
            mt = set(_tokenize(hay))
            inter = q_tokens & mt
            strong = [t for t in inter if len(t) >= 3]
            if strong:
                score = max(score, 0.35 + 0.25 * (len(strong) / len(q_tokens)))

        if score >= 0.35:
            scored.append({"score": round(min(score, 1.0), 2), **m})

    scored.sort(key=lambda x: -x["score"])
    return {
        "query": query,
        "spec": spec,
        "results": scored[:limit],
        "total": len(scored)
    }

def match_bom_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    逐行匹配库存。分层：
      1. C编号直击      2. 型号精确      3. 归一化相等/包含
      4. 规格解码匹配（阻值/容值/电感 + 封装 + 类别）
      5. 关键词 token 评分
    """
    conn = get_db_connection()

    # 库存全量载入（几千行内内存匹配更快更灵活）
    inv = [dict(r) for r in conn.execute("SELECT code, model, brand, category, package, quantity, price FROM materials").fetchall()]
    conn.close()

    for it in items:
        it["candidates"] = []
        best = None

        # 1. C编号直击
        if it.get("code"):
            for m in inv:
                if m["code"] == it["code"]:
                    best = {"tier": "code", "m": m, "score": 1.0}
                    break

        # 2. 型号精确
        if not best and it.get("model"):
            um = it["model"].strip().upper()
            for m in inv:
                if m["model"].strip().upper() == um:
                    best = {"tier": "exact", "m": m, "score": 0.98}
                    break

        # 3. 归一化相等 / 包含（长度>=5 才做包含，避免短码误命中）
        if not best and it.get("model"):
            nm = _norm(it["model"])
            if nm:
                for m in inv:
                    ninv = _norm(m["model"])
                    if not ninv:
                        continue
                    if ninv == nm:
                        best = {"tier": "norm", "m": m, "score": 0.95}; break
                    if min(len(nm), len(ninv)) >= 5 and (nm in ninv or ninv in nm):
                        c = {"tier": "contains", "m": m, "score": 0.85}
                        if not best or c["score"] > best["score"]:
                            best = c

        # 3.5 短料号（如 SS34 / S8050）：BOM 主码作为独立 token 出现在库存型号中
        if not best and it.get("model"):
            nm = _norm(it["model"])
            if 3 <= len(nm) <= 12 and re.fullmatch(r'[A-Z0-9]+', nm):
                for m in inv:
                    if nm in _tokenize(f'{m["model"]} {m["brand"] or ""}'):
                        best = {"tier": "mpn", "m": m, "score": 0.92}
                        break

        # 4. 规格解码匹配
        if not best and it.get("model"):
            spec = decode_spec(f'{it["model"]} {it.get("package") or ""} {it.get("ref") or ""}')
            pkg = spec["package"] or (it.get("package") or "")
            cat_words = []
            if spec["res_values"]: cat_words += [("电阻", spec["res_values"])]
            if spec["cap_values"]: cat_words += [("电容", spec["cap_values"])]
            if spec["ind_values"]: cat_words += [("电感", spec["ind_values"])]

            scored = []
            for cat, values in cat_words:
                for m in inv:
                    if cat not in (m["category"] or "") and cat not in (m["model"] or ""):
                        continue
                    hay = f'{m["model"]} {m["package"] or ""}'.upper()
                    if pkg and pkg not in hay:
                        continue
                    val_hit = any(v.upper() in hay for v in values)
                    if not val_hit:
                        continue
                    # 电压冲突软惩罚：BOM 标 50V 而库存只写 16V → 降为候选
                    volt_conflict = False
                    if spec["voltages"]:
                        inv_volts = set(re.findall(r'(\d+(?:\.\d+)?)V', hay))
                        bom_volts = {v[:-1] for v in spec["voltages"]}
                        if inv_volts and not (inv_volts & bom_volts):
                            volt_conflict = True
                    score = 0.75 + (0.05 if pkg else 0) - (0.15 if volt_conflict else 0)
                    scored.append({"tier": "spec", "m": m, "score": min(max(score, 0.5), 0.9)})
            if scored:
                scored.sort(key=lambda x: -x["score"])
                best = scored[0]

        # 5. 关键词 token 评分（兜底；剔除纯封装 token 防止仅凭 0603 误配）
        token_pool = []
        if not best and it.get("model"):
            bt = set(_tokenize(it["model"] + ' ' + (it.get("package") or '')))
            if it.get("package"):
                bt.discard(str(it["package"]).upper())
            if len(bt) >= 2:
                for m in inv:
                    mt = set(_tokenize(f'{m["model"]} {m["brand"] or ""} {m["package"] or ""} {m["category"] or ""}'))
                    if not mt:
                        continue
                    inter = bt & mt
                    # 必须命中至少一个长度>=3 的强 token，防 2P/SMD 之类弱 token 误配
                    if not inter or max(len(t) for t in inter) < 3:
                        continue
                    score = len(inter) / max(len(bt), 1)
                    if score >= 0.5:
                        token_pool.append({"tier": "token", "m": m, "score": round(0.4 + score * 0.3, 2)})
                token_pool.sort(key=lambda x: -x["score"])
                if token_pool:
                    best = token_pool[0]

        # 候选列表（Top3，供人工改选）
        cand = {}
        pools = []
        if best:
            pools.append(best)
        # 补充规格/token 候选
        if it.get("model"):
            spec = decode_spec(f'{it["model"]} {it.get("package") or ""}')
            for cat, values in (
                ([("电阻", spec["res_values"])] if spec["res_values"] else []) +
                ([("电容", spec["cap_values"])] if spec["cap_values"] else []) +
                ([("电感", spec["ind_values"])] if spec["ind_values"] else [])):
                for m in inv:
                    if cat not in (m["category"] or "") and cat not in (m["model"] or ""):
                        continue
                    hay = f'{m["model"]} {m["package"] or ""}'.upper()
                    if spec["package"] and spec["package"] not in hay:
                        continue
                    if any(v.upper() in hay for v in values):
                        cand[m["code"]] = {"code": m["code"], "model": m["model"], "brand": m["brand"],
                                           "package": m["package"], "quantity": m["quantity"],
                                           "price": m["price"], "score": 0.75}
            bt = set(_tokenize(it["model"] + ' ' + (it.get("package") or '')))
            if it.get("package"):
                bt.discard(str(it["package"]).upper())
            if len(bt) >= 2:
                for m in inv:
                    mt = set(_tokenize(f'{m["model"]} {m["brand"] or ""} {m["package"] or ""} {m["category"] or ""}'))
                    if not mt:
                        continue
                    inter = bt & mt
                    if not inter or max(len(t) for t in inter) < 3:
                        continue
                    score = len(inter) / max(len(bt), 1)
                    if score >= 0.45 and m["code"] not in cand:
                        cand[m["code"]] = {"code": m["code"], "model": m["model"], "brand": m["brand"],
                                           "package": m["package"], "quantity": m["quantity"],
                                           "price": m["price"], "score": round(score, 2)}
        model_matches = [m for m in inv if it.get("model") and _norm(m["model"]) == _norm(it["model"]) and
                         (not it.get("package") or _norm(m["package"]) == _norm(it["package"]))]
        for m in model_matches:
            cand[m["code"]] = {"code": m["code"], "model": m["model"], "brand": m["brand"],
                               "package": m["package"], "quantity": m["quantity"], "price": m["price"], "score": 0.95}
        if best:
            bm = best["m"]
            cand[bm["code"]] = {"code": bm["code"], "model": bm["model"], "brand": bm["brand"],
                                "package": bm["package"], "quantity": bm["quantity"],
                                "price": bm["price"], "score": best["score"]}
        cl = sorted(cand.values(), key=lambda c: (not (best and c["code"] == best["m"]["code"]), -c["score"]))[:3]
        it["candidates"] = cl

        # Similar specifications are suggestions, not verified electrical substitutes.
        package_agrees = not it.get("package") or (best and _norm(it["package"]) == _norm(best["m"]["package"]))
        if best and best["tier"] in ("code", "exact", "norm") and (best["tier"] == "code" or (package_agrees and len(model_matches) == 1)) and (not it.get("code") or best["m"]["code"] == it["code"]):
            chosen = next(c for c in cl if c["code"] == best["m"]["code"])
        else:
            chosen = None

        if chosen:
            it["matched_code"] = chosen["code"]
            it["matched_model"] = chosen["model"]
            it["matched_brand"] = chosen["brand"]
            it["matched_price"] = chosen["price"]
            it["stock_qty"] = chosen["quantity"]
            it["match_tier"] = best["tier"] if best else "candidate"
            it["shortfall"] = max(0, it["qty"] - chosen["quantity"])
            it["status"] = "insufficient" if chosen["quantity"] < it["qty"] else "ok"
        else:
            it["matched_code"] = None
            it["matched_model"] = None
            it["matched_price"] = 0.0
            it["stock_qty"] = 0
            it["match_tier"] = None
            it["shortfall"] = it["qty"]
            it["status"] = "none"

    return allocate_stock(items)


def allocate_stock(items):
    used = {}
    for item in items:
        code = item.get("matched_code")
        if not code:
            continue
        available = max(0, item["stock_qty"] - used.get(code, 0))
        item["available_qty"] = available
        item["shortfall"] = max(0, item["qty"] - available)
        item["status"] = "insufficient" if item["shortfall"] else "ok"
        used[code] = used.get(code, 0) + item["qty"]
    return items

def summarize(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    total_cost = 0.0
    shortfall_cost = 0.0
    ok = insufficient = none = 0
    for it in items:
        if it["status"] == "ok":
            ok += 1
        elif it["status"] == "insufficient":
            insufficient += 1
        else:
            none += 1
        if it.get("matched_price"):
            total_cost += it["matched_price"] * it["qty"]
            if it["status"] != "ok":
                shortfall_cost += it["matched_price"] * it.get("shortfall", it["qty"])
    return {
        "lines": len(items), "ok": ok, "insufficient": insufficient, "none": none,
        "total_cost": round(total_cost, 2),
        "shortfall_cost": round(shortfall_cost, 2),
    }
