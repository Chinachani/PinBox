import os
import sqlite3

DB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "inventory.db")

def get_db_connection() -> sqlite3.Connection:
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    # 物料主表
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS materials (
        code TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        package TEXT DEFAULT '',
        quantity INTEGER NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT '个',
        price REAL DEFAULT 0.0, -- 单价（元）
        location TEXT DEFAULT '',
        use_case TEXT DEFAULT '',
        batch TEXT DEFAULT '',
        order_date TEXT DEFAULT '',
        min_stock INTEGER DEFAULT 0,
        remark TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 出入库流水记录表
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS stock_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_code TEXT NOT NULL,
        change_type TEXT NOT NULL, -- 'in', 'out', 'adjust', 'init', 'import'
        delta INTEGER NOT NULL,
        remaining INTEGER NOT NULL,
        reason TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (material_code) REFERENCES materials (code) ON DELETE CASCADE
    );
    """)

    # 物理库位（收纳盒/抽屉格位）登记表
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT (datetime('now','localtime'))
    );
    """)

    # 应用元信息（用于一次性数据迁移标记）
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    """)

    # 索引优化检索速度
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_materials_category ON materials (category);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_materials_location ON materials (location);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_materials_model ON materials (model);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_logs_code ON stock_logs (material_code);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_logs_created ON stock_logs (created_at);")

    # 历史结构升级（老库无 price 列时补齐）
    try:
        cursor.execute("ALTER TABLE materials ADD COLUMN price REAL DEFAULT 0.0;")
    except Exception:
        pass

    # 流水关联项目（项目领料统计）
    try:
        cursor.execute("ALTER TABLE stock_logs ADD COLUMN project TEXT DEFAULT '';")
    except Exception:
        pass

    # 一次性时区迁移：老数据由 UTC 校正为东八区本地时间
    migrated = cursor.execute("SELECT value FROM app_meta WHERE key = 'tz_shift_plus8_v1'").fetchone()
    if not migrated:
        cursor.execute("UPDATE materials SET created_at = datetime(created_at, '+8 hours'), updated_at = datetime(updated_at, '+8 hours');")
        cursor.execute("UPDATE stock_logs SET created_at = datetime(created_at, '+8 hours');")
        cursor.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('tz_shift_plus8_v1', 'done');")

    # 历史上直接填在物料上的库位名，自动登记为正式库位
    cursor.execute("""
        INSERT OR IGNORE INTO locations (name)
        SELECT DISTINCT location FROM materials
        WHERE location IS NOT NULL AND location != '';
    """)

    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully at:", DB_PATH)
