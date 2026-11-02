"""Inventory timestamps are Beijing wall time, independent of the host timezone."""
from datetime import datetime, timedelta, timezone


def now_local():
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
