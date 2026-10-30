import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


# Importing the app initializes its database. Always isolate that first import too.
bootstrap = tempfile.TemporaryDirectory(prefix="pinbox-tests-")
os.environ["PINBOX_DATA_DIR"] = bootstrap.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import database
import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_DIR", str(tmp_path))
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "inventory.db"))
    monkeypatch.setattr(main, "DB_PATH", database.DB_PATH)
    monkeypatch.setattr(main, "BACKUP_DIR", str(tmp_path / "backups"))
    monkeypatch.delenv("PINBOX_API_TOKEN", raising=False)
    database.init_db()
    with TestClient(main.app, raise_server_exceptions=False) as test_client:
        yield test_client
