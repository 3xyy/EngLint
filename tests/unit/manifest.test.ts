import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../wxt.config';

describe('manifest', () => {
  it('manifest description is set', () => {
    const manifest = config.manifest as { description?: string };
    expect(manifest.description).toBe('A linter for English.');
  });

  it('asks for the context menu (an inclusion check; the dev self-reload keeps alarms)', () => {
    const { permissions } = config.manifest as { permissions?: string[] };
    expect(permissions).toContain('contextMenus');
    expect(permissions).toContain('alarms');
  });

  it('asks for an offscreen document and lets extension pages compile WebAssembly, with host permissions unchanged', () => {
    const manifest = config.manifest as {
      permissions?: string[];
      host_permissions?: string[];
      content_security_policy?: { extension_pages?: string };
    };
    expect(manifest.permissions).toContain('offscreen');
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    expect(csp).toMatch(/(^|;)\s*script-src 'self' 'wasm-unsafe-eval'\s*(;|$)/);
    expect(csp).toMatch(/(^|;)\s*object-src 'self'\s*(;|$)/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(manifest.host_permissions).toEqual(['https://api.anthropic.com/*']);
  });

  it('declares the englint-tools shortcut: Ctrl+Shift+E (Control on a Mac too)', () => {
    const { commands } = config.manifest as { commands?: Record<string, unknown> };
    expect(commands?.['englint-tools']).toEqual({
      suggested_key: { default: 'Ctrl+Shift+E', mac: 'MacCtrl+Shift+E' },
      description: 'Rewrite or find synonyms for the selected text',
    });
  });

  it('declares the EngLint icon at 16, 32, 48 and 128 px, each a real PNG of that size in public/', () => {
    const icons = (config.manifest as { icons?: Record<string, string> }).icons;
    expect(icons).toEqual({ 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' });
    for (const [size, path] of Object.entries(icons!)) {
      const file = `public/${path}`;
      expect(existsSync(file), file).toBe(true);
      const png = readFileSync(file);
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      // IHDR width and height, big-endian, at bytes 16..23
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([Number(size), Number(size)]);
    }
  });
});

describe('e2e-only manifest switches', () => {
  it('a production build keeps the Docs scripts on docs.google.com only', async () => {
    const manifest = {
      content_scripts: [
        { matches: ['<all_urls>'], js: ['content-scripts/content.js'] },
        { matches: ['https://docs.google.com/document/*'], js: ['content-scripts/gdocs.js'] },
      ],
      web_accessible_resources: [{ resources: ['content-scripts/gdocs.css'], matches: ['https://docs.google.com/*'] }],
    };
    const before = structuredClone(manifest);
    const hook = (config.hooks as Record<string, (wxt: unknown, manifest: unknown) => unknown>)['build:manifestGenerated']!;
    await hook({}, manifest);
    expect(manifest).toEqual(before);
  });
});
