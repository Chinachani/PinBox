const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('wms-mode')) localStorage.setItem('wms-mode', 'local');
    localStorage.setItem('wms-onboarded', '1');
  });
  await page.goto('/');
});

async function seed(page, fields = {}) {
  await page.evaluate(async fields => {
    const res = await api('/api/materials', { method: 'POST', body: JSON.stringify({ code: 'C123', model: 'TEST', quantity: 20, category: 'old', ...fields }) });
    if (!res.ok) throw new Error(JSON.stringify(await res.json()));
    await loadCategories(); await loadMaterials();
  }, fields);
}
async function server(page, request) {
  await request.post('/api/wipe?confirm=yes');
  await request.post('/api/materials', { data: { code: 'C123', model: 'SERVER', quantity: 20, category: 'server' } });
  await page.evaluate(() => localStorage.setItem('wms-mode', 'server'));
  await page.reload();
  await expect(page.locator('.material-card')).toHaveCount(1);
}

test('late scan parsing is cancelled on direction change and finish exits auto-stock', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => switchView('view-scan'));
  await page.locator('#scan-mode-seg button[data-mode=in]').click();
  await page.evaluate(() => {
    const original = DataLayer.api.bind(DataLayer);
    DataLayer.api = async (path, opts) => {
      const result = await original(path, opts);
      if (path === '/api/scan') await new Promise(resolve => { window.releaseScan = resolve; });
      return result;
    };
    window.scanPromise = handleScanText('pc:C123,qty:5');
  });
  await expect.poll(() => page.evaluate(() => typeof window.releaseScan)).toBe('function');
  await page.locator('#scan-mode-seg button[data-mode=out]').click();
  await page.evaluate(async () => { releaseScan(); await scanPromise; });
  expect(await page.evaluate(async () => (await LocalDB.get('materials', 'C123')).quantity)).toBe(20);
  await page.locator('#btn-batch-finish').click();
  expect(await page.evaluate(() => state.scanMode)).toBe('normal');
});

test('BOM demand never prefills received inventory', async ({ page }) => {
  await page.evaluate(async () => { switchView('view-bom'); await runBomCheck({ content: 'MISSING-PART 10' }); });
  await page.locator('.bom-status.none').click();
  await expect(page.locator('#mf-quantity')).toHaveValue('0');
  await page.locator('#mf-code').fill('C123');
  await page.locator('#material-form').evaluate(form => form.requestSubmit());
  await expect.poll(() => page.evaluate(async () => (await LocalDB.get('materials', 'C123'))?.quantity)).toBe(0);
});

test('removing the selected category resets filtering and searchable category controls work', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    setCategory('old');
    await api('/api/materials/C123', { method: 'PUT', body: JSON.stringify({ category: 'new' }) });
    await loadCategories();
    await loadMaterials();
  });
  await expect(page.locator('.material-card')).toHaveCount(1);
  expect(await page.evaluate(() => state.activeCategory)).toBe('');
  await page.locator('#btn-cat-dd').click();
  await page.getByRole('searchbox', { name: '搜索分类' }).fill('new');
  await page.locator('#cat-dd-panel .cat-chip[data-cat="new"]').click();
  await expect(page.locator('#btn-cat-dd-text')).toHaveText('分类：new');
});

test('box and unassigned navigation clear unrelated search, category and location filters', async ({ page }) => {
  await seed(page, { location: 'B', category: 'diode' });
  await page.evaluate(async () => {
    state.activeCategory = 'resistor'; state.searchQuery = 'nothing'; state.locationFilter = 'A'; state.stockPage = 9;
    gotoLocationFilter('B');
    await loadMaterials();
  });
  await expect(page.locator('.material-card')).toHaveCount(1);
  expect(await page.evaluate(() => [state.activeCategory, state.searchQuery, state.locationFilter, state.stockPage])).toEqual(['', '', 'B', 1]);
  await page.evaluate(() => setQuickFilter('unassigned'));
  expect(await page.evaluate(() => state.locationFilter)).toBe('');
});

test('deleting the only row on the last page returns to the previous valid page', async ({ page }) => {
  await page.evaluate(async () => {
    for (let i = 0; i < 25; i++) await api('/api/materials', { method: 'POST', body: JSON.stringify({ code: `C${i + 100}`, model: 'TEST', quantity: 0 }) });
    state.stockPage = 2;
    await loadMaterials();
    await api(`/api/materials/${state.materials[0].code}`, { method: 'DELETE' });
    await loadMaterials();
  });
  expect(await page.evaluate(() => state.stockPage)).toBe(1);
  await expect(page.locator('.material-card')).toHaveCount(24);
});

test('offline pending badge updates immediately after commits', async ({ page }) => {
  await seed(page);
  await expect(page.locator('#pending-count')).toHaveText('1');
  await page.evaluate(() => api('/api/materials/C123/stock', { method: 'POST', body: JSON.stringify({ delta: -1 }) }));
  await expect(page.locator('#pending-count')).toHaveText('2');
});

test('online response loss can be retried without a second stock deduction', async ({ page, request }) => {
  await server(page, request);
  let first = true;
  await page.route('**/api/materials/C123/stock', async route => {
    if (first) { first = false; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  expect(await page.evaluate(async () => (await adjustStockQuick('C123', -3, { skipGate: true })).ok)).toBe(false);
  expect((await (await request.get('/api/materials/C123')).json()).quantity).toBe(17);
  expect(await page.evaluate(async () => (await adjustStockQuick('C123', -3, { skipGate: true })).ok)).toBe(true);
  expect((await (await request.get('/api/materials/C123')).json()).quantity).toBe(17);
});

test('live updates refresh cards and category lists rather than only totals', async ({ page, request }) => {
  await server(page, request);
  await expect.poll(() => page.evaluate(() => wsConn?.readyState)).toBe(1);
  const dataset = (await (await request.get('/api/sync/state')).json()).dataset_id;
  await request.post('/api/materials/C123/stock', { data: { delta: -2, op_id: require('node:crypto').randomUUID(), dataset_id: dataset } });
  await expect(page.locator('#stock-val-C123')).toHaveText('18');
  await request.put('/api/materials/C123', { data: { category: 'changed', expected: { category: 'server' } } });
  await expect(page.locator('#cat-chips')).toContainText('changed');
});

test('testing a draft server never changes the current write target', async ({ page }) => {
  await seed(page);
  await page.route('http://other.test/api/stats', route => route.fulfill({ json: { total_sku: 1, total_pieces: 80 }, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.evaluate(() => { switchView('view-tools'); document.querySelector('[data-tab="tab-system"]').click(); });
  await page.locator('#input-server-url').fill('http://other.test');
  await page.locator('#btn-sync-test').click();
  await expect(page.locator('#sync-status')).toContainText('未改变数据源');
  expect(await page.evaluate(() => DataLayer.serverUrl)).toBe('');
});

test('editing a single field preserves changes another user made to other fields', async ({ page, request }) => {
  await server(page, request);
  await page.evaluate(() => openMaterialModal('edit', state.materials[0]));
  await request.put('/api/materials/C123', { data: { remark: 'other user', expected: { remark: '' } } });
  await page.locator('#mf-brand').fill('new-brand');
  await page.locator('#material-form').evaluate(form => form.requestSubmit());
  await expect(page.locator('#material-modal')).not.toHaveClass(/show/);
  const material = await (await request.get('/api/materials/C123')).json();
  expect(material.remark).toBe('other user');
  expect(material.brand).toBe('new-brand');
});

test('navigation and category items are keyboard controls and dialogs retain focus', async ({ page }) => {
  await seed(page);
  expect(await page.locator('.nav-item, .sidebar-item, .cat-chip').evaluateAll(els => els.every(el => el.tagName === 'BUTTON' && el.tabIndex === 0))).toBe(true);
  await page.evaluate(() => { document.querySelector('#btn-add-material').focus(); openMaterialModal('create'); });
  await expect(page.locator('#material-modal')).toHaveAttribute('role', 'dialog');
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => $('material-modal').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#btn-add-material')).toBeFocused();
});

test('native export bridge writes cache data and passes its URI to the system share sheet', async ({ page }) => {
  const result = await page.evaluate(async () => {
    let write, share;
    window.Capacitor = { isNativePlatform: () => true, Plugins: {
      Filesystem: { writeFile: async opts => { write = opts; return { uri: 'file:///private/cache/backup.json' }; } },
      Share: { share: async opts => { share = opts; } }
    } };
    await downloadBlob('{"materials":[]}', 'backup.json', 'application/json');
    return { write, share };
  });
  expect(result.write.directory).toBe('CACHE');
  expect(Buffer.from(result.write.data, 'base64').toString()).toBe('{"materials":[]}');
  expect(result.share.files).toEqual(['file:///private/cache/backup.json']);
});

test('online detail price and single-location editors submit conflict baselines', async ({ page, request }) => {
  await server(page, request);
  await page.evaluate(() => openDetailModal('C123'));
  await page.locator('#detail-price-input').fill('2.5');
  await page.locator('#btn-save-price').click();
  await expect.poll(async () => (await (await request.get('/api/materials/C123')).json()).price).toBe(2.5);
  await page.evaluate(async () => { closeModal('detail-modal'); await openLocAssignSingle('C123'); });
  await page.locator('#input-new-location').fill('Box B');
  await page.locator('#btn-save-location').click();
  await expect(page.locator('#location-modal')).not.toHaveClass(/show/);
  expect((await (await request.get('/api/materials/C123')).json()).location).toBe('Box B');
});
