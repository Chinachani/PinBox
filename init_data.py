import os
import sys
import json
import sqlite3

# 切换路径
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_DIR = os.path.dirname(CURRENT_DIR)
JSON_PATH = os.path.join(WORKSPACE_DIR, "全量采购元器件库存总表.json")

sys.path.append(os.path.join(CURRENT_DIR, "backend"))
from database import get_db_connection, init_db

def load_initial_data():
    init_db()
    conn = get_db_connection()
    c = conn.cursor()
    
    # 清理已有数据以保持干净
    c.execute("DELETE FROM stock_logs")
    c.execute("DELETE FROM materials")
    
    if not os.path.exists(JSON_PATH):
        print(f"Error: {JSON_PATH} not found!")
        return
        
    with open(JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    today_orders = data.get("today_orders", [])
    hist_items = data.get("historical_inventory", [])
    
    print(f"Loading {len(today_orders)} today items and {len(hist_items)} historical items...")
    
    # 插入今日订单
    for it in today_orders:
        code = it["商品编号"].strip().upper()
        cat = it["商品类型"].strip()
        brand = it["品牌"].strip()
        model = it["商品型号/名称"].strip()
        pkg = it["封装格式"].strip()
        qty = int(it["采购数量"])
        unit = it["单位"].strip()
        use = it["核心用途/实验场景"].strip()
        batch = it["库存批次"].strip()
        
        c.execute("""
            INSERT INTO materials (code, category, brand, model, package, quantity, unit, location, use_case, batch, min_stock, remark)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')
        """, (code, cat, brand, model, pkg, qty, unit, "", use, batch))
        
        c.execute("""
            INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason)
            VALUES (?, 'init', ?, ?, ?)
        """, (code, qty, qty, f"系统初始入库 ({batch})"))

    # 插入往期历史对账单
    for it in hist_items:
        code = it["code"].strip().upper()
        cat = it["category"].strip()
        brand = it["brand"].strip()
        model = f"{it['model']} {it.get('description', '')}".strip()
        pkg = it["package"].strip()
        qty = int(it["quantity"])
        unit = it["unit"].strip()
        use = "历史对账单已购物料储备"
        batch = it.get("source", "往期对账单")
        dt = it.get("order_date", "")
        
        existing = c.execute("SELECT * FROM materials WHERE code = ?", (code,)).fetchone()
        if existing:
            new_qty = existing["quantity"] + qty
            c.execute("UPDATE materials SET quantity = ?, batch = batch || ' + ' || ? WHERE code = ?", (new_qty, batch, code))
            c.execute("""
                INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason)
                VALUES (?, 'init', ?, ?, ?)
            """, (code, qty, new_qty, f"合并历史采购记录 ({dt})"))
        else:
            c.execute("""
                INSERT INTO materials (code, category, brand, model, package, quantity, unit, location, use_case, batch, order_date, min_stock, remark)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')
            """, (code, cat, brand, model, pkg, qty, unit, "", use, batch, dt))
            
            c.execute("""
                INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason)
                VALUES (?, 'init', ?, ?, ?)
            """, (code, qty, qty, f"历史对账单底账录入 ({dt})"))
        
    conn.commit()
    
    # 校验导入结果
    total_sku = c.execute("SELECT COUNT(*) FROM materials").fetchone()[0]
    total_pieces = c.execute("SELECT SUM(quantity) FROM materials").fetchone()[0]
    conn.close()
    
    print(f"Successfully loaded database! Total SKU: {total_sku}, Total Pieces: {total_pieces}")

if __name__ == "__main__":
    load_initial_data()
