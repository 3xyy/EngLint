import type Anthropic from '@anthropic-ai/sdk';
import { splitParagraphs } from '../../core/paragraphs';
import type { Dialect, Mode } from '../../core/types';
import { buildLiveCheckSystem, buildLiveCheckUser, type Learned } from './live-check';

export const DEEP_CHECK_PROMPT_VERSION = 'dc-1';

const DEEP_BLOCK = `## Deep check (${DEEP_CHECK_PROMPT_VERSION})

This time you are reading a whole document, one paragraph per entry, and you may look across paragraphs. Report issues exactly as above (keyed by paragraph_id, with the same rules for original, before, replacement, category, severity and kind), including problems that only show against the rest of the text, such as a verb tense that slips or a word the writer keeps leaning on.

After the results, add "notes": up to 8 observations about the text as a whole. Each note has:
- type: one of
  - tense_shift: the text changes tense without a reason;
  - overused_word: a word or phrase leaned on across the document (set count to the number of times it appears);
  - ambiguous: a passage that could be read two ways, or a reference that is unclear across paragraphs;
  - inconsistency: two places that disagree (spelling, a name, a number, a fact, a style);
- text: one or two plain sentences to the writer, at most 300 characters;
- quotes: 0 to 3 passages copied exactly from the document (at most 200 characters each, no changes to their words), so the writer can find them;
- count: an integer for overused_word, otherwise null.

Notes point and explain; they never rewrite the writer's sentences. A document with nothing worth noting gets an empty notes array. Leave a note out unless you are sure of it.`;

export function buildDeepCheckSystem(mode: Mode, dialect: Dialect, learned?: Learned): Anthropic.TextBlockParam[] {
  return [...buildLiveCheckSystem(mode, dialect, learned), { type: 'text', text: DEEP_BLOCK }];
}

/** The same user turn as a live check: the document's paragraphs, with `<` escaped. */
export function buildDeepCheckUser(text: string): string {
  return buildLiveCheckUser(splitParagraphs(text));
}
