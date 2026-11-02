const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('security overrides retain Capacitor loaders and rimraf glob compatibility', async () => {
  require('@capacitor/cli/dist/android/update');
  const { globSync } = require('glob');
  const { rimraf } = require('rimraf');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinbox-build-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'test.txt'), 'synthetic');
    assert.equal(globSync('*.txt', { cwd: dir }).length, 1);
    await rimraf(path.join(dir, '*.txt'), { glob: true });
    assert.equal(globSync('*.txt', { cwd: dir }).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
