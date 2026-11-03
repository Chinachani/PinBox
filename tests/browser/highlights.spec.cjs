const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

async function configured(page, mode = 'local') {
  await page.addInitScript(mode => {
    if (!localStorage.getItem('wms-mode')) localStorage.setItem('wms-mode', mode);
    localStorage.setItem('wms-onboarded', '1');
  }, mode);
  await page.goto('/');
  await page.evaluate(() => {
    switchView('view-tools');
    document.querySelector('[data-tab="tab-system"]').click();
  });
  await expect(page.locator('#pending-count')).toHaveText('0');
}

test('first use gives both choices equal emphasis and does not preselect independent use', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#setup-wizard-modal')).toHaveClass(/show/);
  await expect(page.locator('#setup-title')).toBeFocused();
  await expect(page.locator('.setup-card[aria-current="true"]')).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    for (const id of ['btn-setup-local', 'btn-setup-shared']) {
      await expect(page.locator('#' + id)).not.toHaveClass(/btn-primary/);
      await expect(page.locator('#' + id)).toBeEnabled();
    }
    await expect.poll(() => page.evaluate(() =>
      getComputedStyle(document.querySelector('#btn-setup-local')).backgroundColor ===
      getComputedStyle(document.querySelector('#btn-setup-shared')).backgroundColor
    )).toBe(true);
  }
});

test('opening or testing another mode never moves the current-use badge before applying', async ({ page }) => {
  await configured(page);
  await page.locator('#btn-open-setup').click();
  await expect(page.locator('#setup-current-local')).toBeVisible();
  await expect(page.locator('#btn-setup-local')).toBeDisabled();
  await expect(page.locator('#setup-current-shared')).toBeHidden();
  await page.locator('#btn-setup-shared').click();
  await page.locator('#setup-api-token').fill('draft-key');
  await page.locator('#btn-setup-test').click();
  await expect(page.locator('#setup-status')).toContainText('未改变数据源');
  await expect(page.locator('#setup-card-local')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#setup-card-shared')).toHaveAttribute('aria-current', 'false');
  expect(await page.evaluate(() => DataLayer.mode)).toBe('local');
  await page.keyboard.press('Escape');
  await expect(page.locator('#data-mode-seg [data-mode="local"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#data-mode-seg [data-mode="server"]')).toHaveAttribute('aria-pressed', 'false');
});

test('current-use and source markers follow a successful mode switch, not a cancelled one', async ({ page }) => {
  await page.route('**/api/instance', route => route.fulfill({ json: { mode: 'shared', auth_required: true } }));
  await configured(page, 'server');
  await page.locator('#btn-open-setup').click();
  await expect(page.locator('#setup-current-shared')).toBeVisible();
  await expect(page.locator('#setup-current-local')).toBeHidden();
  await expect(page.locator('#btn-setup-local')).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.locator('#data-mode-seg [data-mode="local"]').click();
  await expect(page.locator('#confirm-modal')).toHaveClass(/show/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#data-mode-seg [data-mode="server"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#data-mode-seg [data-mode="local"]').click();
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('#btn-confirm-ok').click()]);
  await page.evaluate(() => { switchView('view-tools'); document.querySelector('[data-tab="tab-system"]').click(); });
  await expect(page.locator('#data-mode-seg [data-mode="local"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#data-mode-seg [data-mode="server"]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#btn-open-setup').click();
  await expect(page.locator('#setup-current-local')).toBeVisible();
  await expect(page.locator('#setup-current-shared')).toBeHidden();
});

test('desktop SQLite is independent but a remote server is not mistaken for the desktop instance', async ({ page }) => {
  await configured(page, 'server');
  await page.locator('#btn-open-setup').click();
  await expect(page.locator('#setup-local-description')).toContainText('SQLite');
  await expect(page.locator('#setup-current-local')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => DataLayer.setSettings({ url: 'http://remote.test:8088', token: 'synthetic-key' }));
  await page.locator('#btn-open-setup').click();
  await expect(page.locator('#setup-current-shared')).toBeVisible();
  await expect(page.locator('#setup-current-local')).toBeHidden();
  await expect(page.locator('#btn-setup-local')).toBeEnabled();
});

test('apply is emphasized only for valid changed settings and returns to neutral when edits are undone', async ({ page }) => {
  await configured(page);
  const apply = page.locator('#btn-server-apply');
  await expect(apply).toBeDisabled();
  await expect(apply).not.toHaveClass(/btn-primary/);
  await page.locator('#input-api-token').fill('draft-key');
  await expect(apply).toBeEnabled();
  await expect(apply).toHaveClass(/btn-primary/);
  await expect(page.locator('#connection-draft-hint')).toContainText('有未应用');
  await page.locator('#input-server-url').fill('http://user:password@invalid.test');
  await expect(apply).toBeDisabled();
  await expect(apply).not.toHaveClass(/btn-primary/);
  await page.locator('#input-server-url').fill('');
  await page.locator('#input-api-token').fill('   ');
  await expect(apply).toBeDisabled();
  await expect(page.locator('#connection-draft-hint')).toHaveText('连接设置未改动。');
  expect(await page.evaluate(() => ({ mode: DataLayer.mode, url: DataLayer.serverUrl, token: DataLayer.token })))
    .toEqual({ mode: 'local', url: '', token: '' });
});

test('push emphasis follows the real queue including failure and successful completion', async ({ page, request }) => {
  await request.post('/api/wipe?confirm=yes');
  await configured(page);
  const push = page.locator('#btn-sync-push'), pull = page.locator('#btn-sync-pull');
  await expect(push).toBeDisabled();
  await expect(push).not.toHaveClass(/btn-primary/);
  await expect(page.locator('.pending-pill')).toHaveClass(/is-empty/);
  await expect(pull).toBeEnabled();
  await page.evaluate(() => api('/api/materials', { method: 'POST', body: JSON.stringify({ code: 'C420001', model: 'UI-TEST-ONLY', quantity: 2 }) }));
  await expect(page.locator('#pending-count')).toHaveText('1');
  await expect(push).toBeEnabled();
  await expect(push).toHaveClass(/btn-primary/);
  await expect(pull).toBeDisabled();
  await page.locator('#input-api-token').fill('draft-key');
  await expect(push).toBeDisabled();
  await expect(push).not.toHaveClass(/btn-primary/);
  await page.locator('#input-api-token').fill('');
  await expect(push).toBeEnabled();
  await page.route('**/api/sync/op', route => route.fulfill({ status: 409, json: { detail: 'test conflict' } }));
  await push.click();
  await expect(page.locator('#sync-status')).toContainText('test conflict');
  await expect(push).toBeEnabled();
  await expect(page.locator('#pending-count')).toHaveText('1');
  await page.unroute('**/api/sync/op');
  await push.click();
  await expect(page.locator('#pending-count')).toHaveText('0');
  await expect(push).toBeDisabled();
  await expect(push).not.toHaveClass(/btn-primary/);
  await expect(page.locator('.pending-pill')).toHaveClass(/is-empty/);
  await expect(pull).toBeEnabled();
  expect((await (await request.get('/api/materials/C420001')).json()).quantity).toBe(2);
});

test('testing in progress disables duplicate actions without marking a draft connection as current', async ({ page }) => {
  await configured(page);
  await page.locator('#input-api-token').fill('draft-key');
  await page.evaluate(() => { syncTestConnection = () => new Promise(resolve => { window.finishTest = resolve; }); });
  await page.locator('#btn-sync-test').click();
  await expect(page.locator('#btn-sync-test')).toBeDisabled();
  await expect(page.locator('#btn-server-apply')).toBeDisabled();
  await expect(page.locator('#data-mode-seg [data-mode="server"]')).toBeDisabled();
  await expect(page.locator('#data-mode-seg [data-mode="local"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.finishTest({ ok: true, msg: 'test complete' }));
  await expect(page.locator('#btn-sync-test')).toBeEnabled();
  await expect(page.locator('#btn-server-apply')).toBeEnabled();
  await expect(page.locator('#connection-draft-hint')).toContainText('有未应用');
  expect(await page.evaluate(() => DataLayer.token)).toBe('');
});

test('a failed server switch keeps local selected and restores the available controls', async ({ page }) => {
  await configured(page);
  await page.evaluate(() => {
    syncTestConnection = () => new Promise(resolve => { window.finishTest = resolve; });
  });
  await page.locator('#data-mode-seg [data-mode="server"]').click();
  await page.locator('#btn-confirm-ok').click();
  await expect.poll(() => page.evaluate(() => typeof window.finishTest)).toBe('function');
  await expect(page.locator('#data-mode-seg [data-mode="server"]')).toBeDisabled();
  await expect(page.locator('#data-mode-seg [data-mode="local"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.finishTest({ ok: false, msg: 'synthetic authentication failure' }));
  await expect(page.locator('#sync-status')).toContainText('synthetic authentication failure');
  await expect(page.locator('#data-mode-seg [data-mode="server"]')).toBeEnabled();
  await expect(page.locator('#data-mode-seg [data-mode="server"]')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => DataLayer.mode)).toBe('local');
});

test('a missing native address or an unreadable queue never enables snapshot replacement', async ({ page }) => {
  await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; });
  await configured(page);
  await expect(page.locator('#btn-sync-test')).toBeDisabled();
  await expect(page.locator('#btn-server-apply')).toBeDisabled();
  await expect(page.locator('#btn-sync-push')).toBeDisabled();
  await expect(page.locator('#btn-sync-pull')).toBeDisabled();
  await expect(page.locator('#pull-mode-hint')).toContainText('配置服务器地址');
  await page.evaluate(async () => {
    DataLayer.setSettings({ url: 'http://synthetic.example:8088' });
    document.querySelector('#input-server-url').value = DataLayer.serverUrl;
    syncPendingCount = async () => { throw new Error('synthetic read failure'); };
    await updatePendingCount();
  });
  await expect(page.locator('#pending-count')).toHaveText('—');
  await expect(page.locator('#btn-sync-push')).toBeDisabled();
  await expect(page.locator('#btn-sync-pull')).toBeDisabled();
  await expect(page.locator('#pull-mode-hint')).toContainText('无法确认能否安全覆盖');
});
