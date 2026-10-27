import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { findSecrets } from '../../scripts/check-no-secrets.mjs';

describe('findSecrets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'englint-secrets-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a key-shaped string', () => {
    const file = join(dir, 'a.js');
    writeFileSync(file, `const k = '${'sk-ant-' + 'x'.repeat(20)}';`);
    expect(findSecrets(dir)).toEqual([file]);
  });

  it('skips WebAssembly binaries, still scanning everything else', () => {
    const key = 'sk-ant-' + 'x'.repeat(20);
    writeFileSync(join(dir, 'harper_wasm_slim_bg-abc123.wasm'), `\0asm${key}`);
    const script = join(dir, 'chunk.js');
    writeFileSync(script, `const k = '${key}';`);
    expect(findSecrets(dir)).toEqual([script]);
  });

  it('clean dir returns []', () => {
    writeFileSync(join(dir, 'b.js'), 'console.log("hello");');
    expect(findSecrets(dir)).toEqual([]);
  });
});
