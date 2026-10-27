// An unpacked (developer) install reloads itself when a newer build lands on disk, so nobody has to press
// ↻ in chrome://extensions after `npm run build`. Store installs and the e2e build never poll.

export const DEV_RELOAD_ALARM = 'englint-dev-reload';

/** The build id the e2e build is made with: its runs must never reload themselves mid-test. */
const E2E_BUILD = 'e2e';

export function isNewerBuild(running: string, onDisk: string | null): boolean {
  const id = onDisk?.trim();
  return !!id && id !== running;
}

export interface DevReloadDeps {
  /** The id baked into this bundle at build time. */
  running: string;
  /** The id in build-id.txt now (unpacked extensions read their files from disk). */
  readOnDisk(): Promise<string | null>;
  reload(): void;
}

export async function checkForNewBuild(deps: DevReloadDeps): Promise<boolean> {
  const onDisk = await deps.readOnDisk().catch(() => null);
  if (!isNewerBuild(deps.running, onDisk)) return false;
  deps.reload();
  return true;
}

interface AlarmsLike {
  create(name: string, info: { periodInMinutes: number }): void;
  onAlarm: { addListener(cb: (alarm: { name: string }) => void): void };
}

export async function startDevReload(deps: DevReloadDeps & { isUnpacked(): Promise<boolean>; alarms: AlarmsLike }): Promise<void> {
  if (deps.running === E2E_BUILD || !(await deps.isUnpacked().catch(() => false))) return;
  deps.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DEV_RELOAD_ALARM) void checkForNewBuild(deps);
  });
  deps.alarms.create(DEV_RELOAD_ALARM, { periodInMinutes: 0.5 }); // Chrome's minimum period
  await checkForNewBuild(deps); // the worker also wakes for other events: check then too
}
