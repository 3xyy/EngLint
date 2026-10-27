import { createContentEditableAdapter } from '../content/adapters/contenteditable';
import { createTextareaAdapter } from '../content/adapters/textarea';
import { editingHost, watchFields } from '../content/detect';
import { CARET_KEYS, createFieldHost, loadPageSettings } from '../content/field-host';
import { announcePage } from '../content/page-announce';
import { isGenericHostExcluded } from '../content/skip';
import { readFieldSelection, readPageSelection } from '../content/tools/selection';
import { TOOLS_COPY } from '../content/tools/tools-controller';
import { onMessage, sendMessage } from '../shared/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  cssInjectionMode: 'ui',
  async main(ctx) {
    const host = location.hostname;
    if (isGenericHostExcluded(host)) return;

    // A frame also stops when the tab's top-level site is switched off; only the background knows that host.
    const isTop = window === window.top;
    // The tab's page is this document: the background forgets the old page's state before anything this page
    // reports. On Docs, where this script stops above, the Docs script says it.
    if (isTop) await announcePage(ctx);
    const topHost = isTop ? null : await sendMessage('topHost', undefined).catch(() => null);
    const settings = await loadPageSettings(ctx, host, topHost);
    const fields = createFieldHost(ctx, { host, settings });

    function onFocusField(el: Element) {
      const isTextarea = el instanceof HTMLTextAreaElement;
      if (!isTextarea && !(el instanceof HTMLElement && el.isContentEditable)) return;
      const f = fields.attach(el, (fieldId) =>
        isTextarea ? createTextareaAdapter(el, fieldId) : createContentEditableAdapter(el as HTMLElement, fieldId),
      );
      fields.report(f, true); // the panel follows focus
      fields.focused(f); // a layer the page kept removing is tried again
    }

    // Keyboard "focus" on an issue: the caret moved inside an underlined span.
    ctx.addEventListener(
      document,
      'keyup',
      (e) => {
        if (!CARET_KEYS.has(e.key)) return;
        const target = e.composedPath()[0];
        const f = target instanceof Element ? fields.get(editingHost(target)) : undefined;
        if (f) void fields.openAtCaret(f);
      },
      { capture: true },
    );

    // ---- the right-click menu and the shortcut (background/menus.ts) ----
    const offTools = [
      // The popover on the focused field's selection: opened false without one. With no field EngLint edits
      // in focus (an <input>, or a switched-off site), a notice says so: the user's gesture is spent.
      onMessage('openTools', async ({ data }) => {
        const f = fields.focusedField();
        if (!f) {
          void fields.notify(siteOn ? TOOLS_COPY.cantEdit : TOOLS_COPY.siteOff);
          return { opened: false };
        }
        const range = await readFieldSelection(f.adapter);
        return { opened: !!range && (await fields.openTools(f, range, data.request)) };
      }),
      // The side panel's text when no field holds the selection (the background asks the top frame only).
      ...(isTop ? [onMessage('pageSelection', () => ({ text: readPageSelection(document) }))] : []),
    ];
    ctx.onInvalidated(() => offTools.forEach((off) => off()));

    // ---- site switch ----
    let stopWatching: (() => void) | null = null;
    const start = () => {
      stopWatching ??= watchFields(document, onFocusField, (el) => {
        const f = fields.get(el);
        if (f) fields.detach(f);
      });
    };
    const stop = () => {
      stopWatching?.();
      stopWatching = null;
      fields.detachAll();
    };

    // The top frame tells the background when this tab's site is switched off or on (the "off" badge).
    const reportOff = (off: boolean) => void (isTop && sendMessage('siteOff', { off }).catch(() => {}));
    let siteOn = settings.watchEnabled((nowOn) => {
      if (nowOn !== siteOn) reportOff(!nowOn); // not on every change to the list
      siteOn = nowOn;
      if (nowOn) start();
      else stop();
    });
    ctx.onInvalidated(stop);
    if (siteOn) start();
    else reportOff(true);
  },
});
