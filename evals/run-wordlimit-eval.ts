/**
 * Fit a word limit against the real Claude API (Sonnet, one request per fixture; about $0.12 to $0.14 in all).
 *   npx tsx evals/run-wordlimit-eval.ts
 * The key is read from .env as data and never printed. Page text and model output are not printed either: only
 * counts, pass/fail, timings and token usage. It sends requests through runToolCall, as the background tools service
 * does, and locates, counts and picks the cuts with the functions the popover uses.
 */
import { makeClient, runToolCall } from '../src/background/claude';
import { buildWordLimitSystem, buildWordLimitUser } from '../src/background/prompts/rewrite';
import { changesClaims } from '../src/core/claims';
import { costFromUsage } from '../src/core/cost';
import { countWords } from '../src/core/doc-stats';
import { WORD_LIMIT_JSON_SCHEMA, cleanWordLimit } from '../src/core/tool-schema';
import { MAX_WORD_LIMIT_CHARS, applyCuts, preselect, validTarget, versionFloor } from '../src/core/word-limit';
import fixtures from './wordlimit.fixtures.json';
import { readEnvKey } from './read-env';

/** Stop sending once the spend reaches this (USD). */
const BUDGET = 0.25;
/** A service worker is stopped when a fetch response takes longer than this to arrive; this call isn't streamed. */
const WORKER_FETCH_LIMIT_S = 30;

const client = makeClient(readEnvKey());
let totalCost = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

/** The numbers, and the capitalised words that don't open a sentence (names, places, titles), in `text`. */
function claimWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,.:/-]*\d|\d/g)) out.add(m[0]);
  for (const m of text.matchAll(/\p{L}[\p{L}'’]*/gu)) {
    const w = m[0];
    if (!/^\p{Lu}/u.test(w) || /^I(?:['’]\p{L}+)?$/u.test(w)) continue;
    const before = text.slice(0, m.index).trimEnd();
    if (before === '' || /[.!?:"“”]$/u.test(before)) continue; // a sentence's first word
    out.add(w);
  }
  return out;
}
/** How many numbers or names `version` has that `original` doesn't: facts it added. */
const addedClaims = (original: string, version: string) => {
  const had = claimWords(original);
  return [...claimWords(version)].filter((w) => !had.has(w)).length;
};

async function main() {
  let rawCuts = 0;
  let keptCuts = 0;
  let reached = 0;
  let longWhys = 0;
  let sent = 0;
  for (const f of fixtures) {
    const words = countWords(f.text);
    if (f.text.length > MAX_WORD_LIMIT_CHARS || !validTarget(f.target, words)) throw new Error(`fixture ${f.id} is not one the tool takes`);
    if (totalCost >= BUDGET) {
      check(`${f.id}: sent within the budget`, false, `$${totalCost.toFixed(4)} spent`);
      continue;
    }
    console.log(`\n${f.id}: ${words} words → ${f.target}`);
    const t0 = Date.now();
    const { data, usage, model, truncated } = await runToolCall(client, {
      kind: 'wordLimit',
      system: buildWordLimitSystem('essay', 'en-US'),
      user: buildWordLimitUser({ text: f.text, before: '', after: '', target: f.target }),
      schema: WORD_LIMIT_JSON_SCHEMA,
    });
    const secs = (Date.now() - t0) / 1000;
    totalCost += costFromUsage(model, usage);
    sent++;
    check(`${f.id}: answered, not truncated`, !truncated && data !== null, `${secs.toFixed(1)} s, ${usage.output_tokens} output tokens`);
    check(`${f.id}: inside ${WORKER_FETCH_LIMIT_S} s`, secs < WORKER_FETCH_LIMIT_S, `${secs.toFixed(1)} s`);

    const raw = Array.isArray((data as { cuts?: unknown } | null)?.cuts) ? (data as { cuts: { why?: unknown }[] }).cuts : [];
    const clean = cleanWordLimit(data, f.text, f.target);
    const cuts = clean?.cuts ?? [];
    rawCuts += raw.length;
    keptCuts += cuts.length;
    longWhys += raw.filter((c) => countWords(String(c.why ?? '')) > 8).length;
    const flagged = cuts.filter((c) => c.changesFacts).length;
    const saves = cuts.reduce((n, c) => n + c.saves, 0);
    console.log(`      cuts: ${raw.length} from the model, ${cuts.length} kept, ${flagged} change a fact; together they save ${saves} of the ${words - f.target} needed`);

    const selected = preselect(f.text, cuts, f.target);
    const composed = applyCuts(f.text, cuts.filter((_, i) => selected[i]));
    const after = countWords(composed);
    if (after <= f.target) reached++;
    check(`${f.id}: the cuts picked by default reach the target`, after <= f.target, `${selected.filter(Boolean).length} picked: ${after} words for ${f.target}`);
    check(`${f.id}: the cuts picked by default keep every number, name and quote`, !changesClaims(f.text, composed, { sentenceStarts: 'lenient' }));

    const version = String((data as { version?: unknown } | null)?.version ?? '').trim();
    const vWords = countWords(version);
    check(`${f.id}: the version is within 90-100% of the target`, vWords >= versionFloor(f.target) && vWords <= f.target, `${vWords} words for ${versionFloor(f.target)}-${f.target}`);
    const added = addedClaims(f.text, version);
    check(`${f.id}: the version adds no number or name`, version !== '' && added === 0, `${added} added`);
    const dropped = addedClaims(version, f.text); // the original's numbers and names the version lacks
    console.log(`      version: ${clean?.version ? 'kept' : 'dropped (outside 80-100% of the target)'}; numbers or names it left out: ${dropped}`);
  }

  console.log('\nOverall');
  check('at least 80% of the cuts are valid (found in the selection, no overlap, saving a word)', rawCuts > 0 && keptCuts / rawCuts >= 0.8, `${keptCuts}/${rawCuts}`);
  check('the cuts picked by default reach the target in at least 5 of 6', reached >= 5, `${reached} of ${fixtures.length}`);
  console.log(`      whys over 8 words: ${longWhys} of ${rawCuts}; requests: ${sent}`);
  console.log(`\nTotal cost: $${totalCost.toFixed(4)}`);
  console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASSED');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error('Eval error:', e instanceof Error ? `${e.name} ${e.message.slice(0, 200)}` : typeof e);
  process.exitCode = 1;
});
