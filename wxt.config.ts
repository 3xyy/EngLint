import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'wxt';
// @ts-expect-error plain .mjs script without type declarations
import { extensionIdFromPublicKey } from './scripts/extension-key.mjs';

const e2e = process.env.ENGLINT_E2E === '1';

// One id per build, baked into the bundle and written to build-id.txt beside it: an unpacked install
// reloads itself when the file no longer matches (src/background/dev-reload.ts). The e2e build never does.
const buildId = e2e ? 'e2e' : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// A fixed public key pins the extension ID (same for .output and .output-e2e).
// Generate once with `node scripts/extension-key.mjs --generate`.
if (!existsSync('extension-key.pub.txt')) {
  throw new Error('extension-key.pub.txt is missing. Run: node scripts/extension-key.mjs --generate');
}
const publicKey = readFileSync('extension-key.pub.txt', 'utf8').trim();
const extensionId = extensionIdFromPublicKey(publicKey);

const DOCS_MATCH = 'https://docs.google.com/document/*';
const DOCS_ORIGIN = 'https://docs.google.com/*';
/** e2e only: the fake Docs pages served by the e2e harness (tests/e2e/pages/document/). */
const E2E_DOCS_MATCH = 'http://127.0.0.1/document/*';
const E2E_DOCS_ORIGIN = 'http://127.0.0.1/*';

export default defineConfig({
  srcDir: 'src',
  // The e2e build (mock API base URL, 127.0.0.1 permission) never lands in .output, which the owner loads.
  outDir: e2e ? '.output-e2e' : '.output',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    define: {
      'import.meta.env.WXT_EXTENSION_ID': JSON.stringify(extensionId),
      // e2e only: the field layers' shadow roots are open, so Playwright's locators reach the underlines.
      'import.meta.env.ENGLINT_E2E': JSON.stringify(e2e),
      'import.meta.env.ENGLINT_BUILD_ID': JSON.stringify(buildId),
    },
  }),
  hooks: {
    // e2e builds run both Docs scripts on the fake Docs page too (with the Docs overlay's stylesheet),
    // and keep the generic script off it, as on docs.google.com.
    'build:done': async (wxt) => {
      if (!e2e) writeFileSync(join(wxt.config.outDir, 'build-id.txt'), buildId);
    },
    'build:manifestGenerated': (_wxt, manifest) => {
      if (!e2e) return;
      for (const script of manifest.content_scripts ?? []) {
        if (script.matches?.includes(DOCS_MATCH)) script.matches.push(E2E_DOCS_MATCH);
        else if (script.matches?.includes('<all_urls>')) {
          script.exclude_matches = [...(script.exclude_matches ?? []), E2E_DOCS_MATCH];
        }
      }
      for (const entry of manifest.web_accessible_resources ?? []) {
        if (typeof entry !== 'string' && entry.matches?.includes(DOCS_ORIGIN)) entry.matches.push(E2E_DOCS_ORIGIN);
      }
    },
  },
  manifest: {
    name: 'EngLint',
    description: 'A linter for English.',
    key: publicKey,
    // Rendered from design/icon/*.svg by scripts/render-icons.mjs; Chrome also uses these for the toolbar button.
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    // offscreen: the local Harper checker's document (src/entrypoints/offscreen), whose WebAssembly needs
    // 'wasm-unsafe-eval' on extension pages.
    permissions: ['storage', 'sidePanel', 'activeTab', 'alarms', 'contextMenus', 'offscreen'],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
    // The tools on the selection (src/background/menus.ts): the popover in a field, otherwise the side panel.
    commands: {
      'englint-tools': {
        suggested_key: { default: 'Ctrl+Shift+E', mac: 'MacCtrl+Shift+E' },
        description: 'Rewrite or find synonyms for the selected text',
      },
    },
    // Asked for when the writer saves another provider's address (the Options page), never at install.
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    host_permissions: [
      'https://api.anthropic.com/*',
      ...(e2e ? ['http://127.0.0.1/*'] : []),
    ],
  },
});
