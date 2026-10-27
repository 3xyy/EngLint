/**
 * Word and phrase lists for the local generic-phrasing detectors (see detect.ts). All adapted material
 * for those detectors lives in this file.
 *
 * Sources (both fetched 2026-10-21, reworded and condensed, nothing copied):
 *  - blader/humanizer SKILL.md v3.1.0, MIT, Copyright (c) 2025 Siqi Chen. https://github.com/blader/humanizer
 *  - "Wikipedia:Signs of AI writing", Wikipedia contributors, CC BY-SA 4.0.
 *    https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
 *
 * Adapted material in this file is CC BY-SA 4.0. See public/NOTICE.txt.
 *
 * Purpose: writing quality only. These are patterns that make prose vague or padded, whoever wrote it.
 */

/**
 * Announcements that open a sentence. `fixable`: the rest of the sentence can stand without them. Without "that",
 * what follows "note" is its object ("note the deadline"), not a sentence.
 */
export const RUNUPS: readonly { lead: string; fixable: boolean }[] = [
  { lead: 'it is important to note that', fixable: true },
  { lead: "it's important to note that", fixable: true },
  { lead: 'it is important to note', fixable: false },
  { lead: "it's important to note", fixable: false },
  { lead: 'it is worth noting that', fixable: true },
  { lead: "it's worth noting that", fixable: true },
  { lead: 'it is worth mentioning that', fixable: true },
  { lead: 'it should be noted that', fixable: true },
  { lead: "in today's world,", fixable: true },
  { lead: "in today's fast-paced world,", fixable: true },
  { lead: "in today's digital age,", fixable: true },
  { lead: 'in this essay, i will', fixable: false },
  { lead: 'in this essay, we will', fixable: false },
  { lead: "let's dive into", fixable: false },
  { lead: "let's dive in", fixable: false },
];

/** Inflated claims of significance. */
export const INFLATED_PHRASES: readonly string[] = [
  'stands as a testament to',
  'stand as a testament to',
  'serves as a testament to',
  'serve as a testament to',
  'a testament to',
  'a pivotal moment',
  'stands as a symbol',
  'stand as a symbol',
];
/** "plays a ___ role" */
export const ROLE_ADJECTIVES: readonly string[] = ['vital', 'crucial', 'pivotal'];

/** Sales language about ordinary things; not flagged in Casual. */
export const SALES_WORDS: readonly string[] = [
  'game-changing',
  'game changing',
  'world-class',
  'seamless',
  'seamlessly',
  'cutting-edge',
  'unparalleled',
];

/** Fancy stand-ins for "is" and "has". */
export const SERVES_AS_VERBS: readonly string[] = ['serves', 'stands', 'serve', 'stand'];
/** Words that start a noun phrase. */
export const NOUN_PHRASE_STARTERS: readonly string[] = [
  'a', 'an', 'the', 'one', 'our', 'their', 'its', 'his', 'her', 'my', 'your',
  'this', 'that', 'these', 'those', 'another', 'both', 'each', 'every',
];
/** What may follow "boasts" when it means "has" (a number also counts). */
export const BOASTS_NEXT: readonly string[] = [
  ...NOUN_PHRASE_STARTERS, 'over', 'more', 'nearly', 'almost', 'some', 'several', 'many', 'numerous', 'two', 'three', 'four', 'five',
];

/** Words before "serve/stand as" that show an infinitive or a modal, so "are" would be wrong. */
export const NOT_A_SUBJECT: readonly string[] = [
  'to', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'do', 'did', 'does', 'not', "don't", "doesn't", 'and', 'or',
];
/** A person as the subject: someone who serves as treasurer is taking a role, not dressing up "is". */
export const PERSONAL_SUBJECTS: readonly string[] = ['i', 'we', 'you', 'he', 'she'];
/** Adverbs that can sit between a subject and "serve/stand", hiding the subject (an -ly word counts too). */
export const SERVES_AS_ADVERBS: readonly string[] = ['always', 'sometimes', 'often', 'never', 'usually', 'also', 'still', 'rarely', 'seldom', 'just'];
/** Words that make the verb after them plural. */
export const PLURAL_SUBJECTS: readonly string[] = ['they', 'we', 'you', 'these', 'those', 'people', 'children', 'men', 'women'];

/** Left behind by a chatbot answer. */
export const CHATBOT_PHRASES: readonly string[] = [
  'as an ai language model',
  'as of my last update',
  'as of my knowledge cutoff',
];
/** A compliment that opens a reply; only when it opens the paragraph and ends in punctuation. */
export const CHATBOT_COMPLIMENTS: readonly string[] = ['great question'];
/** A sign-off; only when it is the last thing in the paragraph. */
export const CHATBOT_CLOSERS: readonly string[] = ['i hope this helps'];
/** "Certainly! Here is ..." */
export const CHATBOT_OPENERS: readonly string[] = ['certainly'];
export const CHATBOT_HERE: readonly string[] = ['here is', "here's", 'here are'];
