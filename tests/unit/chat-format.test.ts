import { describe, expect, it, vi } from 'vitest';
import { canApply, canApplyAll, EDITS_SENTINEL, locateEdit, MAX_EDITS, parseChatClientMessage, splitAnswer, visibleSoFar } from '../../src/core/chat-format';
import { foldTypography } from '../../src/core/typography';

// The real fold, counted.
vi.mock('../../src/core/typography', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/typography')>();
  return { ...real, foldTypography: vi.fn(real.foldTypography) };
});

describe('splitAnswer', () => {
  it('splits the message from the edits after the sentinel line', () => {
    const r = splitAnswer('Try this.\n@@EDITS@@\n[{"original":"a","replacement":"b"}]');
    expect(r.message).toBe('Try this.');
    expect(r.edits).toEqual([{ original: 'a', replacement: 'b' }]);
  });

  it('keeps the message and gives no edits for malformed JSON', () => {
    const r = splitAnswer('Try this.\n@@EDITS@@\n[{"original":"a","replacement":');
    expect(r).toEqual({ message: 'Try this.', edits: [] });
  });

  it('caps the edits at 8', () => {
    const edits = Array.from({ length: 9 }, (_, i) => ({ original: `o${i}`, replacement: `r${i}` }));
    const r = splitAnswer(`Several fixes.\n${EDITS_SENTINEL}\n${JSON.stringify(edits)}`);
    expect(MAX_EDITS).toBe(8);
    expect(r.edits).toHaveLength(8);
    expect(r.edits[7]).toEqual({ original: 'o7', replacement: 'r7' });
  });

  it('drops an edit whose original is over 300 characters, is empty or is unchanged, and keeps the rest', () => {
    const edits = [
      { original: 'x'.repeat(301), replacement: 'y' },
      { original: '', replacement: 'y' },
      { original: 'same', replacement: 'same' },
      { original: 'keep', replacement: 'kept' },
      { original: 'x'.repeat(300), replacement: 'y' },
    ];
    const r = splitAnswer(`Fixes.\n@@EDITS@@\n${JSON.stringify(edits)}`);
    expect(r.edits).toEqual([{ original: 'keep', replacement: 'kept' }, { original: 'x'.repeat(300), replacement: 'y' }]);
  });

  it('gives no edits when the JSON is not an array of edits', () => {
    expect(splitAnswer('Hi.\n@@EDITS@@\n{"original":"a","replacement":"b"}').edits).toEqual([]);
    expect(splitAnswer('Hi.\n@@EDITS@@\n[1, "two"]').edits).toEqual([]);
  });

  it('reads edits wrapped in a code fence', () => {
    const r = splitAnswer('Hi.\n@@EDITS@@\n```json\n[{"original":"a","replacement":"b"}]\n```');
    expect(r.edits).toEqual([{ original: 'a', replacement: 'b' }]);
  });

  it('returns the whole text as the message when there is no sentinel line', () => {
    expect(splitAnswer('  Just an answer.\n')).toEqual({ message: 'Just an answer.', edits: [] });
    // Mid-line, it is ordinary text.
    expect(splitAnswer('Write @@EDITS@@ here').message).toBe('Write @@EDITS@@ here');
  });
});

describe('visibleSoFar', () => {
  it('hides a partial sentinel at the end', () => {
    expect(visibleSoFar('Hello\n@@ED')).toBe('Hello');
    expect(visibleSoFar('Hello\n@')).toBe('Hello');
  });
  it('shows only the text before a complete sentinel', () => {
    expect(visibleSoFar('Hello\n@@EDITS@@\n[{"orig')).toBe('Hello');
    expect(visibleSoFar('Hello\n@@EDITS@@')).toBe('Hello');
  });
  it('shows a line that only starts like the sentinel once it differs', () => {
    expect(visibleSoFar('Hello\n@john')).toBe('Hello\n@john');
  });
  it('shows plain text as it is', () => {
    expect(visibleSoFar('Hello there')).toBe('Hello there');
  });
});

describe('parseChatClientMessage', () => {
  it('accepts a send and a reset', () => {
    const send = { type: 'send', tabId: 3, fieldId: 'f-1', mode: 'essay', text: 'Doc.', focus: { start: 0, end: 2 }, message: 'Hi' };
    expect(parseChatClientMessage(send)).toEqual(send);
    expect(parseChatClientMessage({ type: 'reset', tabId: 3, fieldId: 'f-1' })).toEqual({ type: 'reset', tabId: 3, fieldId: 'f-1' });
  });
  it('rejects anything else', () => {
    expect(parseChatClientMessage({ type: 'send', tabId: 3, fieldId: 'f-1', mode: 'loud', text: '', focus: null, message: 'Hi' })).toBeNull();
    expect(parseChatClientMessage({ type: 'reset', tabId: '3', fieldId: 'f' })).toBeNull();
    expect(parseChatClientMessage('send')).toBeNull();
  });
});

describe('locateEdit', () => {
  it("finds the only occurrence, in the text's own offsets", () => {
    expect(locateEdit('I has a cat. She runs.', 'She runs')).toEqual({ start: 13, end: 21 });
  });
  it('matches straight quotes against curled ones and maps back to the curled text', () => {
    expect(locateEdit('Well, it’s “fine” now.', 'it\'s "fine"')).toEqual({ start: 6, end: 17 });
  });
  it('says missing or ambiguous instead of guessing', () => {
    expect(locateEdit('I has a cat.', 'a dog')).toBe('missing');
    expect(locateEdit('I has a cat. I has a dog.', 'I has')).toBe('ambiguous');
  });
  it('finds nothing for an empty original', () => {
    expect(locateEdit('I has a cat.', '')).toBe('missing');
  });
  it("never matches part of a folded ellipsis", () => {
    expect(locateEdit('Wait… what', '..')).toBe('missing');
    expect(locateEdit('Wait… what', 'Wait...')).toEqual({ start: 0, end: 5 });
  });
});

describe('canApply', () => {
  const edit = (original: string, replacement: string) => ({ original, replacement });

  it('is ok for an original found once', () => {
    expect(canApply('I has a cat. She runs.', edit('I has', 'I have'), 'standard')).toBe('ok');
  });
  it('is ambiguous for an original found twice', () => {
    expect(canApply('I has a cat. I has a dog.', edit('I has', 'I have'), 'standard')).toBe('ambiguous');
  });
  it('is ok when the text has curled quotes where the original has straight ones', () => {
    expect(canApply('It’s a long day.', edit("It's a long day", "It's a hard day"), 'standard')).toBe('ok');
  });
  it('is blocked when the replacement changes a claim (a number, a date, a name or a quote)', () => {
    expect(canApply('We met in 2019.', edit('in 2019', 'in 2020'), 'standard')).toBe('blocked');
    expect(canApply('I asked Maria.', edit('asked Maria', 'asked Jon'), 'standard')).toBe('blocked');
  });
  it('in Essay mode is too_big for an edit adding 4 new words, and ok for 3', () => {
    const four = edit('The plan works', 'The plan works very well for us');
    const three = edit('The plan works', 'The plan works very well today');
    expect(canApply('The plan works.', four, 'essay')).toBe('too_big');
    expect(canApply('The plan works.', three, 'essay')).toBe('ok');
    expect(canApply('The plan works.', four, 'standard')).toBe('ok');
    expect(canApply('The plan works.', four, 'casual')).toBe('ok');
  });
  it('in Essay mode, an edit too big that also changes a claim is too_big; a small claims change stays blocked', () => {
    expect(canApply('We met in 2019.', edit('We met in 2019', 'We met in 2020 at a busy summer camp'), 'essay')).toBe('too_big');
    expect(canApply('We met in 2019.', edit('in 2019', 'in 2020'), 'essay')).toBe('blocked');
  });
  it('is missing when the original is not in the text', () => {
    expect(canApply('I has a cat.', edit('a dog', 'one dog'), 'standard')).toBe('missing');
  });
  it('says where the original is before judging the change: missing or ambiguous wins over blocked', () => {
    expect(canApply('We met.', edit('in 2019', 'in 2020'), 'standard')).toBe('missing');
    expect(canApply('We met in 2019 and in 2019.', edit('in 2019', 'in 2020'), 'standard')).toBe('ambiguous');
  });
});

describe('canApplyAll', () => {
  const TEXT = 'I has a cat. I has a dog. We met in 2019. It’s late.';
  const EDITS = [
    { original: 'a cat', replacement: 'one cat' },
    { original: 'I has', replacement: 'I have' },
    { original: 'in 2019', replacement: 'in 2020' },
    { original: 'a zebra', replacement: 'one zebra' },
    { original: "It's late", replacement: "It's very late tonight for us all" },
  ];

  it('judges each edit as canApply does, in order', () => {
    for (const mode of ['essay', 'standard', 'casual'] as const) {
      expect(canApplyAll(TEXT, EDITS, mode)).toEqual(EDITS.map((e) => canApply(TEXT, e, mode)));
    }
    expect(canApplyAll(TEXT, EDITS, 'essay')).toEqual(['ok', 'ambiguous', 'blocked', 'missing', 'too_big']);
    expect(canApplyAll(TEXT, [], 'standard')).toEqual([]);
  });

  it('folds the text once, however many edits it judges', () => {
    vi.mocked(foldTypography).mockClear();
    canApplyAll(TEXT, EDITS, 'standard');
    expect(vi.mocked(foldTypography).mock.calls.filter(([s]) => s === TEXT)).toHaveLength(1);
  });
});
