import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Chrome's extension ID: first 32 hex chars of sha256(DER public key), with 0-f mapped to a-p. */
export function extensionIdFromPublicKey(derBase64) {
  const hex = createHash('sha256').update(Buffer.from(derBase64, 'base64')).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--generate')) {
    console.error('usage: node scripts/extension-key.mjs --generate [--force]');
    process.exit(1);
  }
  const out = resolve(fileURLToPath(import.meta.url), '../../extension-key.pub.txt');
  if (existsSync(out) && !process.argv.includes('--force')) {
    console.error('extension-key.pub.txt already exists; pass --force to replace it (this changes the extension ID).');
    process.exit(1);
  }
  // The private key is generated only because the API requires it. It is never written or printed.
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const base64 = publicKey.toString('base64');
  writeFileSync(out, base64 + '\n');
  console.log(`wrote extension-key.pub.txt\nextension id: ${extensionIdFromPublicKey(base64)}`);
}
