import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEV_RELOAD_ALARM, checkForNewBuild, isNewerBuild, startDevReload } from '../../src/background/dev-reload';
import config from '../../wxt.config';

describe('isNewerBuild', () => {
  it('is true only when the build on disk differs from the running one', () => {
    expect(isNewerBuild('abc', 'abd')).toBe(true);
    expect(isNewerBuild('abc', 'abc')).toBe(false);
    expect(isNewerBuild('abc', 'abc\n')).toBe(false); // the file may end with a newline
    expect(isNewerBuild('abc', null)).toBe(false); // no file: nothing to compare
    expect(isNewerBuild('abc', '')).toBe(false);
  });
});

describe('checkForNewBuild', () => {
  it('reloads when a newer build is on disk', async () => {
    const reload = vi.fn();
    expect(await checkForNewBuild({ running: 'a', readOnDisk: async () => 'b', reload })).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does nothing when the build on disk is the running one, or reading it fails', async () => {
    const reload = vi.fn();
    await checkForNewBuild({ running: 'a', readOnDisk: async () => 'a', reload });
    await checkForNewBuild({ running: 'a', readOnDisk: () => Promise.reject(new Error('gone')), reload });
    expect(reload).not.toHaveBeenCalled();
  });
});

function fakeAlarms() {
  const listeners: ((alarm: { name: string }) => void)[] = [];
  return {
    create: vi.fn(),
    onAlarm: { addListener: (cb: (alarm: { name: string }) => void) => listeners.push(cb) },
    fire: (name: string) => listeners.forEach((l) => l({ name })),
  };
}

describe('startDevReload', () => {
  it('in an unpacked install: checks at once, then on a 30-second alarm', async () => {
    const alarms = fakeAlarms();
    let onDisk = 'a';
    const reload = vi.fn();
    await startDevReload({ running: 'a', isUnpacked: async () => true, readOnDisk: async () => onDisk, reload, alarms });
    expect(alarms.create).toHaveBeenCalledWith(DEV_RELOAD_ALARM, { periodInMinutes: 0.5 });
    expect(reload).not.toHaveBeenCalled();
    onDisk = 'b'; // a new build lands
    alarms.fire('some-other-alarm');
    await vi.waitFor(() => expect(reload).not.toHaveBeenCalled());
    alarms.fire(DEV_RELOAD_ALARM);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it('a store install (not unpacked) never polls or reloads', async () => {
    const alarms = fakeAlarms();
    const readOnDisk = vi.fn(async () => 'b');
    const reload = vi.fn();
    await startDevReload({ running: 'a', isUnpacked: async () => false, readOnDisk, reload, alarms });
    expect(alarms.create).not.toHaveBeenCalled();
    expect(readOnDisk).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('the e2e build never polls or reloads, even unpacked', async () => {
    const alarms = fakeAlarms();
    const reload = vi.fn();
    await startDevReload({ running: 'e2e', isUnpacked: async () => true, readOnDisk: async () => 'b', reload, alarms });
    expect(alarms.create).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('build id wiring (wxt.config)', () => {
  it('build:done writes the same id the bundle is built with, to build-id.txt in the output folder', async () => {
    const vite = (config.vite as () => { define: Record<string, string> })();
    const baked = JSON.parse(vite.define['import.meta.env.ENGLINT_BUILD_ID']!) as string;
    expect(baked).toMatch(/^[a-z0-9-]{6,}$/);
    const outDir = mkdtempSync(join(tmpdir(), 'englint-build-'));
    const hook = (config.hooks as Record<string, (wxt: unknown, output: unknown) => Promise<void>>)['build:done']!;
    await hook({ config: { outDir } }, {});
    expect(readFileSync(join(outDir, 'build-id.txt'), 'utf8')).toBe(baked);
  });

  it('declares the alarms permission the poll needs', () => {
    expect((config.manifest as { permissions: string[] }).permissions).toContain('alarms');
  });
});
