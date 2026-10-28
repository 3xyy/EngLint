import { createBinaryModuleFromUrl, LocalLinter } from 'harper.js';
import { createHarperHost } from './harper-host';
import { createWorkerHandler, type FromWorker } from './harper-worker';

// The offscreen document's Harper worker (harper-worker.ts says why it is one): it lints off the main thread
// that the extension's pages share.
const scope = self as unknown as {
  postMessage(data: FromWorker): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
};

const handle = createWorkerHandler(
  // A fresh binary module each time: a failed load stays failed inside the module that tried it.
  (wasmUrl) => createHarperHost(() => new LocalLinter({ binary: createBinaryModuleFromUrl(wasmUrl, 'slim') })),
  (data) => scope.postMessage(data),
);
scope.addEventListener('message', (e) => void handle(e.data));
