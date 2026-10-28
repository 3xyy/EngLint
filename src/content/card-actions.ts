// The card's setting action, in its "⋯" menu: "Stop suggesting {label}" writes a rule for the mode, "Add “{word}”
// to dictionary" a word. Each write comes with an undo that removes exactly what it wrote. FieldHost re-filters
// every field when either list changes, so the underlines go (and come back on Undo) with no new request.
import { kindInfo } from '../core/kinds';
import type { LocatedIssue, Mode } from '../core/types';
import { dictionaryForm } from '../core/typography';
import { addDictionaryWord, declinedItem, dictionaryItem, dismissCountsItem, rulesItem } from '../shared/settings';

export interface CardAction {
  /** The button's words. */
  label: string;
  /** Writes the setting; resolves to the undo chip's words and an undo of exactly this write. */
  apply(): Promise<{ text: string; undo(): Promise<void> }>;
}

/** The word as written, without surrounding spaces and edge punctuation; '' when nothing is left. */
const bareWord = (original: string) => original.trim().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');

/**
 * The setting action the card's menu offers, if any:
 * - "Stop suggesting {label}" for a rule-eligible kind (style suggestions and style-preference errors such as
 *   the Oxford comma), in Essay and Standard. Casual has no rules: it shows no suggestions.
 * - "Add “{word}” to dictionary" for a spelling error on one word, in any mode.
 */
export function cardAction(issue: Pick<LocatedIssue, 'original' | 'severity' | 'category' | 'kind'>, mode: Mode): CardAction | null {
  const info = kindInfo(issue.kind);
  if (info?.ruleEligible && mode !== 'casual') return stopSuggesting(mode, info.kind, info.label);
  const word = bareWord(issue.original);
  if (issue.severity === 'error' && issue.category === 'spelling' && word !== '' && !/\s/u.test(word)) return addToDictionary(word);
  return null;
}

function stopSuggesting(mode: Mode, kind: string, label: string): CardAction {
  const isThis = (r: { mode: Mode; kind: string }) => r.mode === mode && r.kind === kind;
  return {
    label: `Stop suggesting ${label}`,
    async apply() {
      const rules = await rulesItem.getValue();
      const added = !rules.some(isThis);
      if (added) await rulesItem.setValue([...rules, { mode, kind }]);
      return {
        text: `Stopped suggesting ${label}.`,
        async undo() {
          if (!added) return; // it was there before: not this action's to remove
          const now = await rulesItem.getValue();
          const at = now.findIndex(isThis);
          if (at !== -1) await rulesItem.setValue(now.filter((_, i) => i !== at));
        },
      };
    },
  };
}

function addToDictionary(word: string): CardAction {
  const entry = dictionaryForm(word);
  return {
    label: `Add “${word}” to dictionary`,
    async apply() {
      const added = !(await dictionaryItem.getValue()).includes(entry);
      if (added) await addDictionaryWord(word);
      return {
        text: `Added “${word}” to your dictionary.`,
        async undo() {
          if (!added) return;
          const now = await dictionaryItem.getValue();
          if (now.includes(entry)) await dictionaryItem.setValue(now.filter((w) => w !== entry));
        },
      };
    },
  };
}

/** The dismissals of one rule-eligible kind in one mode after which the writer is asked about stopping it. */
const DISMISSALS_BEFORE_OFFER = 3;

/** What follows a dismissal: a question with a yes button and "Not now". */
export interface Offer {
  question: string;
  /** The yes button's words. */
  yes: string;
  /** Yes: the write, as a card action does it (the undo chip's words and an undo of exactly that write). */
  accept(): Promise<{ text: string; undo(): Promise<void> }>;
  /** "Not now": a stop offer is remembered and never made again for the pair; a dictionary offer is not. */
  decline(): Promise<void>;
}

// The dismissal counts change by read, change and write, one change at a time, so dismissals close together all count.
let countsQueue: Promise<unknown> = Promise.resolve();
function changeCounts(change: (counts: Record<string, number>) => Record<string, number>): Promise<Record<string, number>> {
  const run = countsQueue.then(async () => {
    const next = change(await dismissCountsItem.getValue());
    await dismissCountsItem.setValue(next);
    return next;
  });
  countsQueue = run.catch(() => {}); // a failed write must not stop the next one
  return run;
}

/** Only whitespace and opening punctuation between the start of the text (or of a line) or a sentence's end and the word. */
function startsSentence(before: string): boolean {
  const gap = /[\s"'“”‘’([{«»]*$/u.exec(before)![0];
  const rest = before.slice(0, before.length - gap.length);
  return rest === '' || gap.includes('\n') || /[.!?]$/u.test(rest);
}

/**
 * Counts a dismissal and decides what to ask next, at most one question:
 * - the third dismissal of a rule-eligible kind in Essay or Standard, when it has no rule and the writer hasn't
 *   said "Not now" for it: "Stop suggesting {label} in essays?"
 * - otherwise a dismissed spelling error on one capitalized word that doesn't start its sentence (a name,
 *   probably): "Add “{word}” to your dictionary?"
 * `before` is the field's text up to the issue, or null when the field no longer holds the issue there (then where
 * the word sits is unknown, and there is no dictionary offer).
 */
export async function offerAfterDismiss(
  issue: Pick<LocatedIssue, 'original' | 'severity' | 'category' | 'kind'>,
  mode: Mode,
  before: string | null,
): Promise<Offer | null> {
  const info = kindInfo(issue.kind);
  if (info?.ruleEligible && mode !== 'casual') {
    const pair = `${mode}:${info.kind}`;
    if ((await rulesItem.getValue()).some((r) => r.mode === mode && r.kind === info.kind)) return null;
    const count = (await changeCounts((counts) => ({ ...counts, [pair]: (counts[pair] ?? 0) + 1 })))[pair]!;
    if (count < DISMISSALS_BEFORE_OFFER || (await declinedItem.getValue()).includes(pair)) return null;
    const stop = stopSuggesting(mode, info.kind, info.label);
    return {
      question: `Stop suggesting ${info.label} in ${mode === 'essay' ? 'essays' : 'other writing'}?`,
      yes: 'Stop',
      async accept() {
        const done = await stop.apply();
        try {
          await changeCounts((counts) => {
            const rest = { ...counts };
            delete rest[pair];
            return rest;
          });
        } catch {
          // the rule is written: its undo chip still shows, and the count is moot while the rule stands
        }
        return done;
      },
      async decline() {
        const declined = await declinedItem.getValue();
        if (!declined.includes(pair)) await declinedItem.setValue([...declined, pair]);
      },
    };
  }
  const word = bareWord(issue.original);
  if (issue.severity !== 'error' || issue.category !== 'spelling' || word === '' || /\s/u.test(word)) return null;
  if (before === null || !/^\p{Lu}/u.test(word) || startsSentence(before)) return null;
  if ((await dictionaryItem.getValue()).includes(dictionaryForm(word))) return null;
  const add = addToDictionary(word);
  return { question: `Add “${word}” to your dictionary?`, yes: 'Add', accept: add.apply, decline: async () => {} };
}
