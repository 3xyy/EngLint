import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorAdapter } from '../../src/content/adapters/types';
import { BUSY_RETRY_MS, FieldSession, HARPER_DEBOUNCE_MS, HARPER_MAX_CHARS, HARPER_MAX_PARAGRAPHS, type SessionDeps } from '../../src/content/session';
import type { SuggestionPolicy } from '../../src/core/match';
import { defaultFamilies } from '../../src/core/modes';
import { hashText } from '../../src/core/paragraphs';
import type { ParagraphRaw, SourcedIssue } from '../../src/core/sources';
import type { CheckStatus, LocatedIssue, Mode, RawIssue } from '../../src/core/types';
import { detectTells } from '../../src/core/tells/detect';
import { dismissalKey, type CheckRequest, type CheckResponse, type HarperCheckRequest, type HarperCheckResponse } from '../../src/shared/messages';

vi.mock('../../src/core/tells/detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/tells/detect')>();
  return { ...actual, detectTells: vi.fn(actual.detectTells) };
});

const raw = (o: Partial<RawIssue>): RawIssue => ({
  original: 'Teh',
  replacement: 'The',
  before: '',
  category: 'spelling',
  severity: 'error',
  kind: 'typo',
  reason: 'r',
  ...o,
});

class FakeAdapter implements EditorAdapter {
  fieldId = 'f1';
  element = {} as Element;
  text: string;
  failReplace = false;
  disposed = false;
  listeners = new Set<() => void>();
  /** Every getText() call. */
  reads = 0;
  reportsEveryChange?: boolean;
  constructor(text: string) {
    this.text = text;
  }
  async getText() {
    this.reads++;
    return this.text;
  }
  async rectsFor() {
    return [];
  }
  async replace(start: number, end: number, t: string) {
    if (this.failReplace) return false;
    this.text = this.text.slice(0, start) + t + this.text.slice(end);
    return true;
  }
  async select() {}
  onChange(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onLayoutChange() {
    return () => {};
  }
  isAlive() {
    return true;
  }
  dispose() {
    this.disposed = true;
  }
  type(text: string) {
    this.text = text;
    this.listeners.forEach((l) => l());
  }
}

function setup(text: string, respond: (req: CheckRequest) => CheckResponse | Promise<CheckResponse>) {
  const adapter = new FakeAdapter(text);
  const sent: CheckRequest[] = [];
  const updates: { issues: LocatedIssue[]; status: CheckStatus }[] = [];
  const persisted: string[] = [];
  /** Every busy change the session announced, in order. */
  const busy: boolean[] = [];
  /** What deps.policy answers (Clarity on, as a writer who turned it on); a test changes it as a settings change would. */
  const settings = { families: { ...defaultFamilies('standard'), clarity: true }, rules: new Set<string>(), dictionary: new Set<string>() };
  const policyModes: Mode[] = [];
  const deps: SessionDeps = {
    host: 'example.com',
    getMode: () => 'standard',
    policy: (mode): SuggestionPolicy => {
      policyModes.push(mode);
      return { mode, ...settings };
    },
    send: vi.fn(async (req: CheckRequest) => {
      sent.push(req);
      return respond(req);
    }),
    persistDismissal: vi.fn(async (k: string) => {
      persisted.push(k);
    }),
    onUpdate: (issues, status) => updates.push({ issues, status }),
    onBusyChange: (b) => busy.push(b),
  };
  const session = new FieldSession(adapter, deps);
  return { adapter, session, sent, updates, persisted, deps, settings, policyModes, busy };
}

const ok = (results: Record<string, RawIssue[]>, dismissed: string[] = []): CheckResponse => ({
  status: 'ok',
  results,
  dismissed,
});
const byText = (map: Record<string, RawIssue[]>) => (req: CheckRequest) =>
  ok(Object.fromEntries(req.paragraphs.map((p) => [p.hash, map[p.text] ?? []])));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('FieldSession', () => {
  it('waits 1000 ms after the last input', async () => {
    const { adapter, session, sent } = setup('Teh cat.', byText({}));
    session.start();
    vi.advanceTimersByTime(0);
    adapter.type('Teh cat');
    await vi.advanceTimersByTimeAsync(500);
    adapter.type('Teh cat.');
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    session.dispose();
  });

  it('sends only changed paragraphs', async () => {
    const { session, adapter, sent } = setup('Teh cat.\nA dog.', byText({ 'Teh cat.': [raw({})] }));
    await session.checkNow();
    expect(sent[0]!.paragraphs.map((p) => p.text)).toEqual(['Teh cat.', 'A dog.']);
    adapter.text = 'Teh cat.\nA dogg.';
    await session.checkNow();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.paragraphs.map((p) => p.text)).toEqual(['A dogg.']);
    expect(session.issues()).toHaveLength(1);
  });

  it('stale results are dropped or re-anchored', async () => {
    let release!: (r: CheckResponse) => void;
    const { session, adapter } = setup('Teh cat.', () => new Promise((r) => (release = r)));
    const p = session.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    adapter.text = 'The cat sat.';
    release(ok({ [hashText('Teh cat.')]: [raw({ before: '' })] }));
    await p;
    expect(session.issues()).toEqual([]);

    // unchanged paragraph keeps its issue at its new absolute offset
    const s2 = setup('Teh cat.\nI has a cat.', byText({ 'I has a cat.': [raw({ original: 'has', replacement: 'have', before: 'I' })] }));
    await s2.session.checkNow();
    expect(s2.session.issues()[0]!.start).toBe(11);
    s2.adapter.text = 'New line first.\nTeh cat.\nI has a cat.';
    await s2.session.checkNow();
    expect(s2.session.issues()).toHaveLength(1);
    expect(s2.session.issues()[0]!.start).toBe(27);
  });

  it('accept replaces and re-anchors remaining issues without a new send', async () => {
    const text = 'Teh cat has a bone.';
    const { session, adapter, sent } = setup(
      text,
      byText({ [text]: [raw({}), raw({ original: 'has', replacement: 'had', kind: 'tense', before: 'Teh cat' })] }),
    );
    await session.checkNow();
    expect(session.issues()).toHaveLength(2);
    const first = session.issues()[0]!;
    expect(await session.accept(first.id)).toBe(true);
    expect(adapter.text).toBe('The cat has a bone.');
    expect(sent).toHaveLength(1);
    await session.checkNow();
    expect(sent).toHaveLength(1);
    expect(session.issues().map((i) => i.original)).toEqual(['has']);
    expect(session.issues()[0]!.start).toBe(8);
  });

  it('accept failure returns false and keeps the issue', async () => {
    const { session, adapter } = setup('Teh cat.', byText({ 'Teh cat.': [raw({})] }));
    await session.checkNow();
    adapter.failReplace = true;
    expect(await session.accept(session.issues()[0]!.id)).toBe(false);
    expect(adapter.text).toBe('Teh cat.');
    expect(session.issues()).toHaveLength(1);
  });

  it('dismiss hides and persists the key', async () => {
    const { session, persisted, updates } = setup('Teh cat.', byText({ 'Teh cat.': [raw({})] }));
    await session.checkNow();
    const issue = session.issues()[0]!;
    await session.dismiss(issue.id);
    expect(session.issues()).toEqual([]);
    expect(updates.at(-1)!.issues).toEqual([]);
    expect(persisted).toEqual([dismissalKey(issue.paragraphHash, 'Teh', 'typo')]);
  });

  it('hides issues the background reports as dismissed, and survives persist failure', async () => {
    const h = hashText('Teh cat.');
    const a = setup('Teh cat.', () => ok({ [h]: [raw({})] }, [dismissalKey(h, 'Teh', 'typo')]));
    await a.session.checkNow();
    expect(a.session.issues()).toEqual([]);

    const b = setup('Teh cat.', byText({ 'Teh cat.': [raw({})] }));
    b.deps.persistDismissal = async () => {
      throw new Error('gone');
    };
    await b.session.checkNow();
    await expect(b.session.dismiss(b.session.issues()[0]!.id)).resolves.toBeUndefined();
    expect(b.session.issues()).toEqual([]);
  });

  it('acceptAllErrors applies errors only, descending', async () => {
    const text = 'Teh cat has a bone, ofcourse.';
    const calls: number[] = [];
    const { session, adapter } = setup(
      text,
      byText({
        [text]: [
          raw({}),
          raw({ original: 'ofcourse', replacement: 'of course', kind: 'typo2', before: 'a bone,' }),
          raw({ original: 'has', replacement: 'owns', severity: 'suggestion', category: 'clarity', kind: 'wordy_phrase', before: 'Teh cat' }),
        ],
      }),
    );
    const orig = adapter.replace.bind(adapter);
    adapter.replace = async (s, e, t) => (calls.push(s), orig(s, e, t));
    await session.checkNow();
    expect(await session.acceptAllErrors()).toEqual({ applied: 2, failed: 0 });
    expect(adapter.text).toBe('The cat has a bone, of course.');
    expect(calls).toEqual([...calls].sort((a, b) => b - a));
    expect(calls).toHaveLength(2);
    expect(session.issues().map((i) => i.severity)).toEqual(['suggestion']);
  });

  it('acceptAllErrors counts failures', async () => {
    const { session, adapter } = setup('Teh cat.', byText({ 'Teh cat.': [raw({})] }));
    await session.checkNow();
    adapter.failReplace = true;
    expect(await session.acceptAllErrors()).toEqual({ applied: 0, failed: 1 });
  });

  it('gives identical paragraphs unique ids and accepts only the chosen one', async () => {
    const t = 'I has a cat.\nI has a cat.';
    const { session, adapter } = setup(t, byText({ 'I has a cat.': [raw({ original: 'has', replacement: 'have', before: 'I' })] }));
    await session.checkNow();
    const [a, b] = session.issues();
    expect(session.issues()).toHaveLength(2);
    expect(a!.id).not.toBe(b!.id);
    expect(await session.accept(b!.id)).toBe(true);
    expect(adapter.text).toBe('I has a cat.\nI have a cat.');
    expect(session.issues()).toHaveLength(1);
    expect(session.issues()[0]!.start).toBe(2);
  });

  it('send rejection keeps issues and reports offline', async () => {
    let fail = false;
    const { session, adapter, updates } = setup('Teh cat.', (req) => {
      if (fail) throw new Error('Extension context invalidated');
      return byText({ 'Teh cat.': [raw({})] })(req);
    });
    await session.checkNow();
    fail = true;
    adapter.text = 'Teh cat.\nNew.';
    await expect(session.checkNow()).resolves.toBeUndefined();
    expect(session.status()).toBe('offline');
    expect(session.issues()).toHaveLength(1);
    expect(updates.at(-1)!.status).toBe('offline');
  });

  it('never runs two sends at once; input in flight schedules another check', async () => {
    const releases: ((r: CheckResponse) => void)[] = [];
    const { session, adapter, sent } = setup('Teh cat.', () => new Promise((r) => releases.push(r)));
    session.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(1);
    adapter.type('Teh cat. More.');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1);
    releases[0]!(ok({}));
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    releases[1]!(ok({}));
    session.dispose();
  });

  it('reports the response status', async () => {
    const { session, updates } = setup('Teh cat.', () => ({ status: 'key_missing', results: {}, dismissed: [] }));
    expect(session.status()).toBe('ok');
    await session.checkNow();
    expect(session.status()).toBe('key_missing');
    expect(updates.at(-1)!.status).toBe('key_missing');
  });

  describe('one re-check after a busy or offline answer', () => {
    const busy = (status: CheckStatus): CheckResponse => ({ status, results: {}, dismissed: [] });

    it('rate_limited: re-checks once, about 30 s later, and reports the new status', async () => {
      let calls = 0;
      const { session, sent, updates } = setup('Teh cat.', (req) =>
        calls++ === 0 ? busy('rate_limited') : byText({ 'Teh cat.': [raw({})] })(req),
      );
      await session.checkNow();
      expect(session.status()).toBe('rate_limited');
      expect(BUSY_RETRY_MS).toBeGreaterThan(30_000); // after the background's 30 s pause
      expect(BUSY_RETRY_MS).toBeLessThanOrEqual(35_000);
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS - 1);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.paragraphs.map((p) => p.text)).toEqual(['Teh cat.']);
      expect(session.status()).toBe('ok');
      expect(updates.at(-1)).toMatchObject({ status: 'ok' });
      expect(session.issues()).toHaveLength(1);
      session.dispose();
    });

    it('a retry that is still busy is not retried again', async () => {
      const { session, sent } = setup('Teh cat.', () => busy('overloaded'));
      await session.checkNow();
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
      expect(sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 10);
      expect(sent).toHaveLength(2);
      expect(session.status()).toBe('overloaded');
      session.dispose();
    });

    it('offline from the background, or a send that throws, re-checks once', async () => {
      const a = setup('Teh cat.', () => busy('offline'));
      await a.session.checkNow();
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
      expect(a.sent).toHaveLength(2);
      a.session.dispose();

      let calls = 0;
      const b = setup('Teh cat.', (req) => {
        if (calls++ === 0) throw new Error('background unreachable');
        return byText({})(req);
      });
      await b.session.checkNow();
      expect(b.session.status()).toBe('offline');
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS);
      expect(b.sent).toHaveLength(2);
      expect(b.session.status()).toBe('ok');
      b.session.dispose();
    });

    it('other statuses never schedule a re-check', async () => {
      for (const status of ['ok', 'bad_response', 'key_invalid', 'key_missing', 'paused_cap', 'out_of_credit', 'off_site'] as CheckStatus[]) {
        const { session, sent } = setup('Teh cat.', () => busy(status));
        await session.checkNow();
        await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 2);
        expect(sent, status).toHaveLength(1);
        session.dispose();
      }
    });

    it('dispose cancels the pending re-check', async () => {
      const { session, sent } = setup('Teh cat.', () => busy('rate_limited'));
      await session.checkNow();
      expect(vi.getTimerCount()).toBe(1);
      session.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 2);
      expect(sent).toHaveLength(1);
    });

    it('a check that succeeds before the re-check cancels it', async () => {
      let calls = 0;
      const { session, adapter, sent } = setup('Teh cat.', (req) => (calls++ === 0 ? busy('overloaded') : byText({})(req)));
      await session.checkNow();
      adapter.text = 'Teh cat!';
      await session.checkNow(); // e.g. the panel's "Check everything"
      expect(session.status()).toBe('ok');
      expect(vi.getTimerCount()).toBe(0); // nothing left to fire
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 2);
      expect(sent).toHaveLength(2);
    });

    it('a new check cancels the pending re-check (its own busy answer gets one of its own)', async () => {
      const { session, adapter, sent } = setup('Teh cat.', () => busy('rate_limited'));
      session.start();
      await vi.advanceTimersByTimeAsync(1000); // the start check
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4000);
      adapter.type('Teh cat!'); // 5 s: input, checked at 6 s, busy again
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS - 1000); // past the first retry's time: cancelled
      expect(sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000); // the second check's own retry
      expect(sent).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 3);
      expect(sent).toHaveLength(3);
      session.dispose();
    });
  });

  it('dispose clears timers and disposes adapter', async () => {
    const { session, adapter, sent } = setup('Teh cat.', byText({}));
    session.start();
    adapter.type('Teh cat!');
    session.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(0);
    expect(adapter.disposed).toBe(true);
    expect(adapter.listeners.size).toBe(0);
  });

  it('dismissal survives accepting another issue in the same paragraph', async () => {
    const text = 'Teh cat has a bone.';
    const issues = [raw({}), raw({ original: 'has', replacement: 'had', kind: 'tense', before: 'Teh cat' })];
    const { session, adapter, persisted } = setup(text, byText({ [text]: issues }));
    await session.checkNow();
    const [teh, has] = session.issues();
    await session.dismiss(has!.id);
    expect(await session.accept(teh!.id)).toBe(true);
    expect(adapter.text).toBe('The cat has a bone.');
    expect(session.issues()).toEqual([]);
    const newHash = hashText('The cat has a bone.');
    expect(persisted).toContain(dismissalKey(newHash, 'has', 'tense'));
  });

  // The located issue carries the document's text and a curled fix; the session must still know its raw entry.
  it.each([
    ['as the document has it', 'don’t really'],
    ['straight-quoted (found by the typography fallback)', "don't really"],
  ])('accepting a curled-span fix where the phrase repeats leaves no phantom on the other one: model original %s', async (_, original) => {
    const text = 'I don’t really know. She said I don’t really care.';
    const fix = raw({ original, replacement: "don't", before: 'She said I', severity: 'suggestion', category: 'clarity', kind: 'wordy_phrase' });
    const { session, adapter, sent } = setup(text, byText({ [text]: [fix] }));
    await session.checkNow();
    const [issue] = session.issues();
    expect(issue).toMatchObject({ original: 'don’t really', replacement: 'don’t', start: 32 });
    expect(await session.accept(issue!.id)).toBe(true);
    expect(adapter.text).toBe('I don’t really know. She said I don’t care.');
    expect(session.issues()).toEqual([]);
    await session.checkNow();
    expect(sent).toHaveLength(1);
    expect(session.issues()).toEqual([]);
  });

  it('a dismissed issue found by the typography fallback stays dismissed when the paragraph gets a new hash', async () => {
    const text = 'Teh cat said I don’t really know.';
    const note = raw({ original: "don't really", replacement: "don't", before: 'said I', severity: 'suggestion', category: 'clarity', kind: 'wordy_phrase' });
    const { session, adapter, persisted } = setup(text, byText({ [text]: [raw({}), note] }));
    await session.checkNow();
    const [teh, dont] = session.issues();
    expect(dont).toMatchObject({ original: 'don’t really' });
    await session.dismiss(dont!.id);
    expect(await session.accept(teh!.id)).toBe(true);
    expect(adapter.text).toBe('The cat said I don’t really know.');
    expect(session.issues()).toEqual([]);
    const newHash = hashText('The cat said I don’t really know.');
    expect(persisted).toContain(dismissalKey(newHash, "don't really", 'wordy_phrase'));
  });

  it('dismissal survives acceptAllErrors', async () => {
    const text = 'Teh cat has a bone, ofcourse.';
    const { session, adapter } = setup(
      text,
      byText({
        [text]: [
          raw({}),
          raw({ original: 'ofcourse', replacement: 'of course', kind: 'typo2', before: 'a bone,' }),
          raw({ original: 'has', replacement: 'owns', severity: 'suggestion', category: 'clarity', kind: 'wordy_phrase', before: 'Teh cat' }),
        ],
      }),
    );
    await session.checkNow();
    const sug = session.issues().find((i) => i.severity === 'suggestion')!;
    await session.dismiss(sug.id);
    expect(await session.acceptAllErrors()).toEqual({ applied: 2, failed: 0 });
    expect(adapter.text).toBe('The cat has a bone, of course.');
    expect(session.issues()).toEqual([]);
  });

  it('typing before an issue re-locates it before the debounce fires', async () => {
    const { session, adapter, sent, updates } = setup('I has a cat.', byText({ 'I has a cat.': [raw({ original: 'has', replacement: 'have', before: 'I' })] }));
    await session.checkNow();
    session.start();
    const before = updates.length;
    expect(session.issues()[0]!.start).toBe(2);
    // a new paragraph inserted before: existing paragraph keeps its issue, shifted
    adapter.type('Hello there.\nI has a cat.');
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(1);
    expect(session.issues()[0]!.start).toBe(15);
    expect(updates.length).toBeGreaterThan(before);
    session.dispose();
  });

  it('onUpdate throwing does not set offline or reject', async () => {
    const { session, deps } = setup('Teh cat.', byText({ 'Teh cat.': [raw({})] }));
    deps.onUpdate = () => {
      throw new Error('listener boom');
    };
    await expect(session.checkNow()).resolves.toBeUndefined();
    expect(session.status()).toBe('ok');
    expect(session.issues()).toHaveLength(1);
    await expect(session.dismiss(session.issues()[0]!.id)).resolves.toBeUndefined();
  });

  it('checkNow during flight triggers a follow-up check', async () => {
    const releases: ((r: CheckResponse) => void)[] = [];
    const { session, adapter, sent } = setup('Teh cat.', () => new Promise((r) => releases.push(r)));
    const p = session.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    adapter.text = 'Teh cat.\nMore text.'; // no change callback fired (not started)
    void session.checkNow();
    releases[0]!(ok({ [hashText('Teh cat.')]: [] }));
    await p;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.paragraphs.map((x) => x.text)).toEqual(['More text.']);
    releases[1]!(ok({}));
    session.dispose();
  });

  it('accept uses fresh offsets when a keystroke refresh supersedes it', async () => {
    const { session, adapter } = setup('I has a cat.', byText({ 'I has a cat.': [raw({ original: 'has', replacement: 'have', before: 'I' })] }));
    await session.checkNow();
    session.start();
    const id = session.issues()[0]!.id;
    const held: (() => void)[] = [];
    const real = adapter.getText.bind(adapter);
    adapter.getText = () => new Promise((r) => held.push(() => r(adapter.text)));
    const accepting = session.accept(id); // read 1 held
    await vi.advanceTimersByTimeAsync(0);
    adapter.text = 'Hi.\nI has a cat.'; // keystroke while the read is pending
    adapter.listeners.forEach((l) => l()); // read 2 (superseding refresh) held
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toHaveLength(2);
    held[0]!();
    await vi.advanceTimersByTimeAsync(0);
    adapter.getText = real;
    held.slice(1).forEach((h) => h());
    expect(await accepting).toBe(true);
    expect(adapter.text).toBe('Hi.\nI have a cat.');
    session.dispose();
  });

  describe('the suggestion policy', () => {
    const text = 'In order to win, we use very very good plans.';
    const WORDY = raw({ original: 'In order to', replacement: 'To', severity: 'suggestion', category: 'clarity', kind: 'wordy_phrase' });
    const REPEAT = raw({ original: 'very very', replacement: 'very', before: 'we use', severity: 'suggestion', category: 'engagement', kind: 'repeated_word' });

    it('selects under deps.policy for the current mode: its families, rules and dictionary', async () => {
      const typo = raw({ original: 'plans', replacement: 'plants', before: 'very very good' });
      const { session, settings, policyModes } = setup(text, byText({ [text]: [WORDY, REPEAT, typo] }));
      settings.families = { ...settings.families, engagement: true };
      await session.checkNow();
      expect(session.issues().map((i) => i.kind)).toEqual(['wordy_phrase', 'repeated_word', 'typo']);
      expect(policyModes.at(-1)).toBe('standard');

      settings.rules = new Set(['wordy_phrase']);
      settings.dictionary = new Set(['plans']);
      await session.checkNow();
      expect(session.issues().map((i) => i.kind)).toEqual(['repeated_word']); // the typo was category spelling
    });

    it('refilter() re-selects the held results after the policy changes: a family turned off hides, with no request', async () => {
      const { session, settings, sent, updates, deps } = setup(text, byText({ [text]: [WORDY, REPEAT] }));
      settings.families = { ...settings.families, engagement: true };
      await session.checkNow();
      expect(session.issues().map((i) => i.kind)).toEqual(['wordy_phrase', 'repeated_word']);
      const emitted = updates.length;

      settings.families = { ...settings.families, engagement: false };
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues().map((i) => i.kind)).toEqual(['wordy_phrase']);
      expect(updates.length).toBe(emitted + 1);
      expect(updates.at(-1)!.issues.map((i) => i.kind)).toEqual(['wordy_phrase']);
      expect(sent).toHaveLength(1);
      expect(deps.send).toHaveBeenCalledTimes(1);

      settings.families = { ...settings.families, engagement: true }; // and back on (undo), still no request
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues().map((i) => i.kind)).toEqual(['wordy_phrase', 'repeated_word']);
      expect(deps.send).toHaveBeenCalledTimes(1);
    });
  });
  describe('issues from the local sources', () => {
    /** The session's held issues per paragraph; the local sources write here, so tests put entries in directly. */
    const held = (s: FieldSession) => (s as unknown as { raw: Map<string, ParagraphRaw> }).raw;
    const local = (o: Partial<SourcedIssue>): SourcedIssue => ({ ...raw({ reason: 'harper' }), source: 'harper', ruleId: 'harper:AnA', suggestionCount: 1, ...o });
    const keyMissing = (): CheckResponse => ({ status: 'key_missing', results: {}, dismissed: [] });
    const text = 'I ate a apple and teh pear.';
    const AN_A = local({ original: 'a', replacement: 'an', category: 'grammar', kind: 'article', at: 6 });
    const SPELL = local({ original: 'teh', replacement: 'the', ruleId: 'harper:SpellCheck', at: 18 });

    it('a paragraph Claude has not answered shows an instant Harper issue, and is still sent to Claude', async () => {
      const { session, sent } = setup(text, keyMissing);
      held(session).set(hashText(text), { harper: [AN_A] });
      await session.checkNow();
      expect(sent.map((r) => r.paragraphs.map((p) => p.text))).toEqual([[text]]);
      expect(session.status()).toBe('key_missing');
      expect(session.issues().map((i) => [i.original, i.replacement, i.start])).toEqual([['a', 'an', 6]]);
    });

    it('once Claude answers the paragraph, its issues replace an untrusted Harper one; a trusted one elsewhere stays', async () => {
      const t = 'I ate a apple, its red and teh end.';
      const its = local({ original: 'its', replacement: "it's", category: 'grammar', kind: 'its_vs_it_is', ruleId: 'harper:ItsContraction', at: t.indexOf('its') });
      const anA = local({ original: 'a', replacement: 'an', category: 'grammar', kind: 'article', at: t.indexOf('a apple') });
      let release!: (r: CheckResponse) => void;
      const { session, sent } = setup(t, () => new Promise((r) => (release = r)));
      held(session).set(hashText(t), { harper: [its, anA] });
      const p = session.checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.map((r) => r.paragraphs.map((x) => x.text))).toEqual([[t]]);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues().map((i) => [i.original, i.reason])).toEqual([['a', 'harper'], ['its', 'harper']]);
      const typo = raw({ original: 'teh', replacement: 'the', before: 'its red and', reason: 'claude' });
      release(ok({ [hashText(t)]: [typo] }));
      await p;
      expect(session.issues().map((i) => [i.original, i.reason])).toEqual([['a', 'harper'], ['teh', 'claude']]);
    });

    it('accepting a Harper issue carries no local entry to the new text, and adds no Claude entry it never had', async () => {
      const { session, adapter, sent } = setup(text, keyMissing);
      held(session).set(hashText(text), { harper: [AN_A, SPELL] });
      await session.checkNow();
      expect(session.issues().map((i) => i.original)).toEqual(['a', 'teh']);
      expect(await session.accept(session.issues()[0]!.id)).toBe(true);
      const fixed = 'I ate an apple and teh pear.';
      expect(adapter.text).toBe(fixed);
      expect(session.issues()).toEqual([]); // the local sources answer the new text afresh
      await session.checkNow();
      expect(sent.map((r) => r.paragraphs.map((p) => p.text))).toEqual([[text], [fixed]]);
    });

    it('a local issue next to a Claude fix is not carried to the fixed text, where its verdict no longer holds', async () => {
      const t = 'I need a elp now.';
      const help = raw({ original: 'elp', replacement: 'help', before: 'I need a', reason: 'claude' });
      const { session, adapter } = setup(t, byText({ [t]: [help] }));
      held(session).set(hashText(t), { harper: [{ ...AN_A, at: 7 }] });
      await session.checkNow();
      expect(session.issues().map((i) => [i.original, i.replacement])).toEqual([['a', 'an'], ['elp', 'help']]);
      expect(await session.accept(session.issues()[1]!.id)).toBe(true);
      expect(adapter.text).toBe('I need a help now.');
      expect(session.issues()).toEqual([]);
    });

    it('a Claude error over a trusted Harper issue hides it, and accepting the fix leaves nothing on the fixed text', async () => {
      const t = 'I ate a apple, its red.';
      const article = raw({ original: 'a apple', replacement: 'an apple', before: 'I ate', category: 'grammar', kind: 'article', reason: 'claude' });
      const { session, adapter } = setup(t, byText({ [t]: [article] }));
      held(session).set(hashText(t), { harper: [AN_A] });
      await session.checkNow();
      expect(session.issues().map((i) => [i.original, i.reason])).toEqual([['a apple', 'claude']]);
      expect(await session.accept(session.issues()[0]!.id)).toBe(true);
      const fixed = 'I ate an apple, its red.';
      expect(adapter.text).toBe(fixed);
      expect(fixed.slice(6, 7)).toBe('a'); // the old offset now points into "an"
      expect(session.issues()).toEqual([]);
    });

    it('a dismissed Claude error still hides the trusted Harper issue under it', async () => {
      const t = 'I ate a apple, its red.';
      const article = raw({ original: 'a apple', replacement: 'an apple', before: 'I ate', category: 'grammar', kind: 'article', reason: 'claude' });
      const { session } = setup(t, byText({ [t]: [article] }));
      held(session).set(hashText(t), { harper: [AN_A] });
      await session.checkNow();
      await session.dismiss(session.issues()[0]!.id);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toEqual([]);
    });

    it('a Claude suggestion over a trusted Harper error does not hide it, also when the settings hide the suggestion', async () => {
      const t = 'In order to get a apple, we ran.';
      const generic = raw({
        original: 'In order to get a apple',
        replacement: 'To get an apple',
        category: 'delivery',
        severity: 'suggestion',
        kind: 'generic_phrasing',
        reason: 'claude',
      });
      const { session, settings } = setup(t, byText({ [t]: [generic] }));
      expect(settings.families.generic).toBe(false);
      held(session).set(hashText(t), { harper: [{ ...AN_A, at: t.indexOf('a apple') }] });
      await session.checkNow();
      expect(session.issues().map((i) => [i.original, i.replacement, i.reason])).toEqual([['a', 'an', 'harper']]);
    });

    it('a dismissed local issue stays dismissed when a fix gives its paragraph a new hash', async () => {
      const { session, persisted } = setup(text, keyMissing);
      held(session).set(hashText(text), { harper: [AN_A, SPELL] });
      await session.checkNow();
      await session.dismiss(session.issues().find((i) => i.original === 'teh')!.id);
      expect(await session.accept(session.issues()[0]!.id)).toBe(true);
      const fixed = 'I ate an apple and teh pear.';
      expect(persisted).toContain(dismissalKey(hashText(fixed), 'teh', 'typo'));
      held(session).set(hashText(fixed), { harper: [{ ...SPELL, at: 19 }] }); // the local source answers the new text
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toEqual([]);
    });

    it('applying a local issue leaves an identical Claude entry in place', async () => {
      const t = 'I ate a apple and a pear.';
      // Claude's twin of the Harper issue can't be located (its before is empty), so only the held list shows it.
      const twin = raw({ original: 'a', replacement: 'an', category: 'grammar', kind: 'article', reason: 'harper' });
      const { session, adapter } = setup(t, byText({ [t]: [twin] }));
      held(session).set(hashText(t), { harper: [AN_A] });
      await session.checkNow();
      expect(session.issues().map((i) => [i.original, i.start])).toEqual([['a', 6]]);
      expect(await session.accept(session.issues()[0]!.id)).toBe(true);
      expect(adapter.text).toBe('I ate an apple and a pear.');
      expect(held(session).get(hashText('I ate an apple and a pear.'))!.claude).toEqual([twin]);
    });

    it('a fix that makes a paragraph match one already held keeps Claude’s answer for it', async () => {
      const t = 'I ate a apple.\nI ate an apple.';
      const article = raw({ original: 'a apple', replacement: 'an apple', before: 'I ate', category: 'grammar', kind: 'article' });
      const tense = raw({ original: 'ate', replacement: 'eat', before: 'I', category: 'grammar', kind: 'tense' });
      const { session, adapter } = setup(t, byText({ 'I ate a apple.': [article], 'I ate an apple.': [tense] }));
      await session.checkNow();
      expect(await session.accept(session.issues().find((i) => i.kind === 'article')!.id)).toBe(true);
      expect(adapter.text).toBe('I ate an apple.\nI ate an apple.');
      expect(session.issues().map((i) => [i.original, i.start])).toEqual([['ate', 2], ['ate', 18]]);
    });
  });
  describe('the local Harper checker', () => {
    const held = (s: FieldSession) => (s as unknown as { raw: Map<string, ParagraphRaw> }).raw;
    const local = (o: Partial<SourcedIssue>): SourcedIssue => ({ ...raw({ reason: 'harper' }), source: 'harper', ruleId: 'harper:AnA', suggestionCount: 1, ...o });
    const keyMissing = (): CheckResponse => ({ status: 'key_missing', results: {}, dismissed: [] });
    const text = 'I ate a apple and teh pear.';
    const AN_A = local({ original: 'a', replacement: 'an', category: 'grammar', kind: 'article', at: 6 });
    const SPELL = local({ original: 'teh', replacement: 'the', ruleId: 'harper:SpellCheck', at: 18 });

    /** The session with Harper wired: `answer` gives each paragraph's issues by its text (missing: none). */
    function withHarper(
      initial: string,
      respond: (req: CheckRequest) => CheckResponse | Promise<CheckResponse>,
      answer: (req: HarperCheckRequest) => HarperCheckResponse | Promise<HarperCheckResponse> = harperByText({}),
    ) {
      const s = setup(initial, respond);
      const harper: HarperCheckRequest[] = [];
      const localOn = { value: true };
      s.deps.sendHarper = vi.fn(async (req: HarperCheckRequest) => {
        harper.push(req);
        return answer(req);
      });
      s.deps.localChecks = () => localOn.value;
      return { ...s, harper, localOn };
    }
    const harperByText =
      (map: Record<string, SourcedIssue[]>) =>
      (req: HarperCheckRequest): HarperCheckResponse => ({
        status: 'ok',
        results: Object.fromEntries(req.paragraphs.map((p) => [p.hash, map[p.text] ?? []])),
        dismissed: [],
      });
    const texts = (reqs: { paragraphs: { text: string }[] }[]) => reqs.map((r) => r.paragraphs.map((p) => p.text));

    it('asks Harper 150 ms after the last input, for the paragraphs it has not answered', async () => {
      expect(HARPER_DEBOUNCE_MS).toBe(150);
      const { session, adapter, harper } = withHarper('I ate a apple.', keyMissing);
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS - 1);
      expect(harper).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(texts(harper)).toEqual([['I ate a apple.']]);
      expect(harper[0]).toMatchObject({ host: 'example.com', mode: 'standard' });

      adapter.type('I ate a apple.\nA do');
      await vi.advanceTimersByTimeAsync(100);
      adapter.type('I ate a apple.\nA dog.');
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS - 1);
      expect(harper).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(texts(harper)).toEqual([['I ate a apple.'], ['A dog.']]);

      await vi.advanceTimersByTimeAsync(2000);
      adapter.type('I ate a apple.\nA dog.\nA cat.');
      session.dispose(); // a pending tick goes with the session
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(harper).toHaveLength(2);
    });

    it('shows instant issues before a held Claude answer; once it comes, an untrusted one goes and a trusted one stays', async () => {
      let release!: (r: CheckResponse) => void;
      const { session, sent, updates } = withHarper(text, () => new Promise((r) => (release = r)), harperByText({ [text]: [AN_A, SPELL] }));
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(session.issues().map((i) => [i.original, i.replacement, i.start])).toEqual([['a', 'an', 6], ['teh', 'the', 18]]);
      expect(updates.at(-1)!.issues.map((i) => i.original)).toEqual(['a', 'teh']); // drawn, not only held
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toHaveLength(1); // Claude's request is in flight
      expect(session.issues().map((i) => i.original)).toEqual(['a', 'teh']);
      release(ok({ [hashText(text)]: [] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues().map((i) => [i.original, i.reason])).toEqual([['a', 'harper']]);
      session.dispose();
    });

    it('with no key, the instant issues stay and Harper adds no request to Claude', async () => {
      const { session, adapter, sent, harper } = withHarper(text, keyMissing, harperByText({ [text]: [AN_A] }));
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(session.issues().map((i) => i.original)).toEqual(['a']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toHaveLength(1);
      expect(session.status()).toBe('key_missing');
      expect(session.issues().map((i) => i.original)).toEqual(['a']);
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 2);
      expect(sent).toHaveLength(1);

      adapter.type(`${text}\nMore.`);
      await vi.advanceTimersByTimeAsync(2000);
      expect(texts(harper)).toEqual([[text], ['More.']]);
      expect(texts(sent)).toEqual([[text], [text, 'More.']]); // one check per input, as without Harper (no key: nothing held)
      expect(session.issues().map((i) => i.original)).toEqual(['a']);
      session.dispose();
    });

    it('with "Instant local checks" off, Harper is never asked', async () => {
      const { session, adapter, deps, localOn } = withHarper(text, keyMissing, harperByText({ [text]: [AN_A] }));
      localOn.value = false;
      session.start();
      adapter.type(`${text} More.`);
      await vi.advanceTimersByTimeAsync(2000);
      session.refilter();
      await vi.advanceTimersByTimeAsync(2000);
      expect(deps.sendHarper).not.toHaveBeenCalled();
      expect(session.issues()).toEqual([]);
      session.dispose();
    });

    it('turning local checks off hides Harper issues at once; back on shows them again without asking again', async () => {
      const { session, harper, localOn } = withHarper(text, keyMissing, harperByText({ [text]: [AN_A] }));
      session.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(session.issues().map((i) => i.original)).toEqual(['a']);
      localOn.value = false;
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toEqual([]);
      localOn.value = true;
      session.refilter();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(session.issues().map((i) => i.original)).toEqual(['a']);
      expect(harper).toHaveLength(1);
      session.dispose();
    });

    it('turning local checks on asks Harper about the text at once, with no typing', async () => {
      const { session, harper, localOn } = withHarper(text, keyMissing, harperByText({ [text]: [AN_A] }));
      localOn.value = false;
      session.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(harper).toHaveLength(0);
      localOn.value = true;
      session.refilter(); // the page's settings watcher does this when the switch changes
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(harper)).toEqual([[text]]);
      expect(session.issues().map((i) => i.original)).toEqual(['a']);
      session.dispose();
    });

    it('an answer with nothing in it changes no underline, so it sends no update', async () => {
      const { session, updates, deps } = withHarper(text, keyMissing);
      await session.checkNow();
      const before = updates.length;
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(deps.sendHarper).toHaveBeenCalledTimes(1);
      expect(updates).toHaveLength(before);
      session.dispose();
    });

    it('an answer whose issues none are shown (not instant rules) sends no update either', async () => {
      const agreement = local({ original: 'has', replacement: 'have', category: 'grammar', kind: 'subject_verb_agreement', ruleId: 'harper:PronounVerbAgreement', at: 2 });
      const t = 'I has a cat.';
      const { session, updates, deps } = withHarper(t, keyMissing, harperByText({ [t]: [agreement] }));
      await session.checkNow();
      const before = updates.length;
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(deps.sendHarper).toHaveBeenCalledTimes(1);
      expect(session.issues()).toEqual([]);
      expect(updates).toHaveLength(before);
      session.dispose();
    });

    it('an answer for a paragraph that changed meanwhile is kept under the old text and not shown on the new one', async () => {
      const before = 'I ate a apple.';
      const after = 'I ate a apple!';
      const releases: ((r: HarperCheckResponse) => void)[] = [];
      const { session, adapter, harper } = withHarper(before, keyMissing, () => new Promise((r) => releases.push(r)));
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(harper)).toEqual([[before]]);
      adapter.type(after);
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(harper).toHaveLength(1); // one request at a time
      releases[0]!({ status: 'ok', results: { [hashText(before)]: [AN_A] }, dismissed: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(held(session).get(hashText(before))?.harper).toEqual([AN_A]);
      expect(held(session).get(hashText(after))?.harper).toBeUndefined();
      expect(session.issues()).toEqual([]);

      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS); // the follow-up asks about the new text
      expect(texts(harper)).toEqual([[before], [after]]);
      releases[1]!({ status: 'ok', results: { [hashText(after)]: [] }, dismissed: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toEqual([]);

      adapter.type(before); // back to the text it answered: shown again, with no new request
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(session.issues().map((i) => [i.original, i.start])).toEqual([['a', 6]]);
      expect(harper).toHaveLength(2);
      session.dispose();
    });

    it('keeps no entry for a paragraph Harper did not answer, or for an off_site answer, so a later tick asks again', async () => {
      let answer: HarperCheckResponse = { status: 'ok', results: {}, dismissed: [] };
      const { session, adapter, harper } = withHarper(text, keyMissing, () => answer);
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(held(session).get(hashText(text))?.harper).toBeUndefined();
      answer = { status: 'off_site', results: { [hashText(text)]: [AN_A] }, dismissed: [] };
      adapter.type(text);
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(held(session).get(hashText(text))?.harper).toBeUndefined();
      expect(session.issues()).toEqual([]);
      answer = harperByText({ [text]: [AN_A] })(harper[0]!);
      adapter.type(text);
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(harper)).toEqual([[text], [text], [text]]);
      expect(session.issues().map((i) => i.original)).toEqual(['a']);
      session.dispose();
    });

    it('a failed Harper request leaves Claude’s issues and status as they were', async () => {
      const t = 'I has a cat.';
      const has = raw({ original: 'has', replacement: 'have', before: 'I', category: 'grammar', kind: 'subject_verb_agreement' });
      const { session, adapter, updates, deps } = withHarper(t, byText({ [t]: [has] }), () => Promise.reject(new Error('Could not establish connection')));
      await session.checkNow();
      expect(session.issues().map((i) => i.original)).toEqual(['has']);
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(deps.sendHarper).toHaveBeenCalledTimes(1);
      expect(session.status()).toBe('ok');
      expect(session.issues().map((i) => i.original)).toEqual(['has']);
      expect(updates.every((u) => u.status === 'ok')).toBe(true);
      adapter.type(t); // nothing was kept, so the next input asks again
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(deps.sendHarper).toHaveBeenCalledTimes(2);
      session.dispose();
    });

    it('a Harper request never shows as busy and never changes the status', async () => {
      let release!: (r: HarperCheckResponse) => void;
      const { session, adapter, busy, updates } = withHarper(text, keyMissing, () => new Promise((r) => (release = r)));
      await session.checkNow();
      expect(session.status()).toBe('key_missing');
      expect(busy).toEqual([true, false]);
      session.start();
      adapter.type(text);
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(session.busy()).toBe(false);
      release({ status: 'ok', results: { [hashText(text)]: [AN_A] }, dismissed: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues().map((i) => i.original)).toEqual(['a']);
      expect(updates.at(-1)!.status).toBe('key_missing');
      expect(session.status()).toBe('key_missing');
      expect(busy).toEqual([true, false]); // Claude's own request only
      session.dispose();
    });

    it('a dismissed Harper issue stays hidden when Claude reports the same words as the same kind', async () => {
      const twin = raw({ original: 'a', replacement: 'an', before: 'I ate', category: 'grammar', kind: 'article', reason: 'claude' });
      let release!: (r: CheckResponse) => void;
      const { session, persisted } = withHarper(text, () => new Promise((r) => (release = r)), harperByText({ [text]: [AN_A] }));
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      await session.dismiss(session.issues()[0]!.id);
      expect(persisted).toEqual([dismissalKey(hashText(text), 'a', 'article')]);
      await vi.advanceTimersByTimeAsync(1000);
      release(ok({ [hashText(text)]: [twin] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toEqual([]);
      session.dispose();
    });

    it('a quiet Harper re-locate never swallows the update a Claude answer owes', async () => {
      const t = 'I has a cat.';
      const agreement = local({ original: 'has', replacement: 'have', category: 'grammar', kind: 'subject_verb_agreement', ruleId: 'harper:PronounVerbAgreement', at: 2 });
      let answerHarper!: (r: HarperCheckResponse) => void;
      let holdNextRead = false;
      const held: (() => void)[] = [];
      const { session, adapter, updates } = withHarper(
        t,
        () => {
          holdNextRead = true; // the re-locate after Claude's answer reads slowly
          return keyMissing();
        },
        () => new Promise((r) => (answerHarper = r)),
      );
      const read = adapter.getText.bind(adapter);
      adapter.getText = () => {
        if (!holdNextRead) return read();
        holdNextRead = false;
        return new Promise((r) => held.push(() => r(adapter.text)));
      };
      session.start();
      await vi.advanceTimersByTimeAsync(1000); // Harper asked at 150 ms; Claude answered, its re-locate held
      expect(held).toHaveLength(1);
      answerHarper({ status: 'ok', results: { [hashText(t)]: [agreement] }, dismissed: [] }); // shows nothing new
      await vi.advanceTimersByTimeAsync(0);
      held[0]!(); // the superseded read
      await vi.advanceTimersByTimeAsync(0);
      expect(session.status()).toBe('key_missing');
      expect(updates.some((u) => u.status === 'key_missing')).toBe(true);
      session.dispose();
    });

    it('dismissal keys that come with Harper’s answer hide its issues before Claude answers', async () => {
      const { session } = withHarper(text, keyMissing, (req) => ({
        ...harperByText({ [text]: [AN_A, SPELL] })(req),
        dismissed: [dismissalKey(hashText(text), 'a', 'article')],
      }));
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(session.issues().map((i) => i.original)).toEqual(['teh']);
      session.dispose();
    });

    it('an answer that brings a new dismissal key and no issue still hides a tell shown before it', async () => {
      const serves = 'The library serves as a meeting place.';
      const { session, adapter, settings, updates } = withHarper('', keyMissing, (req) => ({
        ...harperByText({})(req),
        dismissed: [dismissalKey(hashText(serves), 'serves as', 'generic_phrasing')],
      }));
      settings.families = { ...settings.families, generic: true };
      session.start();
      adapter.type(serves);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues().map((i) => i.original)).toEqual(['serves as']);
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(session.issues()).toEqual([]);
      expect(updates.at(-1)!.issues).toEqual([]);

      // An answer whose keys are all known already, with no issue, re-reads nothing beyond its own read.
      adapter.type(`${serves}\nAll good here.`);
      await vi.advanceTimersByTimeAsync(0);
      const reads = adapter.reads;
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(adapter.reads).toBe(reads + 1);
      session.dispose();
    });

    it('after a fix, Harper is asked about the fixed text, though the editor reports no change', async () => {
      const { session, adapter, harper } = withHarper(text, keyMissing, harperByText({ [text]: [AN_A, SPELL] }));
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(await session.accept(session.issues()[0]!.id)).toBe(true); // the fake reports no change for its own edit
      const fixed = 'I ate an apple and teh pear.';
      expect(adapter.text).toBe(fixed);
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(harper)).toEqual([[text], [fixed]]);
      session.dispose();
    });

    it('after Accept all errors, too', async () => {
      const { session, adapter, harper } = withHarper(text, keyMissing, harperByText({ [text]: [AN_A, SPELL] }));
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(await session.acceptAllErrors()).toEqual({ applied: 2, failed: 0 });
      expect(adapter.text).toBe('I ate an apple and the pear.');
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(harper)).toEqual([[text], ['I ate an apple and the pear.']]);
      session.dispose();
    });

    it('asks about at most 60 paragraphs or 30,000 characters at a time; the rest go on the next tick', async () => {
      expect([HARPER_MAX_PARAGRAPHS, HARPER_MAX_CHARS]).toEqual([60, 30_000]);
      const many = Array.from({ length: 61 }, (_, n) => `Line ${n + 1}.`);
      const s1 = withHarper(many.join('\n'), keyMissing);
      s1.session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(s1.harper)).toEqual([many.slice(0, 60)]);
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(s1.harper)).toEqual([many.slice(0, 60), ['Line 61.']]);
      s1.session.dispose();

      const long = (c: string) => c.repeat(12_000);
      const s2 = withHarper([long('a'), long('b'), long('c')].join('\n'), keyMissing);
      s2.session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(s2.harper)).toEqual([[long('a'), long('b')]]);
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
      expect(texts(s2.harper).at(-1)).toEqual([long('c')]);
      s2.session.dispose();

      const huge = 'x'.repeat(31_000); // one paragraph over the limit still goes, alone
      const s3 = withHarper(`${huge}\nShort.`, keyMissing);
      s3.session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS * 2);
      expect(texts(s3.harper)).toEqual([[huge], ['Short.']]);
      s3.session.dispose();
    });

    it('when an answer covers none of the paragraphs (Harper backing off), the rest wait for the next input: no loop', async () => {
      const many = Array.from({ length: 61 }, (_, n) => `Line ${n + 1}.`);
      const { session, adapter, harper } = withHarper(many.join('\n'), keyMissing, () => ({ status: 'ok', results: {}, dismissed: [] }));
      session.start();
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS * 10);
      expect(harper).toHaveLength(1);
      adapter.type(many.join('\n'));
      await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS * 10);
      expect(harper).toHaveLength(2);
      session.dispose();
    });

    describe('one text read per input', () => {
      it('the Harper tick and the re-locates share the read a keystroke made; Claude’s run reads afresh, once', async () => {
        const typed = 'I ate a apple.\nA dog.';
        const { session, adapter, sent, harper } = withHarper('I ate a apple.', byText({}), harperByText({ [typed.split('\n')[0]!]: [AN_A] }));
        adapter.reportsEveryChange = true;
        session.start();
        await vi.advanceTimersByTimeAsync(2000);
        adapter.reads = 0;
        adapter.type(typed);
        await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
        expect(texts(harper).at(-1)).toEqual(['A dog.']);
        await vi.advanceTimersByTimeAsync(1000 - HARPER_DEBOUNCE_MS);
        expect(texts(sent).at(-1)).toEqual(['A dog.']);
        expect(adapter.reads).toBe(2); // the keystroke's read, and Claude's own
        expect(session.issues().map((i) => [i.original, i.start])).toEqual([['a', 6]]);
        session.dispose();
      });

      it('a read still on its way when input arrives is not reused', async () => {
        const { session, adapter, harper } = withHarper('Old.', byText({}));
        adapter.reportsEveryChange = true;
        session.start();
        await vi.advanceTimersByTimeAsync(2000);
        const realRead = adapter.getText.bind(adapter);
        let finish!: () => void;
        adapter.getText = () => new Promise((r) => (finish = () => r('Old. Mid.'))); // the keystroke's read, held
        adapter.type('Old. Mid.');
        adapter.getText = realRead;
        adapter.type('Old. Mid. New.'); // reads the new text at once
        finish(); // the older read lands last
        await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
        expect(texts(harper).at(-1)).toEqual(['Old. Mid. New.']);
        session.dispose();
      });

      it('after a fix, a later read sees the fixed text, though the editor has not reported the edit yet', async () => {
        const t = 'Teh cat sat.';
        const { session, adapter } = withHarper(t, byText({ [t]: [raw({})] }));
        adapter.reportsEveryChange = true;
        session.start();
        await vi.advanceTimersByTimeAsync(2000);
        expect(session.issues().map((i) => i.original)).toEqual(['Teh']);
        expect(await session.accept(session.issues()[0]!.id)).toBe(true); // the fake reports no change for its own edit
        session.refilter();
        await vi.advanceTimersByTimeAsync(0);
        expect(adapter.text).toBe('The cat sat.');
        expect(session.issues()).toEqual([]);
        session.dispose();
      });

      it('after Accept all errors, too', async () => {
        const t = 'Teh cat sat.';
        const { session, adapter } = withHarper(t, byText({ [t]: [raw({})] }));
        adapter.reportsEveryChange = true;
        session.start();
        await vi.advanceTimersByTimeAsync(2000);
        expect(await session.acceptAllErrors()).toEqual({ applied: 1, failed: 0 });
        session.refilter();
        await vi.advanceTimersByTimeAsync(0);
        expect(adapter.text).toBe('The cat sat.');
        expect(session.issues()).toEqual([]);
        session.dispose();
      });

      it('Claude’s run reads afresh even when the adapter reports every change, so it never gets text from before a keystroke', async () => {
        const { session, adapter, sent, harper } = withHarper('Hello.', byText({}));
        adapter.reportsEveryChange = true;
        session.start();
        await vi.advanceTimersByTimeAsync(2000);
        adapter.type('Hello there.');
        await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
        expect(texts(harper).at(-1)).toEqual(['Hello there.']);
        adapter.text = 'Hello there!'; // typed, with the editor's report still on its way
        await vi.advanceTimersByTimeAsync(1000);
        expect(texts(sent).at(-1)).toEqual(['Hello there!']);
        session.dispose();
      });

      it('an adapter that may miss a change (a textarea set by script) is read afresh: Claude gets the text as it is', async () => {
        const { session, adapter, sent, harper } = withHarper('Hello.', byText({}));
        session.start();
        await vi.advanceTimersByTimeAsync(2000);
        adapter.type('Hello there.');
        await vi.advanceTimersByTimeAsync(HARPER_DEBOUNCE_MS);
        expect(texts(harper).at(-1)).toEqual(['Hello there.']);
        adapter.text = ''; // a chat page cleared its box after sending: no input event
        await vi.advanceTimersByTimeAsync(1000);
        expect(texts(sent)).toEqual([['Hello.']]);
        session.dispose();
      });
    });
  });
  describe('busy(): a check request is in flight', () => {
    it('is true from the request until its answer, and says so on each change, without an update of its own', async () => {
      let release!: (r: CheckResponse) => void;
      const { session, busy, updates } = setup('Teh cat.', () => new Promise((r) => (release = r)));
      expect(session.busy()).toBe(false);
      const p = session.checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.busy()).toBe(true);
      expect(busy).toEqual([true]);
      expect(updates).toHaveLength(0); // the issues didn't change: nothing to re-measure
      release(ok({ [hashText('Teh cat.')]: [raw({})] }));
      await p;
      expect(session.busy()).toBe(false);
      expect(busy).toEqual([true, false]);
      expect(session.issues()).toHaveLength(1);
    });

    it('is never true when nothing needs sending: the paragraphs were checked already', async () => {
      const { session, busy, sent } = setup('Teh cat.', byText({}));
      await session.checkNow();
      expect(busy).toEqual([true, false]);
      await session.checkNow(); // same text: re-located from what is held, no request
      expect(sent).toHaveLength(1);
      expect(busy).toEqual([true, false]);
      expect(session.busy()).toBe(false);
    });

    it('ends when the request fails, too', async () => {
      const { session, busy } = setup('Teh cat.', () => Promise.reject(new Error('down')));
      await session.checkNow();
      expect(session.status()).toBe('offline');
      expect(session.busy()).toBe(false);
      expect(busy).toEqual([true, false]);
      session.dispose();
    });
  });
  describe('checked(): the field has had its first answer', () => {
    it('is false until the first check ends, also while its request is in flight', async () => {
      let release!: (r: CheckResponse) => void;
      const { session } = setup('Teh cat.', () => new Promise((r) => (release = r)));
      expect(session.checked()).toBe(false);
      const p = session.checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.checked()).toBe(false);
      release(ok({}));
      await p;
      expect(session.checked()).toBe(true);
    });

    it('is true before the update that follows the answer, so that update can show it', async () => {
      const { session, deps } = setup('Teh cat.', byText({}));
      const seen: boolean[] = [];
      deps.onUpdate = () => seen.push(session.checked());
      await session.checkNow();
      expect(seen).toEqual([true]);
    });

    it('a check with nothing to send (an empty field) counts, and so does a failed one', async () => {
      const empty = setup('', byText({}));
      await empty.session.checkNow();
      expect(empty.sent).toHaveLength(0);
      expect(empty.session.checked()).toBe(true);
      const down = setup('Teh cat.', () => Promise.reject(new Error('down')));
      await down.session.checkNow();
      expect(down.session.checked()).toBe(true);
      down.session.dispose();
    });
  });
  describe('generic-phrasing tells', () => {
    const SERVES = 'The library serves as a meeting place.';
    const genericOn = (settings: { families: SuggestionPolicy['families'] }) => {
      settings.families = { ...settings.families, generic: true };
    };
    const quiet = () => ok({});
    beforeEach(() => {
      vi.mocked(detectTells).mockClear();
    });

    it('shows a tell before any Claude answer and sends nothing for it', async () => {
      const { session, adapter, settings, sent } = setup('', quiet);
      genericOn(settings);
      session.start();
      adapter.type(SERVES);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues().map((i) => [i.kind, i.original, i.replacement])).toEqual([['generic_phrasing', 'serves as', 'is']]);
      expect(sent).toHaveLength(0);
      session.dispose();
    });

    it('shows nothing while the generic toggle is off, and does no detection', async () => {
      const { session, adapter, sent } = setup('', quiet);
      session.start();
      adapter.type(SERVES);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toEqual([]);
      expect(detectTells).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
      session.dispose();
    });

    it('turning the toggle on shows the tell with no request, and off hides it again', async () => {
      const { session, settings, sent } = setup(SERVES, byText({}));
      await session.checkNow();
      expect(session.issues()).toEqual([]);
      genericOn(settings);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toHaveLength(1);
      settings.families = { ...settings.families, generic: false };
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toEqual([]);
      expect(sent).toHaveLength(1);
    });

    it('stays after Claude answers the paragraph, unless Claude flagged the same words', async () => {
      const { session, settings } = setup(SERVES, byText({}));
      genericOn(settings);
      await session.checkNow();
      expect(session.issues().map((i) => i.original)).toEqual(['serves as']);
      const claude = setup(SERVES, byText({ [SERVES]: [raw({ original: 'serves as', replacement: 'is', category: 'delivery', severity: 'suggestion', kind: 'generic_phrasing', reason: 'claude' })] }));
      genericOn(claude.settings);
      await claude.session.checkNow();
      expect(claude.session.issues().map((i) => i.reason)).toEqual(['claude']);
    });

    it('accepting the fix applies it with no request and the tell is gone', async () => {
      const { session, adapter, settings, sent } = setup(SERVES, quiet);
      genericOn(settings);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      const [issue] = session.issues();
      expect(await session.accept(issue!.id)).toBe(true);
      expect(adapter.text).toBe('The library is a meeting place.');
      expect(session.issues()).toEqual([]);
      expect(sent).toHaveLength(0);
    });

    it('a dismissed tell stays hidden', async () => {
      const { session, settings, persisted } = setup(SERVES, quiet);
      genericOn(settings);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      await session.dismiss(session.issues()[0]!.id);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.issues()).toEqual([]);
      expect(persisted).toEqual([dismissalKey(hashText(SERVES), 'serves as', 'generic_phrasing')]);
    });

    it('holds no entry for a paragraph that only has tells, so typing never grows the held results', async () => {
      const heldOf = (s: FieldSession) => (s as unknown as { raw: Map<string, ParagraphRaw> }).raw;
      const { session, adapter, settings } = setup('', byText({}));
      genericOn(settings);
      session.start();
      for (const n of [1, 2, 3]) {
        adapter.type(`Entry ${n} serves as a record.`);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(session.issues().map((i) => i.original)).toEqual(['serves as']);
      expect(heldOf(session).size).toBe(0);
      await session.checkNow();
      expect([...heldOf(session).values()]).toEqual([{ claude: [] }]);
      expect(session.issues().map((i) => i.original)).toEqual(['serves as']);
      session.dispose();
    });

    it('a dismissed tell stays dismissed when a fix elsewhere gives its paragraph a new hash', async () => {
      const text = 'The library serves as a meeting place, and teh door is red.';
      const { session, settings } = setup(text, byText({ [text]: [raw({ original: 'teh', replacement: 'the' })] }));
      genericOn(settings);
      await session.checkNow();
      expect(session.issues().map((i) => i.original).sort()).toEqual(['serves as', 'teh']);
      await session.dismiss(session.issues().find((i) => i.original === 'serves as')!.id);
      expect(await session.accept(session.issues().find((i) => i.original === 'teh')!.id)).toBe(true);
      expect(session.issues()).toEqual([]);
    });

    it('detects a paragraph once, and again when the mode changes', async () => {
      const { session, deps, settings } = setup('The offer is seamless.', quiet);
      genericOn(settings);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(detectTells).toHaveBeenCalledTimes(1);
      expect(session.issues()).toHaveLength(1);
      deps.getMode = () => 'casual';
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(detectTells).toHaveBeenCalledTimes(2);
      expect(session.issues()).toEqual([]);
    });

    it('keeps at most 500 paragraphs, dropping the oldest', async () => {
      const paragraph = (n: number) => `Entry ${n} serves as a record.`;
      const all = Array.from({ length: 501 }, (_, n) => paragraph(n + 1));
      const { session, adapter, settings } = setup(all.join('\n'), quiet);
      genericOn(settings);
      session.refilter();
      await vi.advanceTimersByTimeAsync(0);
      expect(detectTells).toHaveBeenCalledTimes(501);
      const locate = async (text: string) => {
        adapter.text = text;
        session.refilter();
        await vi.advanceTimersByTimeAsync(0);
      };
      await locate(paragraph(501));
      await locate(paragraph(300));
      expect(detectTells).toHaveBeenCalledTimes(501);
      await locate(paragraph(1));
      expect(detectTells).toHaveBeenCalledTimes(502);
    });
  });
});
