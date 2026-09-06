/**
 * Keep the three places a version lives in sync.
 *
 * The updater compares the running app's version (from tauri.conf.json) with
 * the one in latest.json. If Cargo.toml and tauri.conf.json disagree, the
 * release builds but the update is never offered — so bump them together.
 *
 *   npm run bump 0.1.1
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: npm run bump <major.minor.patch>   e.g. npm run bump 0.1.1');
  process.exit(1);
}

function edit(relPath, pattern, replacement) {
  const path = join(root, relPath);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.error(`✗ ${relPath}: version field not found`);
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`✓ ${relPath}`);
}

edit('package.json', /("version":\s*)"[^"]+"/, `$1"${version}"`);
edit('src-tauri/tauri.conf.json', /("version":\s*)"[^"]+"/, `$1"${version}"`);
// Only the [package] version, which is the first `version = "..."` in the file.
edit('src-tauri/Cargo.toml', /^version = "[^"]+"/m, `version = "${version}"`);

console.log(`\nv${version} 준비 완료. 다음 단계:`);
console.log(`  git commit -am "v${version}"`);
console.log(`  git tag v${version}`);
console.log('  git push --follow-tags');
