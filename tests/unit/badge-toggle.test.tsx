import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { showBadgeItem } from '../../src/shared/settings';
import { BadgeToggle } from '../../src/shared/ui/BadgeToggle';

const isOn = (sw: HTMLElement) => sw.getAttribute('aria-checked') === 'true';

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

describe('BadgeToggle', () => {
  it('shows "Show the EngLint badge", on in fresh storage', async () => {
    const { getByLabelText } = render(<BadgeToggle />);
    await waitFor(() => expect(isOn(getByLabelText('Show the EngLint badge'))).toBe(true));
    expect(getByLabelText('Show the EngLint badge').getAttribute('role')).toBe('switch');
  });

  it('a click turns the badge off, a second click back on', async () => {
    const { getByLabelText } = render(<BadgeToggle />);
    const box = () => getByLabelText('Show the EngLint badge');
    await waitFor(() => expect(isOn(box())).toBe(true));
    await act(async () => fireEvent.click(box()));
    await waitFor(async () => expect(await showBadgeItem.getValue()).toBe(false));
    expect(isOn(box())).toBe(false);
    await act(async () => fireEvent.click(box()));
    await waitFor(async () => expect(await showBadgeItem.getValue()).toBe(true));
  });

  it('follows a change made elsewhere (the panel and Options show the same switch)', async () => {
    const { getByLabelText } = render(<BadgeToggle />);
    const box = () => getByLabelText('Show the EngLint badge');
    await waitFor(() => expect(isOn(box())).toBe(true));
    await act(async () => showBadgeItem.setValue(false));
    await waitFor(() => expect(isOn(box())).toBe(false));
  });
});
