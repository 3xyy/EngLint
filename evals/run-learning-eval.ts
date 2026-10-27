/**
 * Learning eval against the real Claude API (the live check on Haiku, the style profile and Sound like me on Sonnet;
 * costs a few cents). It aborts past the budget below.
 *   npx tsx evals/run-learning-eval.ts
 *   npx tsx evals/run-learning-eval.ts --live-only   (the live check part only, on Haiku)
 * The key is read from .env as data and never printed. Page text and model output are not printed either: only counts,
 * pass/fail and token usage. Requests go through runLiveCheck and runToolCall, the functions the background uses.
 */
import { readFileSync } from 'node:fs';
import { LIVE_CHECK_MODEL, makeClient, runLiveCheck, runToolCall, type ToolCall } from '../src/background/claude';
import { PROMPT_VERSION, type Learned } from '../src/background/prompts/live-check';
import { buildRewriteSystem, buildRewriteUser } from '../src/background/prompts/rewrite';
import { buildStyleProfileSystem, buildStyleProfileUser } from '../src/background/prompts/style-profile';
import { changesClaims } from '../src/core/claims';
import { costFromUsage, type UsageLike } from '../src/core/cost';
import { selectIssues, type SuggestionPolicy } from '../src/core/match';
import { STYLE_PROFILE_JSON_SCHEMA, VOICE_JSON_SCHEMA, cleanStyleProfile, cleanVoice, MAX_PROFILE_CHARS } from '../src/core/tool-schema';
import type { FamilyToggles, Paragraph, RawIssue } from '../src/core/types';
import { readEnvKey } from './read-env';

const BUDGET_USD = 0.5;
const LIVE_ONLY = process.argv.includes('--live-only');
const client = makeClient(readEnvKey());
let totalCost = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};
const spend = (cost: number) => {
  totalCost += cost;
  if (totalCost > BUDGET_USD) throw new Error(`budget exceeded: $${totalCost.toFixed(4)} > $${BUDGET_USD}`);
};

const ALL_ON: FamilyToggles = { clarity: true, engagement: true, delivery: true, generic: true };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
type Fixture = { id: string; mode: string; text: string; expect: { original: string; replacement: string }[] };

// A misspelling-like name (a spelling a checker would correct) in a sentence appended to a paragraph with one seeded error.
const EXTRAS: [name: string, sentence: (name: string) => string][] = [
  ['Jeniffer', (n) => `My teammate ${n} said that in order to finish on time we had to start early.`],
  ['Micheal', (n) => `${n} asked whether, due to the fact that it rained, we should move the meeting.`],
  ['Catheryne', (n) => `At this point in time, ${n} is the only one who has the key.`],
  ['Rebbecca', (n) => `${n} will call you in the event that the order is late.`],
  ['Steven-Pau', (n) => `In order to reach ${n}, send a message before noon.`],
  ['Isabela', (n) => `For the purpose of the review, ${n} kept every receipt.`],
  ['Alexandr', (n) => `${n} left early on account of the fact that the bus was late.`],
  ['Jonathon', (n) => `Please thank ${n} in advance for the help.`],
];
/** The claims rule Sound like me's apply gate uses. */
const VOICE_CLAIMS = { sentenceStarts: 'lenient' } as const;

const overlaps = (a: string, b: string) => a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());

async function liveCheck(paragraphs: { id: string; text: string }[], learned?: Learned) {
  const out = await runLiveCheck(client, { mode: 'standard', dialect: 'en-US', learned, paragraphs });
  spend(costFromUsage(LIVE_CHECK_MODEL, out.usage));
  const raw = new Map<string, RawIssue[]>();
  for (const r of out.output.results) raw.set(r.paragraph_id, [...(raw.get(r.paragraph_id) ?? []), ...r.issues]);
  return { raw, truncated: out.truncated };
}

/** Gold errors the model reported (a shown error that overlaps the seeded one), by the client's own filter. */
function recall(items: { paragraph: Paragraph; gold: string }[], raw: Map<string, RawIssue[]>): number {
  const policy: SuggestionPolicy = { mode: 'standard', families: ALL_ON, rules: new Set(), dictionary: new Set() };
  return items.filter(({ paragraph, gold }) =>
    selectIssues(paragraph, raw.get(paragraph.id) ?? [], policy).some((i) => i.severity === 'error' && overlaps(i.original, gold)),
  ).length;
}

async function tool(c: ToolCall) {
  const r = await runToolCall(client, c);
  spend(costFromUsage(r.model, r.usage as UsageLike));
  return r;
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'’\s]/gu, ' ').split(/\s+/).filter(Boolean);
/** The longest run of words the profile shares with the samples. */
function longestShared(profile: string, samples: string): number {
  const p = words(profile);
  const hay = ` ${words(samples).join(' ')} `;
  let best = 0;
  for (let i = 0; i < p.length; i++) for (let n = best + 1; i + n <= p.length && hay.includes(` ${p.slice(i, i + n).join(' ')} `); n++) best = n;
  return best;
}

async function main() {
  console.log(`Live check ${PROMPT_VERSION} (Haiku): the dictionary`);
  const fixtures = readJson<Fixture[]>('evals/live-check.fixtures.json').filter((f) => f.mode === 'standard' && f.expect.length === 1 && /^standard-err-0[1-8]$/.test(f.id));
  check('fixtures: 8 seeded-error paragraphs', fixtures.length === 8, `${fixtures.length}`);
  const items = fixtures.map((f, i) => ({ id: `p${i}`, text: `${f.text} ${EXTRAS[i]![1](EXTRAS[i]![0])}`, gold: f.expect[0]!.original, name: EXTRAS[i]![0] }));
  const paragraphs = items.map((it) => ({ id: it.id, text: it.text }));
  const goldItems = items.map((it) => ({ paragraph: { id: it.id, text: it.text } as Paragraph, gold: it.gold }));
  const learned: Learned = { dictionary: items.map((it) => it.name) };

  const control = await liveCheck(paragraphs);
  const taught = await liveCheck(paragraphs, learned);
  check('both batches complete', !control.truncated && !taught.truncated);
  const nameSpelling = (r: Map<string, RawIssue[]>) => flaggedNames(r).length;
  const flaggedNames = (r: Map<string, RawIssue[]>) => items.filter((it) => (r.get(it.id) ?? []).some((i) => i.category === 'spelling' && overlaps(i.original, it.name)));
  console.log(`  without the dictionary: ${nameSpelling(control.raw)} names flagged as spelling`);
  check('dictionary: no dictionary name is flagged as spelling', nameSpelling(taught.raw) === 0, `${nameSpelling(taught.raw)} of ${items.length} names flagged${nameSpelling(taught.raw) ? `: ${flaggedNames(taught.raw).map((it) => it.name).join(', ')}` : ''}`);
  const [before, after] = [recall(goldItems, control.raw), recall(goldItems, taught.raw)];
  check('seeded errors: recall with the dictionary >= recall without', after >= before, `${after}/${items.length} vs ${before}/${items.length}`);
  check('seeded errors: at least 6 of 8 found with the dictionary', after >= 6, `${after}/${items.length}`);

  if (LIVE_ONLY) return finish();

  console.log('Style profile sp-1 (Sonnet)');
  const voices = readJson<{ id: string; text: string }[]>('evals/voice.fixtures.json');
  const samples = voices.map((v) => v.text).join('\n\n');
  const built = await tool({ kind: 'styleProfile', system: buildStyleProfileSystem(), user: buildStyleProfileUser(samples), schema: STYLE_PROFILE_JSON_SCHEMA });
  const profile = cleanStyleProfile(built.data);
  check('profile: non-empty', !!profile, `samples ${samples.length} chars`);
  check(`profile: at most ${MAX_PROFILE_CHARS} characters`, !!profile && profile.length <= MAX_PROFILE_CHARS, `${profile?.length ?? 0} chars`);
  const shared = profile ? longestShared(profile, samples) : 99;
  check('profile: no run of more than 8 words from the samples', shared <= 8, `longest shared run ${shared} words`);

  console.log('Sound like me rw-4 (Sonnet)');
  const sugg = readJson<{ id: string; text: string }[]>('evals/suggestions.fixtures.json');
  const generic = ['gen-pos-e01', 'gen-pos-e03', 'gen-pos-e04'].map((id) => sugg.find((s) => s.id === id)!);
  const voice = (text: string) =>
    tool({
      kind: 'rewrite',
      system: buildRewriteSystem('essay', 'en-US', profile),
      user: buildRewriteUser({ request: { kind: 'preset', presetId: 'voice' }, text, before: '', after: '', stage: 'variants' }),
      schema: VOICE_JSON_SCHEMA,
    });
  for (const g of generic) {
    const r = await voice(g.text);
    const v = cleanVoice(r.data, g.text);
    check(`${g.id}: at least 1 tell`, !!v && v.tells.length >= 1, `${v?.tells.length ?? 0} tells`);
    check(`${g.id}: final differs from the original`, !!v && v.final.trim() !== g.text.trim());
    check(`${g.id}: claims unchanged (the apply gate would allow it)`, !!v && !changesClaims(g.text, v.final, VOICE_CLAIMS));
  }

  console.log('Other generic-phrasing fixtures (report only)');
  for (const id of ['gen-pos-e02', 'gen-pos-e05', 'gen-pos-e06']) {
    const text = sugg.find((x) => x.id === id)!.text;
    const v = cleanVoice((await voice(text)).data, text);
    console.log(`INFO  ${id}: ${v ? `${v.tells.length} tells, final ${v.final.trim() === text.trim() ? 'unchanged' : 'changed'}, changes claims: ${changesClaims(text, v.final, VOICE_CLAIMS)}` : 'bad response'}`);
  }

  console.log('Already plain (report only)');
  for (const id of ['voice-03', 'voice-10']) {
    const text = voices.find((v) => v.id === id)!.text;
    const v = cleanVoice((await voice(text)).data, text);
    console.log(`INFO  ${id}: ${v ? `${v.tells.length} tells, final ${v.final.trim() === text.trim() ? 'unchanged' : 'changed'}` : 'bad response'}`);
  }

  finish();
}

function finish() {
  console.log(`\nTotal cost: $${totalCost.toFixed(4)}`);
  console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASSED');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error('Eval error:', e instanceof Error ? `${e.name} ${e.message.slice(0, 200)}` : typeof e);
  console.log(`Cost so far: $${totalCost.toFixed(4)}`);
  process.exitCode = 1;
});
