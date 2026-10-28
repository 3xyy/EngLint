import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../../src/entrypoints/options/App';
import { currentSection, SECTIONS } from '../../src/entrypoints/options/sections';
import { sendMessage } from '../../src/shared/messages';

vi.mock('../../src/shared/messages', () => ({ sendMessage: vi.fn() }));

beforeEach(() => {
  fakeBrowser.reset();
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendMessage).mockImplementation((async (name: string) => {
    if (name === 'keyStatus') return { saved: true, last4: '1234' };
    throw new Error(`unexpected ${name}`);
  }) as never);
});
afterEach(cleanup);

const TITLES = ['AI provider', 'Spending', 'Writing', 'Suggestions', 'On the page', 'Your writing style', 'Your rules', 'Google Docs'];

describe('currentSection', () => {
  const at = (...tops: number[]) => tops.map((top, i) => ({ id: `s${i}`, top }));

  it('is the last section whose top has reached the line', () => {
    expect(currentSection(at(-900, -300, 40, 600), 96)).toBe('s2');
    expect(currentSection(at(-900, -300, 96, 600), 96)).toBe('s2'); // exactly on the line
    expect(currentSection(at(-900, -300, 97, 600), 96)).toBe('s1');
  });

  it('is the first section while none has reached the line, and null with no sections', () => {
    expect(currentSection(at(120, 600), 96)).toBe('s0');
    expect(currentSection([], 96)).toBeNull();
  });

  it('skips a section that is not on the page', () => {
    expect(currentSection([{ id: 'a', top: -50 }, { id: 'b', top: null }, { id: 'c', top: 400 }], 96)).toBe('a');
  });
});

describe('the options page', () => {
  async function renderPage() {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'AI provider' })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('region', { name: 'Your rules' }).textContent).toContain('Nothing here yet'));
  }
  const nav = () => within(screen.getByRole('navigation', { name: 'Settings sections' }));

  it('has a card per section, each with a title and a one-line description, in the order of the nav', async () => {
    await renderPage();
    expect(SECTIONS.map((s) => s.title)).toEqual(TITLES);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(TITLES);
    for (const title of TITLES) {
      const card = screen.getByRole('region', { name: title });
      expect(card.querySelector('.settings-card-desc')?.textContent, title).toMatch(/\S/);
    }
  });

  it('the nav links to every card: each link points at the card of the same name', async () => {
    await renderPage();
    const links = nav().getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(TITLES);
    for (const a of links) {
      const target = document.getElementById(a.getAttribute('href')!.replace(/^#/, ''));
      expect(target, a.textContent!).toBe(screen.getByRole('region', { name: a.textContent! }));
    }
  });

  it('marks the section being read, and the one a click goes to', async () => {
    await renderPage();
    const current = () => nav().getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'location').map((a) => a.textContent);
    expect(current()).toEqual(['AI provider']);
    await act(async () => fireEvent.click(nav().getByRole('link', { name: 'Your rules' })));
    expect(current()).toEqual(['Your rules']);
  });
});
