import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { extensionIdFromPublicKey } from '../../scripts/extension-key.mjs';

function freshKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return publicKey.toString('base64');
}

describe('extensionIdFromPublicKey', () => {
  it('id is 32 chars a–p', () => {
    expect(extensionIdFromPublicKey(freshKey())).toMatch(/^[a-p]{32}$/);
  });

  it('deterministic for the same key', () => {
    const key = freshKey();
    expect(extensionIdFromPublicKey(key)).toBe(extensionIdFromPublicKey(key));
  });

  it('differs between keys', () => {
    expect(extensionIdFromPublicKey(freshKey())).not.toBe(extensionIdFromPublicKey(freshKey()));
  });

  it('maps hex digits 0–f to a–p (known answer)', () => {
    // sha256 of the single byte 0x00 starts 6e340b9c ffb37a98 9ca544e6 bb780a2c
    expect(extensionIdFromPublicKey('AA==')).toBe('godealjmppldhkjijmkfeeogllhiakcm');
  });
});
