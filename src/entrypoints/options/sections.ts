/** The options page's sections in page order: each card's id (the nav's link target) and title. */
export const SECTIONS = [
  { id: 'provider', title: 'AI provider' },
  { id: 'spending', title: 'Spending' },
  { id: 'writing', title: 'Writing' },
  { id: 'suggestions', title: 'Suggestions' },
  { id: 'on-the-page', title: 'On the page' },
  { id: 'style', title: 'Your writing style' },
  { id: 'rules', title: 'Your rules' },
  { id: 'docs', title: 'Google Docs' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * The section being read: the last one whose top (viewport px) has scrolled up to `line`, or the first while none
 * has. A section not on the page (top null) is skipped; null when there are none.
 */
export function currentSection(tops: readonly { id: string; top: number | null }[], line: number): string | null {
  const shown = tops.filter((t): t is { id: string; top: number } => t.top !== null);
  let current = shown[0]?.id ?? null;
  for (const t of shown) if (t.top <= line) current = t.id;
  return current;
}
