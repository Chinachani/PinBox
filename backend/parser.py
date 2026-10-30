import csv
import io
import json
import math
import re

from schemas import MaterialCreate
from use_case_infer import infer_material_use_case


CODE_RE = re.compile(r"(?<![A-Za-z0-9])(C\d{1,9})(?!\d)", re.I)


def parse_lcsc_barcode(raw_text):
    raw = str(raw_text or "").strip()
    result = {"raw": raw, "code": None, "quantity": None, "model": None, "matched": False}
    code = re.search(r'(?:pc|code|item_code)["\']?\s*[:=]\s*["\']?(C\d{1,9})(?!\d)', raw, re.I) or CODE_RE.search(raw)
    if code:
        result.update(code=code.group(1).upper(), matched=True)
    model = re.search(r'(?:pm|model|型号)["\']?\s*[:=]\s*["\']?([^,;\n}]+)', raw, re.I)
    if model:
        result["model"] = model.group(1).strip().strip('"\'')
    qty = re.search(r'(?:^|[^A-Za-z0-9_])(?:qty|数量|count|pcs|quantity)["\']?\s*[:=]\s*["\']?([^,;\s}"\']*)', raw, re.I)
    if not qty:
        qty = re.search(r'(?<![A-Za-z0-9_.+\-])([+\-]?\d[\d.,eE+\-]*)\s*(?:个|颗|支|块|条|套|PCS|只)(?![A-Za-z])', raw, re.I)
    if qty:
        text = re.sub(r'(?:个|颗|支|块|条|套|PCS|只)$', '', qty.group(1), flags=re.I)
        value = float(text) if re.fullmatch(r'\d+(?:\.\d+)?', text) else 0.0
        if value.is_integer() and 0 < value <= 2_147_483_647:
            result["quantity"] = int(value)
    elif result["code"]:
        parts = re.split(r'[,;|\n]', raw)
        if len(parts) > 1 and parts[0].strip().upper() == result["code"] and re.fullmatch(r'\d{1,7}', parts[1].strip()):
            result["quantity"] = int(parts[1]) or None
    return result


def pick(row, *keys, default=""):
    for key in keys:
        if key in row and row[key] is not None and str(row[key]).strip() != "":
            return row[key]
    return default


def number(value, integer=False):
    if isinstance(value, bool):
        raise ValueError("数量或单价不能是布尔值")
    value = float(str(value).replace("￥", "").replace("¥", "").replace(",", "").strip())
    if not math.isfinite(value) or value < 0 or (integer and not value.is_integer()):
        raise ValueError("数量必须是非负整数，单价必须是有限非负数")
    return int(value) if integer else value


def normalize_record(row, filename):
    if not isinstance(row, dict):
        raise ValueError("物料记录必须是对象")
    code = pick(row, "code", "商品编号", "C编号", "立创编号", "商品代码")
    if not code:
        return None
    model = str(pick(row, "model", "商品型号", "商品型号/名称", "型号", "型号/名称", "name", "商品名称", default=code)).strip()
    category = str(pick(row, "category", "商品类型", "分类", default="导入物料"))
    brand = str(pick(row, "brand", "品牌"))
    data = {
        "code": str(code).strip().upper(), "model": model, "category": category, "brand": brand,
        "package": str(pick(row, "package", "封装格式", "封装", "pkg")),
        "quantity": number(pick(row, "quantity", "订购数量", "采购数量", "数量", "实发数量", "qty", default=1), True),
        "price": number(pick(row, "price", "单价", "单价(元)", "单价（人民币含税）", "含税单价", default=0)),
        "min_stock": number(pick(row, "min_stock", "预警线", default=0), True),
        "unit": str(pick(row, "unit", "商品单位", "单位", default="个")),
        "location": str(pick(row, "location", "库位")),
        "use_case": str(pick(row, "use_case", "核心用途/实验场景", "use", "用途", default=infer_material_use_case(str(code), category, brand, model, str(row.get("description", ""))))),
        "batch": str(pick(row, "batch", "库存批次", "source", default=filename)),
        "order_date": str(pick(row, "order_date", "订单日期")),
        "remark": str(pick(row, "remark", "备注")),
    }
    return MaterialCreate.model_validate(data).model_dump()


def decode_csv(content):
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return content.decode("gb18030")


def table_records(rows):
    rows = list(rows)
    header = next((i for i, row in enumerate(rows[:10]) if any(str(c).strip() in ("code", "商品编号", "C编号", "立创编号", "商品代码") for c in row)), None)
    if header is None:
        raise ValueError("未找到物料编号表头")
    headers = [str(c).strip() if c is not None else "" for c in rows[header]]
    return [dict(zip(headers, row)) for row in rows[header + 1:] if any(c is not None and str(c).strip() for c in row)]


def parse_import_records(content, filename):
    fname = (filename or "").lower()
    if fname.endswith(".json"):
        data = json.loads(content.decode("utf-8-sig"))
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict) and ("today_orders" in data or "historical_inventory" in data):
            rows = data.get("today_orders", []) + data.get("historical_inventory", [])
        elif isinstance(data, dict) and isinstance(data.get("materials"), list):
            rows = data["materials"]
        else:
            raise ValueError("不支持的库存 JSON 结构")
    elif fname.endswith(".csv"):
        rows = table_records(csv.reader(io.StringIO(decode_csv(content))))
    elif fname.endswith(".xlsx"):
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True, read_only=True)
        try:
            rows = table_records(wb.active.iter_rows(values_only=True))
        finally:
            wb.close()
    elif fname.endswith(".xls"):
        import xlrd
        with xlrd.open_workbook(file_contents=content) as wb:
            sheet = wb.sheet_by_index(0)
            rows = table_records(sheet.row_values(i) for i in range(sheet.nrows))
    else:
        raise ValueError("仅支持 JSON / CSV / XLS / XLSX 文件")
    records = []
    for index, row in enumerate(rows, 1):
        try:
            record = normalize_record(row, filename)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"第 {index} 条物料无效: {exc}") from exc
        if record:
            records.append(record)
    return records
