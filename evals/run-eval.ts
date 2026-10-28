/**
 * Live-check prompt eval against the real Claude API (costs real money, a few cents per run).
 *   npm run eval              full run: key check, prefix tokens, cache check, fixtures
 *   npm run eval -- --dry-run validate fixtures and show the batches; no API calls
 *   npm run eval -- --fixtures <path>   use another fixture file (e.g. evals/holdout.fixtures.json)
 *     evals/grammarly-compare.fixtures.json: two paragraphs from a side-by-side with Grammarly; their labelled
 *     suggestions are reported (found, expected fix, hidden by the client) beside the errors
 *   npm run eval -- --suite suggestions|voice [--runs 2] [--dry-run] [--defaults (suggestions: run each fixture with its mode's default families)]
 *     the suggestion suites (pooled main + holdout; voice = clean essay paragraphs)
 * The key is read from .env as data and never printed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { LIVE_CHECK_MODEL, LiveCheckParseError, makeClient, runLiveCheck } from '../src/background/claude';
import { buildLiveCheckSystem, PROMPT_VERSION } from '../src/background/prompts/live-check';
import { costFromUsage, type UsageLike } from '../src/core/cost';
import { essayPolicy, toggleOf } from '../src/core/kinds';
import { capFamily, locateIssue, selectIssues, type SuggestionPolicy } from '../src/core/match';
import { ESSAY_FAMILY_DEFAULTS, defaultFamilies } from '../src/core/modes';
import { splitParagraphs } from '../src/core/paragraphs';
import { isCasualSuppressedEdit, isSuppressedEdit } from '../src/core/suppress';
import type { Dialect, FamilyToggle, FamilyToggles, LocatedIssue, Mode, Paragraph, RawIssue, SuggestionFamily } from '../src/core/types';
import { readEnvKey } from './read-env';
import { reportLabelledSuggestions, scoreSuggestions, type LabelledTally, type SuggestionScore } from './suggestion-scoring';

const MAIN_FIXTURES = 'evals/live-check.fixtures.json';
const PRIVATE_DIR = 'evals/private';
const MODES: Mode[] = ['essay', 'standard', 'casual'];
// Same limits as makeBatches in src/background/check-service.ts (not exported there).
const MAX_PARAGRAPHS = 12;
const MAX_CHARS = 6000;
// Brief targets.
const MIN_FIXTURES = 100;
const MIN_WITH_ERRORS = 40;
const MIN_CLEAN = 40;
const PRECISION_TARGET = 0.9;
const MIN_PREFIX_TOKENS = 512;
const COST_LIMIT_USD = 0.1;

const FamilySchema = z.enum(['clarity', 'engagement', 'delivery']);
const FixtureSchema = z.object({
  id: z.string(),
  mode: z.enum(['essay', 'standard', 'casual']),
  dialect: z.enum(['en-US', 'en-GB']).optional(),
  text: z.string(),
  expect: z.array(z.object({ original: z.string(), replacement: z.string() })),
  suggest: z
    .array(z.object({ original: z.string(), family: FamilySchema, kind: z.string().optional(), replacement: z.string().optional() }))
    .optional(),
  acceptable: z.array(z.object({ original: z.string(), family: FamilySchema })).optional(),
});
type Fixture = z.infer<typeof FixtureSchema>;
type Span = { start: number; end: number };
type Item = { fixture: Fixture; paragraph: Paragraph };

function occurrences(text: string, sub: string): number {
  let n = 0;
  for (let i = text.indexOf(sub); sub !== '' && i !== -1; i = text.indexOf(sub, i + 1)) n++;
  return n;
}

/** Private samples and the brief's minimum counts belong to the main set only; other sets run as given. */
function loadFixtures(path: string): { fixtures: Fixture[]; privateCount: number } {
  const parseFile = (file: string) => z.array(FixtureSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
  const isMainSet = path === MAIN_FIXTURES;
  const fixtures = parseFile(path);
  let privateCount = 0;
  if (isMainSet && existsSync(PRIVATE_DIR)) {
    for (const name of readdirSync(PRIVATE_DIR).filter((n) => n.endsWith('.json')).sort()) {
      const more = parseFile(join(PRIVATE_DIR, name));
      fixtures.push(...more);
      privateCount += more.length;
    }
  }

  const problems: string[] = [];
  const ids = new Set<string>();
  for (const f of fixtures) {
    if (ids.has(f.id)) problems.push(`${f.id}: duplicate id`);
    ids.add(f.id);
    for (const e of f.expect) {
      const n = occurrences(f.text, e.original);
      if (n !== 1) problems.push(`${f.id}: expected original "${e.original}" occurs ${n} times; it must occur exactly once`);
      if (f.mode === 'casual' && e.original !== e.replacement && e.original.toLowerCase() === e.replacement.toLowerCase()) {
        problems.push(`${f.id}: Casual mode never flags capitalization`);
      }
    }
    for (const l of [...(f.suggest ?? []), ...(f.acceptable ?? [])]) {
      const n = occurrences(f.text, l.original);
      if (n !== 1) problems.push(`${f.id}: label "${l.original}" occurs ${n} times; it must occur exactly once`);
    }
  }
  const withErrors = fixtures.filter((f) => f.expect.length > 0).length;
  const clean = fixtures.length - withErrors;
  if (isMainSet) {
    if (fixtures.length < MIN_FIXTURES) problems.push(`only ${fixtures.length} fixtures; need ${MIN_FIXTURES}`);
    if (withErrors < MIN_WITH_ERRORS) problems.push(`only ${withErrors} fixtures with errors; need ${MIN_WITH_ERRORS}`);
    if (clean < MIN_CLEAN) problems.push(`only ${clean} clean fixtures; need ${MIN_CLEAN}`);
  }
  if (problems.length) throw new Error(`bad fixtures:\n  ${problems.join('\n  ')}`);
  return { fixtures, privateCount };
}

/** Groups by mode and dialect (one request has one of each), then applies the check-service batch limits. */
function makeBatches(fixtures: Fixture[]): Item[][] {
  const groups = new Map<string, Item[]>();
  for (const fixture of fixtures) {
    const key = `${fixture.mode}|${fixture.dialect ?? 'en-US'}`;
    const items = groups.get(key) ?? [];
    for (const paragraph of splitParagraphs(fixture.text)) items.push({ fixture, paragraph });
    groups.set(key, items);
  }
  const batches: Item[][] = [];
  for (const items of groups.values()) {
    let cur: Item[] = [];
    let chars = 0;
    for (const it of items) {
      if (cur.length >= MAX_PARAGRAPHS || (cur.length > 0 && chars + it.paragraph.text.length > MAX_CHARS)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(it);
      chars += it.paragraph.text.length;
    }
    if (cur.length) batches.push(cur);
  }
  return batches;
}

function describeError(e: unknown): string {
  // Only status and message: SDK messages carry the API's error body, never request headers.
  if (e instanceof Anthropic.APIError) return `${e.name} ${e.status ?? ''}: ${e.message}`;
  if (!(e instanceof Error)) return String(e);
  // A LiveCheckParseError's cause (JSON or zod error) says why the model's reply was rejected.
  const cause = e.cause instanceof Error ? ` (cause: ${e.cause.name}: ${e.cause.message.slice(0, 400)})` : '';
  return `${e.name}: ${e.message}${cause}`;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const applyEdit = (text: string, span: Span, replacement: string) =>
  text.slice(0, span.start) + replacement + text.slice(span.end);
const usd = (n: number) => `$${n.toFixed(4)}`;
const ratio = (num: number, den: number) => (den === 0 ? 'n/a' : (num / den).toFixed(2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ModeStats {
  fixtures: number;
  flagged: number;
  correct: number;
  expected: number;
  found: number;
  fixMatch: number;
  clarity: number;
  dropped: number;
}

// ---------------------------------------------------------------------------------------------
// Suggestion and voice suites. Scoring lives in ./suggestion-scoring (pure, unit-tested).
// ---------------------------------------------------------------------------------------------
const SUGGESTION_FILES = ['evals/suggestions.fixtures.json', 'evals/suggestions-holdout.fixtures.json'];
const VOICE_FILES = ['evals/voice.fixtures.json', 'evals/voice-holdout.fixtures.json'];
const FAMILIES: SuggestionFamily[] = ['clarity', 'engagement', 'delivery'];
const ALL_ON: FamilyToggles = { clarity: true, engagement: true, delivery: true, generic: true };
const SUGGESTION_PRECISION_TARGET = 0.9;
const ERROR_PRECISION_TARGET = 0.95;
const VOICE_MAX_PER_300_WORDS = 1;
const MIN_POSITIVE_PER_FAMILY = 15;
const MIN_CLEAN_PER_FAMILY = 15;
const MIN_CURLED_POSITIVES = 6;
const MIN_QUOTE_POSITIVES = 3;
const MIN_VOICE = 20;
const MIN_VOICE_HOLDOUT = 10;
// Clean suggestion fixtures are tagged by id prefix with the family they tempt; generic phrasing is a delivery kind.
const CLEAN_PREFIX: Record<string, SuggestionFamily> = { clar: 'clarity', eng: 'engagement', del: 'delivery', gen: 'delivery' };
const CURLED = /[‘’“”]/;
const CURLED_QUOTE = /[‘“”]/;
const VoiceSchema = z.object({ id: z.string(), text: z.string() });

interface SuiteSet {
  file: string;
  fixtures: Fixture[];
}

const hasLabels = (f: Fixture) => (f.suggest?.length ?? 0) + (f.acceptable?.length ?? 0) > 0;

function loadSuggestionSets(files: string[]): SuiteSet[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const sets = files.map((file) => ({ file, fixtures: z.array(FixtureSchema).parse(JSON.parse(readFileSync(file, 'utf8'))) }));
  for (const { file, fixtures } of sets) {
    const pos = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<SuggestionFamily, number>;
    const clean = { ...pos };
    let curled = 0;
    let quoted = 0;
    let generic = 0;
    for (const f of fixtures) {
      const where = `${file} ${f.id}`;
      if (ids.has(f.id)) problems.push(`${where}: duplicate id`);
      ids.add(f.id);
      if (f.mode === 'casual') problems.push(`${where}: Casual mode never gets suggestions`);
      if (f.expect.length > 0) problems.push(`${where}: suggestion fixtures must not contain labelled errors`);
      for (const e of f.expect) {
        if (occurrences(f.text, e.original) !== 1) problems.push(`${where}: expect "${e.original}" must occur exactly once`);
      }
      const labels = [...(f.suggest ?? []), ...(f.acceptable ?? [])];
      for (const l of labels) {
        const n = occurrences(f.text, l.original);
        if (n !== 1) problems.push(`${where}: label "${l.original}" occurs ${n} times; it must occur exactly once`);
      }
      for (const l of f.suggest ?? []) {
        if (l.kind && f.mode === 'essay' && essayPolicy(l.kind) === 'off') {
          problems.push(`${where}: kind ${l.kind} is off in Essay, so it cannot be expected there`);
        }
        if (l.kind === 'generic_phrasing' && l.family !== 'delivery') problems.push(`${where}: generic_phrasing is a delivery kind`);
      }
      for (const fam of new Set((f.suggest ?? []).map((l) => l.family))) pos[fam]++;
      for (const l of f.suggest ?? []) if (l.kind === 'generic_phrasing') generic++;
      if ((f.suggest ?? []).some((l) => CURLED.test(l.original))) curled++;
      if ((f.suggest ?? []).some((l) => CURLED_QUOTE.test(l.original))) quoted++;
      if (!hasLabels(f)) {
        const fam = CLEAN_PREFIX[f.id.split('-')[0] ?? ''];
        if (!fam) problems.push(`${where}: a clean fixture id must start with clar-, eng-, del- or gen-`);
        if (fam) clean[fam]++;
      } else if (CLEAN_PREFIX[f.id.split('-')[0] ?? ''] && f.id.includes('-ok-')) {
        problems.push(`${where}: an "-ok-" fixture must have no labels`);
      }
    }
    for (const fam of FAMILIES) {
      if (pos[fam] < MIN_POSITIVE_PER_FAMILY) problems.push(`${file}: only ${pos[fam]} ${fam} positives; need ${MIN_POSITIVE_PER_FAMILY}`);
      if (clean[fam] < MIN_CLEAN_PER_FAMILY) problems.push(`${file}: only ${clean[fam]} clean ${fam} fixtures; need ${MIN_CLEAN_PER_FAMILY}`);
    }
    if (curled < MIN_CURLED_POSITIVES) problems.push(`${file}: only ${curled} curled-typography positives; need ${MIN_CURLED_POSITIVES}`);
    if (quoted < MIN_QUOTE_POSITIVES) problems.push(`${file}: only ${quoted} positives with a curled quote mark inside the labelled span; need ${MIN_QUOTE_POSITIVES}`);
    const lens = (xs: Fixture[]) => xs.map((f) => wordCount(f.text)).sort((x, y) => x - y);
    const med = (xs: number[]) => (xs.length === 0 ? 0 : (xs[Math.floor((xs.length - 1) / 2)]! + xs[Math.ceil((xs.length - 1) / 2)]!) / 2);
    const posMed = med(lens(fixtures.filter((f) => (f.suggest?.length ?? 0) > 0)));
    const cleanFixtures = fixtures.filter((f) => !hasLabels(f));
    const cleanMed = med(lens(cleanFixtures));
    const single = cleanFixtures.filter((f) => (f.text.match(/[.!?](\s|$)/g) ?? []).length <= 1).length;
    if (Math.abs(posMed - cleanMed) > 3) problems.push(`${file}: median length ${posMed} (positives) vs ${cleanMed} (clean); keep them within 3 words`);
    if (single > cleanFixtures.length / 3) problems.push(`${file}: ${single} of ${cleanFixtures.length} clean fixtures are one sentence; at most a third`);
    console.log(`    median words: positives ${posMed}, clean ${cleanMed}; one-sentence clean ${single}/${cleanFixtures.length}`);
    console.log(
      `  ${file}: ${fixtures.length} fixtures | positives ` +
        FAMILIES.map((fam) => `${fam} ${pos[fam]}`).join(', ') + ` | clean ` +
        FAMILIES.map((fam) => `${fam} ${clean[fam]}`).join(', ') + ` | curled positives ${curled} (quote marks ${quoted}) | generic positives ${generic}`,
    );
    for (const mode of ['essay', 'standard'] as const) {
      const inMode = fixtures.filter((f) => f.mode === mode);
      console.log(`    ${mode}: ${inMode.filter((f) => (f.suggest?.length ?? 0) > 0).length} positive, ${inMode.filter((f) => !hasLabels(f)).length} unlabelled`);
    }
  }
  if (problems.length) throw new Error(`bad fixtures:\n  ${problems.join('\n  ')}`);
  return sets;
}

function voiceFiles(): string[] {
  const priv = existsSync(PRIVATE_DIR) ? readdirSync(PRIVATE_DIR).filter((n) => /voice.*\.json$/.test(n)).sort() : [];
  return [...VOICE_FILES, ...priv.map((n) => join(PRIVATE_DIR, n))];
}

function loadVoiceSets(files: string[]): SuiteSet[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const sets = files.map((file, i) => {
    const rows = z.array(VoiceSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
    const min = i === 0 ? MIN_VOICE : i === 1 ? MIN_VOICE_HOLDOUT : 1;
    if (rows.length < min) problems.push(`${file}: only ${rows.length} voice fixtures; need ${min}`);
    for (const r of rows) {
      if (ids.has(r.id)) problems.push(`${file}: duplicate id ${r.id}`);
      ids.add(r.id);
    }
    console.log(`  ${file}: ${rows.length} voice paragraphs, ${rows.reduce((n, r) => n + wordCount(r.text), 0)} words`);
    return { file, fixtures: rows.map((r): Fixture => ({ id: r.id, mode: 'essay', text: r.text, expect: [] })) };
  });
  if (problems.length) throw new Error(`bad fixtures:\n  ${problems.join('\n  ')}`);
  return sets;
}

const wordCount = (text: string) => (text.match(/[\p{L}\p{N}'’]+/gu) ?? []).length;
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

type Tally = { correct: number; flagged: number };
const emptyToggles = (): Record<FamilyToggle, Tally> => ({
  clarity: { correct: 0, flagged: 0 },
  engagement: { correct: 0, flagged: 0 },
  delivery: { correct: 0, flagged: 0 },
  generic: { correct: 0, flagged: 0 },
});
interface SetStats {
  perFamily: Record<SuggestionFamily, { correct: number; flagged: number }>;
  /** Keyed by settings toggle (generic_phrasing is `generic`), overall and by fixture mode. */
  perToggle: Record<FamilyToggle, Tally>;
  perToggleByMode: Record<Mode, Record<FamilyToggle, Tally>>;
  byToggle: Record<FamilyToggle, number>;
  words: number;
}
const emptySet = (): SetStats => ({
  perFamily: Object.fromEntries(FAMILIES.map((f) => [f, { correct: 0, flagged: 0 }])) as SetStats['perFamily'],
  perToggle: emptyToggles(),
  perToggleByMode: { essay: emptyToggles(), standard: emptyToggles(), casual: emptyToggles() },
  byToggle: { clarity: 0, engagement: 0, delivery: 0, generic: 0 },
  words: 0,
});

interface RunResult {
  cost: number;
  paragraphs: number;
  failures: string[];
  /** Paragraphs the model returned no result for; they would otherwise read as clean. */
  missing: number;
  droppedInvalid: number;
  /** Errors shown on suggestion fixtures (all unexpected: those fixtures contain none). */
  errorFlags: number;
  sets: Map<string, SetStats>;
  details: string[];
}

async function runSuggestionSuite(suite: 'suggestions' | 'voice', dryRun: boolean, runs: number, useDefaults = false): Promise<number> {
  // --defaults: each fixture's client policy uses its mode's default families; otherwise every family is on.
  // The request never varies: it always asks for every family the mode allows (the family toggles filter on the client, so flipping one needs no new request).
  const familiesFor = (mode: Mode): FamilyToggles => (useDefaults ? defaultFamilies(mode) : ALL_ON);
  console.log(`EngLint ${suite} eval | prompt ${PROMPT_VERSION} | model ${LIVE_CHECK_MODEL} | ${runs} run(s) | families: ${useDefaults ? 'defaults per mode' : 'all on'}`);
  const sets = suite === 'suggestions' ? loadSuggestionSets(SUGGESTION_FILES) : loadVoiceSets(voiceFiles());
  const fixtures = sets.flatMap((s) => s.fixtures);
  const batches = makeBatches(fixtures);
  console.log(`pooled: ${fixtures.length} fixtures in ${batches.length} batches per run`);
  if (dryRun) {
    for (const [i, b] of batches.entries()) {
      const f = b[0]!.fixture;
      console.log(`  batch ${i + 1}: ${f.mode} ${f.dialect ?? 'en-US'}, ${b.length} paragraphs`);
    }
    console.log('dry run: fixtures valid, no API calls made');
    return 0;
  }

  const client = makeClient(readEnvKey());
  console.log('.env: ANTHROPIC_API_KEY parsed (value not shown)');
  const [stableBlock] = buildLiveCheckSystem('standard', 'en-US');
  const prefix = await client.messages.countTokens({
    model: LIVE_CHECK_MODEL,
    system: [stableBlock!],
    messages: [{ role: 'user', content: '.' }],
  });
  console.log(`stable prefix tokens: ${prefix.input_tokens}`);

  const setOf = new Map<Fixture, string>();
  for (const set of sets) for (const f of set.fixtures) setOf.set(f, set.file);
  const results: RunResult[] = [];
  for (let run = 1; run <= runs; run++) {
    const r: RunResult = {
      cost: 0,
      paragraphs: 0,
      failures: [],
      missing: 0,
      droppedInvalid: 0,
      errorFlags: 0,
      sets: new Map(sets.map((set) => [set.file, emptySet()])),
      details: [],
    };
    const rawFor = new Map<Item, RawIssue[]>();
    for (const [i, batch] of batches.entries()) {
      const { mode, dialect = 'en-US' } = batch[0]!.fixture;
      const label = `run ${run} batch ${i + 1}/${batches.length} ${mode} ${dialect} (${batch.length})`;
      try {
        const out = await runLiveCheck(client, {
          mode,
          dialect,
          paragraphs: batch.map((it, j) => ({ id: `p${j}`, text: it.paragraph.text })),
        });
        r.cost += costFromUsage(LIVE_CHECK_MODEL, out.usage);
        r.paragraphs += batch.length;
        r.droppedInvalid += out.droppedInvalid;
        if (out.truncated) {
          r.failures.push(`${label}: truncated at max_tokens`);
          continue;
        }
        const byId = new Map<string, RawIssue[]>();
        for (const res of out.output.results) byId.set(res.paragraph_id, [...(byId.get(res.paragraph_id) ?? []), ...res.issues]);
        batch.forEach((it, j) => {
          if (!byId.has(`p${j}`)) {
            r.missing++;
            r.details.push(`MISSING  [${it.fixture.id}] the model returned no result for this paragraph`);
          }
          rawFor.set(it, byId.get(`p${j}`) ?? []);
        });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw e;
        r.failures.push(`${label}: ${describeError(e)}`);
      }
    }
    for (const f of fixtures) {
      const items = [...rawFor.keys()].filter((it) => it.fixture === f);
      if (items.length === 0) {
        r.details.push(`SKIPPED  [${f.id}] its batch failed`);
        continue;
      }
      const st = r.sets.get(setOf.get(f)!)!;
      const shown: LocatedIssue[] = [];
      for (const it of items) {
        const policy: SuggestionPolicy = { mode: f.mode, families: familiesFor(f.mode), rules: new Set(), dictionary: new Set() };
        shown.push(...selectIssues(it.paragraph, rawFor.get(it)!, policy));
      }
      st.words += wordCount(f.text);
      const score: SuggestionScore = scoreSuggestions(f, shown);
      for (const fam of FAMILIES) {
        st.perFamily[fam].correct += score.perFamily[fam].correct;
        st.perFamily[fam].flagged += score.perFamily[fam].flagged;
      }
      for (const t of Object.keys(score.perToggle) as FamilyToggle[]) {
        for (const tally of [st.perToggle[t], st.perToggleByMode[f.mode][t]]) {
          tally.correct += score.perToggle[t].correct;
          tally.flagged += score.perToggle[t].flagged;
        }
      }
      const labelled = [...(f.suggest ?? []), ...(f.acceptable ?? [])].map((l) => {
        const start = f.text.indexOf(l.original);
        return { ...l, start, end: start + l.original.length };
      });
      const suggestions = shown.filter((i) => i.severity === 'suggestion');
      for (const s of suggestions) {
        const toggle = toggleOf(s);
        st.byToggle[toggle ?? 'clarity']++;
        const family = capFamily(s); // the same family scoreSuggestions uses
        const ok = labelled.some((l) => l.family === family && overlaps(s, l));
        const where = `[${f.id}] ${f.mode} "${s.original}" -> ${JSON.stringify(s.replacement)} (${family}/${s.kind}; model: ${JSON.stringify(s.model.replacement)})`;
        r.details.push(`${ok ? 'OK      ' : 'FP      '} ${where}`);
      }
      for (const l of f.suggest ?? []) {
        const start = f.text.indexOf(l.original);
        if (!suggestions.some((s) => capFamily(s) === l.family && overlaps(s, { start, end: start + l.original.length }))) {
          r.details.push(`MISS     [${f.id}] "${l.original}" (${l.family}${l.kind ? '/' + l.kind : ''})`);
        }
      }
      for (const e of shown.filter((i) => i.severity === 'error')) {
        r.errorFlags++;
        r.details.push(`ERROR    [${f.id}] "${e.original}" -> ${JSON.stringify(e.replacement)} (${e.kind}); these fixtures contain no errors`);
      }
    }
    results.push(r);
    console.log(
      `run ${run}: ${usd(r.cost)}, ${r.paragraphs} paragraphs, ${r.missing} paragraph results missing, ${r.droppedInvalid} invalid issues dropped` +
        (r.failures.length ? `, ${r.failures.length} FAILED batches` : ''),
    );
    for (const f of r.failures) console.log(`  FAILED ${f}`);
  }

  console.log('\nDetails (last run):');
  for (const line of results[results.length - 1]!.details.sort()) console.log(`  ${line}`);

  const meanOf = (pick: (r: RunResult) => number) => mean(results.map(pick));
  const sumSets = (files: string[], pick: (s: SetStats) => number) => meanOf((r) => files.reduce((n, f) => n + pick(r.sets.get(f)!), 0));
  const allFiles = sets.map((s) => s.file);
  console.log(`\ncost per run: ${results.map((r) => usd(r.cost)).join(', ')} (mean ${usd(meanOf((r) => r.cost))})`);
  console.log(`cost per paragraph: ${usd(meanOf((r) => (r.paragraphs ? r.cost / r.paragraphs : 0)))}`);
  console.log(`stable prefix tokens: ${prefix.input_tokens}`);
  const incomplete = results.some((r) => r.failures.length > 0 || r.missing > 0);
  if (incomplete) {
    console.log(
      `INCOMPLETE: ${results.map((r, i) => `run ${i + 1}: ${r.failures.length} failed batches, ${r.missing} paragraph results missing`).join('; ')}. ` +
        'A run with a missing result fails the gate; do not read its numbers as a pass.',
    );
  }
  const checks: [string, boolean][] = [['every paragraph answered in every run', !incomplete]];
  const ratioOf = (c: number, f: number) => (f === 0 ? 'n/a' : (c / f).toFixed(2));

  if (suite === 'suggestions') {
    console.log('\nPrecision = mean correct / mean flagged over the runs (pooled main + holdout is the gated number).');
    const groups: [string, string[]][] = [['pooled', allFiles], ...allFiles.map((f): [string, string[]] => [f, [f]])];
    for (const [name, files] of groups) {
      console.log(`\n${name}\nfamily      flagged  correct  precision`);
      for (const fam of FAMILIES) {
        const flagged = sumSets(files, (s) => s.perFamily[fam].flagged);
        const correct = sumSets(files, (s) => s.perFamily[fam].correct);
        console.log(`${fam.padEnd(10)} ${flagged.toFixed(1).padStart(8)} ${correct.toFixed(1).padStart(8)} ${ratioOf(correct, flagged).padStart(10)}`);
        if (name === 'pooled') checks.push([`${fam} precision >= ${SUGGESTION_PRECISION_TARGET}`, flagged === 0 || correct / flagged >= SUGGESTION_PRECISION_TARGET]);
      }
    }
    // Same correctness as above, keyed by settings toggle (generic_phrasing is its own row), pooled and per file, then by mode.
    const TOGGLE_ROWS: FamilyToggle[] = ['clarity', 'engagement', 'delivery', 'generic'];
    for (const [name, files] of groups) {
      console.log(`\n${name} by toggle\ntoggle      flagged  correct  precision`);
      for (const t of TOGGLE_ROWS) {
        const flagged = sumSets(files, (s) => s.perToggle[t].flagged);
        const correct = sumSets(files, (s) => s.perToggle[t].correct);
        console.log(`${t.padEnd(10)} ${flagged.toFixed(1).padStart(8)} ${correct.toFixed(1).padStart(8)} ${ratioOf(correct, flagged).padStart(10)}`);
      }
    }
    for (const mode of ['essay', 'standard'] as const) {
      console.log(`\npooled by toggle, ${mode} fixtures\ntoggle      flagged  correct  precision`);
      for (const t of TOGGLE_ROWS) {
        const flagged = sumSets(allFiles, (s) => s.perToggleByMode[mode][t].flagged);
        const correct = sumSets(allFiles, (s) => s.perToggleByMode[mode][t].correct);
        console.log(`${t.padEnd(10)} ${flagged.toFixed(1).padStart(8)} ${correct.toFixed(1).padStart(8)} ${ratioOf(correct, flagged).padStart(10)}`);
      }
    }
    console.log(`\nerror flags on these error-free fixtures (informational; error precision is the default suite's job): ${meanOf((r) => r.errorFlags).toFixed(1)} per run`);
  } else {
    const recommend: FamilyToggles = { ...ESSAY_FAMILY_DEFAULTS, clarity: true };
    const groups: [string, string[]][] = [['pooled', allFiles], ...allFiles.map((f): [string, string[]] => [f, [f]])];
    for (const [name, files] of groups) {
      const words = sumSets(files, (s) => s.words);
      console.log(`\n${name}: ${words.toFixed(0)} words checked per run`);
      console.log('toggle       shown  per 300 words  (every shown suggestion here is a false positive)');
      for (const toggle of ['engagement', 'delivery', 'generic'] as const) {
        const shown = sumSets(files, (s) => s.byToggle[toggle]);
        const rate = words === 0 ? 0 : (shown / words) * 300;
        const ok = rate <= VOICE_MAX_PER_300_WORDS && shown === 0;
        console.log(`${toggle.padEnd(11)} ${shown.toFixed(1).padStart(6)} ${rate.toFixed(2).padStart(14)}${name === 'pooled' ? `  -> ${ok ? 'on' : 'off'} in Essay` : ''}`);
        if (name === 'pooled') {
          recommend[toggle] = ok;
          checks.push([`${toggle}: <= ${VOICE_MAX_PER_300_WORDS} per 300 words and no false positives`, ok]);
        }
      }
    }
    console.log(`clarity      ${sumSets(allFiles, (s) => s.byToggle.clarity).toFixed(1).padStart(5)} (reported, not part of the Essay gate)`);
    console.log(`ESSAY_FAMILY_DEFAULTS recommendation: ${JSON.stringify(recommend)}`);
  }
  console.log(`checks: ${checks.map(([name, ok]) => `${name}: ${ok ? 'yes' : 'NO'}`).join(' | ')}`);
  if (runs < 2) {
    console.log(`single run: no pass/fail verdict (the pass bar is the mean of 2 runs); rerun with --runs 2. ${incomplete ? 'This run is INCOMPLETE.' : ''}`);
    return incomplete ? 1 : 0;
  }
  console.log(`verdict: ${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const suiteFlag = args.indexOf('--suite');
  const suite = suiteFlag === -1 ? 'default' : args[suiteFlag + 1];
  if (suite === 'suggestions' || suite === 'voice') {
    const runsFlag = args.indexOf('--runs');
    const runs = runsFlag === -1 ? 2 : Number(args[runsFlag + 1]);
    if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('--runs needs a whole number from 1 to 5');
    const defaults = args.includes('--defaults');
    if (defaults && suite !== 'suggestions') throw new Error('--defaults applies to --suite suggestions only');
    return runSuggestionSuite(suite, dryRun, runs, defaults);
  }
  if (suite !== 'default') throw new Error('--suite must be suggestions or voice');
  const flag = args.indexOf('--fixtures');
  const fixturesPath = flag === -1 ? MAIN_FIXTURES : args[flag + 1];
  if (!fixturesPath) throw new Error('--fixtures needs a path');
  const { fixtures, privateCount } = loadFixtures(fixturesPath);
  const batches = makeBatches(fixtures);
  const withErrors = fixtures.filter((f) => f.expect.length > 0).length;
  console.log(`EngLint live-check eval | prompt ${PROMPT_VERSION} | model ${LIVE_CHECK_MODEL} | ${fixturesPath}`);
  console.log(
    `fixtures: ${fixtures.length} (${withErrors} with errors, ${fixtures.length - withErrors} clean, ${privateCount} private) in ${batches.length} batches`,
  );
  if (dryRun) {
    for (const [i, b] of batches.entries()) {
      const f = b[0]!.fixture;
      console.log(`  batch ${i + 1}: ${f.mode} ${f.dialect ?? 'en-US'}, ${b.length} paragraphs`);
    }
    console.log('dry run: fixtures valid, no API calls made');
    return 0;
  }

  const client = makeClient(readEnvKey());
  console.log('.env: ANTHROPIC_API_KEY parsed (value not shown)');

  const { data: models, response } = await client.models.list({ limit: 1000 }).withResponse();
  const listed = models.data.some((m) => m.id === LIVE_CHECK_MODEL);
  console.log(`GET /v1/models: ${response.status}, ${LIVE_CHECK_MODEL} listed: ${listed ? 'yes' : 'no'}`);

  const [stableBlock] = buildLiveCheckSystem('standard', 'en-US');
  const prefix = await client.messages.countTokens({
    model: LIVE_CHECK_MODEL,
    system: [stableBlock!],
    messages: [{ role: 'user', content: '.' }],
  });
  console.log(`stable prefix tokens: ${prefix.input_tokens}`);

  let totalCost = 0;
  const bill = (u: UsageLike) => {
    const c = costFromUsage(LIVE_CHECK_MODEL, u);
    totalCost += c;
    return c;
  };

  // Before the eval, so the first call is cold (unless a run in the last 5 minutes warmed it).
  const probe = {
    mode: 'standard' as Mode,
    dialect: 'en-US' as Dialect,
    paragraphs: [{ id: 'p0', text: 'This short sentence checks that the prompt cache works.' }],
  };
  const first = await runLiveCheck(client, probe);
  bill(first.usage);
  await sleep(3000);
  const second = await runLiveCheck(client, probe);
  bill(second.usage);
  const cacheHit = (second.usage.cache_read_input_tokens ?? 0) > 0;
  console.log(
    `cache check: call 1 wrote ${first.usage.cache_creation_input_tokens ?? 0} / read ${first.usage.cache_read_input_tokens ?? 0}; ` +
      `call 2 wrote ${second.usage.cache_creation_input_tokens ?? 0} / read ${second.usage.cache_read_input_tokens ?? 0}`,
  );
  console.log(`cache hit: ${cacheHit ? 'yes' : 'no'}`);

  const rawFor = new Map<Item, RawIssue[]>();
  const failures: string[] = [];
  let badRequests = 0;
  let missingIds = 0;
  let droppedInvalid = 0;
  for (const [i, batch] of batches.entries()) {
    const { mode, dialect = 'en-US' } = batch[0]!.fixture;
    const label = `batch ${i + 1}/${batches.length} ${mode} ${dialect} (${batch.length})`;
    try {
      const out = await runLiveCheck(client, {
        mode,
        dialect,
        paragraphs: batch.map((it, j) => ({ id: `p${j}`, text: it.paragraph.text })),
      });
      const cost = bill(out.usage);
      droppedInvalid += out.droppedInvalid;
      const u = out.usage;
      console.log(
        `${label}: in ${u.input_tokens}, out ${u.output_tokens}, cache read ${u.cache_read_input_tokens ?? 0}, ` +
          `write ${u.cache_creation_input_tokens ?? 0}, ${usd(cost)}${out.truncated ? ' TRUNCATED' : ''}` +
          (out.droppedInvalid ? `, ${out.droppedInvalid} invalid issues dropped` : ''),
      );
      if (out.truncated) {
        failures.push(`${label}: truncated at max_tokens`);
        continue;
      }
      const byId = new Map<string, RawIssue[]>();
      for (const r of out.output.results) byId.set(r.paragraph_id, [...(byId.get(r.paragraph_id) ?? []), ...r.issues]);
      batch.forEach((it, j) => {
        if (!byId.has(`p${j}`)) missingIds++;
        rawFor.set(it, byId.get(`p${j}`) ?? []);
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw e;
      if (e instanceof Anthropic.BadRequestError) badRequests++;
      const kind = e instanceof LiveCheckParseError ? 'schema mismatch' : 'API error';
      failures.push(`${label}: ${kind}: ${describeError(e)}`);
      console.log(`${label}: FAILED (${kind})`);
    }
  }

  const stats = new Map<Mode, ModeStats>(
    MODES.map((m) => [m, { fixtures: 0, flagged: 0, correct: 0, expected: 0, found: 0, fixMatch: 0, clarity: 0, dropped: 0 }]),
  );
  const details: string[] = [];
  const labelled: LabelledTally = { found: 0, total: 0, fixes: 0, fixTotal: 0, ok: 0, fp: 0 };
  for (const f of fixtures) {
    const items = [...rawFor.keys()].filter((it) => it.fixture === f);
    if (items.length === 0) {
      // Its batch failed: leave it out of the metrics rather than count every expected fix as missed.
      details.push(`SKIPPED  [${f.id}] its batch failed`);
      continue;
    }
    const s = stats.get(f.mode)!;
    s.fixtures++;
    const shown: LocatedIssue[] = [];
    for (const it of items) {
      const raw = rawFor.get(it)!;
      const policy: SuggestionPolicy = {
        mode: f.mode,
        families: defaultFamilies(f.mode),
        rules: new Set(),
        dictionary: new Set(),
      };
      const located = selectIssues(it.paragraph, raw, policy);
      shown.push(...located);
      for (const r of raw) {
        if (isSuppressedEdit(r.original, r.replacement) || (f.mode === 'casual' && isCasualSuppressedEdit(r.original, r.replacement))) {
          details.push(`SUPPRESSED [${f.id}] "${r.original}" -> ${JSON.stringify(r.replacement)} (${r.kind}) by src/core/suppress.ts`);
          continue;
        }
        if (r.severity === 'error' && (r.replacement === null || locateIssue(it.paragraph.text, r) === null)) {
          s.dropped++;
          details.push(`DROPPED  [${f.id}] "${r.original}" -> ${JSON.stringify(r.replacement)} (${r.kind}) not located or no fix`);
        }
      }
    }
    const expected = f.expect.map((e) => {
      const start = f.text.indexOf(e.original);
      return { ...e, start, end: start + e.original.length };
    });
    const errors = shown.filter((i) => i.severity === 'error');
    s.flagged += errors.length;
    s.expected += expected.length;
    s.clarity += shown.length - errors.length;
    for (const issue of errors) {
      const fix = issue.replacement ?? '';
      const match = expected.find((e) => overlaps(issue, e));
      if (!match) {
        details.push(
          `FP       [${f.id}] ${JSON.stringify(f.text)}: "${issue.original}" -> ${JSON.stringify(fix)} (${issue.kind}: ${issue.reason})`,
        );
        continue;
      }
      s.correct++;
      if (applyEdit(f.text, issue, fix) === applyEdit(f.text, match, match.replacement)) s.fixMatch++;
      else details.push(`FIX DIFF [${f.id}] "${issue.original}" -> ${JSON.stringify(fix)}; expected "${match.original}" -> ${JSON.stringify(match.replacement)}`);
    }
    for (const e of expected) {
      if (errors.some((issue) => overlaps(issue, e))) s.found++;
      else details.push(`MISS     [${f.id}] ${JSON.stringify(f.text)}: expected "${e.original}" -> ${JSON.stringify(e.replacement)}`);
    }
    const suggestions = shown.filter((i) => i.severity === 'suggestion');
    if (!hasLabels(f)) {
      for (const note of suggestions) {
        details.push(`CLARITY  [${f.id}] "${note.original}" -> ${JSON.stringify(note.replacement)} (${note.kind}: ${note.reason})`);
      }
      continue;
    }
    const report = reportLabelledSuggestions(f.id, f, suggestions, items.flatMap((it) => rawFor.get(it)!));
    details.push(...report.details);
    for (const k of Object.keys(labelled) as (keyof LabelledTally)[]) labelled[k] += report.tally[k];
  }

  console.log('\nDetails:');
  for (const line of details.sort()) console.log(`  ${line}`);
  console.log('\nmode      fixtures  flagged  correct  precision  expected  found  recall  fix-match  clarity  dropped');
  for (const [mode, s] of stats) {
    console.log(
      `${mode.padEnd(9)} ${String(s.fixtures).padStart(8)} ${String(s.flagged).padStart(8)} ${String(s.correct).padStart(8)} ` +
        `${ratio(s.correct, s.flagged).padStart(10)} ${String(s.expected).padStart(9)} ${String(s.found).padStart(6)} ` +
        `${ratio(s.found, s.expected).padStart(7)} ${`${s.fixMatch}/${s.correct}`.padStart(10)} ${String(s.clarity).padStart(8)} ${String(s.dropped).padStart(8)}`,
    );
  }
  if (labelled.total > 0) {
    console.log(
      `labelled suggestions: ${labelled.found} of ${labelled.total} found, ${labelled.fixes} of ${labelled.fixTotal} with the expected fix; ` +
        `shown ${labelled.ok + labelled.fp} (${labelled.ok} on a label, ${labelled.fp} not)`,
    );
  }
  if (missingIds) console.log(`paragraph ids missing from the model's results: ${missingIds}`);
  console.log(`issues dropped for an unknown category or severity: ${droppedInvalid}`);
  for (const f of failures) console.log(`FAILED ${f}`);
  console.log(`total cost: ${usd(totalCost)}`);

  const precisionOk = [...stats.values()].every((s) => s.flagged === 0 || s.correct / s.flagged >= PRECISION_TARGET);
  const checks: [string, boolean][] = [
    ['no 400 errors', badRequests === 0],
    ['all batches answered', failures.length === 0],
    [`prefix tokens >= ${MIN_PREFIX_TOKENS}`, prefix.input_tokens >= MIN_PREFIX_TOKENS],
    ['cache hit', cacheHit],
    [`total cost < ${usd(COST_LIMIT_USD)}`, totalCost < COST_LIMIT_USD],
    [`error precision >= ${PRECISION_TARGET} in every mode`, precisionOk],
  ];
  console.log(`checks: ${checks.map(([name, ok]) => `${name}: ${ok ? 'yes' : 'NO'}`).join(' | ')}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`eval aborted: ${describeError(e)}`);
    if (e instanceof Anthropic.AuthenticationError) console.error('BLOCKED: the API rejected the key (401).');
    process.exitCode = 2;
  },
);
