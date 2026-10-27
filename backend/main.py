import os
import sys
import json
import sqlite3
import io
import csv
import time
import shutil
import threading
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# 导入数据库和解析模块
sys.path.append(os.path.dirname(__file__))
from database import get_db_connection, init_db, DB_PATH
from parser import parse_lcsc_barcode, parse_import_records
import bom as bom_engine

app = FastAPI(title="LCSC Mini WMS", description="嘉立创元器件掌上出入库与库存管理系统")

# 允许跨域（方便局域网内任意客户端调用）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 初始化数据库
init_db()

# --- Pydantic 模型 ---
class MaterialCreate(BaseModel):
    code: str
    category: str = "未分类"
    brand: Optional[str] = ""
    model: str
    package: Optional[str] = ""
    quantity: int = 0
    unit: Optional[str] = "个"
    price: Optional[float] = 0.0
    location: Optional[str] = ""
    use_case: Optional[str] = ""
    batch: Optional[str] = "手动录入"
    order_date: Optional[str] = ""
    min_stock: Optional[int] = 0
    remark: Optional[str] = ""

class MaterialUpdate(BaseModel):
    category: Optional[str] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    package: Optional[str] = None
    quantity: Optional[int] = None
    unit: Optional[str] = None
    price: Optional[float] = None
    location: Optional[str] = None
    use_case: Optional[str] = None
    batch: Optional[str] = None
    order_date: Optional[str] = None
    min_stock: Optional[int] = None
    remark: Optional[str] = None

class StockChange(BaseModel):
    delta: int  # 正数为入库，负数为出库
    reason: Optional[str] = "手动调整"
    project: Optional[str] = ""

class ScanRequest(BaseModel):
    text: str

class LocationCreate(BaseModel):
    name: str
    note: Optional[str] = ""

class LocationUpdate(BaseModel):
    name: Optional[str] = None
    note: Optional[str] = None

class BatchLocation(BaseModel):
    codes: List[str]
    location: str = ""

# --- 工具函数 ---

def now_local() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# --- API 端点 ---

@app.get("/api/stats")
def get_stats():
    conn = get_db_connection()
    c = conn.cursor()

    total_sku = c.execute("SELECT COUNT(*) FROM materials").fetchone()[0]
    total_pieces = c.execute("SELECT COALESCE(SUM(quantity), 0) FROM materials").fetchone()[0]
    total_categories = c.execute("SELECT COUNT(DISTINCT category) FROM materials").fetchone()[0]

    assigned_locations = c.execute("SELECT COUNT(*) FROM materials WHERE location != '' AND location IS NOT NULL").fetchone()[0]
    unassigned_locations = total_sku - assigned_locations

    low_stock = c.execute("SELECT COUNT(*) FROM materials WHERE (quantity <= min_stock AND min_stock > 0) OR quantity = 0").fetchone()[0]
    zero_stock = c.execute("SELECT COUNT(*) FROM materials WHERE quantity = 0").fetchone()[0]
    total_asset_value = c.execute("SELECT COALESCE(SUM(quantity * price), 0.0) FROM materials").fetchone()[0]
    location_count = c.execute("SELECT COUNT(*) FROM locations").fetchone()[0]

    conn.close()
    return {
        "total_sku": total_sku,
        "total_pieces": total_pieces,
        "total_categories": total_categories,
        "assigned_locations": assigned_locations,
        "unassigned_locations": unassigned_locations,
        "low_stock": low_stock,
        "zero_stock": zero_stock,
        "location_count": location_count,
        "total_asset_value": round(total_asset_value, 2)
    }

@app.get("/api/materials")
def list_materials(
    q: Optional[str] = None,
    category: Optional[str] = None,
    location: Optional[str] = None,
    unassigned: Optional[bool] = None,
    low_stock: Optional[bool] = None,
    zero_stock: Optional[bool] = None,
    sort_by: Optional[str] = "updated_at",
    page: int = 1,
    page_size: int = 30,
):
    conn = get_db_connection()
    c = conn.cursor()

    sql = "SELECT * FROM materials WHERE 1=1"
    params = []

    if q:
        q_clean = f"%{q.strip()}%"
        sql += " AND (code LIKE ? OR model LIKE ? OR brand LIKE ? OR package LIKE ? OR use_case LIKE ? OR location LIKE ? OR remark LIKE ?)"
        params.extend([q_clean] * 7)

    if category:
        sql += " AND category = ?"
        params.append(category)

    if location:
        sql += " AND location = ?"
        params.append(location)

    if unassigned is True:
        sql += " AND (location = '' OR location IS NULL)"
    elif unassigned is False:
        sql += " AND location != '' AND location IS NOT NULL"

    if low_stock:
        sql += " AND ((quantity <= min_stock AND min_stock > 0) OR quantity = 0)"

    if zero_stock:
        sql += " AND quantity = 0"

    # 排序处理
    order_map = {
        "updated_at": "updated_at DESC",
        "quantity_desc": "quantity DESC",
        "quantity_asc": "quantity ASC",
        "code_asc": "code ASC",
        "location_asc": "location ASC"
    }
    order_clause = order_map.get(sort_by, "updated_at DESC")
    count_sql = "SELECT COUNT(*) FROM (" + sql + ")"
    total_count = c.execute(count_sql, params).fetchone()[0]

    offset = (max(1, page) - 1) * page_size
    sql += f" ORDER BY {order_clause} LIMIT ? OFFSET ?"
    params.extend([page_size, offset])

    rows = c.execute(sql, params).fetchall()
    materials = [dict(row) for row in rows]
    conn.close()

    return {
        "page": page,
        "page_size": page_size,
        "total": total_count,
        "total_pages": (total_count + page_size - 1) // page_size,
        "items": materials
    }

@app.get("/api/materials/{code}")
def get_material(code: str):
    conn = get_db_connection()
    c = conn.cursor()
    code = code.strip().upper()
    row = c.execute("SELECT * FROM materials WHERE code = ?", (code,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="元器件不存在")

    material = dict(row)
    # 获取出入库流水
    logs = c.execute("""
        SELECT * FROM stock_logs WHERE material_code = ?
        ORDER BY created_at DESC LIMIT 30
    """, (code,)).fetchall()
    material["logs"] = [dict(l) for l in logs]

    conn.close()
    return material

@app.post("/api/materials")
def create_material(data: MaterialCreate):
    conn = get_db_connection()
    c = conn.cursor()
    code = data.code.strip().upper()

    if not code:
        conn.close()
        raise HTTPException(status_code=400, detail="物料编号不能为空")
    if not data.model.strip():
        conn.close()
        raise HTTPException(status_code=400, detail="型号/名称不能为空")

    exists = c.execute("SELECT code FROM materials WHERE code = ?", (code,)).fetchone()
    if exists:
        conn.close()
        raise HTTPException(status_code=400, detail=f"物料编码 {code} 已存在，可直接入库")

    # 若指定了库位，自动登记为新库位
    location = (data.location or "").strip()
    if location:
        c.execute("INSERT OR IGNORE INTO locations (name) VALUES (?)", (location,))

    c.execute("""
        INSERT INTO materials (code, category, brand, model, package, quantity, unit, price, location, use_case, batch, order_date, min_stock, remark)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (code, data.category.strip() or "未分类", data.brand or "", data.model.strip(), data.package or "",
          data.quantity, data.unit or "个", data.price or 0.0, location, data.use_case or "",
          data.batch or "手动录入", data.order_date or "", data.min_stock or 0, data.remark or ""))

    if data.quantity > 0:
        c.execute("""
            INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason, created_at)
            VALUES (?, 'init', ?, ?, '初始建档录入', ?)
        """, (code, data.quantity, data.quantity, now_local()))

    conn.commit()
    conn.close()
    return {"message": "创建成功", "code": code}

@app.put("/api/materials/{code}")
def update_material(code: str, data: MaterialUpdate):
    conn = get_db_connection()
    c = conn.cursor()
    code = code.strip().upper()

    row = c.execute("SELECT * FROM materials WHERE code = ?", (code,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="元器件不存在")

    old_data = dict(row)
    update_dict = {k: v for k, v in data.dict().items() if v is not None}

    if not update_dict:
        conn.close()
        return {"message": "无内容更新"}

    # 库位变更时，确保新库位存在于库位表
    if "location" in update_dict:
        new_loc = (update_dict["location"] or "").strip()
        update_dict["location"] = new_loc
        if new_loc:
            c.execute("INSERT OR IGNORE INTO locations (name) VALUES (?)", (new_loc,))

    # 如果直接修改了 quantity，记录调整日志
    if "quantity" in update_dict and update_dict["quantity"] != old_data["quantity"]:
        new_q = update_dict["quantity"]
        delta = new_q - old_data["quantity"]
        c.execute("""
            INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason, created_at)
            VALUES (?, 'adjust', ?, ?, '人工直接修正库存', ?)
        """, (code, delta, new_q, now_local()))

    set_clause = ", ".join([f"{k} = ?" for k in update_dict.keys()]) + ", updated_at = datetime('now','localtime')"
    values = list(update_dict.values()) + [code]

    c.execute(f"UPDATE materials SET {set_clause} WHERE code = ?", values)
    conn.commit()
    conn.close()
    return {"message": "更新成功"}

@app.delete("/api/materials/{code}")
def delete_material(code: str):
    conn = get_db_connection()
    c = conn.cursor()
    code = code.strip().upper()

    row = c.execute("SELECT code FROM materials WHERE code = ?", (code,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="元器件不存在")

    c.execute("DELETE FROM stock_logs WHERE material_code = ?", (code,))
    c.execute("DELETE FROM materials WHERE code = ?", (code,))
    conn.commit()
    conn.close()
    return {"message": f"已删除物料 {code}"}

@app.post("/api/materials/{code}/stock")
def change_stock(code: str, change: StockChange):
    conn = get_db_connection()
    c = conn.cursor()
    code = code.strip().upper()

    row = c.execute("SELECT * FROM materials WHERE code = ?", (code,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="元器件不存在")

    current_q = row["quantity"]
    delta = change.delta
    if delta == 0:
        conn.close()
        raise HTTPException(status_code=400, detail="变动数量不能为 0")

    # 原子更新：库存不足时 WHERE 条件不成立，rowcount 为 0
    cur = c.execute("""
        UPDATE materials
        SET quantity = quantity + ?, updated_at = datetime('now','localtime')
        WHERE code = ? AND quantity + ? >= 0
    """, (delta, code, delta))
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(status_code=400, detail=f"库存不足，当前仅剩 {current_q} {row['unit']}")

    new_q = c.execute("SELECT quantity FROM materials WHERE code = ?", (code,)).fetchone()[0]
    change_type = "in" if delta > 0 else "out"
    reason = change.reason or ("快速扫码入库" if delta > 0 else "快速出库领料")
    project = (change.project or "").strip()

    c.execute("""
        INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason, project, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (code, change_type, delta, new_q, reason, project, now_local()))

    conn.commit()
    conn.close()
    return {"message": "库存变动成功", "code": code, "previous": current_q, "delta": delta, "current": new_q}

@app.post("/api/scan-image")
async def scan_image(file: UploadFile = File(...)):
    """
    后端极强条码识别引擎：基于 zxing-cpp + 多尺度/多对比度自适应增强
    无论手机拍照模糊、反光、带倾斜均能精准解析
    """
    content = await file.read()
    decoded_text = ""

    try:
        import zxingcpp
        from PIL import Image, ImageEnhance
        img = Image.open(io.BytesIO(content)).convert("RGB")

        # 1. 原图快速多向检测
        results = zxingcpp.read_barcodes(img, try_rotate=True, try_downscale=True)
        if results:
            decoded_text = results[0].text
        else:
            # 2. 图像自适应预处理重试（灰度化 + 对比度拉升）
            gray = img.convert("L")
            for factor in [1.5, 2.2, 0.8]:
                enhanced = ImageEnhance.Contrast(gray).enhance(factor)
                res = zxingcpp.read_barcodes(enhanced, try_rotate=True, try_downscale=True, try_invert=True)
                if res:
                    decoded_text = res[0].text
                    break

            # 3. 若还未识别，尝试自动中心多区块裁剪扫描
            if not decoded_text:
                w, h = img.size
                boxes = [
                    (int(w*0.1), int(h*0.1), int(w*0.9), int(h*0.9)),
                    (int(w*0.2), int(h*0.2), int(w*0.8), int(h*0.8)),
                    (0, int(h*0.15), int(w*0.85), int(h*0.85))
                ]
                for box in boxes:
                    crop_img = img.crop(box)
                    res = zxingcpp.read_barcodes(crop_img, try_rotate=True, try_downscale=True)
                    if res:
                        decoded_text = res[0].text
                        break
    except Exception as e:
        print("Backend barcode scan error:", e)

    return build_scan_response(decoded_text)

@app.post("/api/scan")
def scan_code(req: ScanRequest):
    """
    处理手机扫码/拍照上传识别出的二维码文本
    """
    return build_scan_response(req.text)

def build_scan_response(raw_text: str) -> Dict[str, Any]:
    parsed = parse_lcsc_barcode(raw_text or "")
    conn = get_db_connection()
    c = conn.cursor()
    material = None
    if parsed["code"]:
        row = c.execute("SELECT * FROM materials WHERE code = ?", (parsed["code"],)).fetchone()
        if row:
            material = dict(row)
    conn.close()

    return {
        "decoded": bool(raw_text),
        "raw_text": raw_text,
        "parsed": parsed,
        "found": material is not None,
        "material": material
    }

@app.get("/api/qrcode")
def qrcode_svg(text: str = Query(..., min_length=1, max_length=512)):
    """生成二维码 SVG（用于库位/物料标签打印）"""
    try:
        import qrcode
        import qrcode.image.svg
        img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, box_size=12, border=2)
        buf = io.BytesIO()
        img.save(buf)
        return Response(content=buf.getvalue(), media_type="image/svg+xml",
                        headers={"Cache-Control": "public, max-age=86400"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"二维码生成失败: {e}")

@app.get("/api/categories")
def get_categories():
    conn = get_db_connection()
    c = conn.cursor()
    rows = c.execute("""
        SELECT category, COUNT(*) as count, SUM(quantity) as pieces
        FROM materials GROUP BY category ORDER BY count DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# --- 库位管理 ---

@app.get("/api/locations")
def get_locations():
    conn = get_db_connection()
    c = conn.cursor()
    rows = c.execute("""
        SELECT l.id, l.name, l.note,
               COUNT(m.code) as sku_count,
               COALESCE(SUM(m.quantity), 0) as pieces
        FROM locations l
        LEFT JOIN materials m ON m.location = l.name
        GROUP BY l.id
        ORDER BY l.name ASC
    """).fetchall()
    result = [dict(r) for r in rows]

    # 兜底：物料里存在但未登记的库位名（理论上迁移后不会出现）
    known = {r["name"] for r in result}
    strays = c.execute("""
        SELECT location as name, COUNT(*) as sku_count, SUM(quantity) as pieces
        FROM materials WHERE location != '' AND location IS NOT NULL
        GROUP BY location
    """).fetchall()
    for s in strays:
        if s["name"] not in known:
            result.append(dict(s))

    # 未分配库位统计
    un = c.execute("""
        SELECT COUNT(*) as sku_count, COALESCE(SUM(quantity), 0) as pieces
        FROM materials WHERE location = '' OR location IS NULL
    """).fetchone()
    conn.close()
    result.append({
        "id": None,
        "name": "未分配库位",
        "note": "尚未贴标归位的物料",
        "sku_count": un["sku_count"],
        "pieces": un["pieces"],
        "unassigned": True
    })
    return result

@app.post("/api/locations")
def create_location(data: LocationCreate):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="库位名称不能为空")
    conn = get_db_connection()
    c = conn.cursor()
    exists = c.execute("SELECT id FROM locations WHERE name = ?", (name,)).fetchone()
    if exists:
        conn.close()
        raise HTTPException(status_code=400, detail=f"库位 {name} 已存在")
    c.execute("INSERT INTO locations (name, note, created_at) VALUES (?, ?, ?)",
              (name, data.note or "", now_local()))
    conn.commit()
    new_id = c.execute("SELECT id FROM locations WHERE name = ?", (name,)).fetchone()[0]
    conn.close()
    return {"message": "库位创建成功", "id": new_id, "name": name}

@app.put("/api/locations/{loc_id}")
def update_location(loc_id: int, data: LocationUpdate):
    conn = get_db_connection()
    c = conn.cursor()
    row = c.execute("SELECT * FROM locations WHERE id = ?", (loc_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="库位不存在")

    updates = {}
    if data.note is not None:
        updates["note"] = data.note
    if data.name is not None and data.name.strip() and data.name.strip() != row["name"]:
        new_name = data.name.strip()
        dup = c.execute("SELECT id FROM locations WHERE name = ? AND id != ?", (new_name, loc_id)).fetchone()
        if dup:
            conn.close()
            raise HTTPException(status_code=400, detail=f"库位 {new_name} 已存在")
        updates["name"] = new_name

    if not updates:
        conn.close()
        return {"message": "无内容更新"}

    if "name" in updates:
        c.execute("UPDATE locations SET name = ? WHERE id = ?", (updates["name"], loc_id))
        c.execute("UPDATE materials SET location = ?, updated_at = datetime('now','localtime') WHERE location = ?",
                  (updates["name"], row["name"]))
    if "note" in updates:
        c.execute("UPDATE locations SET note = ? WHERE id = ?", (updates["note"], loc_id))

    conn.commit()
    conn.close()
    return {"message": "库位已更新"}

@app.delete("/api/locations/{loc_id}")
def delete_location(loc_id: int, force: bool = False):
    conn = get_db_connection()
    c = conn.cursor()
    row = c.execute("SELECT * FROM locations WHERE id = ?", (loc_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="库位不存在")

    used = c.execute("SELECT COUNT(*) FROM materials WHERE location = ?", (row["name"],)).fetchone()[0]
    if used > 0 and not force:
        conn.close()
        raise HTTPException(status_code=400, detail=f"该库位下仍有 {used} 款物料，请先移走或使用强制删除")

    c.execute("UPDATE materials SET location = '', updated_at = datetime('now','localtime') WHERE location = ?", (row["name"],))
    c.execute("DELETE FROM locations WHERE id = ?", (loc_id,))
    conn.commit()
    conn.close()
    return {"message": f"库位 {row['name']} 已删除", "cleared_materials": used}

@app.post("/api/batch-location")
def batch_assign_location(data: BatchLocation):
    conn = get_db_connection()
    c = conn.cursor()
    loc = (data.location or "").strip()
    if loc:
        exists = c.execute("SELECT id FROM locations WHERE name = ?", (loc,)).fetchone()
        if not exists:
            c.execute("INSERT INTO locations (name, created_at) VALUES (?, ?)", (loc, now_local()))

    updated = 0
    for raw_code in data.codes:
        code = (raw_code or "").strip().upper()
        if not code:
            continue
        row = c.execute("SELECT quantity FROM materials WHERE code = ?", (code,)).fetchone()
        if not row:
            continue
        c.execute("UPDATE materials SET location = ?, updated_at = datetime('now','localtime') WHERE code = ?",
                  (loc, code))
        c.execute("""
            INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason, created_at)
            VALUES (?, 'adjust', 0, ?, ?, ?)
        """, (code, row["quantity"], f"批量归位至「{loc or '未分配'}」", now_local()))
        updated += 1

    conn.commit()
    conn.close()
    return {"message": f"已将 {updated} 款物料归位到「{loc or '未分配'}」", "updated": updated}

# --- 导入 / 导出 / 备份 ---

@app.post("/api/import")
async def import_file(file: UploadFile = File(...)):
    content = await file.read()
    records = parse_import_records(content, file.filename)
    if not records:
        raise HTTPException(status_code=400, detail="未在文件中解析出有效的物料数据")

    conn = get_db_connection()
    c = conn.cursor()

    added_count = 0
    updated_count = 0
    skipped = 0

    for r in records:
        code = (r.get("code") or "").strip().upper()
        if not code:
            skipped += 1
            continue
        existing = c.execute("SELECT * FROM materials WHERE code = ?", (code,)).fetchone()
        if existing:
            # 累加库存并更新批次
            new_q = existing["quantity"] + (r.get("quantity") or 0)
            c.execute("""
                UPDATE materials SET
                    quantity = ?,
                    price = CASE WHEN ? > 0 THEN ? ELSE price END,
                    batch = ?,
                    updated_at = datetime('now','localtime')
                WHERE code = ?
            """, (new_q, r.get("price", 0.0), r.get("price", 0.0), r.get("batch") or existing["batch"] or "", code))

            c.execute("""
                INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason, created_at)
                VALUES (?, 'import', ?, ?, ?, ?)
            """, (code, r.get("quantity", 0), new_q, f"订单导入累加 ({file.filename})", now_local()))
            updated_count += 1
        else:
            c.execute("""
                INSERT INTO materials (code, category, brand, model, package, quantity, unit, price, location, use_case, batch, order_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                code,
                r.get("category", "导入物料"),
                r.get("brand", ""),
                r.get("model", ""),
                r.get("package", ""),
                r.get("quantity", 0),
                r.get("unit", "个"),
                r.get("price", 0.0),
                "",
                r.get("use_case", ""),
                r.get("batch", file.filename),
                ""
            ))

            c.execute("""
                INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason, created_at)
                VALUES (?, 'init', ?, ?, ?, ?)
            """, (code, r.get("quantity", 0), r.get("quantity", 0), f"订单导入初次建档 ({file.filename})", now_local()))
            added_count += 1

    conn.commit()
    conn.close()
    return {
        "message": "导入完成",
        "total_parsed": len(records),
        "newly_added": added_count,
        "stock_updated": updated_count,
        "skipped": skipped
    }

@app.get("/api/export")
def export_data(format: str = "json"):
    conn = get_db_connection()
    c = conn.cursor()
    rows = c.execute("SELECT * FROM materials ORDER BY category, code").fetchall()
    materials = [dict(r) for r in rows]
    conn.close()

    if format == "csv":
        output = io.StringIO()
        fieldnames = ["code", "category", "brand", "model", "package", "quantity", "unit", "price", "location", "use_case", "batch", "min_stock", "remark"]
        writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for m in materials:
            writer.writerow(m)
        return Response(
            content=output.getvalue().encode("utf-8-sig"),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=lcsc_inventory_{datetime.now().strftime('%Y%m%d')}.csv"}
        )
    else:
        return {
            "exported_at": datetime.now().isoformat(),
            "count": len(materials),
            "materials": materials
        }

@app.get("/api/backup")
def backup_all():
    """全量备份：物料 + 流水 + 库位"""
    conn = get_db_connection()
    c = conn.cursor()
    data = {
        "backup_version": 1,
        "exported_at": now_local(),
        "materials": [dict(r) for r in c.execute("SELECT * FROM materials").fetchall()],
        "stock_logs": [dict(r) for r in c.execute("SELECT * FROM stock_logs").fetchall()],
        "locations": [dict(r) for r in c.execute("SELECT * FROM locations").fetchall()],
    }
    conn.close()
    return Response(
        content=json.dumps(data, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename=lcsc_backup_{datetime.now().strftime('%Y%m%d_%H%M')}.json"}
    )

@app.post("/api/restore")
async def restore_backup(file: UploadFile = File(...), confirm: str = Query("")):
    if confirm != "yes":
        raise HTTPException(status_code=400, detail="缺少确认参数，拒绝恢复")
    content = await file.read()
    try:
        data = json.loads(content.decode("utf-8", errors="replace"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"备份文件解析失败: {e}")

    materials = data.get("materials") or []
    if not materials:
        raise HTTPException(status_code=400, detail="备份文件中没有物料数据")

    conn = get_db_connection()
    c = conn.cursor()
    c.execute("DELETE FROM stock_logs")
    c.execute("DELETE FROM materials")
    c.execute("DELETE FROM locations")

    loc_count = 0
    for loc in data.get("locations") or []:
        name = (loc.get("name") or "").strip()
        if not name:
            continue
        c.execute("INSERT OR IGNORE INTO locations (name, note, created_at) VALUES (?, ?, ?)",
                  (name, loc.get("note", ""), loc.get("created_at") or now_local()))
        loc_count += 1

    mat_count = 0
    for m in materials:
        code = (m.get("code") or "").strip().upper()
        if not code:
            continue
        c.execute("""
            INSERT INTO materials (code, category, brand, model, package, quantity, unit, price, location, use_case, batch, order_date, min_stock, remark, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (code, m.get("category", "未分类"), m.get("brand", ""), m.get("model", ""), m.get("package", ""),
              m.get("quantity", 0), m.get("unit", "个"), m.get("price", 0.0), m.get("location", ""),
              m.get("use_case", ""), m.get("batch", ""), m.get("order_date", ""), m.get("min_stock", 0),
              m.get("remark", ""), m.get("created_at") or now_local(), m.get("updated_at") or now_local()))
        mat_count += 1

    log_count = 0
    for l in data.get("stock_logs") or []:
        code = (l.get("material_code") or "").strip().upper()
        if not code:
            continue
        try:
            c.execute("""
                INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (code, l.get("change_type", "init"), l.get("delta", 0), l.get("remaining", 0),
                  l.get("reason", ""), l.get("created_at") or now_local()))
            log_count += 1
        except sqlite3.Error:
            continue

    conn.commit()
    conn.close()
    return {"message": "恢复完成", "materials": mat_count, "logs": log_count, "locations": loc_count}

@app.get("/api/logs")
def get_logs(
    q: Optional[str] = None,
    type: Optional[str] = None,
    days: Optional[int] = None,
    page: int = 1,
    page_size: int = 20
):
    conn = get_db_connection()
    c = conn.cursor()
    offset = (max(1, page) - 1) * page_size

    base_sql = """
        FROM stock_logs l
        LEFT JOIN materials m ON l.material_code = m.code
    """
    conds = []
    params = []
    if q and q.strip():
        q_clean = f"%{q.strip()}%"
        conds.append("(l.material_code LIKE ? OR l.reason LIKE ? OR m.model LIKE ? OR m.brand LIKE ?)")
        params.extend([q_clean] * 4)

    # 类型筛选：in=入库 delta>0，out=出库 delta<0，adjust=人工/批量调整
    type_map = {
        "in": "l.delta > 0",
        "out": "l.delta < 0",
        "adjust": "l.change_type = 'adjust'",
    }
    if type and type in type_map:
        conds.append(type_map[type])

    if days is not None and days > 0:
        conds.append("l.created_at >= datetime('now', 'localtime', ?)")
        params.append(f'-{int(days)} days')

    where = (" WHERE " + " AND ".join(conds)) if conds else ""

    total = c.execute(f"SELECT COUNT(*) {base_sql}{where}", params).fetchone()[0]
    rows = c.execute(f"""
        SELECT l.*, m.model, m.brand, m.unit, m.location
        {base_sql}{where}
        ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?
    """, params + [page_size, offset]).fetchall()
    conn.close()
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": (total + page_size - 1) // page_size,
        "logs": [dict(r) for r in rows]
    }

@app.get("/api/dashboard")
def dashboard():
    """分类资产价值 Top 榜 + 近 7 天出入库趋势"""
    conn = get_db_connection()
    c = conn.cursor()

    cats = c.execute("""
        SELECT category,
               COUNT(*) as sku,
               SUM(quantity) as pieces,
               ROUND(SUM(quantity * price), 2) as value
        FROM materials
        GROUP BY category
        ORDER BY value DESC, pieces DESC
        LIMIT 12
    """).fetchall()

    trend = c.execute("""
        SELECT date(created_at) as day,
               SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END) as in_qty,
               SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END) as out_qty
        FROM stock_logs
        WHERE created_at >= datetime('now', 'localtime', '-7 days')
        GROUP BY day ORDER BY day ASC
    """).fetchall()

    top_locations = c.execute("""
        SELECT location as name, COUNT(*) as sku_count, SUM(quantity) as pieces
        FROM materials WHERE location != '' AND location IS NOT NULL
        GROUP BY location ORDER BY pieces DESC LIMIT 8
    """).fetchall()

    conn.close()
    return {
        "categories": [dict(r) for r in cats],
        "trend": [dict(r) for r in trend],
        "top_locations": [dict(r) for r in top_locations]
    }

# --- BOM 核对 ---

@app.post("/api/bom/check")
async def bom_check(request: Request, file: Optional[UploadFile] = File(None)):
    """
    BOM 一键核对：JSON {"content": 文本} 或表格文件上传 (.xlsx/.xls/.csv)。
    逐行匹配库存并计算成本与缺料。
    """
    items = []
    content = None
    if file is None:
        ctype = request.headers.get("content-type", "")
        if "application/json" in ctype:
            try:
                body = await request.json()
                content = (body or {}).get("content")
            except Exception:
                content = None
        else:
            form = await request.form()
            content = form.get("content")
    if file is not None:
        raw = await file.read()
        fname = (file.filename or "").lower()
        if fname.endswith(".csv"):
            text = raw.decode("utf-8-sig", errors="replace")
            rows = list(csv.DictReader(io.StringIO(text)))
            items = bom_engine.parse_bom_file_rows(rows)
        elif fname.endswith(".xlsx") or fname.endswith(".xls"):
            try:
                import openpyxl
                wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
                sheet = wb.active
                rows = list(sheet.iter_rows(values_only=True))
                if rows:
                    headers = [str(h).strip() if h is not None else "" for h in rows[0]]
                    dicts = []
                    for r in rows[1:]:
                        if not any(v is not None for v in r):
                            continue
                        dicts.append({headers[i]: v for i, v in enumerate(r) if i < len(headers)})
                    items = bom_engine.parse_bom_file_rows(dicts)
            except Exception:
                try:
                    import xlrd
                    wb = xlrd.open_workbook(file_contents=raw)
                    sheet = wb.sheet_by_index(0)
                    headers = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]
                    dicts = []
                    for r in range(1, sheet.nrows):
                        row = {headers[c]: sheet.cell_value(r, c) for c in range(sheet.ncols)}
                        dicts.append(row)
                    items = bom_engine.parse_bom_file_rows(dicts)
                except Exception as e:
                    raise HTTPException(status_code=400, detail=f"表格解析失败: {e}")
        else:
            raise HTTPException(status_code=400, detail="仅支持 .xlsx / .xls / .csv 文件")
    elif content:
        items = bom_engine.parse_bom_text(content)
    else:
        raise HTTPException(status_code=400, detail="请提供 BOM 文本或文件")

    if not items:
        raise HTTPException(status_code=400, detail="未从输入中解析出任何 BOM 行")

    items = bom_engine.match_bom_items(items)
    summary = bom_engine.summarize(items)
    return {"items": items, "summary": summary}

# --- 低库存补货建议 ---

@app.get("/api/restock")
def restock_suggestions():
    """
    根据预警线生成补货清单：目标库存 = 预警线 × 2，建议采购 = 目标 - 现存。
    """
    conn = get_db_connection()
    c = conn.cursor()
    rows = c.execute("""
        SELECT code, model, brand, category, package, unit, quantity, min_stock, price
        FROM materials
        WHERE min_stock > 0 AND quantity < min_stock * 2
        ORDER BY (min_stock * 2 - quantity) DESC
    """).fetchall()
    conn.close()

    items = []
    total = 0.0
    for r in rows:
        m = dict(r)
        target = m["min_stock"] * 2
        suggest = target - m["quantity"]
        if suggest <= 0:
            continue
        price = m["price"] or 0.0
        subtotal = round(price * suggest, 4)
        total += subtotal
        m["target"] = target
        m["suggest"] = suggest
        m["subtotal"] = round(subtotal, 2)
        items.append(m)
    return {"items": items, "total_cost": round(total, 2)}

# --- 项目领料统计 ---

@app.get("/api/projects")
def project_stats():
    conn = get_db_connection()
    c = conn.cursor()
    rows = c.execute("""
        SELECT COALESCE(NULLIF(l.project, ''), '(未关联项目)') as project,
               COUNT(DISTINCT l.material_code) as materials,
               SUM(CASE WHEN l.delta < 0 THEN -l.delta ELSE 0 END) as out_pieces,
               ROUND(SUM(CASE WHEN l.delta < 0 THEN -l.delta * COALESCE(m.price, 0) ELSE 0 END), 2) as out_cost
        FROM stock_logs l
        LEFT JOIN materials m ON l.material_code = m.code
        WHERE l.delta < 0
        GROUP BY 1
        ORDER BY out_pieces DESC
        LIMIT 10
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# --- 每日自动备份 ---

BACKUP_DIR = os.path.join(os.path.dirname(DB_PATH), "backups")

def _run_backup() -> str:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = f"inventory-{datetime.now().strftime('%Y%m%d')}.db"
    dst_path = os.path.join(BACKUP_DIR, name)
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(dst_path)
    src.backup(dst)
    dst.close()
    src.close()
    # 只保留最近 30 份
    files = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("inventory-") and f.endswith(".db"))
    for f in files[:-30]:
        try:
            os.remove(os.path.join(BACKUP_DIR, f))
        except OSError:
            pass
    return name

def _backup_scheduler():
    """容器内每日 03:00 自动备份，独立守护线程。"""
    def loop():
        while True:
            now = datetime.now()
            target = now.replace(hour=3, minute=0, second=0, microsecond=0)
            if target <= now:
                target += timedelta(days=1)
            time.sleep(max(60, (target - now).total_seconds()))
            try:
                _run_backup()
                print(f"[backup] daily backup done at {datetime.now().isoformat()}")
            except Exception as e:
                print("[backup] failed:", e)
    threading.Thread(target=loop, daemon=True).start()

@app.get("/api/backups")
def list_backups():
    if not os.path.isdir(BACKUP_DIR):
        return {"backups": []}
    out = []
    for f in sorted(os.listdir(BACKUP_DIR), reverse=True):
        if f.startswith("inventory-") and f.endswith(".db"):
            p = os.path.join(BACKUP_DIR, f)
            out.append({"name": f, "size_kb": round(os.path.getsize(p) / 1024, 1)})
    return {"backups": out}

@app.post("/api/backups/run")
def backup_now():
    name = _run_backup()
    return {"message": f"备份完成: {name}", "name": name}


# 挂载前端静态资源
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    import threading

    cert_file = "/app/certs/cert.pem"
    key_file = "/app/certs/key.pem"

    # 每日 03:00 自动备份
    _backup_scheduler()

    # 双协议并发监听：HTTP (8088) + HTTPS (8089)
    if os.path.exists(cert_file) and os.path.exists(key_file):
        def start_https():
            config = uvicorn.Config(app, host="0.0.0.0", port=8089, ssl_certfile=cert_file, ssl_keyfile=key_file)
            server = uvicorn.Server(config)
            server.run()
        t = threading.Thread(target=start_https, daemon=True)
        t.start()
        print("HTTPS server started on port 8089")

    uvicorn.run(app, host="0.0.0.0", port=8088)
