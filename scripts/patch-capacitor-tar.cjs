const fs = require('node:fs');
const path = require('node:path');

// Capacitor 6 expects tar's old default export. Security fixes require tar 7,
// whose CommonJS entry exports extract directly. Keep the Android SDK unchanged.
const cli = require.resolve('@capacitor/cli/package.json');
const version = JSON.parse(fs.readFileSync(cli, 'utf8')).version;
if (version.startsWith('6.')) {
  const template = path.join(path.dirname(cli), 'dist/util/template.js');
  const source = fs.readFileSync(template, 'utf8');
  const oldImport = 'const tar_1 = tslib_1.__importDefault(require("tar"));';
  if (source.includes(oldImport)) {
    fs.writeFileSync(template, source.replace(oldImport, 'const tar_1 = { default: require("tar") };'));
  } else if (!source.includes('const tar_1 = { default: require("tar") };')) {
    throw new Error('Capacitor tar compatibility patch no longer matches; inspect the CLI before building.');
  }
}
