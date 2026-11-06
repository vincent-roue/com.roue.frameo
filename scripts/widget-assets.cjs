'use strict';

// frameo/public is the source for every catalogue size. Variant HTML changes
// only the fixed format; all behaviour, styles and artwork remain identical.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const widgetsRoot = path.join(root, 'app/widgets');
const canonical = path.join(widgetsRoot, 'frameo');
const variants = Object.freeze([
  { id: 'frameo-compact', format: 'compact' },
  { id: 'frameo-portrait', format: 'portrait' },
]);

function publicFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    assert(!entry.isSymbolicLink(), 'Widget public assets must be regular files');
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return publicFiles(path.join(directory, entry.name), relative);
    assert(entry.isFile(), 'Widget public assets must be regular files');
    return [relative];
  });
}

async function syncWidgetAssets({ check = false } = {}) {
  const compose = JSON.parse(fs.readFileSync(path.join(canonical, 'widget.compose.json'), 'utf8'));
  assert.equal(compose.height, '100%', 'The existing frameo widget must keep its square manifest height');
  assert(!compose.settings.some(setting => setting.id === 'format'), 'Catalogue sizes must not offer a competing format setting');
  const files = publicFiles(path.join(canonical, 'public'));
  const expected = new Map();
  for (const variant of variants) {
    const directory = path.join(widgetsRoot, variant.id);
    for (const relative of files) {
      let contents = fs.readFileSync(path.join(canonical, 'public', relative));
      if (relative === 'index.html') {
        const html = contents.toString('utf8');
        assert.equal(html.split("format: 'square'").length, 2, 'The canonical widget must declare exactly one fixed square format');
        contents = Buffer.from(html.replace("format: 'square'", "format: '" + variant.format + "'"));
      }
      expected.set(path.join(directory, 'public', relative), contents);
    }
  }
  const differences = [];
  for (const [filename, contents] of expected) {
    const matches = fs.existsSync(filename) && fs.readFileSync(filename).equals(contents);
    if (matches) continue;
    if (check) differences.push(path.relative(root, filename).replaceAll('\\', '/'));
    else { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, contents); }
  }
  assert.equal(differences.length, 0, 'Unsynchronized widget assets: ' + differences.join(', '));
  return { widgets: ['frameo', ...variants.map(variant => variant.id)], publicFiles: files.length, checked: check };
}

if (require.main === module) syncWidgetAssets({ check: process.argv.includes('--check') }).then(result => {
  console.log(JSON.stringify(result));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { syncWidgetAssets };
