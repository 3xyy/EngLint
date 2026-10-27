import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{10,}/;
/** Compiled third-party binaries (Harper's 20 MB WebAssembly): random bytes, never built from our source. */
const SKIPPED = /\.wasm$/i;

/** Returns paths of files under `dir` containing an API-key-shaped string. Never returns the match. */
export function findSecrets(dir) {
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...findSecrets(path));
    } else if (entry.isFile() && !SKIPPED.test(entry.name) && KEY_PATTERN.test(readFileSync(path, 'latin1'))) {
      hits.push(path);
    }
  }
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? '.output';
  try {
    statSync(dir);
  } catch {
    console.error(`check-no-secrets: directory not found: ${dir}`);
    process.exit(1);
  }
  const hits = findSecrets(dir);
  if (hits.length > 0) {
    console.error('Key-shaped strings found in:');
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log('no secrets found');
}
