import { readFileSync } from 'node:fs';
// @ts-expect-error plain .mjs script without type declarations
import { extensionIdFromPublicKey } from '../../scripts/extension-key.mjs';
import { expect, test } from './fixtures';

test('the runtime id equals WXT_EXTENSION_ID', ({ extensionId }) => {
  const key = readFileSync('extension-key.pub.txt', 'utf8').trim();
  expect(extensionId).toBe(extensionIdFromPublicKey(key));
});
