import { byUser } from './ToolsPopover';

/** Round size of the button, px (overlay.css .englint-select-btn). */
export const SELECTION_BUTTON_SIZE = 26;
/** Gap between the selection's last rect and the button, px. */
const GAP = 4;

/** Where the button sits for a selection ending at `rect`: just after it, centred on its line, kept in view. */
export function buttonPosition(rect: DOMRect, viewport: { width: number; height: number }): { left: number; top: number } {
  const left = Math.min(rect.right + GAP, viewport.width - SELECTION_BUTTON_SIZE - GAP);
  const top = rect.top + rect.height / 2 - SELECTION_BUTTON_SIZE / 2;
  return {
    left: Math.max(GAP, left),
    top: Math.max(GAP, Math.min(top, viewport.height - SELECTION_BUTTON_SIZE - GAP)),
  };
}

/**
 * The EngLint button next to a field's selection. It lives in the fixed overlay. Its mousedown is
 * prevented, so pressing it never moves focus or the selection out of the field. Only the user's own
 * click opens the popover (byUser, I3).
 */
export function SelectionButton(props: { at: DOMRect; onClick(): void }) {
  const { left, top } = buttonPosition(props.at, { width: window.innerWidth, height: window.innerHeight });
  return (
    <button
      type="button"
      className="englint-select-btn"
      aria-label="EngLint: rewrite or find synonyms"
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={byUser(() => props.onClick())}
    >
      <svg width="16" height="16" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
        <path d="M6 35.5Q8.8 54.2 16.9 72.3L120 60.2Q121 46 116.1 24.5Z" fill="#FFD31A" />
        <path d="M14 92q8-14 16 0t16 0" fill="none" stroke="#E5402F" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M54 90c5 4 9 9 13 15c12-20 26-38 48-58" fill="none" stroke="#1E8E3E" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
