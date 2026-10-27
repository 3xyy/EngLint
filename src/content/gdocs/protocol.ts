// Wire protocol between the MAIN-world Docs script (gdocs-main.content.ts) and the isolated-world bridge.
// Every CustomEvent detail is a JSON string: object details don't reliably cross the MAIN↔ISOLATED boundary.
// No imports: this file is bundled into the MAIN-world script, which must stay tiny.

export const GDOCS_REQ = 'englint:gdocs:req';
export const GDOCS_RES = 'englint:gdocs:res';
export const GDOCS_READY = 'englint:gdocs:ready';
export const GDOCS_PAINT = 'englint:gdocs:paint';

export type GdocsOp = 'getText' | 'getSelection' | 'setSelection' | 'ping' | 'runs';

/** The recorder numbers its canvases (`data-englint-canvas`); any other id could break the attribute selector that finds one. */
export const CANVAS_ID = /^\d{1,9}$/;

/**
 * What one `runs` snapshot may hold in all: canvases, runs, and characters of run text. The page world stops adding
 * canvases before it would pass them, so it never builds a reply only to have it refused; the isolated world keeps
 * the first SNAPSHOT_MAX_CANVASES canvases and rejects a reply past either total whole.
 */
export const SNAPSHOT_MAX_CANVASES = 256;
export const SNAPSHOT_MAX_RUNS = 20_000;
export const SNAPSHOT_MAX_TEXT = 2_000_000;

/**
 * `ping` answers `{ available }` (see GdocsReady): at once when available, otherwise when the MAIN script's
 * connect window ends. A ping after a final false opens one fresh window.
 */
export interface GdocsRequest {
  reqId: string;
  op: GdocsOp;
  args?: [number, number];
}

export interface GdocsResponse {
  reqId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface GdocsReady {
  available: boolean;
}

export interface GdocsPaint {
  generation: number;
}

export interface GdocsEventMap {
  [GDOCS_REQ]: GdocsRequest;
  [GDOCS_RES]: GdocsResponse;
  [GDOCS_READY]: GdocsReady;
  [GDOCS_PAINT]: GdocsPaint;
}

export function encode(message: GdocsRequest | GdocsResponse | GdocsReady | GdocsPaint): string {
  return JSON.stringify(message);
}

/** Parses an event detail. Anything but a JSON object string → null. Fields are unchecked, hence Partial. */
export function decode<T extends object>(detail: unknown): Partial<T> | null {
  if (typeof detail !== 'string') return null;
  try {
    const value: unknown = JSON.parse(detail);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Partial<T>) : null;
  } catch {
    return null;
  }
}

export function emit<K extends keyof GdocsEventMap>(target: EventTarget, type: K, message: GdocsEventMap[K]): void {
  target.dispatchEvent(new CustomEvent(type, { detail: encode(message) }));
}

/** Calls `handler` with each decodable message of `type`; returns the unsubscribe function. */
export function listen<K extends keyof GdocsEventMap>(
  target: EventTarget,
  type: K,
  handler: (message: Partial<GdocsEventMap[K]>) => void,
): () => void {
  const onEvent = (event: Event) => {
    const message = decode<GdocsEventMap[K]>((event as CustomEvent).detail);
    if (message) handler(message);
  };
  target.addEventListener(type, onEvent);
  return () => target.removeEventListener(type, onEvent);
}
