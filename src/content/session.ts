import { selectIssues, type SuggestionPolicy } from '../core/match';
import { mergeParagraph } from '../core/merge';
import { splitParagraphs } from '../core/paragraphs';
import { detectTells } from '../core/tells/detect';
import type { ParagraphRaw, SourceId, SourcedIssue } from '../core/sources';
import type { CheckStatus, LocatedIssue, Mode, RawIssue } from '../core/types';
import {
  dismissalKey,
  type CheckRequest,
  type CheckResponse,
  type HarperCheckRequest,
  type HarperCheckResponse,
} from '../shared/messages';
import type { EditorAdapter } from './adapters/types';

export interface SessionDeps {
  host: string;
  getMode(): Mode;
  /** The writer's suggestion settings for `mode`: family toggles, rules and dictionary (read on every selection). */
  policy(mode: Mode): SuggestionPolicy;
  send(req: CheckRequest): Promise<CheckResponse>;
  /** The local Harper checker (best effort: its answers never change busy() or the status). Absent: not asked. */
  sendHarper?(req: HarperCheckRequest): Promise<HarperCheckResponse>;
  /** "Instant local checks": false means Harper is not asked and its held issues are not shown. Absent: on. */
  localChecks?(): boolean;
  persistDismissal(key: string): Promise<void>;
  onUpdate(issues: LocatedIssue[], status: CheckStatus): void;
  /** A check request was sent (true) or answered (false): busy() changed. The issues didn't, so no onUpdate. */
  onBusyChange?(busy: boolean): void;
  debounceMs?: number; // default 1000
}

/** Answers that may clear up by themselves: the session re-checks once, BUSY_RETRY_MS later. */
const BUSY = new Set<CheckStatus>(['rate_limited', 'overloaded', 'offline']);
/** Just past the background's 30 s pause after a 429/5xx, so the re-check reaches the API. */
export const BUSY_RETRY_MS = 32_000;

/** Harper is asked this long after the last input: its answers come in milliseconds, so it keeps up with typing. */
export const HARPER_DEBOUNCE_MS = 150;
/** One Harper request asks about at most this many paragraphs, or characters (a longer paragraph goes alone). */
export const HARPER_MAX_PARAGRAPHS = 60;
export const HARPER_MAX_CHARS = 30_000;

/** Paragraphs whose tells are kept; the oldest go first. */
export const TELL_CACHE_MAX = 500;

const sameRaw = (a: RawIssue, b: RawIssue) =>
  a.original === b.original &&
  a.replacement === b.replacement &&
  a.before === b.before &&
  a.kind === b.kind &&
  a.severity === b.severity &&
  a.category === b.category &&
  a.reason === b.reason;

/**
 * A located issue may carry the document's text and a curled or dropped fix (see selectIssues), so
 * the session finds its raw entry, and keys its dismissal, by the model's own text.
 */
const asRaw = (i: LocatedIssue): RawIssue => ({ ...i, ...i.model });
/** What a render and a card show of an issue: two lists with the same keys draw the same underlines. */
const shownKey = (i: LocatedIssue): string => `${i.id}|${i.start}|${i.end}|${i.severity}|${i.replacement}`;
const sameShown = (a: LocatedIssue[], b: LocatedIssue[]): boolean =>
  a.length === b.length && a.every((i, n) => shownKey(i) === shownKey(b[n]!));
const dismissalKeyOf = (i: LocatedIssue): string => dismissalKey(i.paragraphHash, i.model.original, i.kind);

/** The source a located issue came from: a local one carries `source` (see SourcedIssue), Claude's carry none. */
const sourceOf = (i: LocatedIssue): SourceId => (i as LocatedIssue & Partial<Pick<SourcedIssue, 'source'>>).source ?? 'claude';

export class FieldSession {
  private raw = new Map<string, ParagraphRaw>(); // paragraph hash -> raw issues held, per source
  private tellCache = new Map<string, SourcedIssue[]>(); // `${mode}:${hash}` -> tells, oldest first
  private dismissed = new Set<string>();
  private current: LocatedIssue[] = [];
  private lastStatus: CheckStatus = 'ok';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retrying = false; // the check about to run is the scheduled re-check
  private running: Promise<void> | null = null;
  private sending = false; // a check request is in flight
  private answered = false; // a check has run to its end
  private dirty = false; // input arrived while a request was in flight
  private harperTimer: ReturnType<typeof setTimeout> | null = null;
  private harperRunning: Promise<void> | null = null;
  private harperDirty = false; // input arrived while a Harper request was in flight
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private refreshSeq = 0;
  private emitOwed = false; // a refresh that had to emit was superseded: the next one to finish emits
  private textSeq = 0; // counts inputs and this session's own edits
  private lastRead: { seq: number; text: string } | null = null; // see readText()

  constructor(
    private readonly adapter: EditorAdapter,
    private readonly deps: SessionDeps,
  ) {}

  start(): void {
    if (this.disposed || this.unsubscribe) return;
    this.unsubscribe = this.adapter.onChange(() => this.onInput());
    this.schedule();
    this.scheduleHarper();
  }

  issues(): LocatedIssue[] {
    return this.current;
  }

  status(): CheckStatus {
    return this.lastStatus;
  }

  /** True while a check request is in flight (not while the session waits out its debounce). */
  busy(): boolean {
    return this.sending;
  }

  /**
   * True once a check has run to its end: answered, failed, or with nothing to send (an empty field). Until
   * then no issues means nothing is known yet, not that the text is clean.
   */
  checked(): boolean {
    return this.answered;
  }

  checkNow(): Promise<void> {
    this.clearTimer();
    this.clearRetry(); // any new check replaces a pending re-check
    const isRetry = this.retrying;
    this.retrying = false;
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.dirty = true; // the flight may be reading older text; follow up
      return this.running;
    }
    this.running = this.run(isRetry).finally(() => {
      this.running = null;
      if (this.dirty && !this.disposed) {
        this.dirty = false;
        this.schedule();
      }
    });
    return this.running;
  }

  async accept(issueId: string): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const issue = await this.relocate(issueId);
      if (!issue || issue.replacement === null) return false;
      const replaced = await this.adapter.replace(issue.start, issue.end, issue.replacement);
      this.textChanged();
      if (!replaced) return false;
      await this.reanchor([issue]);
      await this.refresh();
      this.scheduleHarper(); // the editor may not report the session's own edit
      return true;
    } catch {
      return false;
    }
  }

  async dismiss(issueId: string): Promise<void> {
    const issue = this.current.find((i) => i.id === issueId);
    if (!issue) return;
    const key = dismissalKeyOf(issue);
    this.dismissed.add(key);
    this.current = this.current.filter((i) => i.id !== issueId && !this.isDismissed(i));
    this.emit();
    try {
      await this.deps.persistDismissal(key);
    } catch {
      // local dismissal stands; persistence is best effort
    }
  }

  async acceptAllErrors(): Promise<{ applied: number; failed: number }> {
    let applied = 0;
    let failed = 0;
    if (this.disposed) return { applied, failed };
    try {
      const errors = (await this.freshLocate())
        .filter((i) => i.severity === 'error' && i.replacement !== null)
        .sort((a, b) => b.start - a.start);
      const done: LocatedIssue[] = [];
      for (const issue of errors) {
        // Descending order keeps the offsets of earlier issues valid.
        // A keystroke since the read would shift offsets: only replace if the span still matches.
        const stillThere = (await this.adapter.getText()).slice(issue.start, issue.end) === issue.original;
        const replaced = stillThere && (await this.adapter.replace(issue.start, issue.end, issue.replacement as string));
        if (stillThere) this.textChanged();
        if (replaced) {
          applied++;
          done.push(issue);
        } else {
          failed++;
        }
      }
      if (done.length > 0) await this.reanchor(done);
      await this.refresh();
      if (done.length > 0) this.scheduleHarper();
    } catch {
      // keep counts so far
    }
    return { applied, failed };
  }

  /**
   * Selects again from the results already held, under the current policy (a setting changed), and emits.
   * No request to Claude: the background is asked for every family, so the held results already have them.
   * Harper is asked about any paragraph it hasn't answered (local checks may have just been turned on).
   */
  refilter(): void {
    if (this.disposed) return;
    this.relocateQuietly();
    this.scheduleHarper();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.clearRetry();
    this.clearHarperTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.adapter.dispose();
  }

  // ---- internals ----

  private onInput(): void {
    if (this.disposed) return;
    this.textChanged();
    this.relocateQuietly(); // keep offsets valid until the next response
    if (this.running) this.dirty = true;
    else this.schedule();
    this.scheduleHarper();
  }

  /** The text may differ from the last read: an input, or an edit this session made. */
  private textChanged(): void {
    this.textSeq++;
  }

  /**
   * The field's text. When the adapter reports every change, a read stands until the next input or edit, so the
   * Harper tick and the re-locates share the read a keystroke made (in Google Docs each read is a round trip to
   * the page). `fresh` (Claude's run) always reads, so Claude is never sent text from before a keystroke the
   * editor hasn't reported yet; the re-locate after its answer then shares that read. Any other adapter is read
   * every time: a script can set a textarea's value with no input event.
   */
  private async readText(fresh = false): Promise<string> {
    const reuse = this.adapter.reportsEveryChange === true;
    if (reuse && !fresh && this.lastRead?.seq === this.textSeq) return this.lastRead.text;
    const seq = this.textSeq;
    const text = await this.adapter.getText();
    if (reuse && seq === this.textSeq) this.lastRead = { seq, text }; // a read that input overtook is not kept
    return text;
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.checkNow();
    }, this.deps.debounceMs ?? 1000);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Harper is asked when the field can reach it and the writer left "Instant local checks" on. */
  private localChecksOn(): boolean {
    return this.deps.sendHarper !== undefined && this.deps.localChecks?.() !== false;
  }

  private scheduleHarper(): void {
    if (this.disposed || !this.localChecksOn()) return;
    this.clearHarperTimer();
    this.harperTimer = setTimeout(() => {
      this.harperTimer = null;
      this.checkHarper();
    }, HARPER_DEBOUNCE_MS);
  }

  private clearHarperTimer(): void {
    if (this.harperTimer !== null) clearTimeout(this.harperTimer);
    this.harperTimer = null;
  }

  /** One Harper request at a time; input during one asks again once it is answered. */
  private checkHarper(): void {
    if (this.disposed) return;
    if (this.harperRunning) {
      this.harperDirty = true;
      return;
    }
    this.harperRunning = this.runHarper().finally(() => {
      this.harperRunning = null;
      if (this.harperDirty && !this.disposed) {
        this.harperDirty = false;
        this.scheduleHarper();
      }
    });
  }

  /**
   * Asks Harper about the paragraphs it hasn't answered. Quiet and best effort: never busy, never a status, and a
   * failure changes nothing. An answer is kept under the hash of the text that was checked (its offsets are
   * relative to it), so an answer for a paragraph that changed meanwhile never lands on the new text. A paragraph
   * left out of the answer (a timeout) or an off_site answer keeps nothing, so a later tick asks again.
   */
  private async runHarper(): Promise<void> {
    const send = this.deps.sendHarper;
    if (!send || !this.localChecksOn() || !this.adapter.isAlive()) return;
    try {
      const toSend = new Map<string, string>();
      let chars = 0;
      let more = false; // paragraphs past the request's bounds, for the next tick
      for (const p of splitParagraphs(await this.readText())) {
        if (this.raw.get(p.hash)?.harper !== undefined || toSend.has(p.hash)) continue;
        if (toSend.size >= HARPER_MAX_PARAGRAPHS || (toSend.size > 0 && chars + p.text.length > HARPER_MAX_CHARS)) {
          more = true;
          break;
        }
        toSend.set(p.hash, p.text);
        chars += p.text.length;
      }
      if (toSend.size === 0) return;
      const resp = await send({
        host: this.deps.host,
        mode: this.deps.getMode(),
        paragraphs: [...toSend].map(([hash, text]) => ({ hash, text })),
      });
      if (this.disposed || resp.status !== 'ok') return;
      let newDismissal = false; // a key not held yet may hide an issue already shown (a tell, a Claude issue)
      for (const key of resp.dismissed ?? []) {
        if (this.dismissed.has(key)) continue;
        this.dismissed.add(key);
        newDismissal = true;
      }
      let found = false;
      let answered = false;
      for (const hash of toSend.keys()) {
        const list = resp.results[hash];
        if (!list) continue;
        this.raw.set(hash, { ...this.raw.get(hash), harper: list });
        answered = true;
        found ||= list.length > 0;
      }
      // An answer that covered nothing (Harper backing off, a timeout) leaves the rest for the next input.
      if (more && answered) this.harperDirty = true;
      // An update re-measures every underline (in Docs, more text reads): only when the answer may change one.
      if (found || newDismissal) await this.refresh('changed');
    } catch {
      // Harper adds nothing this time; Claude's issues and the status stand
    }
  }

  /** "Retrying shortly" is true: one re-check after a busy or offline answer, never a second in a row. */
  private retryIfBusy(status: CheckStatus, isRetry: boolean): void {
    if (this.disposed || isRetry || !BUSY.has(status)) return;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retrying = true;
      void this.checkNow();
    }, BUSY_RETRY_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private isDismissed(i: LocatedIssue): boolean {
    return this.dismissed.has(dismissalKeyOf(i));
  }

  private emit(): void {
    try {
      this.deps.onUpdate(this.current, this.lastStatus);
    } catch {
      // a throwing listener must not change session state or escape a timer
    }
  }

  private setSending(sending: boolean): void {
    if (this.sending === sending) return;
    this.sending = sending;
    try {
      this.deps.onBusyChange?.(sending);
    } catch {
      // as emit(): a throwing listener changes nothing here
    }
  }

  private relocateQuietly(): void {
    this.refresh().catch(() => {});
  }

  private async run(isRetry: boolean): Promise<void> {
    if (!this.adapter.isAlive()) return;
    try {
      const paragraphs = splitParagraphs(await this.readText(true));
      const toSend = new Map<string, string>();
      // A paragraph with no Claude entry is sent, whatever the local sources hold for it.
      for (const p of paragraphs) if (this.raw.get(p.hash)?.claude === undefined) toSend.set(p.hash, p.text);

      if (toSend.size > 0) {
        const mode = this.deps.getMode();
        this.setSending(true);
        let resp: CheckResponse;
        try {
          resp = await this.deps.send({
            host: this.deps.host,
            mode,
            paragraphs: [...toSend].map(([hash, text]) => ({ hash, text })),
          });
        } finally {
          this.setSending(false);
        }
        if (this.disposed) return;
        this.lastStatus = resp.status;
        for (const [hash, list] of Object.entries(resp.results)) this.raw.set(hash, { ...this.raw.get(hash), claude: list });
        for (const key of resp.dismissed) this.dismissed.add(key);
        this.retryIfBusy(resp.status, isRetry);
      }
      this.answered = true;
      await this.refresh();
    } catch {
      if (this.disposed) return;
      this.answered = true;
      this.lastStatus = 'offline';
      this.retryIfBusy('offline', isRetry);
      // keep existing issues, but re-locate them against the current text
      await this.refresh().catch(() => {});
      if (!this.disposed) this.emit();
    }
  }

  /** The tells in a paragraph under `mode`, from the cache when this paragraph was already read. */
  private tellsFor(text: string, hash: string, mode: Mode): SourcedIssue[] {
    const key = `${mode}:${hash}`;
    const cached = this.tellCache.get(key);
    if (cached) return cached;
    const tells = detectTells(text, mode);
    this.tellCache.set(key, tells);
    if (this.tellCache.size > TELL_CACHE_MAX) this.tellCache.delete(this.tellCache.keys().next().value as string);
    return tells;
  }

  /** Re-read the text and locate issues; unique ids per field (`#k` for repeated paragraphs). */
  private async locateAll(text: string): Promise<LocatedIssue[]> {
    const mode = this.deps.getMode();
    const policy = this.deps.policy(mode);
    const localOn = this.deps.localChecks?.() !== false;
    const seen = new Map<string, number>();
    const out: LocatedIssue[] = [];
    for (const p of splitParagraphs(text)) {
      const k = seen.get(p.hash) ?? 0;
      seen.set(p.hash, k + 1);
      const held = this.raw.get(p.hash);
      // Tells are local pattern matches, read only while the generic toggle shows them. They live in the bounded
      // tell cache, never in `raw`, which would otherwise gain an entry per keystroke.
      const tells = policy.families.generic ? this.tellsFor(p.text, p.hash, mode) : undefined;
      if (!held && !tells?.length) continue;
      // Local checks off: Harper's held answers stay for when they're back on, unshown.
      const sources: ParagraphRaw = { ...held, harper: localOn ? held?.harper : undefined, tells };
      for (const i of selectIssues(p, mergeParagraph(p.text, sources), policy)) {
        if (this.isDismissed(i)) continue;
        out.push(k === 0 ? i : { ...i, id: `${i.id}#${k}` });
      }
    }
    return out;
  }

  /**
   * `'changed'`: emit only when what is shown changed. A refresh that must emit and is superseded leaves the emit
   * owed, so the newer refresh emits even when it changes nothing shown (a status change still reaches the page).
   */
  private async refresh(emit: boolean | 'changed' = true): Promise<void> {
    if (emit === true) this.emitOwed = true;
    const seq = ++this.refreshSeq;
    const next = await this.locateAll(await this.readText());
    if (this.disposed || seq !== this.refreshSeq) return; // a newer read supersedes this one
    const changed = !sameShown(this.current, next);
    this.current = next;
    if (this.emitOwed || (emit === 'changed' && changed)) {
      this.emitOwed = false;
      this.emit();
    }
  }

  /** Read the text now and locate from that read; becomes `current` and supersedes older refreshes. */
  private async freshLocate(): Promise<LocatedIssue[]> {
    const seq = ++this.refreshSeq;
    const located = await this.locateAll(await this.adapter.getText());
    if (!this.disposed && seq === this.refreshSeq) this.current = located;
    return located;
  }

  /** Fresh position of an issue, or null (and an update) if it no longer exists. */
  private async relocate(issueId: string): Promise<LocatedIssue | null> {
    const issue = (await this.freshLocate()).find((i) => i.id === issueId) ?? null;
    if (!issue) this.emit();
    return issue;
  }

  /** Dismissal keys embed the paragraph hash, so re-key them when issues move to a new hash. */
  private carryDismissals(oldHash: string, newHash: string, moved: RawIssue[]): void {
    for (const r of moved) {
      if (!this.dismissed.has(dismissalKey(oldHash, r.original, r.kind))) continue;
      const key = dismissalKey(newHash, r.original, r.kind);
      this.dismissed.add(key);
      this.deps.persistDismissal(key).catch(() => {}); // best effort
    }
  }

  /**
   * After fixes, keep the paragraphs' remaining Claude issues under their new hash (no API call). Local
   * issues aren't carried: their verdict can depend on the words a fix changed, and the local sources
   * answer the new text afresh. Their dismissals move with the paragraph, so a dismissed one stays hidden.
   */
  private async reanchor(applied: LocatedIssue[]): Promise<void> {
    const mode = this.deps.getMode();
    const text = await this.adapter.getText();
    const paragraphs = splitParagraphs(text);
    const byHash = new Map<string, LocatedIssue[]>();
    for (const i of applied) byHash.set(i.paragraphHash, [...(byHash.get(i.paragraphHash) ?? []), i]);
    for (const [oldHash, group] of byHash) {
      const held = this.raw.get(oldHash) ?? {};
      const remaining = [...(held.claude ?? [])];
      for (const i of group) {
        if (sourceOf(i) !== 'claude') continue; // its raw entry is in its own source's list
        const idx = remaining.findIndex((r) => sameRaw(r, asRaw(i)));
        if (idx !== -1) remaining.splice(idx, 1);
      }
      const at = Math.min(...group.map((i) => i.start));
      const para = paragraphs.find((p) => p.start <= at && at <= p.start + p.text.length);
      if (!para) continue;
      const target = this.raw.get(para.hash);
      if (held.claude && target?.claude === undefined) {
        this.raw.set(para.hash, { ...target, claude: remaining });
        if (para.hash !== oldHash) this.carryDismissals(oldHash, para.hash, remaining);
      }
      const tells = this.tellCache.get(`${mode}:${oldHash}`) ?? [];
      if (para.hash !== oldHash) this.carryDismissals(oldHash, para.hash, [...(held.harper ?? []), ...tells]);
    }
  }
}
