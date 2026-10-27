import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { dictionaryItem, rulesItem } from '../../src/shared/settings';
import { YourRules } from '../../src/shared/ui/YourRules';

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

describe('YourRules', () => {
  it('says what to do when there is nothing yet', async () => {
    const { container } = render(<YourRules />);
    await waitFor(() =>
      expect(container.textContent).toContain('Nothing here yet. Use “Stop suggesting” or “Add to dictionary” on a card.'),
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('lists rules by mode and kind label, and dictionary words', async () => {
    await rulesItem.setValue([
      { mode: 'essay', kind: 'wordy_phrase' },
      { mode: 'standard', kind: 'vague_word' },
    ]);
    await dictionaryItem.setValue(['kubernetes']);
    const { container } = render(<YourRules />);
    await waitFor(() => expect(container.textContent).toContain('in essays'));
    const text = container.textContent ?? '';
    expect(text).toContain('wordy phrases in essays');
    expect(text).toContain('vague words in other writing');
    expect(text).toContain('kubernetes');
    expect(text).not.toContain('Nothing here yet');
  });

  it('an unknown kind is shown with spaces for underscores', async () => {
    await rulesItem.setValue([{ mode: 'essay', kind: 'odd_new_kind' }]);
    const { container } = render(<YourRules />);
    await waitFor(() => expect(container.textContent).toContain('odd new kind in essays'));
  });

  it('Remove deletes exactly that rule, and exactly that word', async () => {
    await rulesItem.setValue([
      { mode: 'essay', kind: 'wordy_phrase' },
      { mode: 'standard', kind: 'wordy_phrase' },
    ]);
    await dictionaryItem.setValue(['kubernetes', 'zoom']);
    const { container, getAllByRole } = render(<YourRules />);
    await waitFor(() => expect(getAllByRole('button')).toHaveLength(4));
    const buttons = () => getAllByRole('button');
    await act(async () => fireEvent.click(buttons()[0]!));
    await waitFor(async () => expect(await rulesItem.getValue()).toEqual([{ mode: 'standard', kind: 'wordy_phrase' }]));
    expect(await dictionaryItem.getValue()).toEqual(['kubernetes', 'zoom']);
    await waitFor(() => expect(container.textContent).not.toContain('in essays'));
    await act(async () => fireEvent.click(getAllByRole('button').at(-1)!));
    await waitFor(async () => expect(await dictionaryItem.getValue()).toEqual(['kubernetes']));
    expect(await rulesItem.getValue()).toEqual([{ mode: 'standard', kind: 'wordy_phrase' }]);
  });
});
