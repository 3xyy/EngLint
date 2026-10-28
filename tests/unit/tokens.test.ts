import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = read('src/shared/ui/tokens.css');

/** The rule's selectors and custom properties, for the light rule (before the dark media query) or the dark one. */
function rule(scheme: 'light' | 'dark') {
  const at = tokens.indexOf('@media (prefers-color-scheme: dark)');
  const part = scheme === 'light' ? tokens.slice(0, at) : tokens.slice(at + '@media (prefers-color-scheme: dark)'.length);
  const [, selector, body] = /([^{}]+)\{([^{}]*)\}/.exec(scheme === 'light' ? part : part.replace(/^\s*\{/, ''))!;
  const vars = Object.fromEntries(Array.from(body!.matchAll(/--el-([\w-]+)\s*:\s*([^;]+);/g), (m) => [m[1]!, m[2]!.trim()]));
  return { selectors: selector!.split(',').map((s) => s.trim()), vars };
}
const light = rule('light');
const dark = rule('dark');
const scheme = { light: light.vars, dark: { ...light.vars, ...dark.vars } };

const luminance = (hex: string) =>
  [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('design tokens', () => {
  it('are defined for documents (:root) and shadow roots (:host), in both colour schemes', () => {
    for (const r of [light, dark]) expect(r.selectors).toEqual([':root', ':host']);
    expect(light.vars.accent).toBe('#4f46e5');
    expect(dark.vars.accent).toBe('#818cf8');
  });

  it('the dark scheme sets every colour again', () => {
    const shared = ['font', 'radius-card', 'radius-control', 'radius-pill', 'focus'];
    expect(Object.keys(dark.vars).sort()).toEqual(Object.keys(light.vars).filter((k) => !shared.includes(k)).sort());
  });

  it.each(['light', 'dark'] as const)('text the controls draw reads at 4.5:1 or more (%s)', (name) => {
    const t = scheme[name];
    const pairs = [
      ['text', 'bg'], ['text', 'surface'], ['text-2', 'bg'], ['text-2', 'surface'], ['text-2', 'surface-2'],
      ['on-accent', 'accent'], ['on-accent', 'accent-hover'], ['accent', 'bg'], ['accent', 'accent-soft'],
      ['ins', 'ins-bg'], ['del', 'bg'], ['bg', 'text'], ['text-3', 'bg'],
    ];
    const low = pairs.filter(([fg, bg]) => contrast(t[fg!]!, t[bg!]!) < 4.5);
    expect(low).toEqual([]);
  });

  it.each(['light', 'dark'] as const)('family colours stand out from the card at 3:1 or more, as dots and underlines (%s)', (name) => {
    const t = scheme[name];
    const low = ['correctness', 'clarity', 'engagement', 'delivery', 'generic'].filter((f) => contrast(t[f]!, t.bg!) < 3);
    expect(low).toEqual([]);
  });
});

describe('stylesheets', () => {
  const imports = (path: string) => Array.from(read(path).matchAll(/@import\s+'([^']+)';/g), (m) => m[1]!.split('/').pop());
  const firstRule = (path: string) => read(path).trim().split(/\s+/)[0];

  it('the overlay, the extension pages and the panel import the tokens before any rule', () => {
    expect(imports('src/content/overlay/overlay.css')).toEqual(['tokens.css', 'controls.css', 'word-limit.css']);
    expect(imports('src/shared/ui/ui.css')).toEqual(['tokens.css', 'controls.css']);
    expect(imports('src/entrypoints/sidepanel/panel.css')).toEqual(['tokens.css', 'word-limit.css']);
    for (const path of ['src/content/overlay/overlay.css', 'src/shared/ui/ui.css', 'src/entrypoints/sidepanel/panel.css'])
      expect(firstRule(path), path).toBe('@import');
  });

  it('underlines and tints keep the light scheme\u2019s family colours in both schemes: they lie on the page, not on a card', () => {
    const overlay = read('src/content/overlay/overlay.css');
    const lines = Object.fromEntries(Array.from(overlay.matchAll(/\[data-family='(\w+)'\]\s*\{\s*--el-fam:\s*([^;]+);/g), (m) => [m[1]!, m[2]!.trim()]));
    const families = ['correctness', 'clarity', 'engagement', 'delivery', 'generic'];
    expect(lines).toEqual(Object.fromEntries(families.map((f) => [f, light.vars[f]])));
    expect(families.filter((f) => contrast(lines[f]!, '#ffffff') < 3)).toEqual([]);
  });

  it('the controls paint only with the tokens: no colour of their own', () => {
    expect(read('src/shared/ui/controls.css').match(/#[0-9a-f]{3,8}\b|rgba?\(/gi)).toBeNull();
  });

  it('the overlay paints only with the tokens, but for the underlines\u2019 family colours', () => {
    const own = read('src/content/overlay/overlay.css').replace(/\[data-family='\w+'\]\s*\{\s*--el-fam:\s*#[0-9a-f]{6};\s*\}/gi, '');
    expect(own.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi)).toBeNull();
  });

  it('a segment\u2019s focus ring is declared once, after its selected look, so a selected segment shows it too', () => {
    const css = read('src/shared/ui/controls.css');
    expect(css.match(/\.el-seg-item:focus-visible/g)).toHaveLength(1);
    expect(css.indexOf('.el-seg-item:focus-visible')).toBeGreaterThan(css.indexOf(".el-seg-item[aria-checked='true']"));
  });

  it('the word-limit views paint only with the tokens too', () => {
    const css = read('src/shared/ui/word-limit.css');
    expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi)).toBeNull();
    expect(css).toContain('var(--el-ins)'); // the counter at or under the target
  });
});

describe('the badge', () => {
  type Rule = { classes: string[]; decls: Record<string, string> };
  /** The rules whose selectors are plain classes (`.a.b`), in source order, with their declarations. */
  const rules = (css: string): Rule[] =>
    Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).flatMap((m) => {
      const decls = Object.fromEntries(Array.from(m[2]!.matchAll(/([\w-]+)\s*:\s*([^;]+);?/g), (d) => [d[1]!, d[2]!.trim()]));
      return m[1]!
        .split(',')
        .map((sel) => sel.trim())
        .filter((sel) => /^(\.[\w-]+)+$/.test(sel))
        .map((sel) => ({ classes: sel.slice(1).split('.'), decls }));
    });
  const overlay = read('src/content/overlay/overlay.css');
  const darkAt = overlay.indexOf('@media (prefers-color-scheme: dark)');
  const controls = rules(read('src/shared/ui/controls.css'));
  const sheets = {
    light: [...controls, ...rules(darkAt < 0 ? overlay : overlay.slice(0, darkAt))],
    dark: [...controls, ...rules(overlay)], // the dark block comes last, so its rules win ties
  };
  /** A declaration on an element with `classes`: the most specific matching rule's, the later on a tie. */
  function cascade(scheme: 'light' | 'dark', classes: string[], prop: string): string | undefined {
    let best: { n: number; value: string } | undefined;
    for (const r of sheets[scheme]) {
      if (!(prop in r.decls) || !r.classes.every((c) => classes.includes(c))) continue;
      if (!best || r.classes.length >= best.n) best = { n: r.classes.length, value: r.decls[prop]! };
    }
    return best?.value;
  }
  /** A colour on the element: a hex, or a var() resolved through the element's own custom properties, then the tokens. */
  function colour(scheme: 'light' | 'dark', classes: string[], value: string | undefined): string {
    const v = /^var\(--([\w-]+)\)$/.exec(value ?? '')?.[1];
    if (!v) return value!;
    const own = cascade(scheme, classes, `--${v}`);
    if (own) return colour(scheme, classes, own);
    return scheme === 'light' ? light.vars[v.replace(/^el-/, '')]! : { ...light.vars, ...dark.vars }[v.replace(/^el-/, '')]!;
  }
  const TONES = [['red'], ['green'], ['grey'], ['amber'], ...['clarity', 'engagement', 'delivery', 'generic'].map((f) => ['family', `el-fam-${f}`])];

  it.each(['light', 'dark'] as const)('its numerals read at 4.5:1 or more on every fill (%s)', (scheme) => {
    const rows = TONES.map((tone) => {
      const classes = ['englint-badge', ...tone];
      const ink = colour(scheme, classes, cascade(scheme, classes, 'color'));
      const fill = colour(scheme, classes, cascade(scheme, classes, 'background'));
      return { tone: tone.join(' '), ink, fill, ratio: Math.round(contrast(ink, fill) * 100) / 100 };
    });
    expect(rows.filter((r) => !/^#[0-9a-f]{6}$/i.test(r.ink) || !/^#[0-9a-f]{6}$/i.test(r.fill))).toEqual([]);
    expect(rows.filter((r) => r.ratio < 4.5)).toEqual([]);
  });

  it('dark numerals only on the light scheme\u2019s lighter fills; the dark scheme keeps its own ink on all of them', () => {
    const ink = (scheme: 'light' | 'dark', tone: string[]) => cascade(scheme, ['englint-badge', ...tone], '--el-badge-ink');
    expect(TONES.filter((t) => ink('light', t) === 'var(--el-text)').map((t) => t.at(-1))).toEqual(['red', 'amber', 'el-fam-engagement', 'el-fam-generic']);
    expect(TONES.map((t) => ink('dark', t))).toEqual(TONES.map(() => 'var(--el-bg)'));
  });
});
