import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { onMessage, sendMessage } from '../shared/messages';

export interface AnnounceDeps {
  /** Sends `pageStarted` to the background. */
  sendStarted(): void;
  /** Answers `pagePresent` from now on; returns the function that stops it. */
  answerPresent(): () => void;
}

const messaging: AnnounceDeps = {
  sendStarted: () => void sendMessage('pageStarted', undefined).catch(() => {}),
  answerPresent: () => onMessage('pagePresent', () => true),
};

/**
 * Tells the background this document is the tab's page, from the top frame's EngLint script (one per document: the
 * generic script, or on Docs the Docs script). Resolves once said, before anything the page reports: `pageStarted`
 * once the page is shown (a prerendered page isn't the tab's page until it is activated), and again each time a
 * back/forward restore shows it from the bfcache, where the tab's state is the page left behind. From then on it
 * answers the background's `pagePresent`.
 */
export async function announcePage(
  ctx: Pick<ContentScriptContext, 'addEventListener' | 'onInvalidated'>,
  doc: EventTarget & { prerendering?: boolean } = document,
  win: Window = window,
  deps: AnnounceDeps = messaging,
): Promise<void> {
  if (doc.prerendering) await new Promise((resolve) => doc.addEventListener('prerenderingchange', resolve, { once: true }));
  ctx.onInvalidated(deps.answerPresent());
  ctx.addEventListener(win, 'pageshow', (e) => {
    if (e.persisted) deps.sendStarted();
  });
  deps.sendStarted();
}
