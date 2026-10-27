import { defineExtensionMessaging } from '@webext-core/messaging';
import type { ChatFocus } from '../core/chat-format';
import type { Source } from '../core/citations';
import type { UsageLike } from '../core/cost';
import type { KeySlot } from '../core/provider';
import type { RewriteToolRequest, ToolRequest } from '../core/presets';
import type { Grading, ReaderReaction } from '../core/review-schema';
import type { ReaderChoice } from '../core/review';
import type { DocNote } from '../core/schema';
import type { SourcedIssue } from '../core/sources';
import type { CheckStatus, Dialect, LocatedIssue, Mode, RawIssue } from '../core/types';

export interface CheckRequest {
  host: string;
  mode: Mode;
  paragraphs: { hash: string; text: string }[];
}
export interface CheckResponse {
  status: CheckStatus;
  /** Keyed by paragraph hash. */
  results: Record<string, RawIssue[]>;
  /** Dismissal keys (see dismissalKey) for the requested paragraphs. */
  dismissed: string[];
}
/** The local Harper checker: same request shape as `check`. */
export type HarperCheckRequest = CheckRequest;
export interface HarperCheckResponse {
  /** Never an error status: Harper is best-effort, and a failure only means no issues. */
  status: 'ok' | 'off_site';
  /** Keyed by paragraph hash; a paragraph Harper didn't answer for is missing. */
  results: Record<string, SourcedIssue[]>;
  /** Dismissal keys (see dismissalKey) for the requested paragraphs, so a dismissed issue never shows first. */
  dismissed: string[];
}

/** Addresses a raw runtime message to the offscreen document, which every extension page also receives. */
export const HARPER_OFFSCREEN = 'harper-offscreen';
/** background -> the offscreen document (a raw runtime message, not through the ProtocolMap below). */
export interface HarperLintMessage {
  target: typeof HARPER_OFFSCREEN;
  mode: Mode;
  dialect: Dialect;
  /** The writer's dictionary. */
  words: string[];
  paragraphs: { hash: string; text: string }[];
}
/** `ok: false`: the checker couldn't start in the document. */
export type HarperLintReply = { ok: true; results: Record<string, SourcedIssue[]> } | { ok: false };

export interface RewriteRequest {
  host: string;
  mode: Mode;
  request: RewriteToolRequest;
  text: string;
  before: string;
  after: string;
  stage: 'critique' | 'variants';
  /** Sound like me's variants stage only: the writer's other paragraphs in the field, at most 1,500 characters (core/context.ts). */
  voiceSample?: string;
}
export interface RewriteResponse {
  status: CheckStatus;
  critique?: { weakness: string; lightFix: string };
  /** Exactly 3 when present; exactly 1 for Sound like me (the selection itself, trimmed, when it found no tells). */
  variants?: string[];
  /** Sound like me: the generic patterns found (0 to 5, each at most 80 characters). */
  tells?: string[];
}
/** A question about a tools result, continuing the popover's conversation (core/follow-up.ts has its limits). */
export interface FollowUpRequest {
  host: string;
  mode: Mode;
  /** The request the shown results answered. */
  request: RewriteToolRequest | { kind: 'synonyms' };
  text: string;
  before: string;
  after: string;
  /** What the popover showed for that request (versions, a critique, synonyms), as text. */
  shown: string;
  /** Earlier follow-ups in this popover, oldest first: the question, and the answer as it was shown. */
  history: { q: string; a: string }[];
  question: string;
}
export interface FollowUpResponse {
  status: CheckStatus;
  message?: string;
  /** Up to 3 when present (1 in Essay); empty when the answer is the message alone. */
  variants?: string[];
}
/** From the options page only: the writer's pasted pieces (core/style-profile.ts has the limits). */
export interface StyleProfileRequest {
  samples: string;
}
export interface StyleProfileResponse {
  status: CheckStatus;
  /** At most 1,200 characters; not stored (the options page saves it when the writer does). */
  profile?: string;
}
export interface SynonymsRequest {
  host: string;
  mode: Mode;
  target: string;
  sentence: string;
  /** The offset of `target` in `sentence`. */
  targetStart: number;
}
export interface SynonymsResponse {
  status: CheckStatus;
  /** 1 to 8 when present (the prompt asks for 6 to 8; the parser keeps any from 1). */
  options?: { text: string; nuance: string }[];
}
/**
 * How the right-click menu or the shortcut opens the tools popover: with a request it sends at once, or
 * 'custom-prompt' ("Custom instruction…": the menu, with the custom input focused).
 */
export type OpenToolsRequest = ToolRequest | 'custom-prompt';
export interface IssuesUpdate {
  fieldId: string;
  host: string;
  mode: Mode;
  status: CheckStatus;
  focused: boolean;
  issues: LocatedIssue[];
  /** The field's final update: it left the page (or the site was switched off). */
  removed?: boolean;
}

/** The common part of every review request: the tab, the text to read (at most MAX_REVIEW_CHARS) and the page's mode. */
export interface ReviewBase {
  tabId: number;
  text: string;
  mode: Mode;
}

export interface ToneResponse {
  status: CheckStatus;
  tones?: string[];
}

export interface ReadersRequest extends ReviewBase {
  reader: ReaderChoice;
  /** Who the reader is, when `reader` is 'custom' (at most MAX_READER_CHARS). */
  custom?: string;
}
export interface ReadersResponse {
  status: CheckStatus;
  reaction?: ReaderReaction;
}
export interface GradeRequest extends ReviewBase {
  /** The prompt or rubric the text is graded against (at most MAX_RUBRIC_CHARS). */
  rubric: string;
}
export interface GradeResponse {
  status: CheckStatus;
  grading?: Grading;
}

export interface DeepCheckResponse {
  status: CheckStatus;
  /** Offsets index into the text that was sent. */
  issues?: LocatedIssue[];
  notes?: DocNote[];
}

/** A claim the writer selected (MIN_CLAIM_CHARS to MAX_CLAIM_CHARS), with up to MAX_CLAIM_CONTEXT_CHARS of text on each side. */
export interface CitationsRequest {
  tabId: number;
  claim: string;
  before: string;
  after: string;
}
export interface CitationsResponse {
  status: CheckStatus;
  /** Only pages the web search returned, at most 4. */
  sources?: Source[];
  /** The API refused web search for this key's organization (an admin turns it on in the Claude Console). */
  searchOff?: boolean;
  /** Claude declined to search for this claim (the answer was still billed). */
  refused?: boolean;
}

/** The model ids an endpoint lists, or why it couldn't be asked. */
export type ListModelsResponse = { ok: true; models: string[] } | { ok: false; status: CheckStatus };

/** A test call to the active provider: what it used and which model answered (`modelNotFound`: that model is unknown there). */
export interface TestKeyResponse {
  ok: boolean;
  status: CheckStatus;
  usage?: UsageLike;
  model?: string;
  modelNotFound?: boolean;
}

export type ApplyEditResult = 'applied' | 'changed' | 'ambiguous' | 'blocked' | 'too_big' | 'failed';

export interface ProtocolMap {
  // content/popup/panel/options -> background
  check(req: CheckRequest): CheckResponse;
  /** From a content script or an extension page: the paragraphs checked by the local Harper checker. */
  harperCheck(req: HarperCheckRequest): HarperCheckResponse;
  dismiss(key: string): void;
  rewrite(req: RewriteRequest): RewriteResponse;
  synonyms(req: SynonymsRequest): SynonymsResponse;
  followUp(req: FollowUpRequest): FollowUpResponse;
  /** From the options page only (the sender is checked): a style profile described from pieces the writer pasted. */
  buildStyleProfile(req: StyleProfileRequest): StyleProfileResponse;
  /** From the side panel only (the sender is checked): the tone of the followed field's text. */
  reviewTone(req: ReviewBase): ToneResponse;
  /** From the side panel only: how one reader reacts to the followed field's text. */
  reviewReaders(req: ReadersRequest): ReadersResponse;
  /** From the side panel only: the text graded against a rubric the writer pasted. */
  reviewGrade(req: GradeRequest): GradeResponse;
  /** From the side panel only: a whole-text check, in the live-check format, plus notes about the whole text. */
  deepCheck(req: ReviewBase): DeepCheckResponse;
  /** From the side panel only: sources for a selected claim, found with web search. */
  findCitations(req: CitationsRequest): CitationsResponse;
  /**
   * From a tab's top frame, before anything it reports: the tab's old page is gone. Sent as its content script starts
   * on a document (a navigation or a reload; a prerendered page once it is shown) and again when a back/forward
   * restore shows it from the bfcache. Tab and frame from sender. One script sends it per document: the generic
   * script, or on Docs the Docs script (content/page-announce.ts).
   */
  pageStarted(): void;
  issuesUpdated(u: IssuesUpdate): void; // tab id from sender
  /**
   * Whether the sender frame has a focused field EngLint edits (tab and frame from sender): the shortcut's
   * map (background/menus.ts). Sent on each change, and again while a selection sits in the field.
   */
  fieldFocused(p: { focused: boolean }): void;
  setSiteMode(p: { host: string; mode: Mode }): void;
  /** From the popup, with its tab: that tab's badge says "off" at once (even with no content script running). */
  setSiteEnabled(p: { host: string; enabled: boolean; tabId?: number }): void;
  /** From a tab's top frame, on load and on each switch: whether its site is switched off (the "off" badge). */
  siteOff(p: { off: boolean }): void;
  /**
   * From a content script, on a user click: opens the side panel on the sender's tab. `opened` is false when Chrome
   * refuses (no user gesture reaches the background, or there is no tab).
   */
  openPanel(): { opened: boolean };
  /** `slot` defaults to the active provider's. */
  keyStatus(p?: { slot?: KeySlot }): { saved: boolean; last4: string | null };
  /** options -> background only (refused from content scripts): the key goes to the background's own store. */
  /** `baseURL`: the address a Custom key is for (required for it, ignored otherwise). */
  setApiKey(p: { slot: KeySlot; key: string; baseURL?: string }): void;
  clearApiKey(p: { slot: KeySlot }): void;
  /** The sender tab's top-level host (from `sender.tab.url`), or null: how a frame learns which site it is in. */
  topHost(): string | null;
  /** From an extension page only (the sender is checked): a live check of one sentence on the active provider, billed. */
  testKey(): TestKeyResponse;
  /**
   * From the options page only (the sender is checked): the models the endpoint lists (GET {baseURL}/models), asked
   * with the slot's saved key. A fixed preset is asked at its own address: `baseURL` counts only for a custom endpoint.
   */
  /** `key`: one typed on the Options page and not stored yet. */
  listModels(p: { slot: KeySlot; baseURL: string; key?: string }): ListModelsResponse;
  // panel/popup -> content script (sent with tabId)
  applyFix(p: { fieldId: string; issueId: string }): { ok: boolean };
  /** A comment-only note's "Rewrite this sentence": opens the tools popover on its sentence (Rewrite). */
  rewriteSentence(p: { fieldId: string; issueId: string }): { opened: boolean };
  dismissIssue(p: { fieldId: string; issueId: string }): void;
  acceptAllErrors(p: { fieldId: string }): { applied: number; failed: number };
  jumpTo(p: { fieldId: string; issueId: string }): void;
  recheckAll(): void;
  /**
   * The side panel's Chat, before each message: the field's whole text, its selection (or the caret as an empty
   * range; null with neither) and the page's mode. `ok: false` when the field is gone or can't be read.
   */
  fieldText(p: { fieldId: string }): { ok: boolean; text?: string; focus?: ChatFocus; mode?: Mode };
  /**
   * A chat edit's Apply: the content script checks it again on the text now (core/chat-format.ts canApply) and
   * replaces through the adapter, which reads it back. `changed`: the original is gone; `ambiguous`, `blocked` (a
   * claim) and `too_big` (Essay's added-words rule) write nothing; `failed`: the field couldn't be read, or the
   * adapter couldn't confirm the write.
   */
  applyEdit(p: { fieldId: string; original: string; replacement: string }): { result: ApplyEditResult };
  /**
   * Selects the first place `quote` is in the field's text (typography folded), scrolls it into view and
   * flashes it; `found: false` when the quote isn't there, or the field is gone or can't be read.
   */
  revealText(p: { fieldId: string; quote: string }): { found: boolean };
  // background -> one frame of a tab (the right-click menu, the shortcut)
  /**
   * To a tab's top frame, once a load completes (sent with background/tab-pages.ts askTopFrame): answered by the
   * script that sent the page's `pageStarted`. No answer (the send rejects) means no EngLint script runs on the page.
   */
  pagePresent(): boolean;
  /** Opens the tools popover on the frame's focused field selection; `opened: false` when it has none. */
  openTools(p: { request?: OpenToolsRequest }): { opened: boolean };
  /** The top frame's selected text ('' when none), for the side panel's Tools. */
  pageSelection(): { text: string };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();

export function dismissalKey(paragraphHash: string, original: string, kind: string): string {
  return `${paragraphHash}|${original}|${kind}`;
}
