export interface MeasureOptions {
  /**
   * The element the field's underline layer is anchored in (overlay/anchor.ts). The browser clips the layer
   * to it and to everything above it, so rects are clipped only to the boxes from the field up to, not
   * including, this element: text painted but scrolled out of view keeps its rect and scrolls in already
   * underlined. Absent: the fixed-layer fallback, clipped to every box that hides the text.
   */
  clipUntil?: Element;
}

export interface EditorAdapter {
  readonly fieldId: string;
  readonly element: Element;
  getText(): Promise<string>;
  rectsFor(start: number, end: number, opts?: MeasureOptions): Promise<DOMRect[]>; // viewport coordinates
  /** Optional batch form: one entry per range, in input order, measured in a single layout pass where possible. */
  rectsForMany?(ranges: { start: number; end: number }[], opts?: MeasureOptions): Promise<DOMRect[][]>;
  replace(start: number, end: number, text: string): Promise<boolean>; // true only if a re-read confirms it
  select(start: number, end: number): Promise<void>;
  /**
   * Optional: the collapsed caret's offset in getText()'s text, or null (a selection, or no caret in the field).
   * Async where the editor can only be asked asynchronously (Google Docs).
   */
  caret?(): number | null | Promise<number | null>;
  /**
   * Optional: the selected range [start, end) in getText()'s text, or null when the selection is collapsed
   * or not (wholly) inside the field. Async where the editor can only be asked asynchronously (Google Docs).
   */
  selection?(): { start: number; end: number } | null | Promise<{ start: number; end: number } | null>;
  /**
   * Optional: the viewport rects of the selection's highlight as the editor painted it, in reading order (the
   * last is where the selection ends), or null when none was painted or none can be read. Async where the
   * paint has to be fetched (Google Docs). The range itself still comes from selection().
   */
  selectionRects?(): DOMRect[] | null | Promise<DOMRect[] | null>;
  /**
   * Optional: the element that scrolls the text when walking up from the field can't find it, because the
   * field is the scroller itself (Google Docs: the editor). The underline layer is anchored in it.
   */
  scrollRoot?(): Element | null;
  /**
   * Optional: the element the text paints in, when that isn't the field, with a stacking level of its own
   * (Google Docs: its tile container, z-index 22, in the editor's first child). The underline layer joins
   * that level (the same z-index) right after the anchor's child that holds it: over the text by tree
   * order, under the page's own UI above that level (Docs: the floating button at 23, the caret at 41).
   */
  paintRoot?(): Element | null;
  /**
   * Optional: where the pointer lands over the text, when that is only part of the field (Google Docs: the
   * tile manager, the editor's hit region; the editor also holds other UI, such as a floating button). A
   * hover counts only there.
   */
  hitRegion?(): Element | null;
  onChange(cb: () => void): () => void;
  /**
   * Optional: true when no change to the text happens without onChange (Google Docs compares each read with the
   * last). The session may then reuse a read until onChange fires. Not a textarea: a script can set its value
   * with no input event.
   */
  readonly reportsEveryChange?: boolean;
  /**
   * `scrolled`: the scrolled element (or document) when a scroll caused the change; absent otherwise.
   * `redrawn`: true when all that is known is that the editor redrew its lines (Google Docs' tiles), with no scroll
   * or resize behind it; a text change that did it also comes through onChange.
   */
  onLayoutChange(cb: (scrolled?: EventTarget | null, redrawn?: boolean) => void): () => void;
  isAlive(): boolean;
  dispose(): void;
}
