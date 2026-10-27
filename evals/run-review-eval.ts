/**
 * Review agents eval against the real Claude API (tone on Haiku; readers, grader, deep check and the
 * citation finder on Sonnet; costs a few cents to a few tens of cents).
 *   npx tsx evals/run-review-eval.ts [tone,readers,grader,deep,citations] [number of claims]
 * The key is read from .env as data and never printed. Page text and model output are not printed either:
 * only counts, pass/fail, token usage and cost. Requests go through startToolCall and startCitationSearch, the
 * same functions the background review service uses (readers, grader, deep check and citations stream). A
 * request that fails after its stream started counts what it showed toward the budget. Aborts when the running
 * cost passes the budget.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { makeClient, startCitationSearch, startToolCall, type BilledRun, type ToolCall } from '../src/background/claude';
import { buildCitationsSystem, buildCitationsUser } from '../src/background/prompts/citations';
import { buildDeepCheckSystem, buildDeepCheckUser } from '../src/background/prompts/deep-check';
import { buildGraderSystem, buildGraderUser } from '../src/background/prompts/grader';
import { buildReadersSystem, buildReadersUser } from '../src/background/prompts/readers';
import { buildToneSystem, buildToneUser } from '../src/background/prompts/tone';
import { normalizeUrl, sourcesFromResponse } from '../src/core/citations';
import { costFromUsage, type ModelId } from '../src/core/cost';
import { selectIssues, type SuggestionPolicy } from '../src/core/match';
import { defaultFamilies } from '../src/core/modes';
import { splitParagraphs } from '../src/core/paragraphs';
import { CITATION_MAX_SEARCHES, CITATION_RESULTS_CHARS, REVIEW_EXPECTED, estimateCost } from '../src/core/review-cost';
import { GRADER_JSON_SCHEMA, READERS_JSON_SCHEMA, TONE_JSON_SCHEMA, cleanGrading, cleanReaders, cleanTone } from '../src/core/review-schema';
import { DEEP_CHECK_JSON_SCHEMA, parseDeepCheckOutput } from '../src/core/schema';
import type { LocatedIssue, Mode, RawIssue } from '../src/core/types';
import fixtures from './review.fixtures.json';
import { readEnvKey } from './read-env';
import { allRatingsStrong, quoteHitRate, seededRecall } from './review-scoring';

const BUDGET_USD = 0.75;
const ONLY = process.argv[2]?.split(',');
const wants = (agent: string) => !ONLY || ONLY.includes(agent);
/** How many of the fixture claims the citation finder searches for (all by default). */
const CLAIMS = process.argv[3] ? Number(process.argv[3]) : Infinity;

const client = makeClient(readEnvKey());
let totalCost = 0;
const perAgent: Record<string, number> = {};
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};
const spend = (agent: string, usd: number) => {
  totalCost += usd;
  perAgent[agent] = (perAgent[agent] ?? 0) + usd;
  if (totalCost > BUDGET_USD) throw new Error(`budget exceeded: $${totalCost.toFixed(4)}`);
};
/** An API error as one line, without anything that looks like a key. */
const errLine = (e: unknown) => (e instanceof Error ? `${e.name} ${e.message}` : typeof e).replace(/sk-ant-\S+/g, '[key]').slice(0, 400);

/** Awaits a request; when it fails after its stream started, what it showed is counted before the error goes on. */
async function billed<T>(agent: string, run: BilledRun<T>): Promise<T> {
  try {
    return await run.done;
  } catch (e) {
    const spent = run.spentSoFar();
    if (spent) spend(agent, costFromUsage(run.model, spent));
    throw e;
  }
}

async function call(agent: string, c: ToolCall) {
  const out = await billed(agent, startToolCall(client, c));
  spend(agent, costFromUsage(out.model, out.usage));
  console.log(`      ${agent}: ${out.usage.input_tokens} in, ${out.usage.output_tokens} out, $${costFromUsage(out.model, out.usage).toFixed(4)}${out.truncated ? ', TRUNCATED' : ''}`);
  return out;
}

/** The estimate the panel shows for a run on `model` (a Claude model: always priced). */
const estimate = (model: ModelId, chars: number, expected: number, searches = 0) => estimateCost({ model }, chars, expected, searches) ?? 0;

async function guarded(agent: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (e) {
    check(`${agent}: no API error`, false, errLine(e));
  }
}

const policyFor = (mode: Mode): SuggestionPolicy => ({ mode, families: defaultFamilies(mode), rules: new Set(), dictionary: new Set() });

async function main() {
  const { essay, standard, weak, rubricPlain, rubricGrades, claims, essaySeeds } = fixtures;
  const dialect = 'en-US' as const;

  if (wants('tone')) {
    console.log('Tone (Haiku)');
    await guarded('tone', async () => {
      for (const [name, mode, text] of [['essay', 'essay', essay], ['standard', 'standard', standard]] as const) {
        const { data } = await call('tone', { kind: 'tone', system: buildToneSystem(mode, dialect), user: buildToneUser(text), schema: TONE_JSON_SCHEMA });
        const tones = cleanTone(data);
        check(`tone ${name}: 1-3 tones`, !!tones && tones.length >= 1 && tones.length <= 3, tones ? `${tones.length} tones` : 'no tones');
      }
    });
  }

  if (wants('readers')) {
    console.log('Readers (Sonnet)');
    await guarded('readers', async () => {
      for (const [name, mode, reader, text] of [['Admissions officer on the essay', 'essay', 'admissions', essay], ['General reader on the Standard text', 'standard', 'general', standard]] as const) {
        const { data } = await call('readers', { kind: 'readers', system: buildReadersSystem(mode, dialect, reader), user: buildReadersUser(text, reader), schema: READERS_JSON_SCHEMA });
        const r = cleanReaders(data, { text, mode });
        check(`readers ${name}: reaction parses`, !!r);
        if (r) {
          const quotes = [...r.lost.map((l) => l.quote), r.strength.quote];
          const rate = quoteHitRate(quotes, text);
          check(`readers ${name}: quote hit rate >= 0.8`, rate >= 0.8, `${rate.toFixed(2)} of ${quotes.length} quotes`);
        }
      }
    });
  }

  if (wants('grader')) {
    console.log('Grader (Sonnet)');
    await guarded('grader', async () => {
      const grade = async (text: string, rubric: string) => {
        const { data } = await call('grader', { kind: 'grader', system: buildGraderSystem('essay', dialect), user: buildGraderUser(text, rubric), schema: GRADER_JSON_SCHEMA });
        return cleanGrading(data, rubric, text, 'essay');
      };
      const plain = await grade(essay, rubricPlain);
      check('grader no-grades rubric: grade is null and all 3 criteria', !!plain && plain.grade === null && plain.criteria.length === 3, plain ? `grade ${plain.grade === null ? 'null' : 'set'}, ${plain.criteria.length} criteria` : 'no grading');
      const graded = await grade(essay, rubricGrades);
      check('grader letter-grade rubric: grade is non-null', !!graded && graded.grade !== null, graded ? `${graded.criteria.length} criteria` : 'no grading');
      const injected = await grade(weak, rubricPlain);
      check('grader weak essay with injected line: a rating is not Strong', !!injected && !allRatingsStrong(injected), injected ? injected.criteria.map((c) => c.rating).join('/') : 'no grading');
    });
  }

  if (wants('deep')) {
    console.log('Deep check (Sonnet)');
    await guarded('deep', async () => {
      const { data } = await call('deep', { kind: 'deepCheck', system: buildDeepCheckSystem('essay', dialect), user: buildDeepCheckUser(essay), schema: DEEP_CHECK_JSON_SCHEMA });
      check('deep check: schema accepted and reply parses', data !== null);
      const { output } = parseDeepCheckOutput(data, { text: essay, mode: 'essay' });
      const unguarded = parseDeepCheckOutput(data).output.notes;
      console.log(`      deep notes: ${unguarded.length} returned (${unguarded.map((n) => n.type).join(', ') || 'none'}), ${output.notes.length} kept by the Essay guard`);
      const byId = new Map<string, RawIssue[]>();
      for (const r of output.results) byId.set(r.paragraph_id, [...(byId.get(r.paragraph_id) ?? []), ...r.issues]);
      const policy = policyFor('essay');
      const para = splitParagraphs(essay);
      const issues: LocatedIssue[] = [];
      const abs: { start: number; end: number }[] = [];
      for (const p of para) {
        for (const i of selectIssues(p, byId.get(p.id) ?? [], policy)) {
          issues.push(i);
          // selectIssues already returns document offsets.
          abs.push({ start: i.start, end: i.end });
        }
      }
      const recall = seededRecall(essay, abs, essaySeeds);
      const rawCount = [...byId.values()].reduce((n, l) => n + l.length, 0);
      const seedHits = essaySeeds.map((sd) => `${sd.kind}:${seededRecall(essay, abs, [sd]) === 1 ? 'hit' : 'miss'}`).join(' ');
      check('deep check: seeded recall >= 3/4', recall >= 0.75, `${Math.round(recall * 4)}/4 (${seedHits}), ${rawCount} reported, ${issues.length} shown`);
      check('deep check: a tense_shift note', output.notes.some((n) => n.type === 'tense_shift'), `${output.notes.length} notes: ${output.notes.map((n) => n.type).join(', ')}`);
      const over = output.notes.filter((n) => n.type === 'overused_word');
      check('deep check: an overused_word note with count >= 4', over.some((n) => (n.count ?? 0) >= 4), over.map((n) => `count ${n.count}`).join(', ') || 'none');
    });
  }

  if (wants('citations')) {
    console.log('Citation finder (Sonnet + web search)');
    await guarded('citations', async () => {
      for (const { id, claim } of claims.slice(0, CLAIMS)) {
        const out = await billed('citations', startCitationSearch(client, { system: buildCitationsSystem(), user: buildCitationsUser(claim, '', '') }));
        const cost = costFromUsage(out.model, out.usage);
        spend('citations', cost);
        const searches = out.usage.server_tool_use?.web_search_requests ?? 0;
        const returned = new Set<string>();
        for (const b of out.content) {
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.type === 'web_search_result') returned.add(normalizeUrl(r.url));
        }
        const sources = sourcesFromResponse(out.content);
        const est = estimate(out.model, claim.length + CITATION_RESULTS_CHARS, REVIEW_EXPECTED.citations, CITATION_MAX_SEARCHES);
        console.log(`      citations ${id}: ${out.usage.input_tokens} in, ${out.usage.output_tokens} out, ${searches} searches, input ${out.usage.input_tokens} + cache write ${out.usage.cache_creation_input_tokens ?? 0} + cache read ${out.usage.cache_read_input_tokens ?? 0}, real $${cost.toFixed(4)} vs estimate $${est.toFixed(4)} (${(cost / est).toFixed(2)}x), stop ${out.stopReason}`);
        check(`citations ${id}: >= 2 sources`, sources.length >= 2, `${sources.length} sources, ${returned.size} results`);
        check(`citations ${id}: every URL is in the results`, sources.length > 0 && sources.every((s) => returned.has(normalizeUrl(s.url))));
        check(`citations ${id}: <= 3 searches`, searches <= 3, `${searches} searches`);
      }
    });
  }

  // Panel estimates against the real per-run cost, for the agents that ran once on the essay.
  console.log('\nCost by agent');
  for (const [agent, usd] of Object.entries(perAgent)) console.log(`  ${agent}: $${usd.toFixed(4)}`);
  console.log(`  panel estimates: readers $${estimate('claude-sonnet-5-5', essay.length, REVIEW_EXPECTED.readers).toFixed(4)}, grader $${estimate('claude-sonnet-5-5', essay.length + rubricPlain.length, REVIEW_EXPECTED.grader).toFixed(4)}, deep check $${estimate('claude-sonnet-5-5', essay.length, REVIEW_EXPECTED.deepCheck).toFixed(4)}`);
  console.log(`\nTotal cost: $${totalCost.toFixed(4)}`);
  console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASSED');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error('Eval error:', errLine(e));
  console.log(`Total cost so far: $${totalCost.toFixed(4)}`);
  process.exitCode = 1;
});
