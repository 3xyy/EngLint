import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEnvKey } from '../../evals/read-env';

describe('readEnvKey', () => {
  let dir: string;
  let envPath: string;
  const write = (content: string) => writeFileSync(envPath, content);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'englint-env-'));
    envPath = join(dir, '.env');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("value containing '=' is kept whole", () => {
    write('ANTHROPIC_API_KEY=abc=def==\n');
    expect(readEnvKey(envPath)).toBe('abc=def==');
  });

  it('quotes stripped', () => {
    write('ANTHROPIC_API_KEY="dq-value"\n');
    expect(readEnvKey(envPath)).toBe('dq-value');
    write("ANTHROPIC_API_KEY='sq-value'\n");
    expect(readEnvKey(envPath)).toBe('sq-value');
  });

  it('missing → error text has no file contents', () => {
    write('OTHER_VAR=zzz-sentinel-value\n# ANTHROPIC_API_KEY=commented-out\n');
    let message = '';
    try {
      readEnvKey(envPath);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('ANTHROPIC_API_KEY missing from .env');
    expect(message).not.toContain('zzz-sentinel-value');
    expect(message).not.toContain('commented-out');
  });

  it('empty value counts as missing', () => {
    write('ANTHROPIC_API_KEY=\n');
    expect(() => readEnvKey(envPath)).toThrow('ANTHROPIC_API_KEY missing from .env');
  });

  it('finds the key among other lines, with CRLF endings and spaces around it', () => {
    write('FIRST=1\r\n\r\n  ANTHROPIC_API_KEY = spaced-value  \r\nLAST=2\r\n');
    expect(readEnvKey(envPath)).toBe('spaced-value');
  });

  it('reads another variable by name', () => {
    write('ANTHROPIC_API_KEY=a\nOTHER_KEY=b\n');
    expect(readEnvKey(envPath, 'OTHER_KEY')).toBe('b');
  });
});
