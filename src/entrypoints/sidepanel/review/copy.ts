// Every line the Review tab shows: notices, status lines, headings, labels and button text.
import type { CitationStyle } from '../../../core/citations';
import type { ReaderChoice } from '../../../core/review';
import { MAX_CLAIM_CHARS, MAX_REVIEW_CHARS, MAX_RUBRIC_CHARS, TONE_MIN_WORDS } from '../../../core/review';
import { COST_UNKNOWN } from '../../../core/review-cost';
import type { Rating } from '../../../core/review-schema';
import type { DocNote } from '../../../core/schema';
import { APPLY_FAILED, APPLY_FAILED_COPIED, UNREACHABLE_FIELD } from '../../../shared/status-text';
import { CHAT_COPY } from '../Chat';

const READER_LABELS: Record<ReaderChoice, string> = {
  admissions: 'Admissions officer',
  teacher: 'Teacher',
  recruiter: 'Recruiter',
  general: 'General reader',
  custom: 'Custom…',
};
const RATING_LABELS: Record<Rating, string> = { strong: 'Strong', solid: 'Solid', needs_work: 'Needs work' };
const NOTE_LABELS: Record<DocNote['type'], string> = {
  tense_shift: 'Tense shift',
  overused_word: 'Overused word',
  ambiguous: 'Ambiguous',
  inconsistency: 'Inconsistency',
};
const STYLE_LABELS: Record<CitationStyle, string> = { mla: 'MLA', apa: 'APA', chicago: 'Chicago' };

export const REVIEW_COPY = {
  region: 'Review',
  noField: 'Click into a text box or document first.',
  cut: `Reviewing the first ${MAX_REVIEW_CHARS.toLocaleString('en-US')} characters.`,
  unreachable: UNREACHABLE_FIELD,
  shortText: 'Needs 30 words',
  toneWaiting: 'Tone appears after you pause for a few seconds.',
  toneShort: `Tone needs at least ${TONE_MIN_WORDS} words.`,
  toneFailed: 'Tone unavailable right now.',
  rubricCut: `Only the first ${MAX_RUBRIC_CHARS.toLocaleString('en-US')} characters of the rubric are used.`,
  passageChanged: 'That passage has changed since the review.',
  deepChanged: 'The text changed. Run Deep check again.',
  nothingToFlag: 'Nothing to flag.',
  selectClaim: 'Select a claim in your text, then search.',
  claimTooLong: `Select a shorter claim, up to ${MAX_CLAIM_CHARS} characters.`,
  reading: 'Reading…',
  grading: 'Grading…',
  checking: 'Checking…',
  searching: 'Searching…',
  searchOff: "Web search is turned off for this API key's organization. An admin can turn it on in the Claude Console.",
  refused: "Claude wouldn't search for this claim.",
  noSources: 'No sources found for that claim.',
  noExcerpt: 'No excerpt',
  nowhere: 'Nowhere in particular.',
  costUnknown: COST_UNKNOWN,
  tooBig: CHAT_COPY.tooBig,
  applyFailed: APPLY_FAILED,
  applyFailedCopied: APPLY_FAILED_COPIED,

  overview: {
    heading: 'Overview',
    words: 'Words',
    characters: 'Characters',
    sentences: 'Sentences',
    readingTime: 'Reading time',
    speakingTime: 'Speaking time',
    avgSentence: 'Avg. sentence',
    avgSentenceValue: (words: number) => `${words} words`,
    readability: 'Readability',
    readabilityValue: (score: number, label: string) => `${score} · ${label}`,
    percent: (pct: number) => `${pct}%`,
    uniqueWords: 'Unique words',
    longWords: 'Long words',
    tone: (tones: string[]) => `Tone: ${tones.join(', ')}`,
    openHeading: 'Open in this text',
    errors: 'Errors',
    clarity: 'Clarity',
    engagement: 'Engagement',
    delivery: 'Delivery',
  },
  readers: {
    heading: 'Reader reactions',
    reader: 'Reader',
    labels: READER_LABELS,
    describe: 'Describe the reader',
    describePlaceholder: 'Describe the reader (e.g. an expert in marine biology)',
    run: 'Get reactions',
    runWithCost: (cost: string) => `Get reactions · ${cost}`,
    firstImpression: 'First impression',
    remember: "What they'll remember",
    questions: "Questions they'd ask",
    lost: 'Where they got lost or bored',
    strength: 'One strength to keep',
  },
  grader: {
    heading: 'Grader',
    rubric: 'Prompt or rubric',
    rubricPlaceholder: 'Paste the prompt or rubric',
    run: 'Grade against it',
    runWithCost: (cost: string) => `Grade against it · ${cost}`,
    ratings: RATING_LABELS,
    raise: 'To raise it:',
    grade: (grade: string) => `Grade (from your rubric): ${grade}`,
  },
  deep: {
    heading: 'Deep check',
    run: 'Check the whole text',
    runWithCost: (cost: string) => `Check the whole text · ${cost}`,
    issues: (n: number) => `Issues (${n})`,
    apply: 'Apply',
    applied: 'Applied',
    applyLabel: (n: number) => `Apply fix ${n}`,
    appliedLabel: (n: number) => `Fix ${n} applied`,
    goTo: 'Go to',
    goToLabel: (n: number) => `Go to issue ${n}`,
    notesHeading: 'About the whole text',
    notes: NOTE_LABELS,
    used: (n: number) => ` · used ${n} ${n === 1 ? 'time' : 'times'}`,
  },
  citations: {
    heading: 'Citation finder',
    style: 'Citation style',
    styles: STYLE_LABELS,
    run: 'Find sources',
    runWithCost: (cost: string) => `Find sources · ${cost}`,
    sourcesFor: 'Sources for ',
    copy: 'Copy citation',
    copyLabel: (n: number) => `Copy citation ${n}`,
  },
} as const;
