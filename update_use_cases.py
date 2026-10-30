import sqlite3
import os
import sys

# 导入推导模块
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(CURRENT_DIR, "backend"))
from use_case_infer import infer_material_use_case

from database import DB_PATH

def update_all_use_cases():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    rows = c.execute("SELECT code, category, brand, model, use_case, remark FROM materials").fetchall()
    print(f"Total materials to audit: {len(rows)}")
    
    updated_count = 0
    for r in rows:
        code = r["code"]
        current_use = r["use_case"] or ""
        
        # 只要包含占位文字或为空，立刻替换为智能硬件真实用途
        if (not current_use) or ("历史对账单" in current_use) or ("物料储备" in current_use) or ("立创订单导入" in current_use):
            new_use = infer_material_use_case(code, r["category"], r["brand"], r["model"], r["remark"])
            c.execute("UPDATE materials SET use_case = ?, updated_at = datetime('now','localtime') WHERE code = ?", (new_use, code))
            updated_count += 1
            print(f"[{code}] {r['model'][:25]} -> {new_use}")
            
    conn.commit()
    conn.close()
    print(f"Successfully updated {updated_count} materials with real hardware use cases!")

if __name__ == "__main__":
    update_all_use_cases()
