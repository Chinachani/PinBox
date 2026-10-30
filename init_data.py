"""Explicit, backed-up initialization from the current inventory source file."""
import argparse
import hashlib
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from uuid import uuid4

CURRENT_DIR = Path(__file__).resolve().parent
JSON_PATH = CURRENT_DIR.parent / "全量采购元器件库存总表.json"
sys.path.insert(0, str(CURRENT_DIR / "backend"))
from database import DB_PATH, init_db, transaction
from parser import parse_import_records
from importer import import_records


def load_initial_data(source=JSON_PATH, reset=False):
    # Validate the source before opening a write transaction or deleting anything.
    source = Path(source)
    content = source.read_bytes()
    records = parse_import_records(content, source.name)
    if not records:
        raise ValueError("库存源文件没有有效物料")
    init_db()
    backup = None
    with transaction() as conn:
        has_data = any(conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() for table in ("materials", "stock_logs", "locations"))
        if has_data and not reset:
            raise ValueError("数据库已有数据；如确需覆盖，请显式传入 --reset（自动先备份）")
        if has_data:
            directory = Path(DB_PATH).parent / "backups"
            directory.mkdir(parents=True, exist_ok=True)
            backup = directory / ("inventory-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".db")
            with sqlite3.connect(DB_PATH) as src, sqlite3.connect(backup) as dst:
                src.backup(dst)
        conn.execute("DELETE FROM stock_logs")
        conn.execute("DELETE FROM materials")
        conn.execute("DELETE FROM locations")
        conn.execute("DELETE FROM app_meta WHERE key LIKE 'import:%'")
        conn.execute("INSERT OR REPLACE INTO app_meta (key,value) VALUES ('dataset_id',?)", (str(uuid4()),))
        result = import_records(conn, records, hashlib.sha256(content).hexdigest(), source.name)
    if backup:
        print("覆盖前备份:", backup)
    print(result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="从最新库存源文件初始化 PinBox")
    parser.add_argument("--source", default=str(JSON_PATH))
    parser.add_argument("--reset", action="store_true", help="覆盖现有库存，自动先备份")
    args = parser.parse_args()
    load_initial_data(args.source, args.reset)
