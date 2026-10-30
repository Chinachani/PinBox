from datetime import datetime

from fastapi import HTTPException

from schemas import MaterialCreate, MAX_QUANTITY


def import_records(conn, records, receipt, filename):
    if not isinstance(receipt, str) or len(receipt) != 64 or any(c not in "0123456789abcdef" for c in receipt):
        raise ValueError("导入文件摘要无效")
    key = "import:" + receipt
    if conn.execute("SELECT 1 FROM app_meta WHERE key=?", (key,)).fetchone():
        return {"message": "此文件已导入，未重复累计", "duplicate": True}
    records = [MaterialCreate.model_validate(r).model_dump() for r in records]
    if not records:
        raise ValueError("没有有效物料数据")
    totals = {}
    for record in records:
        totals[record["code"]] = totals.get(record["code"], 0) + record["quantity"]
    for code, qty in totals.items():
        row = conn.execute("SELECT quantity FROM materials WHERE code=?", (code,)).fetchone()
        if qty + (row[0] if row else 0) > MAX_QUANTITY:
            raise HTTPException(400, f"物料 {code} 累计数量越界")

    added = updated = 0
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for data in records:
        code = data["code"]
        row = conn.execute("SELECT * FROM materials WHERE code=?", (code,)).fetchone()
        if row:
            remaining = row["quantity"] + data["quantity"]
            batch = " + ".join(dict.fromkeys(filter(None, [row["batch"], data["batch"]])))
            conn.execute("UPDATE materials SET quantity=?, price=?, batch=?, updated_at=? WHERE code=?",
                         (remaining, data["price"] if data["price"] > 0 else row["price"], batch, now, code))
            updated += 1
        else:
            remaining = data["quantity"]
            if data["location"]:
                conn.execute("INSERT OR IGNORE INTO locations (name,created_at) VALUES (?,?)", (data["location"], now))
            data.update(created_at=now, updated_at=now)
            conn.execute(f"INSERT INTO materials ({','.join(data)}) VALUES ({','.join('?' for _ in data)})", list(data.values()))
            added += 1
        conn.execute("INSERT INTO stock_logs (material_code,change_type,delta,remaining,reason,created_at) VALUES (?,?,?,?,?,?)",
                     (code, "import" if row else "init", data["quantity"], remaining, f"订单导入 ({filename}) · {data['batch']}", now))
    conn.execute("INSERT INTO app_meta (key,value) VALUES (?,?)", (key, now))
    return {"message": "导入完成", "total_parsed": len(records), "newly_added": added, "stock_updated": updated, "skipped": 0}
