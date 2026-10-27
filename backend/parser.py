import re
import csv
import json
import io
from typing import Dict, Any, Optional, List

from use_case_infer import infer_material_use_case
def parse_lcsc_barcode(raw_text: str) -> Dict[str, Any]:
    """
    解析立创包装袋二维码/条形码文本，提取 C编号、可能包含的型号与数量
    常见格式：
      - 纯编号: C123456
      - 逗号分隔: C123456,100,20261026
      - 键值串: {code:C123456,qty:100,model:...} 或 item_code:C123456;qty:100
      - 商品链接: https://www.szlcsc.com/product-detail/C123456.html
    """
    raw_text = raw_text.strip()
    result = {
        "raw": raw_text,
        "code": None,
        "quantity": None,
        "model": None,
        "matched": False
    }
    
    if not raw_text:
        return result
        
    # 1. 优先精准匹配立创官方键值对格式：pc:C91372, pm:ESD-15, qty:1, on:SO26101510160
    pc_match = re.search(r'(?:pc|code|item_code)[\s:=]*["\']?(C\d{4,9})["\']?', raw_text, re.IGNORECASE)
    if pc_match:
        result["code"] = pc_match.group(1).upper()
        result["matched"] = True
    else:
        # 兼容传统纯 C 编号查找
        c_match = re.search(r'\b(C\d{4,9})\b', raw_text, re.IGNORECASE)
        if not c_match:
            c_match = re.search(r'(C\d{4,9})', raw_text, re.IGNORECASE)
        if c_match:
            result["code"] = c_match.group(1).upper()
            result["matched"] = True
            
    # 2. 提取型号：pm:ESD-15 或 model:...
    pm_match = re.search(r'(?:pm|model|型号)[\s:=]*["\']?([^,;\n}]+)["\']?', raw_text, re.IGNORECASE)
    if pm_match:
        result["model"] = pm_match.group(1).strip()
        
    # 3. 提取数量：精准支持常见立创标签模式
    # 如: qty:1 或 qty:100 或 QTY: 40个 或 QTY: 1个 或 数量: 100 或 纯数字段
    qty_match = re.search(r'(?:qty|数量|count|pcs|quantity)[\s:=]*["\']?([0-9]+(?:\.[0-9]+)?)', raw_text, re.IGNORECASE)
    if qty_match:
        try:
            result["quantity"] = int(float(qty_match.group(1)))
        except (ValueError, TypeError):
            pass
    else:
        # 如果没有明确的 qty 前缀，但在大括号键值对或逗号分隔中
        # 形如: {...,cc:1,...} 或 40个
        cn_qty_match = re.search(r'([0-9]+)\s*(?:个|颗|支|块|条|套|PCS|只)\b', raw_text, re.IGNORECASE)
        if cn_qty_match:
            try:
                result["quantity"] = int(cn_qty_match.group(1))
            except ValueError:
                pass
        else:
            parts = [p.strip() for p in re.split(r'[,;|\n]', raw_text) if p.strip()]
            if len(parts) >= 2 and result["code"]:
                for p in parts:
                    if p != result["code"] and p.isdigit():
                        result["quantity"] = int(p)
                        break

    return result

def parse_import_records(content: bytes, filename: str) -> List[Dict[str, Any]]:
    """
    全面解析嘉立创导出的所有订单明细（.xls, .xlsx, .csv, .json）
    针对嘉立创商城导出的物料明细对账单（首行金额汇总，第2行为表头）做深度适配。
    """
    items = []
    fname = filename.lower()
    
    # 1. JSON 格式解析
    if fname.endswith(".json"):
        try:
            data = json.loads(content.decode("utf-8", errors="replace"))
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict):
                if "today_orders" in data or "historical_inventory" in data:
                    for row in data.get("today_orders", []):
                        code_val = row.get("商品编号") or row.get("code")
                        if not code_val or not re.search(r'(C\d{4,9})', str(code_val), re.IGNORECASE):
                            continue
                        items.append({
                            "code": code_val,
                            "category": row.get("商品类型") or row.get("category", "通用元器件"),
                            "brand": row.get("品牌") or row.get("brand", ""),
                            "model": row.get("商品型号/名称") or row.get("name") or row.get("model", ""),
                            "package": row.get("封装格式") or row.get("pkg") or row.get("package", ""),
                            "quantity": int(row.get("采购数量") or row.get("qty", 1)),
                            "unit": row.get("单位") or row.get("unit", "个"),
                            "use_case": row.get("核心用途/实验场景") or row.get("use", ""),
                            "batch": row.get("库存批次") or row.get("batch", "导入订单")
                        })
                    for row in data.get("historical_inventory", []):
                        code_val = row.get("code")
                        if not code_val or not re.search(r'(C\d{4,9})', str(code_val), re.IGNORECASE):
                            continue
                        desc = f"{row.get('model', '')} {row.get('description', '')}".strip()
                        items.append({
                            "code": code_val,
                            "category": row.get("category", "通用元器件"),
                            "brand": row.get("brand", ""),
                            "model": desc or row.get("model", ""),
                            "package": row.get("package", ""),
                            "quantity": int(row.get("quantity", 1)),
                            "unit": row.get("unit", "个"),
                            "use_case": "历史采购物料",
                            "batch": row.get("source", "往期对账单")
                        })
                elif "materials" in data:
                    items = data["materials"]
        except Exception as e:
            print("JSON parse error:", e)

    # 2. CSV 格式解析
    elif fname.endswith(".csv"):
        try:
            text = content.decode("utf-8-sig", errors="replace")
            lines = text.splitlines()
            # 自动探测哪一行是真正包含“商品编号”或“C编号”的表头
            header_idx = 0
            for i, line in enumerate(lines[:10]):
                if "商品编号" in line or "C编号" in line or "商品型号" in line or "code" in line.lower():
                    header_idx = i
                    break
            
            reader = csv.DictReader(io.StringIO("\n".join(lines[header_idx:])))
            for row in reader:
                code = row.get("商品编号") or row.get("code") or row.get("C编号") or row.get("立创编号")
                if not code:
                    continue
                c_match = re.search(r'(C\d{4,9})', str(code), re.IGNORECASE)
                if not c_match:
                    continue
                code = c_match.group(1).upper()
                
                qty = row.get("订购数量") or row.get("采购数量") or row.get("数量") or row.get("实发数量") or 1
                try:
                    qty = int(float(qty))
                except (ValueError, TypeError):
                    qty = 1
                    
                items.append({
                    "code": code,
                    "category": row.get("商品类型") or row.get("分类") or "立创商城物料",
                    "brand": row.get("品牌") or "",
                    "model": row.get("商品型号") or row.get("商品型号/名称") or row.get("型号") or "",
                    "package": row.get("封装格式") or row.get("封装") or "",
                    "quantity": qty,
                    "unit": row.get("商品单位") or row.get("单位") or "个",
                    "use_case": infer_material_use_case(code, row.get("商品类型") or row.get("分类") or "", row.get("品牌") or "", row.get("商品型号") or row.get("型号") or "", row.get("商品名称") or ""),
                    "batch": filename
                })
        except Exception as e:
            print("CSV parse error:", e)

    # 3. Excel 格式解析 (.xls 与 .xlsx)
    elif fname.endswith(".xls") or fname.endswith(".xlsx"):
        # 首先尝试 xlrd (支持立创导出的标准 BIFF8 .xls)
        parsed_with_xlrd = False
        try:
            import xlrd
            wb = xlrd.open_workbook(file_contents=content)
            sheet = wb.sheet_by_index(0)
            
            # 智能扫描前 10 行寻找表头
            header_row_idx = -1
            header_map = {}
            for r in range(min(10, sheet.nrows)):
                row_vals = [str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols)]
                if any("商品编号" in v or "C编号" in v or "商品型号" in v for v in row_vals):
                    header_row_idx = r
                    header_map = {v: c for c, v in enumerate(row_vals) if v}
                    break
                    
            if header_row_idx != -1:
                def get_cell(row_idx, keys, default=""):
                    for k in keys:
                        for hk in header_map:
                            if k in hk:
                                val = sheet.cell_value(row_idx, header_map[hk])
                                if val is not None and str(val).strip():
                                    return str(val).strip()
                    return default

                for r in range(header_row_idx + 1, sheet.nrows):
                    code_raw = get_cell(r, ["商品编号", "C编号", "立创编号", "商品代码"])
                    c_match = re.search(r'(C\d{4,9})', code_raw, re.IGNORECASE)
                    if not c_match:
                        continue
                    code = c_match.group(1).upper()
                    
                    qty_str = get_cell(r, ["订购数量", "采购数量", "数量", "实发数量"], "1")
                    try:
                        qty = int(float(qty_str))
                    except (ValueError, TypeError):
                        qty = 1
                    
                    price_str = get_cell(r, ["单价", "单价（人民币含税）", "含税单价", "price"], "0")
                    try:
                        price = round(float(str(price_str).replace("￥", "").replace(",", "").strip()), 4)
                    except Exception:
                        price = 0.0
                        
                    model_str = get_cell(r, ["商品型号", "型号"])
                    desc_str = get_cell(r, ["商品名称", "描述"])
                    full_model = model_str if model_str else desc_str
                    
                    items.append({
                        "code": code,
                        "category": get_cell(r, ["商品类型", "分类"], "立创商城物料"),
                        "brand": get_cell(r, ["品牌"], ""),
                        "model": full_model,
                        "package": get_cell(r, ["封装格式", "封装"], ""),
                        "quantity": qty,
                        "unit": get_cell(r, ["商品单位", "单位"], "个"),
                        "price": price,
                        "use_case": infer_material_use_case(code, get_cell(r, ["商品类型", "分类"], ""), get_cell(r, ["品牌"], ""), full_model, desc_str),
                        "batch": filename
                    })
                parsed_with_xlrd = len(items) > 0
        except Exception as e:
            print("xlrd parse fallback:", e)
            
        # 若 xlrd 未能解析，则回退 openpyxl (.xlsx 格式)
        if not parsed_with_xlrd:
            try:
                import openpyxl
                wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
                sheet = wb.active
                
                header_row_idx = -1
                header_map = {}
                rows = list(sheet.iter_rows(values_only=True))
                for r, row in enumerate(rows[:10]):
                    if not row: continue
                    str_vals = [str(c).strip() for c in row if c is not None]
                    if any("商品编号" in v or "C编号" in v or "商品型号" in v for v in str_vals):
                        header_row_idx = r
                        header_map = {str(c).strip(): idx for idx, c in enumerate(row) if c is not None}
                        break
                        
                if header_row_idx != -1:
                    def get_openpyxl_val(row, keys, default=""):
                        for k in keys:
                            for hk, idx in header_map.items():
                                if k in hk and idx < len(row):
                                    v = row[idx]
                                    if v is not None and str(v).strip():
                                        return str(v).strip()
                        return default

                    for row in rows[header_row_idx + 1:]:
                        if not any(row): continue
                        code_raw = get_openpyxl_val(row, ["商品编号", "C编号", "立创编号", "商品代码"])
                        c_match = re.search(r'(C\d{4,9})', code_raw, re.IGNORECASE)
                        if not c_match: continue
                        code = c_match.group(1).upper()
                        
                        qty_str = get_openpyxl_val(row, ["订购数量", "采购数量", "数量", "实发数量"], "1")
                        try:
                            qty = int(float(qty_str))
                        except (ValueError, TypeError):
                            qty = 1
                            
                        price_str = get_openpyxl_val(row, ["单价", "单价（人民币含税）", "含税单价", "price"], "0")
                        try:
                            price = round(float(str(price_str).replace("￥", "").replace(",", "").strip()), 4)
                        except Exception:
                            price = 0.0
                            
                        model_str = get_openpyxl_val(row, ["商品型号", "型号"])
                        desc_str = get_openpyxl_val(row, ["商品名称", "描述"])
                        
                        items.append({
                            "code": code,
                            "category": get_openpyxl_val(row, ["商品类型", "分类"], "立创商城物料"),
                            "brand": get_openpyxl_val(row, ["品牌"], ""),
                            "model": model_str or desc_str,
                            "package": get_openpyxl_val(row, ["封装格式", "封装"], ""),
                            "quantity": qty,
                            "unit": get_openpyxl_val(row, ["商品单位", "单位"], "个"),
                            "price": price,
                        "use_case": infer_material_use_case(code, get_openpyxl_val(row, ["商品类型", "分类"], ""), get_openpyxl_val(row, ["品牌"], ""), model_str or desc_str, desc_str),
                            "batch": filename
                        })
            except Exception as e:
                print("openpyxl parse error:", e)
                
    return items
