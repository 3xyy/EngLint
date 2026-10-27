import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { canApply, canApplyAll, type ChatServerMessage } from '../../src/core/chat-format';
import { Chat, type ChatPortLike } from '../../src/entrypoints/sidepanel/Chat';
import { sendMessage } from '../../src/shared/messages';

// The side panel's Chat against a fake port (the test plays the background) and a fake content script
// (sendMessage answers fieldText and applyEdit).

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));
// The real canApply and canApplyAll, counted.
vi.mock('../../src/core/chat-format', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/chat-format')>();
  return { ...real, canApply: vi.fn(real.canApply), canApplyAll: vi.fn(real.canApplyAll) };
});

const DOC = 'I has a cat. I has a dog. We met in 2019.';
const EMPTY = 'Ask anything about this text. In essays, EngLint coaches rather than writes.';
const NO_FIELD = 'Click into a text box or document, then ask.';
const ELSEWHERE = 'Answering about another text box…';

type FakePort = ChatPortLike & {
  posted: unknown[];
  disconnected: boolean;
  /** The background sends `m`. */
  emit(m: ChatServerMessage): void;
  /** The port breaks (the worker went away). */
  drop(): void;
};

function fakePort(): FakePort {
  const onMessage: ((m: unknown) => void)[] = [];
  const onDisconnect: (() => void)[] = [];
  const port: FakePort = {
    posted: [],
    disconnected: false,
    postMessage(m: unknown) {
      port.posted.push(m);
    },
    disconnect() {
      port.disconnected = true;
    },
    onMessage: { addListener: (cb: (m: unknown) => void) => void onMessage.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => void onDisconnect.push(cb) },
    emit: (m: ChatServerMessage) => act(() => onMessage.forEach((cb) => cb(m))),
    drop: () => act(() => onDisconnect.forEach((cb) => cb())),
  };
  return port;
}

let ports: FakePort[] = [];
const connect = () => {
  const p = fakePort();
  ports.push(p);
  return p;
};
const port = () => ports.at(-1)!;

let docText = DOC;
let docMode: 'essay' | 'standard' | 'casual' = 'standard';
let applyResult: 'applied' | 'changed' | 'ambiguous' | 'blocked' | 'too_big' | 'failed' = 'applied';

beforeEach(() => {
  fakeBrowser.reset();
  ports = [];
  docText = DOC;
  docMode = 'standard';
  applyResult = 'applied';
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation((async (name: string) => {
    if (name === 'fieldText') return { ok: true, text: docText, focus: { start: 2, end: 5 }, mode: docMode };
    if (name === 'applyEdit') return { result: applyResult };
    throw new Error(`unexpected ${name}`);
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat(props: Partial<Parameters<typeof Chat>[0]> = {}) {
  return render(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} {...props} />);
}

const box = () => screen.getByPlaceholderText<HTMLTextAreaElement>('Ask about your writing…');
const log = () => screen.getByRole('log');

/** Types `message` and presses Enter, then waits for the send to reach the port. */
async function ask(message: string) {
  await waitFor(() => expect(box().disabled).toBe(false));
  fireEvent.change(box(), { target: { value: message } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(ports.at(-1)?.posted.some((m: unknown) => (m as { type: string }).type === 'send')).toBe(true));
}

describe('the Chat tab', () => {
  it('sends the tab, the field, its mode, text and focus, and the message', async () => {
    renderChat();
    await ask('  Is this clear?  ');
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('fieldText', { fieldId: 'f-1' }, { tabId: 7, frameId: 3 });
    expect(port().posted).toEqual([
      { type: 'send', tabId: 7, fieldId: 'f-1', mode: 'standard', text: DOC, focus: { start: 2, end: 5 }, message: 'Is this clear?' },
    ]);
    expect(log().textContent).toContain('Is this clear?');
    expect(box().value).toBe('');
  });

  it('shows the answer as it streams, never the edits line', async () => {
    renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'Try ' });
    expect(screen.getByTestId('chat-live').textContent).toMatch(/^Try$/);
    port().emit({ type: 'delta', text: 'this.' });
    expect(screen.getByTestId('chat-live').textContent).toMatch(/^Try this\.$/);
    port().emit({ type: 'delta', text: '\n@@EDI' });
    port().emit({ type: 'delta', text: 'TS@@\n[{"orig' });
    expect(screen.getByTestId('chat-live').textContent).toMatch(/^Try this\.$/);
    expect(log().textContent).not.toContain('@@');
  });

  it('while an answer streams the box is disabled; the end of the turn enables it', async () => {
    renderChat();
    await ask('Is this clear?');
    expect(box().disabled).toBe(true);
    port().emit({ type: 'delta', text: 'Yes.' });
    expect(box().disabled).toBe(true);
    port().emit({ type: 'done', message: 'Yes.', edits: [] });
    expect(box().disabled).toBe(false);
    expect(log().textContent).toContain('Yes.');
  });

  it('done shows each edit with Apply when it can be applied, and Copy when it is ambiguous, blocked or missing', async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({
      type: 'done',
      message: 'Some fixes.',
      edits: [
        { original: 'a cat', replacement: 'one cat' }, // once
        { original: 'I has', replacement: 'I have' }, // twice
        { original: 'in 2019', replacement: 'in 2020' }, // a claim
        { original: 'a zebra', replacement: 'one zebra' }, // not there
      ],
    });
    expect(screen.getByRole('button', { name: 'Apply edit 1' }).textContent).toContain('Apply');
    for (const n of [2, 3, 4]) {
      expect(screen.queryByRole('button', { name: `Apply edit ${n}` })).toBeNull();
      expect(screen.getByRole('button', { name: `Copy edit ${n}` }).textContent).toContain('Copy');
    }
    expect(screen.queryByRole('button', { name: 'Copy edit 1' })).toBeNull();
  });

  it("Apply sends the edit to the field's frame and then reads Applied", async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'One fix.', edits: [{ original: 'a cat', replacement: 'one cat' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit 1' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply edit 1' }).textContent).toContain('Applied'));
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith('applyEdit', { fieldId: 'f-1', original: 'a cat', replacement: 'one cat' }, { tabId: 7, frameId: 3 });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply edit 1' }).disabled).toBe(true);
  });

  it('Apply that the content script refuses as blocked says to copy it instead, and leaves Copy', async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'One fix.', edits: [{ original: 'a cat', replacement: 'one cat' }] });
    applyResult = 'blocked';
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit 1' }));
    expect(await screen.findByText("This edit can't be applied automatically. Copy it instead.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy edit 1' })).toBeTruthy();
  });

  it("Apply that the field couldn't confirm copies the edit and says so, leaving Copy", async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (t: string) => void copied.push(t) } });
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'One fix.', edits: [{ original: 'a cat', replacement: 'one cat' }] });
    applyResult = 'failed';
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit 1' }));
    expect(await screen.findByText("Couldn't apply here — copied to clipboard.")).toBeTruthy();
    expect(copied).toEqual(['one cat']);
    expect(screen.getByRole('button', { name: 'Copy edit 1' })).toBeTruthy();
  });

  it("Apply that the field couldn't confirm, with the clipboard refused, says it couldn't apply", async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: async () => {
          throw new Error('no focus');
        },
      },
    });
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'One fix.', edits: [{ original: 'a cat', replacement: 'one cat' }] });
    applyResult = 'failed';
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit 1' }));
    expect(await screen.findByText("Couldn't apply here.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy edit 1' })).toBeTruthy();
  });

  it('Apply on a text that changed says "The text changed. Ask again." and leaves Copy', async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'One fix.', edits: [{ original: 'a cat', replacement: 'one cat' }] });
    applyResult = 'changed';
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit 1' }));
    expect(await screen.findByText('The text changed. Ask again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy edit 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply edit 1' })).toBeNull();
  });

  it('Apply that the content script finds ambiguous says the text changed too', async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'One fix.', edits: [{ original: 'a cat', replacement: 'one cat' }] });
    applyResult = 'ambiguous';
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit 1' }));
    expect(await screen.findByText('The text changed. Ask again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy edit 1' })).toBeTruthy();
  });

  it('in Essay, an edit too big for the 3-word rule shows only its original, quoted, and says so: no replacement, no Copy', async () => {
    docMode = 'essay';
    renderChat();
    await ask('Fix it.');
    port().emit({
      type: 'done',
      message: 'Some ideas.',
      edits: [
        { original: 'a cat', replacement: 'a sleepy cat who naps all day' }, // 5 new words
        { original: 'in 2019', replacement: 'in 2020' }, // a claim
        { original: 'a dog', replacement: 'the dog' }, // light
      ],
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply edit 3' })).toBeTruthy());
    expect(log().textContent).toContain('“a cat”');
    expect(log().textContent).toContain('Too big a change to suggest for an essay — try revising it yourself.');
    expect(log().textContent).not.toContain('sleepy');
    expect(screen.queryByRole('button', { name: 'Apply edit 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy edit 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy edit 2' })).toBeTruthy(); // a claims change keeps Copy
    expect(screen.queryByRole('button', { name: 'Apply edit 2' })).toBeNull();
  });

  it('outside Essay the same edit gets Apply', async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'An idea.', edits: [{ original: 'a cat', replacement: 'a sleepy cat who naps all day' }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply edit 1' })).toBeTruthy());
    expect(log().textContent).not.toContain('Too big a change');
  });

  it('Apply that the content script finds too big for an essay hides the replacement and leaves no Copy', async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'One fix.', edits: [{ original: 'a cat', replacement: 'a sleepy cat' }] });
    applyResult = 'too_big';
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit 1' }));
    expect(await screen.findByText('Too big a change to suggest for an essay — try revising it yourself.')).toBeTruthy();
    expect(log().textContent).toContain('“a cat”');
    expect(log().textContent).not.toContain('sleepy');
    expect(screen.queryByRole('button', { name: 'Apply edit 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy edit 1' })).toBeNull();
  });

  it("Apply when the field's frame can't be reached says so and leaves Apply to try again", async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'One fix.', edits: [{ original: 'a cat', replacement: 'one cat' }] });
    const answer = vi.mocked(sendMessage).getMockImplementation()!;
    vi.mocked(sendMessage).mockImplementation((async (name: string, ...rest: unknown[]) => {
      if (name === 'applyEdit') throw new Error('no receiver');
      return (answer as (...a: unknown[]) => unknown)(name, ...rest);
    }) as never);
    fireEvent.click(screen.getByRole('button', { name: 'Apply edit 1' }));
    expect(await screen.findByText("Couldn't reach that text box. Click into it and try again.")).toBeTruthy();
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Apply edit 1' });
    expect(button.textContent).toBe('Apply');
    expect(button.disabled).toBe(false);
  });

  it('a status ends the turn with its copy, the text so far staying', async () => {
    renderChat({ spend: { spent: 25, cap: 25 } });
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'Partly' });
    port().emit({ type: 'status', status: 'rate_limited' });
    expect(log().textContent).toContain('Partly');
    expect(screen.getByText('Claude is busy right now. Try again in a moment.')).toBeTruthy();
    expect(box().disabled).toBe(false);

    await ask('Again?');
    port().emit({ type: 'status', status: 'paused_cap' });
    expect(screen.getByText(/^Monthly limit reached \(\$25\.00 of \$25\)\./)).toBeTruthy();
  });

  it('on a port error the partial text stays and a status line appears; the next ask connects again', async () => {
    renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'Half an ans' });
    port().drop();
    expect(log().textContent).toContain('Half an ans');
    expect(screen.getByText("Can't reach Claude. Check your connection.")).toBeTruthy();
    expect(box().disabled).toBe(false);
    await ask('Try again?');
    expect(ports).toHaveLength(2);
  });

  it('the empty state, and with no field the no-field copy with the box disabled', async () => {
    const { rerender } = renderChat({ fieldId: null });
    expect(screen.getByText(NO_FIELD)).toBeTruthy();
    expect(box().disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New chat' }).disabled).toBe(true);
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} />);
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByText(NO_FIELD)).toBeNull();
    await waitFor(() => expect(box().disabled).toBe(false));
  });

  it('New chat sends reset and clears the view', async () => {
    renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'done', message: 'Yes.', edits: [] });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(port().posted.at(-1)).toEqual({ type: 'reset', tabId: 7, fieldId: 'f-1' });
    expect(log().textContent).not.toContain('Is this clear?');
    expect(log().textContent).not.toContain('Yes.');
    expect(screen.getByText(EMPTY)).toBeTruthy();
  });

  it('New chat while an answer streams stops showing it and enables the box', async () => {
    renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'Partly' });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    port().emit({ type: 'delta', text: ' more' }); // sent before the background heard the reset
    expect(log().textContent).not.toContain('Partly');
    expect(log().textContent).not.toContain('more');
    expect(box().disabled).toBe(false);
  });

  it("shows the field's stored conversation, its edits judged against the field's current text", async () => {
    await fakeBrowser.storage.session.set({
      'chat:7:f-1': [
        { role: 'user', text: 'Fix my grammar.' },
        { role: 'assistant', text: 'Two fixes.', edits: [{ original: 'a dog', replacement: 'one dog' }, { original: 'I has', replacement: 'I have' }] },
      ],
    });
    renderChat();
    expect(await screen.findByText('Fix my grammar.')).toBeTruthy();
    expect(screen.getByText('Two fixes.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Apply edit 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy edit 2' })).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("another field's conversation replaces the view, and an answer still streaming for the first isn't painted there", async () => {
    await fakeBrowser.storage.session.set({ 'chat:7:f-2': [{ role: 'user', text: 'About the second box.' }, { role: 'assistant', text: 'Noted.' }] });
    const { rerender } = renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'For the first' });
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} />);
    expect(await screen.findByText('About the second box.')).toBeTruthy();
    port().emit({ type: 'delta', text: ' box' });
    expect(log().textContent).not.toContain('For the first'); // while it streams
    expect(log().textContent).not.toContain('Is this clear?');
    port().emit({ type: 'done', message: 'For the first box', edits: [] });
    expect(log().textContent).not.toContain('For the first'); // and once it's done
    expect(log().textContent).not.toContain('Is this clear?');
  });

  it("New chat on another field leaves the first field's answer streaming; it shows when the panel comes back", async () => {
    const { rerender } = renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'For the first' });
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} />);
    expect(await screen.findByText(ELSEWHERE)).toBeTruthy();
    expect(box().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(port().posted.at(-1)).toEqual({ type: 'reset', tabId: 7, fieldId: 'f-2' });
    expect(screen.getByText(ELSEWHERE)).toBeTruthy(); // still answering about the first box
    expect(box().disabled).toBe(true);

    // The background keeps the turn, then says it's done.
    await fakeBrowser.storage.session.set({ 'chat:7:f-1': [{ role: 'user', text: 'Is this clear?' }, { role: 'assistant', text: 'For the first box.' }] });
    port().emit({ type: 'delta', text: ' box.' });
    port().emit({ type: 'done', message: 'For the first box.', edits: [] });
    expect(screen.queryByText(ELSEWHERE)).toBeNull();
    expect(box().disabled).toBe(false);
    expect(log().textContent).not.toContain('For the first');

    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} />);
    expect(await screen.findByText('For the first box.')).toBeTruthy();
    expect(screen.getByText('Is this clear?')).toBeTruthy();
  });

  it('a field with no answer elsewhere shows no note about another text box', async () => {
    renderChat();
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(screen.queryByText(ELSEWHERE)).toBeNull();
    await ask('Is this clear?');
    expect(screen.queryByText(ELSEWHERE)).toBeNull(); // streaming here, not elsewhere
  });

  it('coming back to a field whose answer finishes after its conversation loaded shows the turn once', async () => {
    const { rerender } = renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'Yes' });
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} />);
    await waitFor(() => expect(screen.getByText(ELSEWHERE)).toBeTruthy());
    // The background stores the turn; the panel comes back and loads it; then the done arrives.
    await fakeBrowser.storage.session.set({ 'chat:7:f-1': [{ role: 'user', text: 'Is this clear?' }, { role: 'assistant', text: 'Yes, it is.' }] });
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} />);
    expect(await screen.findByText('Yes, it is.')).toBeTruthy();
    port().emit({ type: 'done', message: 'Yes, it is.', edits: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getAllByText('Is this clear?')).toHaveLength(1);
    expect(screen.getAllByText('Yes, it is.')).toHaveLength(1);
  });

  it('a status that arrives while the conversation loads stays, with the text so far, once it has loaded', async () => {
    await fakeBrowser.storage.session.set({ 'chat:7:f-1': [{ role: 'user', text: 'Earlier question.' }, { role: 'assistant', text: 'Earlier answer.' }] });
    const { rerender } = renderChat();
    expect(await screen.findByText('Earlier answer.')).toBeTruthy();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'Partly' });
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} />);
    await waitFor(() => expect(screen.getByText(ELSEWHERE)).toBeTruthy());
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} />); // the load starts
    port().emit({ type: 'status', status: 'rate_limited' }); // before it settles
    expect(await screen.findByText('Earlier answer.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(log().textContent).toContain('Partly');
    expect(screen.getByText('Claude is busy right now. Try again in a moment.')).toBeTruthy();
    expect(log().textContent!.indexOf('Earlier answer.')).toBeLessThan(log().textContent!.indexOf('Partly'));
  });

  it("doesn't judge the edits again while an answer streams", async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'Two fixes.', edits: [{ original: 'a cat', replacement: 'one cat' }, { original: 'a dog', replacement: 'one dog' }] });
    await ask('And now?');
    await waitFor(() => expect(box().disabled).toBe(true));
    const before = vi.mocked(canApplyAll).mock.calls.length;
    expect(before).toBeGreaterThan(0);
    for (const piece of ['Some', ' more', ' text', ' here', '.']) port().emit({ type: 'delta', text: piece });
    expect(screen.getByTestId('chat-live').textContent).toBe('Some more text here.');
    expect(vi.mocked(canApplyAll).mock.calls.length).toBe(before);
  });

  it('judges every edit of every answer against one read of the text at a time, never edit by edit', async () => {
    renderChat();
    await ask('Fix it.');
    port().emit({ type: 'done', message: 'Two fixes.', edits: [{ original: 'a cat', replacement: 'one cat' }, { original: 'a dog', replacement: 'one dog' }] });
    await ask('More?');
    port().emit({ type: 'done', message: 'One more.', edits: [{ original: 'We met', replacement: 'We first met' }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply edit 3' })).toBeTruthy());
    const all = [
      { original: 'a cat', replacement: 'one cat' },
      { original: 'a dog', replacement: 'one dog' },
      { original: 'We met', replacement: 'We first met' },
    ];
    expect(vi.mocked(canApplyAll)).toHaveBeenLastCalledWith(DOC, all, 'standard');
    expect(vi.mocked(canApply)).not.toHaveBeenCalled();
  });

  it("while hidden it reads nothing, whichever field the panel follows; once shown it reads the field it follows then", async () => {
    await fakeBrowser.storage.session.set({ 'chat:7:f-2': [{ role: 'user', text: 'About the second box.' }, { role: 'assistant', text: 'Noted.' }] });
    const { rerender } = renderChat({ shown: false });
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} shown={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(sendMessage)).not.toHaveBeenCalled();
    expect(screen.queryByText('About the second box.')).toBeNull();

    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} shown />);
    expect(await screen.findByText('About the second box.')).toBeTruthy();
    expect(vi.mocked(sendMessage).mock.calls.map((c) => [c[0], c[1]])).toEqual([['fieldText', { fieldId: 'f-2' }]]);
  });

  it('once shown and then hidden again, it follows a new field only when shown again', async () => {
    const { rerender } = renderChat();
    await waitFor(() => expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1));
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} shown={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1);
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} shown />);
    await waitFor(() => expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(sendMessage).mock.calls[1]![1]).toEqual({ fieldId: 'f-2' });
  });

  it('an answer that finishes while the Chat is hidden and the panel follows another field still shows when it comes back', async () => {
    const { rerender } = renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'Yes' });
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown={false} />);
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} shown={false} />);
    port().emit({ type: 'done', message: 'Yes, it is.', edits: [] });
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown={false} />);
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown />);
    expect(screen.getByText('Yes, it is.')).toBeTruthy();
    expect(screen.getByText('Is this clear?')).toBeTruthy();
  });

  it("a done that reads storage again reads its own field's conversation, even when the hidden panel follows another", async () => {
    await fakeBrowser.storage.session.set({ 'chat:7:f-2': [{ role: 'user', text: 'About the second box.' }, { role: 'assistant', text: 'Noted.' }] });
    const { rerender } = renderChat();
    await ask('Is this clear?');
    port().emit({ type: 'delta', text: 'Yes' });
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} />);
    expect(await screen.findByText('About the second box.')).toBeTruthy();
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} />); // a load during the turn
    await waitFor(() => expect(screen.queryByText('About the second box.')).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown={false} />);
    rerender(<Chat tabId={7} fieldId="f-2" frameId={3} spend={null} connect={connect} shown={false} />);
    await fakeBrowser.storage.session.set({ 'chat:7:f-1': [{ role: 'user', text: 'Is this clear?' }, { role: 'assistant', text: 'Yes, it is.' }] });
    port().emit({ type: 'done', message: 'Yes, it is.', edits: [] });
    await new Promise((r) => setTimeout(r, 20));
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown={false} />);
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown />);
    expect(await screen.findByText('Yes, it is.')).toBeTruthy();
    expect(screen.queryByText('About the second box.')).toBeNull();
  });

  it('a field that went away while the Chat was hidden (a reload) shows afresh when it comes back, even under the same id', async () => {
    await fakeBrowser.storage.session.set({ 'chat:7:f-1': [{ role: 'user', text: 'Before the reload.' }, { role: 'assistant', text: 'Old answer.' }] });
    const { rerender } = renderChat();
    expect(await screen.findByText('Old answer.')).toBeTruthy();
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown={false} />);
    rerender(<Chat tabId={7} fieldId={null} frameId={3} spend={null} connect={connect} shown={false} />); // the page reloads
    await fakeBrowser.storage.session.remove('chat:7:f-1'); // and the background ends its chats
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown={false} />);
    rerender(<Chat tabId={7} fieldId="f-1" frameId={3} spend={null} connect={connect} shown />);
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByText('Old answer.')).toBeNull();
  });

  it("a text box that can't be reached says so and sends nothing", async () => {
    vi.mocked(sendMessage).mockImplementation((async () => {
      throw new Error('no receiver');
    }) as never);
    renderChat();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: 'Is this clear?' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText("Couldn't reach that text box. Click into it and try again.")).toBeTruthy();
    expect(ports.flatMap((p) => p.posted)).toEqual([]);
    expect(box().value).toBe('Is this clear?');
  });

  it('Shift+Enter and Enter while composing (IME) send nothing; a blank message sends nothing', async () => {
    renderChat();
    await waitFor(() => expect(box().disabled).toBe(false));
    fireEvent.change(box(), { target: { value: 'Is this' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.change(box(), { target: { value: '   ' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 20));
    expect(ports.flatMap((p) => p.posted)).toEqual([]);
    expect(box().value).toBe('   ');
  });

  it('the box takes up to 2,000 characters', () => {
    renderChat();
    expect(box().maxLength).toBe(2000);
  });

  it('closes its port when the panel goes away', async () => {
    const { unmount } = renderChat();
    await ask('Is this clear?');
    unmount();
    expect(port().disconnected).toBe(true);
  });
});
