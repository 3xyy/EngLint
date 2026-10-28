import { slimBinary } from 'harper.js/slimBinary';
import { createOffscreenListener } from '../../offscreen/harper-host';
import { createWorkerLint } from '../../offscreen/harper-worker';

// The background creates this document on the first Harper check (src/background/harper.ts). Harper itself runs
// in a worker (src/offscreen/harper.worker.ts), so building its dictionary never blocks the extension's pages;
// this page relays the checks, and starts a new worker after one fails. The slim WebAssembly build ships as an asset
// beside it.
const lint = createWorkerLint(() => new Worker(new URL('../../offscreen/harper.worker.ts', import.meta.url), { type: 'module' }), String(slimBinary.url));

browser.runtime.onMessage.addListener(createOffscreenListener({ extensionOrigin: browser.runtime.getURL('/'), lint }));
