import { suggestionToggle } from '../../core/match';
import type { FamilyToggle, LocatedIssue } from '../../core/types';

export interface OverlayItem {
  issue: LocatedIssue;
  rects: DOMRect[]; // in the coordinates of the layer they're drawn in (see mount.tsx)
  /** The field's text just before and after the issue, inside its paragraph: its card's preview. */
  context?: { before: string; after: string };
}

export const UNDERLINE_PX = 2;

export interface UnderlinesProps {
  items: OverlayItem[];
  /** Issues shown active: hovered, or with their card open. */
  active: ReadonlySet<string>;
  /** Issues no longer active whose tint is fading out. */
  fading: ReadonlySet<string>;
  /** Issues shown for the first time in this field, just now: their underlines draw in. */
  drawing: ReadonlySet<string>;
}

const box = (r: DOMRect) => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** A suggestion underline's accessible name, by the family toggle that governs it. */
const FAMILY_LABEL: Record<FamilyToggle, string> = {
  clarity: 'Clarity suggestion',
  engagement: 'Engagement suggestion',
  delivery: 'Delivery suggestion',
  generic: 'Generic phrasing',
};

/** How an issue's underline is drawn: errors solid, suggestions dotted, comment-only notes dashed. */
type Line = 'solid' | 'dotted' | 'dashed';

/**
 * An issue's style: its severity, and for a suggestion its family (the same one selectIssues filters it by). The
 * data attributes pick the colour (`family`) and the line (`line`) in overlay.css.
 */
function styleOf(issue: LocatedIssue): { classes: string; label?: string; data: { 'data-family': string; 'data-line': Line } } {
  if (issue.severity !== 'suggestion') return { classes: issue.severity, data: { 'data-family': 'correctness', 'data-line': 'solid' } };
  const family = suggestionToggle(issue);
  const line = issue.replacement === null ? 'dashed' : 'dotted';
  return { classes: `suggestion fam-${family}`, label: FAMILY_LABEL[family], data: { 'data-family': family, 'data-line': line } };
}

/**
 * One field's underlines, in the coordinates of the layer they're drawn in (its own field layer, or the
 * fixed layer's viewport): a 2px strip along the bottom of each rect, a solid line for errors, dots for
 * suggestions and dashes for comment-only notes, each in its family's colour. An active issue also gets a
 * tint, in its own colour, over its rects, under the strip.
 */
export function Underlines({ items, active, fading, drawing }: UnderlinesProps) {
  const tinted = items.filter(({ issue }) => active.has(issue.id) || fading.has(issue.id));
  return (
    <>
      {tinted.flatMap(({ issue, rects }) =>
        rects.map((r, k) => (
          <div
            key={`t/${issue.id}/${k}`}
            className={`englint-tint ${styleOf(issue).classes}${active.has(issue.id) ? '' : ' out'}`}
            data-family={styleOf(issue).data['data-family']}
            style={box(r)}
          />
        )),
      )}
      {items.flatMap(({ issue, rects }) => {
        const { classes, label, data } = styleOf(issue);
        return rects.map((r, k) => (
          <div
            key={`u/${issue.id}/${k}`}
            className={`englint-underline ${classes}${active.has(issue.id) ? ' active' : ''}${drawing.has(issue.id) ? ' draw' : ''}`}
            {...data}
            role={label ? 'img' : undefined}
            aria-label={label}
            style={{ left: r.left, top: r.bottom - UNDERLINE_PX, width: r.width }}
          />
        ));
      })}
    </>
  );
}

/** An accepted fix's green flash over the text it replaced; it fades by itself and is then removed. */
export function Flash({ rects }: { rects: DOMRect[] }) {
  return (
    <>
      {rects.map((r, k) => (
        <div key={k} className="englint-flash" style={box(r)} />
      ))}
    </>
  );
}
