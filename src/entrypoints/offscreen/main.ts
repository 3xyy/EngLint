import { createBinaryModuleFromUrl, LocalLinter } from 'harper.js';
import { slimBinary } from 'harper.js/slimBinary';
import { createHarperHost, createOffscreenListener } from '../../offscreen/harper-host';

// The background creates this document on the first Harper check (src/background/harper.ts). It holds the
// slim WebAssembly build, which the bundler ships as an asset beside this page.
const host = createHarperHost(
  // A fresh binary module each time: a failed load stays failed inside the module that tried it.
  () => new LocalLinter({ binary: createBinaryModuleFromUrl(String(slimBinary.url), 'slim') }),
);

browser.runtime.onMessage.addListener(createOffscreenListener({ extensionOrigin: browser.runtime.getURL('/'), lint: host.lint }));
