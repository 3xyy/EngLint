import type { Dialect as HarperDialect } from 'harper.js';
import { harperConfig, harperDialect, type LintConfig } from '../core/harper-config';
import { type LintLike, mapLints } from '../core/harper-map';
import { hashText } from '../core/paragraphs';
import { isExtensionPage } from '../core/sites';
import { HARPER_SHOWN, harperRule, type SourcedIssue } from '../core/sources';
import type { Dialect, Mode } from '../core/types';
import { HARPER_OFFSCREEN, type HarperLintMessage, type HarperLintReply } from '../shared/messages';

/** The part of harper.js's LocalLinter the host uses. */
export interface LinterLike {
  setup(): Promise<void>;
  getDefaultLintConfig(): Promise<LintConfig>;
  setLintConfig(config: LintConfig): Promise<void>;
  setDialect(dialect: HarperDialect): Promise<void>;
  clearWords(): Promise<void>;
  importWords(words: string[]): Promise<void>;
  organizedLints(text: string, options: { language: 'plaintext'; dedup: boolean }): Promise<Record<string, LintLike[]>>;
}

/**
 * One linter for the document's life, set up once (concurrent first requests wait on the same setup; a failed
 * setup is dropped so a later request builds a fresh linter). Requests run one at a time: each sets the
 * dialect, the mode's rules and the dictionary only when they changed, then lints each paragraph as plain text and
 * returns the lints of the rules the merge can show.
 */
export function createHarperHost(makeLinter: () => LinterLike) {
  let ready: Promise<{ linter: LinterLike; base: LintConfig }> | null = null;
  // What the linter has now. Harper's setDialect builds a new linter inside, with default rules and no words.
  let applied: { dialect?: Dialect; mode?: Mode; words?: string } = {};
  let queue: Promise<unknown> = Promise.resolve();

  function start() {
    if (!ready) {
      const setup = (async () => {
        const linter = makeLinter();
        await linter.setup();
        // The defaults, read once: the current config drifts with each mode set on it.
        return { linter, base: await linter.getDefaultLintConfig() };
      })();
      ready = setup;
      setup.catch(() => {
        if (ready === setup) ready = null;
        applied = {};
      });
    }
    return ready;
  }

  async function configure(linter: LinterLike, base: LintConfig, msg: HarperLintMessage): Promise<void> {
    if (applied.dialect !== msg.dialect) {
      await linter.setDialect(harperDialect(msg.dialect));
      applied = { dialect: msg.dialect };
    }
    if (applied.mode !== msg.mode) {
      await linter.setLintConfig(harperConfig(msg.mode, base));
      applied.mode = msg.mode;
    }
    const words = hashText(msg.words.join('\n'));
    if (applied.words !== words) {
      await linter.clearWords(); // the list replaces what was imported, so a removed word goes too
      if (msg.words.length > 0) await linter.importWords(msg.words);
      applied.words = words;
    }
  }

  async function run(msg: HarperLintMessage): Promise<HarperLintReply> {
    try {
      const { linter, base } = await start();
      await configure(linter, base, msg);
      const results: Record<string, SourcedIssue[]> = {};
      for (const { hash, text } of msg.paragraphs) {
        try {
          const issues = mapLints(text, await linter.organizedLints(text, { language: 'plaintext', dedup: true }));
          results[hash] = issues.filter((issue) => HARPER_SHOWN.has(harperRule(issue.ruleId)));
        } catch {
          results[hash] = [];
        }
      }
      return { ok: true, results };
    } catch {
      applied = {};
      return { ok: false };
    }
  }

  return {
    lint(msg: HarperLintMessage): Promise<HarperLintReply> {
      const next = queue.then(() => run(msg));
      queue = next;
      return next;
    },
  };
}

/**
 * The offscreen document's runtime listener. Every extension page receives every runtime message, and content
 * scripts' messages reach it too: it answers only messages addressed to it, from the service worker or another
 * extension page. Returns the answer, or undefined to leave the message to others.
 */
export function handleOffscreenMessage(
  message: unknown,
  sender: { url?: string },
  deps: { extensionOrigin: string; lint(msg: HarperLintMessage): Promise<HarperLintReply> },
): Promise<HarperLintReply> | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if ((message as { target?: unknown }).target !== HARPER_OFFSCREEN) return undefined;
  if (!isExtensionPage(sender.url, deps.extensionOrigin)) return undefined;
  return deps.lint(message as HarperLintMessage);
}

/**
 * The raw runtime listener around handleOffscreenMessage. It answers through sendResponse and keeps the channel
 * open only for its own messages. It never throws: a throw here would reach whichever context sent the message,
 * content scripts included.
 */
export function createOffscreenListener(deps: {
  extensionOrigin: string;
  lint(msg: HarperLintMessage): Promise<HarperLintReply>;
}): (message: unknown, sender: { url?: string }, sendResponse: (reply: HarperLintReply) => void) => boolean {
  return (message, sender, sendResponse) => {
    try {
      const reply = handleOffscreenMessage(message, sender, deps);
      if (!reply) return false;
      void reply.then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    } catch {
      return false;
    }
  };
}
