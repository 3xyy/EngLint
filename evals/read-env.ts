import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Reads one variable from a dotenv file as plain data: never sourced, never logged.
 * Each line is split on its first `=`, so values may contain `=`. One pair of matching
 * surrounding quotes is stripped. Errors name the variable and file, never the contents.
 */
export function readEnvKey(path = '.env', name = 'ANTHROPIC_API_KEY'): string {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1 || line.slice(0, eq).trim() !== name) continue;
    const value = stripQuotes(line.slice(eq + 1).trim());
    if (value !== '') return value;
  }
  throw new Error(`${name} missing from ${basename(path)}`);
}

function stripQuotes(v: string): string {
  const q = v[0];
  return v.length >= 2 && (q === '"' || q === "'") && v.endsWith(q) ? v.slice(1, -1) : v;
}
