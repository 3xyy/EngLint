// Stand-ins for a 2D canvas context: happy-dom has no CanvasRenderingContext2D implementation.
// Numbers follow a Docs page tile recorded live: 1469 × 1901 backing px shown at 816.11 CSS px,
// with the transform a = d = 1.8, e = f = -9.
import { vi } from 'vitest';

export const BACKING_W = 1469;
export const BACKING_H = 1901;
export const CSS_W = 816.11;
/** CSS px per backing px. */
export const RATIO = CSS_W / BACKING_W;
export const TILE: Matrix = { a: 1.8, b: 0, c: 0, d: 1.8, e: -9, f: -9 };
export const FONT = '14.6667px Arial';
export const SELECTION_BLUE = 'rgba(78, 143, 248, 0.5)';

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** The px size in a canvas font string, e.g. 14.6667 in `bold 14.6667px Arial`. */
export const fontPx = (font: string) => parseFloat(/(\d*\.?\d+)px/.exec(font)?.[1] ?? 'NaN');

/** A stand-in for CanvasRenderingContext2D.prototype. */
export function fakeProto() {
  return {
    fillText: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    // Half the font's pixel size per character, so a width shows which font was set when it was measured.
    measureText: vi.fn(function (this: { font: string }, text: string) {
      return { width: (text.length * fontPx(this.font)) / 2 };
    }),
  };
}
export type FakeProto = ReturnType<typeof fakeProto>;

export interface FakeCanvas {
  width: number;
  height: number;
  dataset: Record<string, string | undefined>;
  isConnected: boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

export interface FakeContext {
  canvas: FakeCanvas;
  font: string;
  fillStyle: unknown;
  textAlign: string;
  direction: string;
  transform: Matrix;
  getTransform(): Matrix;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
}

/** A context whose methods come from `proto`, on a canvas sized like a Docs page tile unless overridden. */
export function fakeContext(
  proto: FakeProto,
  options: { transform?: Matrix; cssWidth?: number; width?: number; height?: number } = {},
): FakeContext {
  const width = options.width ?? BACKING_W;
  const height = options.height ?? BACKING_H;
  const cssWidth = options.cssWidth ?? CSS_W;
  const canvas: FakeCanvas = {
    width,
    height,
    dataset: {},
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssWidth, height: (height * cssWidth) / width }),
  };
  const ctx = Object.create(proto) as FakeContext;
  Object.assign(ctx, {
    canvas,
    font: FONT,
    fillStyle: '#000000',
    textAlign: 'start',
    direction: 'ltr',
    transform: options.transform ?? TILE,
    getTransform(this: FakeContext) {
      return { ...this.transform };
    },
  });
  return ctx;
}

/** The fake prototype typed as the real one, for startCanvasRecorder. */
export const asProto = (proto: FakeProto) => proto as unknown as CanvasRenderingContext2D;
