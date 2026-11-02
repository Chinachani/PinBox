const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

async function existingLocal(page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('wms-mode')) localStorage.setItem('wms-mode', 'local');
    localStorage.setItem('wms-onboarded', '1');
  });
  await page.goto('/');
  await page.evaluate(async () => {
    await api('/api/materials', { method: 'POST', body: JSON.stringify({ code: 'C10001', model: 'LOCAL', quantity: 8, category: '测试分类' }) });
    await loadMaterials(); await loadCategories();
  });
}

async function dataCenter(page) {
  await page.evaluate(() => { switchView('view-tools'); document.querySelector('[data-tab="tab-system"]').click(); });
}

test('fresh native independent setup needs no server or key and cannot be silently dismissed', async ({ page }) => {
  await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; });
  const apiCalls = [];
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) apiCalls.push(req.url()); });
  await page.goto('/');
  await expect(page.locator('#setup-wizard-modal')).toHaveClass(/show/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#setup-wizard-modal')).toHaveClass(/show/);
  expect(await page.evaluate(() => localStorage.getItem('wms-mode'))).toBeNull();
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('#btn-setup-local').click()]);
  await expect(page.locator('#setup-wizard-modal')).not.toHaveClass(/show/);
  await expect.poll(() => page.evaluate(() => DataLayer.mode)).toBe('local');
  expect(await page.evaluate(() => localStorage.getItem('wms-api-token'))).toBeNull();
  expect(apiCalls).toEqual([]);
});

test('desktop independent choice keeps the existing local SQLite warehouse visible', async ({ page, request }) => {
  await request.post('/api/wipe?confirm=yes');
  await request.post('/api/materials', { data: { code: 'C777', model: 'DESKTOP-SQLITE', quantity: 3 } });
  await page.goto('/');
  await expect(page.locator('#setup-local-description')).toContainText('SQLite');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('#btn-setup-local').click()]);
  await expect(page.locator('.material-card')).toContainText('DESKTOP-SQLITE');
  expect(await page.evaluate(() => DataLayer.mode)).toBe('server');
  expect(await page.evaluate(() => LocalDB.count('materials'))).toBe(0);
});

test('legacy browser stash without a mode never silently hides a desktop SQLite warehouse', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#setup-wizard-modal')).toHaveClass(/show/);
  await page.evaluate(() => LocalAPI.handle('POST', '/api/materials', { body: JSON.stringify({ code: 'C900', model: 'OLD-LOCAL-STASH', quantity: 2 }) }));
  await page.reload();
  await expect(page.locator('#setup-wizard-modal')).toHaveClass(/show/);
  await expect(page.locator('#setup-existing-note')).toContainText('1 款物料');
  await expect(page.locator('#setup-local-description')).toContainText('SQLite');
  expect(await page.evaluate(() => localStorage.getItem('wms-mode'))).toBeNull();
});

test('shared first use stays private until connection is verified and never places the key in a URL', async ({ page }) => {
  const requested = [];
  await page.route('**/api/instance', route => route.fulfill({ json: { mode: 'shared', auth_required: true, version: '1.0.24' } }));
  await page.route('**/api/stats', route => {
    requested.push(route.request().url());
    return route.fulfill(route.request().headers().authorization === 'Bearer test-shared-key'
      ? { json: { total_sku: 0, total_pieces: 0 } }
      : { status: 401, json: { detail: '需要有效的连接密钥' } });
  });
  await page.goto('/');
  await expect(page.locator('#setup-wizard-modal')).toHaveClass(/show/);
  expect(requested).toEqual([]);
  await page.locator('#btn-setup-shared').click();
  await page.locator('#btn-setup-connect').click();
  await expect(page.locator('#setup-status')).toContainText('连接失败');
  expect(await page.evaluate(() => localStorage.getItem('wms-mode'))).toBeNull();
  await page.locator('#setup-api-token').fill('test-shared-key');
  await page.locator('[data-reveal="setup-api-token"]').click();
  await expect(page.locator('#setup-api-token')).toHaveAttribute('type', 'text');
  await page.locator('[data-reveal="setup-api-token"]').click();
  await expect(page.locator('#setup-api-token')).toHaveAttribute('type', 'password');
  await page.locator('#btn-setup-test').click();
  await expect(page.locator('#setup-status')).toContainText('未改变数据源');
  expect(await page.evaluate(() => localStorage.getItem('wms-api-token'))).toBeNull();
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('#btn-setup-connect').click()]);
  await expect(page.locator('#setup-wizard-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DataLayer.token)).toBe('test-shared-key');
  expect(requested.every(url => !url.includes('test-shared-key'))).toBe(true);
  expect(page.url()).not.toContain('test-shared-key');
});

test('existing inventory and pending queue survive mode switching without implicit synchronization', async ({ page }) => {
  await existingLocal(page);
  await expect(page.locator('#setup-wizard-modal')).not.toHaveClass(/show/);
  await dataCenter(page);
  await page.locator('#data-mode-seg [data-mode="server"]').click();
  await expect(page.locator('#confirm-msg')).toContainText('1 条待推送');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('#btn-confirm-ok').click()]);
  await expect.poll(() => page.evaluate(() => DataLayer.mode)).toBe('server');
  expect(await page.evaluate(() => LocalDB.count('pending_ops'))).toBe(1);
  expect(await page.evaluate(async () => (await LocalDB.get('materials', 'C10001')).quantity)).toBe(8);
  await dataCenter(page);
  await expect(page.locator('#btn-sync-pull')).toBeDisabled();
  await expect(page.locator('#pull-mode-hint')).toContainText('无需拉取');
});

test('active writes and other-window synchronization prevent changing connection settings', async ({ page, context }) => {
  await existingLocal(page);
  await dataCenter(page);
  await page.evaluate(() => { syncInFlight = true; });
  await page.locator('#data-mode-seg [data-mode="server"]').click();
  await expect(page.locator('#sync-status')).toContainText('等待完成');
  await page.evaluate(() => { syncInFlight = false; });
  const other = await context.newPage();
  await other.goto('/');
  await other.evaluate(() => {
    window.locked = false;
    navigator.locks.request('pinbox-sync', async () => {
      window.locked = true;
      await new Promise(resolve => { window.unlock = resolve; });
    });
  });
  await expect.poll(() => other.evaluate(() => window.locked)).toBe(true);
  const error = await page.evaluate(async () => {
    try { await commitDataSettings({ mode: 'server' }); return ''; }
    catch (error) { return error.message; }
  });
  expect(error).toContain('其他窗口');
  expect(await page.evaluate(() => DataLayer.mode)).toBe('local');
  await other.evaluate(() => window.unlock());
  await other.close();
});

test('reopening and cancelling setup preserves existing connection and masks keys', async ({ page }) => {
  await existingLocal(page);
  await page.evaluate(() => { DataLayer.setServerUrl('http://saved.example:8088'); DataLayer.setToken('saved-private-key'); });
  await dataCenter(page);
  await page.locator('#btn-open-setup').click();
  await expect(page.locator('#setup-existing-note')).toContainText('1 条待推送');
  await page.locator('#btn-setup-shared').click();
  await page.locator('[data-reveal="setup-api-token"]').click();
  await page.locator('#setup-server-url').fill('http://draft.example');
  await page.keyboard.press('Escape');
  await expect(page.locator('#setup-wizard-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DataLayer.serverUrl)).toBe('http://saved.example:8088');
  expect(await page.evaluate(() => DataLayer.token)).toBe('saved-private-key');
  await expect(page.locator('#setup-api-token')).toHaveAttribute('type', 'password');
});

test('closing setup discards a late connection result without switching or reopening confirmation', async ({ page }) => {
  await existingLocal(page);
  await dataCenter(page);
  await page.locator('#btn-open-setup').click();
  await page.locator('#btn-setup-shared').click();
  await page.evaluate(() => {
    syncTestConnection = () => new Promise(resolve => { window.resolveSetupTest = resolve; });
  });
  await page.locator('#btn-setup-connect').click();
  await expect.poll(() => page.evaluate(() => typeof window.resolveSetupTest)).toBe('function');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.resolveSetupTest({ ok: true, msg: 'delayed success' }));
  await expect(page.locator('#setup-wizard-modal')).not.toHaveClass(/show/);
  await expect(page.locator('#confirm-modal')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => DataLayer.mode)).toBe('local');
  expect(await page.evaluate(() => LocalDB.count('pending_ops'))).toBe(1);
});

test('deployment guide uses the real installer and never changes server mode or generates keys in the browser', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btn-setup-shared').click();
  await page.locator('#setup-tab-host').click();
  await expect(page.locator('#setup-host-pane')).toBeVisible();
  await expect(page.locator('#setup-host-pane')).toContainText('./install.sh');
  await expect(page.locator('#setup-connect-pane')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('wms-api-token'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('wms-mode'))).toBeNull();
});

test('320px dark and light layouts have one visible category selector and unclipped dropdown', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await existingLocal(page);
  const category = '测试分类 LongCategoryNameWithoutSpaces012345678901234567890123456789';
  await page.evaluate(async category => {
    await api('/api/materials/C10001', { method: 'PUT', body: JSON.stringify({ category }) });
    await loadCategories();
  }, category);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    await page.evaluate(() => switchView('view-stock'));
    await expect(page.locator('#cat-chips')).toBeHidden();
    await page.locator('#btn-cat-dd').click();
    await page.getByRole('searchbox', { name: '搜索分类' }).fill('测试');
    await page.locator('#cat-dd-panel .cat-chip').filter({ hasText: category }).click();
    await expect(page.locator('#btn-cat-dd-text')).toContainText('测试分类');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await dataCenter(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.locator('#btn-open-setup').click();
    await page.locator('#btn-setup-shared').click();
    await page.locator('#setup-tab-host').click();
    expect(await page.locator('.modal-content-setup').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.keyboard.press('Escape');
  }
});

test('failed existing-server authentication offers a direct connection setup action', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('wms-mode', 'server'); });
  await page.route('**/api/materials?*', route => route.fulfill({ status: 401, json: { detail: '需要有效的连接密钥' } }));
  await page.goto('/');
  await expect(page.locator('#btn-configure-connection')).toBeVisible();
  await page.locator('#btn-configure-connection').click();
  await expect(page.locator('#setup-wizard-modal')).toHaveClass(/show/);
});
