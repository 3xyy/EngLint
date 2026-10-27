import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { suggestionFamiliesByModeItem } from '../../src/shared/settings';
import { FamilyToggles } from '../../src/shared/ui/FamilyToggles';

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

const OFF = { clarity: false, engagement: false, delivery: false, generic: false };

/** A switch's state as shown: checked, indeterminate, and its caption ('' when none). */
function shown(getByLabelText: (text: string) => HTMLElement, name: string) {
  const input = getByLabelText(name) as HTMLInputElement;
  const caption = input.closest('label')!.querySelector('.family-scope')?.textContent ?? '';
  return { checked: input.checked, mixed: input.indeterminate, caption };
}

describe('FamilyToggles', () => {
  it('shows four switches: on when both modes have the family, off when neither, mixed with where it is on otherwise', async () => {
    await suggestionFamiliesByModeItem.setValue({
      essay: { clarity: true, engagement: true, delivery: false, generic: false },
      standard: { clarity: true, engagement: false, delivery: true, generic: false },
      casual: OFF,
    });
    const { getByLabelText } = render(<FamilyToggles />);
    await waitFor(() => expect((getByLabelText('Clarity') as HTMLInputElement).checked).toBe(true));
    expect(shown(getByLabelText, 'Clarity')).toEqual({ checked: true, mixed: false, caption: '' });
    expect(shown(getByLabelText, 'Engagement')).toEqual({ checked: false, mixed: true, caption: 'Essays only' });
    expect(shown(getByLabelText, 'Delivery')).toEqual({ checked: false, mixed: true, caption: 'Other writing only' });
    expect(shown(getByLabelText, 'Generic phrasing')).toEqual({ checked: false, mixed: false, caption: '' });
  });

  it('with the shipped defaults, Engagement and Delivery read mixed, "Essays only"', async () => {
    const { getByLabelText } = render(<FamilyToggles />);
    await waitFor(() => expect((getByLabelText('Clarity') as HTMLInputElement).checked).toBe(true));
    expect(shown(getByLabelText, 'Clarity')).toEqual({ checked: true, mixed: false, caption: '' });
    expect(shown(getByLabelText, 'Engagement')).toEqual({ checked: false, mixed: true, caption: 'Essays only' });
    expect(shown(getByLabelText, 'Delivery')).toEqual({ checked: false, mixed: true, caption: 'Essays only' });
    expect(shown(getByLabelText, 'Generic phrasing')).toEqual({ checked: false, mixed: false, caption: '' });
  });

  it('a click on a mixed switch turns it on in both modes; a second click turns it off in both; casual stays off', async () => {
    const { getByLabelText } = render(<FamilyToggles />);
    await waitFor(() => expect(shown(getByLabelText, 'Engagement').mixed).toBe(true));
    const read = async () => (await suggestionFamiliesByModeItem.getValue())!;

    await act(async () => fireEvent.click(getByLabelText('Engagement')));
    await waitFor(async () => expect((await read())?.standard.engagement).toBe(true));
    expect(await read()).toEqual({
      essay: { clarity: true, engagement: true, delivery: true, generic: false },
      standard: { clarity: true, engagement: true, delivery: false, generic: false },
      casual: OFF,
    });
    expect(shown(getByLabelText, 'Engagement')).toEqual({ checked: true, mixed: false, caption: '' });

    await act(async () => fireEvent.click(getByLabelText('Engagement')));
    await waitFor(async () => expect((await read()).essay.engagement).toBe(false));
    expect((await read()).standard.engagement).toBe(false);
    expect((await read()).casual).toEqual(OFF);
    expect(shown(getByLabelText, 'Engagement')).toEqual({ checked: false, mixed: false, caption: '' });
  });

  it('a click on an off switch turns it on in both modes, and on an on switch off in both', async () => {
    const { getByLabelText } = render(<FamilyToggles />);
    await waitFor(() => expect((getByLabelText('Clarity') as HTMLInputElement).checked).toBe(true));
    const read = async () => (await suggestionFamiliesByModeItem.getValue())!;

    await act(async () => fireEvent.click(getByLabelText('Generic phrasing')));
    await waitFor(async () => expect((await read())?.essay.generic).toBe(true));
    expect((await read()).standard.generic).toBe(true);
    expect(shown(getByLabelText, 'Generic phrasing')).toEqual({ checked: true, mixed: false, caption: '' });

    await act(async () => fireEvent.click(getByLabelText('Clarity')));
    await waitFor(async () => expect((await read()).essay.clarity).toBe(false));
    expect((await read()).standard.clarity).toBe(false);
    expect((await read()).casual).toEqual(OFF);
  });

  it('with nothing saved yet it shows the defaults and saves nothing until a flip', async () => {
    const { getByLabelText } = render(<FamilyToggles />);
    await waitFor(() => expect((getByLabelText('Clarity') as HTMLInputElement).checked).toBe(true));
    expect((getByLabelText('Generic phrasing') as HTMLInputElement).checked).toBe(false);
    expect(await suggestionFamiliesByModeItem.getValue()).toBeNull();
  });
});
