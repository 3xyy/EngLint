import { describe, expect, it, vi } from 'vitest';
import { harperConfig, type LintConfig } from '../../src/core/harper-config';
import type { LintLike } from '../../src/core/harper-map';
import { createHarperHost, type LinterLike } from '../../src/offscreen/harper-host';
import { HARPER_OFFSCREEN, type HarperLintMessage } from '../../src/shared/messages';

const DEFAULTS: LintConfig = { OxfordComma: true, LongSentences: true, SentenceCapitalization: true, AnA: true };

/** An AnA lint on the first " a " in the text, or none. */
function lintsFor(text: string): Record<string, LintLike[]> {
  const at = text.indexOf(' a ') + 1;
  if (at === 0) return { AnA: [] };
  const lint: LintLike = {
    span: () => ({ start: at, end: at + 1 }),
    lint_kind: () => 'Miscellaneous',
    message: () => 'Incorrect indefinite article.',
    suggestions: () => [{ kind: () => 0, get_replacement_text: () => 'an' }],
    suggestion_count: () => 1,
    free: () => {},
  };
  return { AnA: [lint] };
}

function fakeLinter(o: { setup?: () => Promise<void> } = {}) {
  const linter = {
    setup: vi.fn(o.setup ?? (async () => {})),
    getDefaultLintConfig: vi.fn(async () => ({ ...DEFAULTS })),
    // The current config drifts with each set: only the defaults may serve as the base.
    getLintConfig: vi.fn(async () => ({})),
    setLintConfig: vi.fn(async (_c: LintConfig) => {}),
    setDialect: vi.fn(async (_d: number) => {}),
    clearWords: vi.fn(async () => {}),
    importWords: vi.fn(async (_w: string[]) => {}),
    organizedLints: vi.fn(async (text: string) => lintsFor(text)),
  } satisfies LinterLike & Record<string, unknown>;
  return linter;
}

const msg = (o: Partial<HarperLintMessage> = {}): HarperLintMessage => ({
  target: HARPER_OFFSCREEN,
  mode: 'standard',
  dialect: 'en-US',
  words: [],
  paragraphs: [{ hash: 'h1', text: 'This is a apple.' }, { hash: 'h2', text: 'All good.' }],
  ...o,
});

describe('the offscreen Harper host', () => {
  it('lints each paragraph as plain text and maps the lints, keyed by hash', async () => {
    const linter = fakeLinter();
    const host = createHarperHost(() => linter);
    const reply = await host.lint(msg());
    expect(reply).toEqual({
      ok: true,
      results: {
        h1: [expect.objectContaining({ ruleId: 'harper:AnA', original: 'a', replacement: 'an', at: 8, suggestionCount: 1 })],
        h2: [],
      },
    });
    expect(linter.organizedLints).toHaveBeenCalledWith('This is a apple.', { language: 'plaintext', dedup: true });
  });

  it('returns only the rules the merge can show, so other correctness lints never leave the document', async () => {
    const linter = fakeLinter();
    const lint = (rule: string, lintKind: string, start: number, end: number, fix: string): Record<string, LintLike[]> => ({
      [rule]: [
        {
          span: () => ({ start, end }),
          lint_kind: () => lintKind,
          message: () => rule,
          suggestions: () => [{ kind: () => 0, get_replacement_text: () => fix }],
          suggestion_count: () => 1,
          free: () => {},
        },
      ],
    });
    const text = 'this is a apple, teh end';
    linter.organizedLints.mockResolvedValueOnce({
      ...lint('SentenceCapitalization', 'Capitalization', 0, 4, 'This'),
      ...lint('AnA', 'Miscellaneous', 8, 9, 'an'),
      ...lint('SpellCheck', 'Spelling', 17, 20, 'the'),
      ...lint('OkToOkay', 'WordChoice', 21, 24, 'End'),
    });
    const host = createHarperHost(() => linter);
    const reply = await host.lint(msg({ paragraphs: [{ hash: 'h1', text }] }));
    expect(reply.ok && reply.results.h1!.map((i) => i.ruleId)).toEqual(['harper:AnA', 'harper:SpellCheck']);
  });

  it('builds one linter and sets it up once, for concurrent first requests too', async () => {
    const linter = fakeLinter();
    const make = vi.fn(() => linter);
    const host = createHarperHost(make);
    await Promise.all([host.lint(msg()), host.lint(msg()), host.lint(msg({ mode: 'casual' }))]);
    expect(make).toHaveBeenCalledOnce();
    expect(linter.setup).toHaveBeenCalledOnce();
  });

  it('answers ok: false when setup fails, and builds a fresh linter on the next request', async () => {
    const broken = fakeLinter({ setup: async () => Promise.reject(new Error('CompileError')) });
    const working = fakeLinter();
    const make = vi.fn().mockReturnValueOnce(broken).mockReturnValueOnce(working);
    const host = createHarperHost(make);
    expect(await host.lint(msg())).toEqual({ ok: false });
    expect((await host.lint(msg())).ok).toBe(true);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('sets the mode’s rules from the defaults read once, only when the mode changes', async () => {
    const linter = fakeLinter();
    const host = createHarperHost(() => linter);
    await host.lint(msg({ mode: 'casual' }));
    await host.lint(msg({ mode: 'casual' }));
    await host.lint(msg({ mode: 'standard' }));
    expect(linter.setLintConfig.mock.calls).toEqual([[harperConfig('casual', DEFAULTS)], [harperConfig('standard', DEFAULTS)]]);
    expect(linter.setLintConfig.mock.calls[1]![0].SentenceCapitalization).toBe(true);
    expect(linter.getDefaultLintConfig).toHaveBeenCalledOnce();
    expect(linter.getLintConfig).not.toHaveBeenCalled();
  });

  it('replaces the dictionary only when the words change, so a removed word goes too', async () => {
    const linter = fakeLinter();
    const host = createHarperHost(() => linter);
    await host.lint(msg({ words: ['englint', 'harper'] }));
    await host.lint(msg({ words: ['englint', 'harper'] }));
    await host.lint(msg({ words: ['englint'] }));
    expect(linter.importWords.mock.calls).toEqual([[['englint', 'harper']], [['englint']]]);
    expect(linter.clearWords).toHaveBeenCalledTimes(2);
  });

  it('sets the dialect, then the rules and words again, since a new dialect starts a new linter inside Harper', async () => {
    const linter = fakeLinter();
    const host = createHarperHost(() => linter);
    await host.lint(msg({ words: ['englint'] }));
    await host.lint(msg({ words: ['englint'] }));
    await host.lint(msg({ words: ['englint'], dialect: 'en-GB' }));
    expect(linter.setDialect.mock.calls).toEqual([[0], [1]]);
    expect(linter.setLintConfig).toHaveBeenCalledTimes(2);
    expect(linter.importWords).toHaveBeenCalledTimes(2);
    expect(linter.setDialect.mock.invocationCallOrder[1]).toBeLessThan(linter.setLintConfig.mock.invocationCallOrder[1]!);
  });

  it('runs one request at a time, so a mode change never lands in the middle of another request', async () => {
    const linter = fakeLinter();
    const order: string[] = [];
    linter.setLintConfig.mockImplementation(async (c: LintConfig) => void order.push(c.SentenceCapitalization ? 'standard' : 'casual'));
    linter.organizedLints.mockImplementation(async (text: string) => {
      await new Promise((r) => setTimeout(r, 1));
      order.push(`lint:${text}`);
      return lintsFor(text);
    });
    const host = createHarperHost(() => linter);
    await Promise.all([
      host.lint(msg({ mode: 'casual', paragraphs: [{ hash: 'c', text: 'casual' }] })),
      host.lint(msg({ mode: 'standard', paragraphs: [{ hash: 's', text: 'standard' }] })),
    ]);
    expect(order).toEqual(['casual', 'lint:casual', 'standard', 'lint:standard']);
  });

  it('gives a paragraph no issues when linting it throws, and still answers for the rest', async () => {
    const linter = fakeLinter();
    linter.organizedLints.mockImplementationOnce(async () => Promise.reject(new Error('boom')));
    const host = createHarperHost(() => linter);
    expect(await host.lint(msg())).toEqual({ ok: true, results: { h1: [], h2: [] } });
  });
});
