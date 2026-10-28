import { describe, expect, it } from 'vitest';
import * as reviewSchema from '../../src/core/review-schema';
import * as schema from '../../src/core/schema';
import * as toolSchema from '../../src/core/tool-schema';

// The API's structured outputs reject these keywords with a 400; the mock server never checks.
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems'];

function problems(node: unknown, path: string): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => problems(n, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => {
    const here = `${path}.${k}`;
    const own = UNSUPPORTED.includes(k) || (k === 'minItems' && typeof v === 'number' && v > 1) ? [here] : [];
    return [...own, ...problems(v, here)];
  });
}

const all = Object.entries({ ...schema, ...reviewSchema, ...toolSchema }).filter(([name]) => name.endsWith('_JSON_SCHEMA'));

describe('every JSON schema sent to the API', () => {
  it('finds the schemas', () => {
    expect(all.map(([n]) => n).sort()).toEqual(
      ['CRITIQUE_JSON_SCHEMA', 'DEEP_CHECK_JSON_SCHEMA', 'FOLLOW_UP_JSON_SCHEMA', 'GRADER_JSON_SCHEMA', 'LIVE_CHECK_JSON_SCHEMA', 'READERS_JSON_SCHEMA', 'STYLE_PROFILE_JSON_SCHEMA', 'SYNONYMS_JSON_SCHEMA', 'TONE_JSON_SCHEMA', 'VARIANTS_JSON_SCHEMA', 'VOICE_JSON_SCHEMA', 'WORD_LIMIT_JSON_SCHEMA'],
    );
  });
  it.each(all)('%s uses no keyword the API rejects', (name, value) => {
    expect(problems(value, name)).toEqual([]);
  });
});
