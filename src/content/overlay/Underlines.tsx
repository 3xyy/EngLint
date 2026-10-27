import { suggestionToggle } from '../../core/match';
import type { FamilyToggle, LocatedIssue } from '../../core/types';

export interface OverlayItem {
  issue: LocatedIssue;
  rects: DOMRect[]; // in the coordinates of the layer they're drawn in (see mount.tsx)
}

export const UNDERLINE_PX = 3;

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
export const FAMILY_LABEL: Record<FamilyToggle, string> = {
  clarity: 'Clarity suggestion',
  engagement: 'Engagement suggestion',
  delivery: 'Delivery suggestion',
  generic: 'Generic phrasing',
};

/** An issue's style: its severity, and for a suggestion its family (the same one selectIssues filters it by). */
function styleOf(issue: LocatedIssue): { classes: string; label?: string } {
  if (issue.severity !== 'suggestion') return { classes: issue.severity };
  const family = suggestionToggle(issue);
  return { classes: `suggestion fam-${family}`, label: FAMILY_LABEL[family] };
}

/**
 * One field's underlines, in the coordinates of the layer they're drawn in (its own field layer, or the
 * fixed layer's viewport): a 3px strip along the bottom of each rect, a red bar for errors, and dots in each
 * suggestion family's colour (dashes for generic phrasing). An active issue also gets a tint, in its own
 * colour, over its rects, under the strip.
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
            style={box(r)}
          />
        )),
      )}
      {items.flatMap(({ issue, rects }) => {
        const { classes, label } = styleOf(issue);
        return rects.map((r, k) => (
          <div
            key={`u/${issue.id}/${k}`}
            className={`englint-underline ${classes}${active.has(issue.id) ? ' active' : ''}${drawing.has(issue.id) ? ' draw' : ''}`}
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
