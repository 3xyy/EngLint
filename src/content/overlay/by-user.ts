/**
 * Runs `fn` only for the user's own click or key. A page script's synthetic event (isTrusted false) does
 * nothing, so it can't drive the bar or the popover into spending the user's key (I3; the overlay's root is
 * closed too, except in the e2e build, whose Playwright input is trusted).
 */
export const byUser =
  <E extends { isTrusted: boolean }>(fn: (e: E) => void) =>
  (e: E) => {
    if (e.isTrusted) fn(e);
  };
