import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { localChecksItem } from '../../src/shared/settings';
import { LocalChecksToggle } from '../../src/shared/ui/LocalChecksToggle';

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

const isOn = (sw: HTMLElement) => sw.getAttribute('aria-checked') === 'true';
const HELP = "Underlines from EngLint's built-in checker appear as you type and work without the API.";

describe('LocalChecksToggle', () => {
  it('shows "Instant local checks" with its help line, on in fresh storage', async () => {
    const { getByLabelText, getByText } = render(<LocalChecksToggle />);
    const box = () => getByLabelText('Instant local checks');
    await waitFor(() => expect(isOn(box())).toBe(true));
    expect(box().getAttribute('role')).toBe('switch');
    expect(getByText(HELP)).toBeTruthy();
    const described = box().getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toBe(HELP);
  });

  it('unchecking stores false, checking again stores true', async () => {
    const { getByLabelText } = render(<LocalChecksToggle />);
    const box = () => getByLabelText('Instant local checks');
    await waitFor(() => expect(isOn(box())).toBe(true));
    await act(async () => fireEvent.click(box()));
    await waitFor(async () => expect(await localChecksItem.getValue()).toBe(false));
    expect(isOn(box())).toBe(false);
    await act(async () => fireEvent.click(box()));
    await waitFor(async () => expect(await localChecksItem.getValue()).toBe(true));
  });

  it('follows a change made elsewhere (the panel and Options show the same switch)', async () => {
    const { getByLabelText } = render(<LocalChecksToggle />);
    const box = () => getByLabelText('Instant local checks');
    await waitFor(() => expect(isOn(box())).toBe(true));
    await act(async () => localChecksItem.setValue(false));
    await waitFor(() => expect(isOn(box())).toBe(false));
  });
});
