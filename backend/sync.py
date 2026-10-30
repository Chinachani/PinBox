"""Replay offline operations once, in the same transaction as their receipt."""
import hashlib
import json
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException

from database import transaction
from schemas import MaterialCreate, MaterialUpdate, StockChange, LocationCreate, LocationUpdate, MAX_QUANTITY
from importer import import_records


def dataset_id(conn):
    conn.execute("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('dataset_id', ?)", (str(uuid4()),))
    return conn.execute("SELECT value FROM app_meta WHERE key='dataset_id'").fetchone()[0]


def apply_operation(op, expected_dataset=None):
    if not isinstance(expected_dataset, str) or not expected_dataset:
        raise HTTPException(400, "同步操作缺少服务器数据标识，请升级客户端")
    key = op.get("op_id")
    if not isinstance(key, str) or not 8 <= len(key) <= 128:
        raise HTTPException(400, "同步操作缺少有效的操作号")
    payload = {k: v for k, v in op.items() if k not in ("id", "ts")}
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    with transaction() as conn:
        current_dataset = dataset_id(conn)
        if expected_dataset and expected_dataset != current_dataset:
            raise HTTPException(409, "服务器已恢复或清空，请备份本机数据并重新核对后拉取")
        previous = conn.execute("SELECT * FROM idempotency_keys WHERE key=?", (key,)).fetchone()
        if previous:
            if previous["fingerprint"] != fingerprint:
                raise HTTPException(409, "操作号已用于不同的同步内容")
            return json.loads(previous["result"])
        result = _apply(conn, op)
        conn.execute("INSERT INTO idempotency_keys (key, fingerprint, result) VALUES (?, ?, ?)",
                     (key, fingerprint, json.dumps(result, ensure_ascii=False)))
        return result


def _apply(conn, op):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    kind = op.get("kind")
    code = str(op.get("code", "")).strip().upper()

    def log(delta, remaining, reason, change_type="adjust", project=""):
        conn.execute("INSERT INTO stock_logs (material_code, change_type, delta, remaining, reason, project, created_at) VALUES (?,?,?,?,?,?,?)",
                     (code, change_type, delta, remaining, reason, project, now))

    def register_location(name):
        if name:
            conn.execute("INSERT OR IGNORE INTO locations (name, created_at) VALUES (?,?)", (name, now))

    if kind == "import":
        return import_records(conn, op.get("records", []), op.get("receipt"), str(op.get("filename", "离线文件")))
    elif kind == "create":
        data = MaterialCreate.model_validate(op.get("payload")).model_dump()
        code = data["code"]
        if conn.execute("SELECT 1 FROM materials WHERE code=?", (code,)).fetchone():
            raise HTTPException(409, f"物料 {code} 已存在，未覆盖服务器库存；请先核对建档冲突")
        register_location(data["location"])
        data.update(created_at=now, updated_at=now)
        conn.execute(f"INSERT INTO materials ({','.join(data)}) VALUES ({','.join('?' for _ in data)})", list(data.values()))
        if data["quantity"]:
            log(data["quantity"], data["quantity"], "离线建档同步", "init")
    elif kind in ("stock", "update", "delete"):
        row = conn.execute("SELECT * FROM materials WHERE code=?", (code,)).fetchone()
        if not row:
            if kind == "delete":
                return {"message": "物料已删除"}
            raise HTTPException(409, f"物料 {code} 不存在，请先核对")
        if kind == "stock":
            data = StockChange.model_validate(op)
            remaining = row["quantity"] + data.delta
            if not data.delta or not 0 <= remaining <= MAX_QUANTITY:
                raise HTTPException(409, f"物料 {code} 库存不足或数量越界，操作已保留")
            conn.execute("UPDATE materials SET quantity=?, updated_at=? WHERE code=?", (remaining, now, code))
            log(data.delta, remaining, data.reason or "离线同步", "in" if data.delta > 0 else "out", data.project or "")
        else:
            expected = op.get("expected")
            if not isinstance(expected, dict):
                raise HTTPException(409, "旧版离线修改缺少冲突基准，请先备份并人工核对")
            if any(k not in row.keys() or row[k] != v for k, v in expected.items()):
                raise HTTPException(409, f"物料 {code} 已在服务器修改，操作已保留")
            if kind == "delete":
                conn.execute("DELETE FROM materials WHERE code=?", (code,))
            else:
                data = MaterialUpdate.model_validate(op.get("payload")).model_dump(exclude_none=True)
                if set(data) - set(expected):
                    raise HTTPException(409, "离线修改缺少字段冲突基准")
                if "quantity" in data and data["quantity"] != row["quantity"]:
                    log(data["quantity"] - row["quantity"], data["quantity"], "离线修正库存")
                register_location(data.get("location"))
                data["updated_at"] = now
                conn.execute(f"UPDATE materials SET {','.join(k+'=?' for k in data)} WHERE code=?", [*data.values(), code])
    elif kind == "location_create":
        data = LocationCreate.model_validate(op)
        if conn.execute("SELECT 1 FROM locations WHERE name=?", (data.name,)).fetchone():
            raise HTTPException(409, "库位名称已存在，请核对后处理")
        conn.execute("INSERT INTO locations (name,note,created_at) VALUES (?,?,?)", (data.name, data.note, now))
    elif kind in ("location_update", "location_delete"):
        # Local auto-increment IDs are not server IDs. Resolve by the original name.
        name = op.get("original_name") or op.get("name")
        if not name:
            raise HTTPException(409, "旧版库位操作缺少原名称，请先人工核对")
        row = conn.execute("SELECT * FROM locations WHERE name=?", (name,)).fetchone()
        if not row:
            raise HTTPException(409, "服务器库位已变动，操作已保留")
        if "expected_note" in op and row["note"] != op["expected_note"]:
            raise HTTPException(409, "服务器库位备注已变动")
        if kind == "location_delete":
            conn.execute("UPDATE materials SET location='', updated_at=? WHERE location=?", (now, name))
            conn.execute("DELETE FROM locations WHERE id=?", (row["id"],))
        else:
            data = LocationUpdate.model_validate(op.get("payload"))
            new_name = data.name or name
            if conn.execute("SELECT 1 FROM locations WHERE name=? AND id!=?", (new_name, row["id"])).fetchone():
                raise HTTPException(409, "库位新名称已存在")
            conn.execute("UPDATE locations SET name=?, note=? WHERE id=?", (new_name, data.note if data.note is not None else row["note"], row["id"]))
            conn.execute("UPDATE materials SET location=?, updated_at=? WHERE location=?", (new_name, now, name))
    elif kind == "batch_location":
        location = str(op.get("location", "")).strip()
        expected = op.get("expected")
        if not isinstance(expected, dict):
            raise HTTPException(409, "旧版批量归位缺少冲突基准，请先人工核对")
        register_location(location)
        for code in dict.fromkeys(op.get("codes", [])):
            row = conn.execute("SELECT * FROM materials WHERE code=?", (code,)).fetchone()
            if not row or code not in expected or row["location"] != expected[code]:
                raise HTTPException(409, f"物料 {code} 库位已变动")
            conn.execute("UPDATE materials SET location=?, updated_at=? WHERE code=?", (location, now, code))
            log(0, row["quantity"], f"离线归位至 {location}")
    else:
        raise HTTPException(400, "不支持的同步操作")
    return {"message": "同步成功"}
