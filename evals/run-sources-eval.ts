/**
 * Local eval of the free issue sources: no API and no key. Run: npx tsx evals/run-sources-eval.ts
 *
 * - Tells: precision and recall per pattern on evals/tells.fixtures.json, and false fires on the voice and
 *   suggestion texts, which hold no planted tells.
 * - Harper: every paragraph of the live-check, holdout and sources (doubled-word and acronym negatives) fixtures, in each fixture's mode and dialect.
 *   Per rule: flags, flags on a gold issue, flags with the gold fix, the false-flag rate and how many gave
 *   more than one fix; the same for what survives the instant floor and the trusted rules in mergeParagraph.
 * - Instant list: the rules to keep (false-flag rate at most 5%), and rules that could join.
 *
 * harper.js runs in Node from its slim binary export, which is never shipped from here.
 */
import { readFileSync } from 'node:fs';
import { LocalLinter } from 'harper.js';
import { slimBinary } from 'harper.js/slimBinary';
import { harperConfig, harperDialect, type LintConfig } from '../src/core/harper-config';
import { mapLints, type LintLike } from '../src/core/harper-map';
import { mergeParagraph } from '../src/core/merge';
import { HARPER_INSTANT, harperRule, type SourcedIssue } from '../src/core/sources';
import { detectTells } from '../src/core/tells/detect';
import type { Dialect, Mode } from '../src/core/types';
import {
  falseFlagRate,
  instantCandidates,
  pruneInstant,
  scoreFlags,
  scoreTells,
  type Flag,
  type FlagRow,
  type RuleTally,
  type TellCounts,
  type TellLabel,
} from './sources-scoring';

const MAX_FALSE_RATE = 0.05;
/** Fixtures where nothing may show, before or after Claude answers: good-English doubled words, articles before acronyms. */
const MUST_STAY_SILENT = /-ok-(?:dw|acr)\d/;
const MIN_TELL_PRECISION = 0.9;

interface HarperFixture {
  id: string;
  mode: Mode;
  dialect?: Dialect;
  text: string;
  expect: { original: string; replacement: string | null }[];
}
interface TellFixture {
  id: string;
  mode: Mode;
  text: string;
  expect: TellLabel[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

function toFlag(issue: SourcedIssue): Flag {
  return {
    rule: harperRule(issue.ruleId),
    original: issue.original,
    replacement: issue.replacement,
    at: issue.at ?? 0,
    suggestionCount: issue.suggestionCount ?? 0,
  };
}

function runTells(): void {
  const fixtures = readJson<TellFixture[]>('evals/tells.fixtures.json');
  const totals: Record<string, TellCounts> = {};
  const misses: string[] = [];
  for (const f of fixtures) {
    const hits = detectTells(f.text, f.mode).map((i) => ({ ruleId: i.ruleId, original: i.original, at: i.at ?? 0 }));
    const scored = scoreTells(f, hits);
    for (const [pattern, c] of Object.entries(scored)) {
      const t = (totals[pattern] ??= { tp: 0, fp: 0, fn: 0 });
      t.tp += c.tp;
      t.fp += c.fp;
      t.fn += c.fn;
      if (c.fp || c.fn) misses.push(`  ${f.id} ${pattern}: ${c.fp} false fire, ${c.fn} missed`);
    }
  }
  console.log(`\nTELLS (${fixtures.length} fixtures)`);
  console.log('pattern       tp  fp  fn  precision  recall');
  for (const [pattern, t] of Object.entries(totals).sort()) {
    console.log(`${pattern.padEnd(12)} ${String(t.tp).padStart(3)} ${String(t.fp).padStart(3)} ${String(t.fn).padStart(3)}  ${pct(t.tp, t.tp + t.fp)}    ${pct(t.tp, t.tp + t.fn)}`);
  }
  if (misses.length) console.log(`misses:\n${misses.join('\n')}`);

  const negatives: { id: string; text: string; mode: Mode }[] = [];
  for (const file of ['voice', 'voice-holdout']) {
    for (const f of readJson<{ id: string; text: string }[]>(`evals/${file}.fixtures.json`)) negatives.push({ ...f, mode: 'essay' });
  }
  const planted: { id: string; text: string; mode: Mode }[] = [];
  for (const file of ['suggestions', 'suggestions-holdout']) {
    for (const f of readJson<{ id: string; text: string; mode: Mode }[]>(`evals/${file}.fixtures.json`)) {
      // The generic-phrasing positives of the suggestion fixtures do hold planted phrasing.
      (/^gen-(?:h-)?pos-/.test(f.id) ? planted : negatives).push(f);
    }
  }
  const fires = negatives.flatMap((n) => detectTells(n.text, n.mode).map((i) => `  ${n.id}: ${i.ruleId} "${i.original}"`));
  console.log(`false fires on ${negatives.length} texts without planted tells: ${fires.length}`);
  if (fires.length) console.log(fires.join('\n'));
  const caught = planted.filter((p) => detectTells(p.text, p.mode).length > 0).length;
  console.log(`${caught} of ${planted.length} generic-phrasing positives from the suggestion fixtures hold at least one tell`);
}

function printTable(title: string, tallies: Record<string, RuleTally>): void {
  console.log(`\n${title}`);
  console.log('rule                       flags  on-gold  right-fix  false-rate  multi-fix');
  for (const [rule, t] of Object.entries(tallies).sort((a, b) => b[1].flags - a[1].flags)) {
    const flagged = String(t.flags).padStart(5);
    console.log(
      `${rule.padEnd(26)} ${flagged}  ${String(t.overlapping).padStart(7)}  ${String(t.matched).padStart(9)}  ${pct(t.flags - t.matched, t.flags)}      ${String(t.manyFixes).padStart(5)}`,
    );
  }
}

async function runHarper(): Promise<void> {
  const fixtures = [...readJson<HarperFixture[]>('evals/live-check.fixtures.json'), ...readJson<HarperFixture[]>('evals/holdout.fixtures.json'), ...readJson<HarperFixture[]>('evals/sources.fixtures.json')];
  const linter = new LocalLinter({ binary: slimBinary });
  await linter.setup();
  const base = (await linter.getDefaultLintConfig()) as LintConfig;

  const rawRows: FlagRow[] = [];
  const instantRows: FlagRow[] = [];
  const trustedRows: FlagRow[] = [];
  const rawCounts: Record<string, number> = {};
  const leaks: string[] = [];
  let applied = '';
  for (const f of fixtures) {
    const key = `${f.mode}/${f.dialect ?? 'en-US'}`;
    if (key !== applied) {
      await linter.setDialect(harperDialect(f.dialect ?? 'en-US'));
      await linter.setLintConfig(harperConfig(f.mode, base));
      applied = key;
    }
    const organized = (await linter.organizedLints(f.text, { language: 'plaintext', dedup: true })) as unknown as Record<string, LintLike[]>;
    for (const [rule, lints] of Object.entries(organized)) if (lints.length) rawCounts[rule] = (rawCounts[rule] ?? 0) + lints.length;
    const issues = mapLints(f.text, organized);
    rawRows.push({ text: f.text, flags: issues.map(toFlag), gold: f.expect });
    const instant = mergeParagraph(f.text, { harper: issues }) as SourcedIssue[];
    instantRows.push({ text: f.text, flags: instant.map(toFlag), gold: f.expect });
    const trusted = mergeParagraph(f.text, { claude: [], harper: issues }) as SourcedIssue[];
    trustedRows.push({ text: f.text, flags: trusted.map(toFlag), gold: f.expect });
    if (f.expect.length === 0 && MUST_STAY_SILENT.test(f.id)) {
      if (instant.length) leaks.push(`${f.id} before Claude: ${instant.map((i) => i.ruleId).join(', ')}`);
      if (trusted.length) leaks.push(`${f.id} after Claude: ${trusted.map((i) => i.ruleId).join(', ')}`);
    }
  }

  const raw = scoreFlags(rawRows);
  console.log(`\nHARPER (${fixtures.length} paragraphs; ${Object.values(rawCounts).reduce((a, b) => a + b, 0)} lints, ${Object.keys(rawCounts).length} rules)`);
  printTable('every correctness rule Harper flagged (first suggestion scored)', raw);
  const dropped = Object.entries(rawCounts).filter(([rule]) => !raw[rule]);
  console.log(`rules dropped as style, readability or fix-less: ${dropped.map(([r, n]) => `${r}(${n})`).join(', ') || 'none'}`);

  const instant = scoreFlags(instantRows);
  printTable('after the instant floor (no Claude answer)', instant);
  const trusted = scoreFlags(trustedRows);
  printTable('after Claude answers an empty paragraph (trusted rules only)', trusted);
  console.log(`\nmust-stay-silent fixtures (doubled words, acronyms) that surfaced a Harper issue: ${leaks.length}${leaks.length ? `\n  ${leaks.join('\n  ')}` : ''}`);

  // A listed rule is judged as it shows: after the merge's own floor (one fix, and the rule's guards in merge.ts).
  const kept = pruneInstant(HARPER_INSTANT, instant, MAX_FALSE_RATE);
  const removed = [...HARPER_INSTANT].filter((r) => !kept.includes(r)).sort();
  console.log(`\nINSTANT LIST (limit ${MAX_FALSE_RATE * 100}% false flags)`);
  console.log(`current: ${[...HARPER_INSTANT].sort().join(', ')}`);
  console.log(`keep: ${kept.join(', ')}`);
  console.log(`remove: ${removed.join(', ') || 'none'}`);
  const gatedRates = Object.fromEntries([...HARPER_INSTANT].map((r) => [r, instant[r] ? pct(instant[r]!.flags - instant[r]!.matched, instant[r]!.flags) : 'no flags']));
  console.log(`false-flag rate as gated by the merge: ${JSON.stringify(gatedRates)}`);
  const candidates = instantCandidates(raw, MAX_FALSE_RATE).filter((r) => !HARPER_INSTANT.has(r));
  console.log(`candidates (one fix on every flag, at most 5% false; flags in brackets): ${candidates.map((r) => `${r}[${raw[r]!.flags}]`).join(', ') || 'none'}`);
  for (const named of ['The', 'ItsPossessive', 'ItsContraction', 'ToTo']) {
    const t = raw[named];
    console.log(`${named}: ${t ? `${t.flags} flags, ${t.matched} with the gold fix, ${t.manyFixes} with several fixes` : 'no flags on the fixtures'}`);
  }
  const near = Object.entries(raw)
    .filter(([r, t]) => !HARPER_INSTANT.has(r) && falseFlagRate(t) <= MAX_FALSE_RATE && t.manyFixes > 0)
    .map(([r]) => r);
  console.log(`accurate but with several fixes (not eligible): ${near.join(', ') || 'none'}`);
}

runTells();
await runHarper();
console.log(`\n(tell precision floor ${MIN_TELL_PRECISION})`);
