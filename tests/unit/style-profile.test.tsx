import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { sendMessage } from '../../src/shared/messages';
import { PRESETS } from '../../src/core/provider';
import { providerItem, styleProfileItem } from '../../src/shared/settings';
import { StyleProfile } from '../../src/shared/ui/StyleProfile';

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));

const send = vi.mocked(sendMessage) as unknown as ReturnType<typeof vi.fn>;
const PIECE = 'The harbour woke slowly, and I watched it from the pier. '; // 58 characters
const SAMPLES = PIECE.repeat(8); // 464 characters
const PROFILE = 'Short, plain sentences. Leans on concrete nouns.';

const pasteBox = () => screen.getByLabelText('Your writing (one to three pieces)') as HTMLTextAreaElement;
const profileBox = () => screen.getByLabelText('How you write (edit freely)') as HTMLTextAreaElement;
const buildButton = () => screen.getByRole('button', { name: /^(Build my style profile|Rebuild)/ }) as HTMLButtonElement;
const paste = (text = SAMPLES) => fireEvent.change(pasteBox(), { target: { value: text } });
const click = (name: string | RegExp) => act(async () => fireEvent.click(screen.getByRole('button', { name })));

beforeEach(() => {
  fakeBrowser.reset();
  send.mockReset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('StyleProfile', () => {
  it('explains what it does and that the pieces are not saved', async () => {
    const { container } = render(<StyleProfile />);
    await waitFor(() => expect(pasteBox()).toBeTruthy());
    expect(container.textContent).toContain(
      "Paste one to three pieces you're proud of. EngLint writes a short description of how you write and uses it for rewrites and synonyms. The pieces themselves aren't saved.",
    );
  });

  it('shows the cost in the button: under a cent for a short paste, about 2 cents for the longest', async () => {
    render(<StyleProfile />);
    await waitFor(() => expect(buildButton().textContent).toBe('Build my style profile · under $0.01')); // once the provider is read
    paste('x'.repeat(12_000));
    expect(buildButton().textContent).toBe('Build my style profile · about $0.02');
  });

  it('prices the build with the writer\'s prices off Claude, and says when the model has none', async () => {
    const openai = (prices: Record<string, { input: number; output: number }>) =>
      providerItem.setValue({
        active: 'compatible',
        compatible: { preset: 'openai', baseURL: PRESETS.openai.baseURL, fastModel: 'gpt-a', smartModel: 'gpt-b', structuredOutputs: true, prices },
      });
    await openai({ 'gpt-b': { input: 100, output: 400 } });
    render(<StyleProfile />);
    paste('x'.repeat(4000)); // 1,000 + 1,500 input tokens and 600 output: $0.25 + $0.24
    await waitFor(() => expect(buildButton().textContent).toBe('Build my style profile · about $0.49'));
    expect(screen.queryByText('Cost not known for this model.')).toBeNull();
    await act(() => openai({}));
    await waitFor(() => expect(buildButton().textContent).toBe('Build my style profile'));
    expect(screen.getByText('Cost not known for this model.')).toBeTruthy();
  });

  it('keeps the button off until there are 300 characters, and limits the paste to 12,000', async () => {
    render(<StyleProfile />);
    await waitFor(() => expect(pasteBox()).toBeTruthy());
    expect(buildButton().disabled).toBe(true);
    paste('x'.repeat(299));
    expect(buildButton().disabled).toBe(true);
    paste('x'.repeat(300));
    expect(buildButton().disabled).toBe(false);
    expect(pasteBox().maxLength).toBe(12_000);
  });

  it('a build sends the pieces to the background and shows the profile to edit, without saving it', async () => {
    send.mockResolvedValue({ status: 'ok', profile: PROFILE });
    render(<StyleProfile />);
    await waitFor(() => expect(pasteBox()).toBeTruthy());
    paste();
    await click(/^Build my style profile/);
    expect(send).toHaveBeenCalledWith('buildStyleProfile', { samples: SAMPLES });
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    expect(await styleProfileItem.getValue()).toBeNull();
    expect(pasteBox().value).toBe(''); // the pieces are dropped once they are used
    expect(screen.getByRole('status').textContent).toBe('Built, and your pasted pieces are cleared. Edit the profile if you like, then click Save.');
  });

  it('Save stores the edited profile, and says so', async () => {
    send.mockResolvedValue({ status: 'ok', profile: PROFILE });
    render(<StyleProfile />);
    await waitFor(() => expect(pasteBox()).toBeTruthy());
    paste();
    await click(/^Build my style profile/);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    fireEvent.change(profileBox(), { target: { value: `${PROFILE} Dry humour.` } });
    await click('Save');
    await waitFor(async () => expect((await styleProfileItem.getValue())?.text).toBe(`${PROFILE} Dry humour.`));
    expect((await styleProfileItem.getValue())?.updatedAt).toBeGreaterThan(0);
    expect(screen.getByRole('status').textContent).toBe('Profile saved.');
  });

  it('limits the profile box to 1,200 characters and does not save a blank profile', async () => {
    await styleProfileItem.setValue({ text: PROFILE, updatedAt: 1 });
    render(<StyleProfile />);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    expect(profileBox().maxLength).toBe(1200);
    fireEvent.change(profileBox(), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a saved profile, and Delete clears it', async () => {
    await styleProfileItem.setValue({ text: PROFILE, updatedAt: 1 });
    render(<StyleProfile />);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    await click('Delete');
    await waitFor(async () => expect(await styleProfileItem.getValue()).toBeNull());
    expect(screen.queryByLabelText('How you write (edit freely)')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Profile deleted.');
    expect(buildButton().textContent).toMatch(/^Build my style profile/);
  });

  it('Rebuild replaces the profile in the box with a new one from fresh pieces', async () => {
    await styleProfileItem.setValue({ text: PROFILE, updatedAt: 1 });
    send.mockResolvedValue({ status: 'ok', profile: 'Long, winding sentences.' });
    render(<StyleProfile />);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    expect(buildButton().textContent).toMatch(/^Rebuild · /);
    paste();
    await click(/^Rebuild/);
    await waitFor(() => expect(profileBox().value).toBe('Long, winding sentences.'));
    expect((await styleProfileItem.getValue())?.text).toBe(PROFILE); // until Save
    await click('Save');
    await waitFor(async () => expect((await styleProfileItem.getValue())?.text).toBe('Long, winding sentences.'));
  });

  it('shows a failed build in words, keeps the pieces and leaves the profile alone', async () => {
    send.mockResolvedValue({ status: 'paused_cap' });
    render(<StyleProfile />);
    await waitFor(() => expect(pasteBox()).toBeTruthy());
    paste();
    await click(/^Build my style profile/);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Monthly limit reached'));
    expect(pasteBox().value).toBe(SAMPLES);
    expect(screen.queryByLabelText('How you write (edit freely)')).toBeNull();
    send.mockResolvedValue({ status: 'bad_response' });
    await click(/^Build my style profile/);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Couldn't get a usable answer from Claude. Try again."));
  });

  it('a message that cannot be delivered says so', async () => {
    send.mockRejectedValue(new Error('no worker'));
    render(<StyleProfile />);
    await waitFor(() => expect(pasteBox()).toBeTruthy());
    paste();
    await click(/^Build my style profile/);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Couldn't build the profile. Try again."));
  });

  it('Save trims the profile and cuts it to 1,200 characters, and the box then shows what was saved', async () => {
    await styleProfileItem.setValue({ text: PROFILE, updatedAt: 1 });
    render(<StyleProfile />);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    fireEvent.change(profileBox(), { target: { value: `  ${PROFILE}\n ` } });
    await click('Save');
    await waitFor(async () => expect((await styleProfileItem.getValue())?.text).toBe(PROFILE));
    expect(profileBox().value).toBe(PROFILE);
    const long = `${'a'.repeat(1199)}bc`;
    fireEvent.change(profileBox(), { target: { value: ` ${long}` } }); // a paste can pass the box's maxLength
    await click('Save');
    await waitFor(async () => expect((await styleProfileItem.getValue())?.text).toBe(long.slice(0, 1200)));
    expect(profileBox().value).toBe(`${'a'.repeat(1199)}b`);
  });

  it('a Save or Delete that storage refuses says so and keeps the profile in the box', async () => {
    await styleProfileItem.setValue({ text: PROFILE, updatedAt: 1 });
    render(<StyleProfile />);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    const write = vi.spyOn(styleProfileItem, 'setValue').mockRejectedValue(new Error('quota'));
    fireEvent.change(profileBox(), { target: { value: `${PROFILE} Dry humour.` } });
    await click('Save');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Couldn't save the profile."));
    expect(profileBox().value).toBe(`${PROFILE} Dry humour.`);
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    await click('Delete');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe("Couldn't delete the profile."));
    expect(profileBox().value).toBe(`${PROFILE} Dry humour.`);
    write.mockRestore();
    expect((await styleProfileItem.getValue())?.text).toBe(PROFILE);
  });

  it('says "Not saved yet" while the box differs from the saved profile', async () => {
    send.mockResolvedValue({ status: 'ok', profile: PROFILE });
    render(<StyleProfile />);
    await waitFor(() => expect(pasteBox()).toBeTruthy());
    paste();
    await click(/^Build my style profile/);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    await click('Save');
    await waitFor(() => expect(screen.queryByText('Not saved yet')).toBeNull());
    fireEvent.change(profileBox(), { target: { value: `${PROFILE} Dry humour.` } });
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    fireEvent.change(profileBox(), { target: { value: PROFILE } });
    expect(screen.queryByText('Not saved yet')).toBeNull();
  });

  it('asks before the page closes while the box holds an unsaved profile, and not otherwise', async () => {
    await styleProfileItem.setValue({ text: PROFILE, updatedAt: 1 });
    render(<StyleProfile />);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    const leave = () => window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    expect(leave()).toBe(true); // not cancelled: nothing to lose
    fireEvent.change(profileBox(), { target: { value: `${PROFILE} Dry humour.` } });
    expect(leave()).toBe(false);
    await click('Save');
    await waitFor(() => expect(screen.queryByText('Not saved yet')).toBeNull());
    expect(leave()).toBe(true);
  });

  it('follows a save or delete from another tab while the box still shows the saved profile', async () => {
    await styleProfileItem.setValue({ text: PROFILE, updatedAt: 1 });
    render(<StyleProfile />);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    await act(() => styleProfileItem.setValue({ text: 'Long, winding sentences.', updatedAt: 2 }));
    await waitFor(() => expect(profileBox().value).toBe('Long, winding sentences.'));
    expect(screen.queryByText('Not saved yet')).toBeNull();
    await act(() => styleProfileItem.setValue(null));
    await waitFor(() => expect(screen.queryByLabelText('How you write (edit freely)')).toBeNull());
  });

  it('keeps an unsaved edit when another tab saves or deletes, and marks it not saved', async () => {
    await styleProfileItem.setValue({ text: PROFILE, updatedAt: 1 });
    render(<StyleProfile />);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    fireEvent.change(profileBox(), { target: { value: 'My own edit.' } });
    await act(() => styleProfileItem.setValue({ text: 'Long, winding sentences.', updatedAt: 2 }));
    await act(() => styleProfileItem.setValue(null));
    expect(profileBox().value).toBe('My own edit.');
    expect(screen.getByText('Not saved yet')).toBeTruthy();
  });

  it('writes only the profile to storage: the pasted pieces are never stored', async () => {
    const writes: Record<string, unknown>[] = [];
    fakeBrowser.storage.onChanged.addListener((changes) => writes.push(changes));
    send.mockResolvedValue({ status: 'ok', profile: PROFILE });
    render(<StyleProfile />);
    await waitFor(() => expect(pasteBox()).toBeTruthy());
    paste();
    await click(/^Build my style profile/);
    await waitFor(() => expect(profileBox().value).toBe(PROFILE));
    await click('Save');
    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(writes.flatMap((w) => Object.keys(w))).toEqual(['styleProfile']);
    expect(JSON.stringify(writes)).not.toContain('harbour');
    expect(JSON.stringify(await fakeBrowser.storage.local.get(null))).not.toContain('harbour');
    expect(JSON.stringify(await fakeBrowser.storage.sync.get(null))).not.toContain('harbour');
  });
});
