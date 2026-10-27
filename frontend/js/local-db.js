// ============================================================
// LocalDB - IndexedDB 本地数据库（离线模式的存储层）
// ============================================================
const LocalDB = (() => {
  const DB_NAME = 'wms-local';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('materials')) {
          db.createObjectStore('materials', { keyPath: 'code' });
        }
        if (!db.objectStoreNames.contains('logs')) {
          const s = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
          s.createIndex('material_code', 'material_code');
        }
        if (!db.objectStoreNames.contains('locations')) {
          db.createObjectStore('locations', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('pending_ops')) {
          db.createObjectStore('pending_ops', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function store(name, mode = 'readonly') {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return {
    getAll: async (name) => wrap((await store(name)).getAll()),
    get: async (name, key) => wrap((await store(name)).get(key)),
    put: async (name, val) => wrap((await store(name, 'readwrite')).put(val)),
    add: async (name, val) => wrap((await store(name, 'readwrite')).add(val)),
    delete: async (name, key) => wrap((await store(name, 'readwrite')).delete(key)),
    clear: async (name) => wrap((await store(name, 'readwrite')).clear()),
    count: async (name) => wrap((await store(name)).count()),
    // 索引查询
    byIndex: async (name, index, value) => wrap((await store(name)).index(index).getAll(value)),
    // 批量导入（单事务，快）
    bulkPut: async (name, items) => {
      const s = await store(name, 'readwrite');
      return new Promise((resolve, reject) => {
        const tx = s.transaction;
        items.forEach(it => s.put(it));
        tx.oncomplete = () => resolve(items.length);
        tx.onerror = () => reject(tx.error);
      });
    }
  };
})();
