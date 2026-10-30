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
      req.onsuccess = () => {
        req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function facade(tx) {
    return {
      getAll: name => wrap(tx.objectStore(name).getAll()),
      get: (name, key) => wrap(tx.objectStore(name).get(key)),
      put: (name, value) => wrap(tx.objectStore(name).put(value)),
      add: (name, value) => wrap(tx.objectStore(name).add(value)),
      delete: (name, key) => wrap(tx.objectStore(name).delete(key)),
      clear: name => wrap(tx.objectStore(name).clear()),
      count: name => wrap(tx.objectStore(name).count()),
      byIndex: (name, index, value) => wrap(tx.objectStore(name).index(index).getAll(value)),
      bulkPut: async (name, items) => {
        await Promise.all(items.map(item => wrap(tx.objectStore(name).put(item))));
        return items.length;
      }
    };
  }

  async function transaction(names, callback, mode = 'readwrite') {
    const db = await open();
    const tx = db.transaction(names, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('本地事务已取消'));
    });
    try {
      const result = await callback(facade(tx));
      if (result && result.ok === false) {
        tx.abort();
        await done.catch(() => {});
        return result;
      }
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* already completed */ }
      await done.catch(() => {});
      throw error;
    }
  }

  const api = { transaction };
  for (const method of ['getAll', 'get', 'put', 'add', 'delete', 'clear', 'count', 'byIndex', 'bulkPut']) {
    api[method] = (name, ...args) => transaction([name], db => db[method](name, ...args),
      ['getAll', 'get', 'count', 'byIndex'].includes(method) ? 'readonly' : 'readwrite');
  }
  return api;
})();
