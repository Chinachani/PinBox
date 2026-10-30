const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('wms-mode', 'local');
    localStorage.setItem('wms-onboarded', '1');
  });
  await page.goto('/');
});

async function seed(page, fields = {}) {
  await page.evaluate(async fields => {
    const res = await api('/api/materials', { method: 'POST', body: JSON.stringify({ code: 'C10001', model: 'TEST-123', category: 'Offline Category', quantity: 20, ...fields }) });
    if (!res.ok) throw new Error(JSON.stringify(await res.json()));
    await loadMaterials();
    await loadCategories();
    await loadStats();
  }, fields);
}

test('offline categories load through the local data layer and layout fits the screen', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await seed(page);
  await expect(page.locator('.material-card')).toHaveCount(1);
  await expect(page.locator('#cat-chips')).toContainText('Offline Category');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('manual continuous scan changes stock once and refuses missing label quantity', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { switchView('view-scan'); state.scanMode = 'in'; });
  await page.locator('#manual-code-input').fill('pc:C10001,pm:TEST-123,qty:5');
  await page.locator('#manual-code-input').press('Enter');
  await expect.poll(() => page.evaluate(async () => (await LocalDB.get('materials', 'C10001')).quantity)).toBe(25);
  await page.locator('#manual-code-input').press('Enter');
  await page.evaluate(() => handleScanText('C10001'));
  expect(await page.evaluate(async () => (await LocalDB.get('materials', 'C10001')).quantity)).toBe(25);
  expect(await page.evaluate(() => LocalDB.count('pending_ops'))).toBe(2);
});

test('stock quantities reject decimal input and update the cached quantity after success', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => { switchView('view-scan'); return handleScanText('C10001'); });
  await page.locator('#res-custom-qty').fill('1.5');
  await page.locator('#btn-res-plus').click();
  expect(await page.evaluate(async () => (await LocalDB.get('materials', 'C10001')).quantity)).toBe(20);
  await page.locator('#res-custom-qty').fill('3');
  await page.locator('#btn-res-plus').click();
  await expect.poll(() => page.evaluate(() => state.materials[0].quantity)).toBe(23);
});

test('closing a confirmation resolves cancellation and confirming resolves acceptance', async ({ page }) => {
  await page.evaluate(() => { window.confirmResult = null; showConfirm('test', 'test').then(v => window.confirmResult = v); });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.confirmResult)).toBe(false);
  await page.evaluate(() => { window.confirmResult = null; showConfirm('test', 'test').then(v => window.confirmResult = v); });
  await page.locator('#btn-confirm-ok').click();
  await expect.poll(() => page.evaluate(() => window.confirmResult)).toBe(true);
});

test('BOM manual choice reallocates shared stock across all rows', async ({ page }) => {
  await seed(page, { model: '10kΩ 0603 1%', category: '电阻', quantity: 10 });
  await page.evaluate(async () => {
    switchView('view-bom');
    await runBomCheck({ content: '10k 0603 6\n10k 0603 6' });
  });
  await page.locator('.bom-match-select').nth(0).selectOption('C10001');
  await page.locator('.bom-match-select').nth(1).selectOption('C10001');
  await expect(page.locator('#bom-results tr').nth(1).locator('.bom-status')).toContainText('缺 2');
});

test('PWA starts offline with versioned script URLs and reports server failures as failures', async ({ page, context }) => {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await seed(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.material-card')).toHaveCount(1);
  expect(await page.evaluate(() => typeof LocalAPI.handle)).toBe('function');
  expect(await page.evaluate(async () => (await fetch('/api/stats')).status)).toBe(503);
  await context.setOffline(false);
});

test('local backup download includes unsynced operations', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    switchView('view-tools');
    document.querySelector('[data-tab="tab-import"]').click();
  });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#a-export-json').click();
  const download = await downloadPromise;
  const file = await download.path();
  const data = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  expect(data.materials.length).toBe(1);
  expect(data.pending_ops.length).toBe(1);
});

test('printed QR labels preserve Chinese text through decoding', async ({ page, request }) => {
  const encoded = await page.evaluate(async () => {
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvgTag('LOC:元件盒一号'));
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 400;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 400, 400);
    ctx.drawImage(image, 0, 0, 400, 400);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const result = await request.post('/api/scan-image', { multipart: { file: { name: 'label.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') } } });
  expect((await result.json()).raw_text).toBe('LOC:元件盒一号');
});

test('camera scan region uses the scanner width and height arguments', async ({ page }) => {
  const box = await page.evaluate(async () => {
    let region;
    window.Html5Qrcode = class {
      async start(camera, config) { region = config.qrbox(640, 480); }
      async stop() {}
      clear() {}
    };
    await startCamera();
    await stopCamera();
    return region;
  });
  expect(box).toEqual({ width: 298, height: 298 });
});
