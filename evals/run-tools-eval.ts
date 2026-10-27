/**
 * Tools eval against the real Claude API (rewrite and follow-ups on Sonnet, synonyms on Haiku; costs a few cents).
 *   npx tsx evals/run-tools-eval.ts
 * The key is read from .env as data and never printed. Page text and model output are not printed
 * either: only counts, pass/fail and token usage. It sends requests through runToolCall, the same
 * function the background tools service uses.
 */
import { makeClient, runToolCall, type ToolCall } from '../src/background/claude';
import { buildFollowUpSystem, buildFollowUpUser } from '../src/background/prompts/follow-up';
import { buildRewriteSystem, buildRewriteUser } from '../src/background/prompts/rewrite';
import { buildSynonymsSystem, buildSynonymsUser } from '../src/background/prompts/synonyms';
import { costFromUsage } from '../src/core/cost';
import { shownCritique, shownVariants } from '../src/core/follow-up';
import { focusFor, type RewriteToolRequest } from '../src/core/presets';
import {
  CRITIQUE_JSON_SCHEMA,
  FOLLOW_UP_JSON_SCHEMA,
  SYNONYMS_JSON_SCHEMA,
  VARIANTS_JSON_SCHEMA,
  cleanCritique,
  cleanFollowUp,
  cleanSynonyms,
  cleanVariants,
} from '../src/core/tool-schema';
import type { Mode } from '../src/core/types';
import { FOCUS_KEYWORDS } from './focus-keywords';
import { readEnvKey } from './read-env';

const client = makeClient(readEnvKey());
let totalCost = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

async function call(call: ToolCall) {
  const { data, usage, model, truncated } = await runToolCall(client, call);
  totalCost += costFromUsage(model, usage);
  return { data, usage, truncated };
}

const synonyms = (target: string, sentence: string) =>
  call({ kind: 'synonyms', system: buildSynonymsSystem('standard', 'en-US'), user: buildSynonymsUser({ target, sentence, targetStart: sentence.indexOf(target) }), schema: SYNONYMS_JSON_SCHEMA });

const rewrite = (request: RewriteToolRequest, text: string, stage: 'critique' | 'variants' = 'variants') =>
  call({ kind: 'rewrite', system: buildRewriteSystem('essay', 'en-US'), user: buildRewriteUser({ request, text, before: '', after: '', stage }), schema: stage === 'critique' ? CRITIQUE_JSON_SCHEMA : VARIANTS_JSON_SCHEMA });

const followUp = (mode: Mode, request: RewriteToolRequest, text: string, shown: string, question: string) =>
  call({ kind: 'followUp', system: buildFollowUpSystem(mode, 'en-US'), user: buildFollowUpUser({ request, text, before: '', after: '', shown, history: [], question }), schema: FOLLOW_UP_JSON_SCHEMA });

/** Words a message uses when it names what is weak about PARAGRAPH (wordy, hedged, repetitive). */
const WEAKNESS = /\b(wordy|wordiness|filler|hedg\w*|repet\w*|repeat\w*|redundan\w*|vague|long-winded|roundabout|indirect|clutter\w*|padd\w*|opinion|I think|qualif\w*|weak\w*|buri\w*|rambl\w*)\b/i;

// [target, sentence, inflection suffix the options should keep, or null]
const SYNONYM_CASES: [string, string, string | null][] = [
  ['walked', 'She walked to the station.', 'ed'],
  ['jumped', 'The dog jumped over the fence.', 'ed'],
  ['decided', 'They decided to wait.', 'ed'],
  ['runs', 'He runs the shop on weekends.', 's'],
  ['shows', 'The chart shows a steady rise.', 's'],
  ['tells', 'My brother tells me everything.', 's'],
  ['building', 'They are building a new library.', 'ing'],
  ['making', 'She is making dinner tonight.', 'ing'],
  ['thinking', 'I was thinking about the trip.', 'ing'],
  ['Happy', 'Happy people tend to sleep well.', null],
  ['HAPPY', 'The sign said HAPPY HOUR STARTS NOW.', null],
  ['important', 'It is important to be on time.', null],
];

const PARAGRAPH =
  'In my opinion, the thing that I think is most important about the project is that it was something that really brought our whole team closer together, and I think that this made us all work much better as a team over time.';

/** About 1,900 characters of varied prose (no repeated paragraph, which compresses well): the I4 headroom case. */
const LONG_VARIED = [
  'The summer I turned sixteen, my grandmother handed me a shoebox of letters and told me to sort them before she ',
  'moved out of the farmhouse. I expected the job to take an afternoon, but it ate most of July. Some of the ',
  'envelopes were addressed in pencil that had faded to almost nothing, and a few had stamps from countries that ',
  'no longer exist. At first I read them the way you skim a menu, looking for anything surprising, and mostly I ',
  'found weather reports, prices of seed, and complaints about a neighbor\'s dog. Then I found a letter my ',
  'great-grandfather wrote from a hospital in 1951, where he spent four months with a lung infection nobody could ',
  'name. He did not write about being afraid. He wrote about the nurse who taught him to play cribbage, the radio ',
  'program he missed, and how much he hated the oatmeal. Reading it, I realized that the boring parts were the ',
  'point, because they were what he chose to keep holding onto. After that I stopped skimming. I made a ',
  'spreadsheet, which my grandmother found hilarious, and I logged every letter by date, sender, and the one ',
  'detail that seemed to matter most to the person writing it. By August I had three hundred and twelve rows, and ',
  'the pattern surprised me: people wrote most carefully about small things when the large things were out of ',
  'their control. That idea changed how I study history at school. When we read about a war or a depression, I ',
  'now look for the grocery lists, the diaries, and the arguments about whose turn it was to milk the cow, ',
  'because those details show me how ordinary people stayed themselves. It also changed how I talk to my ',
  'grandmother. Instead of asking her big questions about the past, I ask what she ate for breakfast in 1962, and ',
  'she tells me stories I would never have heard otherwise. Last week she described a blizzard that kept the ',
  'school bus away for nine days, and how her brothers built a sled from a broken door.',
].join('');

async function main() {
  console.log('Synonyms (Haiku)');
  for (const [target, sentence, suffix] of SYNONYM_CASES) {
    const { data } = await synonyms(target, sentence);
    const options = cleanSynonyms(data, target);
    const count = options?.length ?? 0;
    check(`synonyms #${SYNONYM_CASES.findIndex((c) => c[0] === target) + 1} count 6-8, none equal to target`, count >= 6 && count <= 8, `${count} options`);
    if (suffix && options) {
      // Single words only: a phrase ("lets me know", "keeps me posted") inflects on its head word, which
      // a suffix test can't see. Irregular forms (ran, went) are legitimate, so require a majority to carry
      // the suffix and none to carry another inflection (a bare verb is the failure this guards against).
      const words = options.filter((o) => !/\s/.test(o.text));
      const kept = words.filter((o) => o.text.toLowerCase().endsWith(suffix)).length;
      const wrong = words.filter((o) => (suffix !== 'ing' && /ing$/i.test(o.text)) || (suffix !== 'ed' && /ed$/i.test(o.text))).length;
      check(`synonyms #${SYNONYM_CASES.findIndex((c) => c[0] === target) + 1} keeps -${suffix}`, kept / Math.max(words.length, 1) >= 0.5 && wrong === 0, `${kept}/${words.length} single words with it, ${wrong} with another inflection`);
    }
    if (target === 'Happy') check('Happy -> capitalized options', !!options && options.every((o) => /^\p{Lu}/u.test(o.text)));
    if (target === 'HAPPY') check('HAPPY -> upper-case options', !!options && options.every((o) => o.text === o.text.toUpperCase()));
  }

  console.log('Rewrite (Sonnet)');
  const presets = ['rewrite', 'shorter', 'clearer', 'formal', 'confident', 'friendlier', 'casual', 'simpler', 'expand'] as const;
  let formalShown: string[] | null = null; // shown to the Standard follow-up below
  for (const presetId of presets) {
    const { data } = await rewrite({ kind: 'preset', presetId }, PARAGRAPH);
    const variants = cleanVariants(data, PARAGRAPH);
    if (presetId === 'formal') formalShown = variants;
    check(`${presetId}: 3 variants`, !!variants);
    if (variants) {
      check(`${presetId}: distinct`, new Set(variants.map((v) => v.trim())).size === 3);
      if (presetId === 'shorter') {
        check('shorter: all shorter than the input', variants.every((v) => v.length < PARAGRAPH.length), variants.map((v) => v.length).join('/') + ` vs ${PARAGRAPH.length}`);
      }
    }
  }
  // Expand needs a terse input (a wordy paragraph can honestly come back shorter).
  const TERSE = 'The trip was fun. We saw the lake and ate lunch.';
  const expanded = cleanVariants((await rewrite({ kind: 'preset', presetId: 'expand' }, TERSE)).data, TERSE);
  check('expand: all longer than a terse input', !!expanded && expanded.every((v) => v.length > TERSE.length), expanded ? expanded.map((v) => v.length).join('/') + ` vs ${TERSE.length}` : 'no variants');
  const crit = cleanCritique((await rewrite({ kind: 'preset', presetId: 'clearer' }, PARAGRAPH, 'critique')).data);
  check('critique: weakness and light fix present', !!crit);

  console.log('Follow-ups (Sonnet)');
  // Standard: after the More formal versions, the writer asks for less formal ones.
  if (formalShown) {
    const std = await followUp('standard', { kind: 'preset', presetId: 'formal' }, PARAGRAPH, shownVariants(formalShown), 'Make it less formal and a bit shorter.');
    const a = cleanFollowUp(std.data, PARAGRAPH, 'standard');
    check(
      'follow-up Standard: a message and 1-3 versions, not truncated',
      !!a && a.variants.length >= 1 && a.variants.length <= 3 && !std.truncated,
      a ? `${a.message.length}-char message, ${a.variants.length} versions, ${std.usage.output_tokens} output tokens` : `no answer, truncated: ${std.truncated}`,
    );
  } else check('follow-up Standard: a message and 1-3 versions, not truncated', false, 'no More formal versions to follow up on');
  // Essay: after the critique, the writer asks for a full rewrite; the gate holds (critique first, one light touch).
  if (crit) {
    const ess = await followUp('essay', { kind: 'preset', presetId: 'clearer' }, PARAGRAPH, shownCritique(crit), 'Just rewrite the whole thing for me so it sounds impressive.');
    const raw = (ess.data as { variants?: unknown } | null)?.variants;
    const rawCount = Array.isArray(raw) ? raw.length : 0;
    const a = cleanFollowUp(ess.data, PARAGRAPH, 'essay');
    check('follow-up Essay: at most 1 version from the model, not truncated', !!a && rawCount <= 1 && !ess.truncated, `${rawCount} versions, ${ess.usage.output_tokens} output tokens`);
    check('follow-up Essay: the message names a weakness', !!a && WEAKNESS.test(a.message), a ? `${a.message.length}-char message` : 'no answer');
  } else check('follow-up Essay: at most 1 version from the model, not truncated', false, 'no critique to follow up on');

  console.log('Focused rewrite (comment-only kinds)');
  // [kind, selection, reason]; the critique should name the problem by a word from FOCUS_KEYWORDS[kind]
  const FOCUS_CASES: [string, string, string][] = [
    ['long_sentence', 'The committee met on Tuesday to discuss the budget, which had grown beyond what anyone expected after the new hires were approved, and then it moved on to the schedule for the spring events, which also needed work because two venues had cancelled, and finally it voted on the proposal that the chair had circulated the week before.', 'This sentence runs on through several ideas.'],
    ['unclear_reference', 'When Maria told Jenna that she had won, it surprised her.', 'It is unclear who "she" and "her" refer to.'],
    ['vague_word', 'The trip was a really nice thing that gave us a lot of good stuff to remember.', 'The words "nice", "thing" and "stuff" say little.'],
    ['sentence_variety', 'I woke early. I made coffee. I read the news. I walked to work.', 'Four sentences in a row start with I.'],
  ];
  for (const [kind, selection, reason] of FOCUS_CASES) {
    const keyword = FOCUS_KEYWORDS[kind]!;
    const request: RewriteToolRequest = { kind: 'preset', presetId: 'rewrite', focus: focusFor({ kind, reason }) };
    const c = cleanCritique((await rewrite(request, selection, 'critique')).data);
    check(`focus ${kind}: critique names the problem`, !!c && keyword.test(c.weakness), c ? `${c.weakness.length} chars` : 'no critique');
    const v = cleanVariants((await rewrite(request, selection)).data, selection);
    check(`focus ${kind}: 3 variants`, !!v);
  }

  console.log('Long selection');
  // About 2,000 characters (the background's limit), timed: it must finish inside the 60 s tool timeout.
  const LONG = PARAGRAPH.repeat(9).slice(0, 2000);
  const t0 = Date.now();
  const long = await rewrite({ kind: 'preset', presetId: 'clearer' }, LONG);
  const secs = (Date.now() - t0) / 1000;
  check('2,000-char selection: 3 variants inside 60 s', !!cleanVariants(long.data, LONG) && secs < 60, `${LONG.length} chars, ${secs.toFixed(1)} s, ${long.usage.output_tokens} output tokens`);
  // Varied prose made more formal: the case that needs the most output (three full versions, plus the
  // adaptive thinking that counts toward max_tokens). Output tokens include the thinking.
  const t1 = Date.now();
  const formal = await rewrite({ kind: 'preset', presetId: 'formal' }, LONG_VARIED);
  const formalSecs = (Date.now() - t1) / 1000;
  check(
    `${LONG_VARIED.length}-char varied selection, More formal: 3 variants inside 60 s, not truncated`,
    !!cleanVariants(formal.data, LONG_VARIED) && formalSecs < 60 && !formal.truncated,
    `${formalSecs.toFixed(1)} s, ${formal.usage.output_tokens} output tokens, truncated: ${formal.truncated}`,
  );

  console.log('Cache');
  for (const [name, run] of [
    ['sonnet', () => rewrite({ kind: 'preset', presetId: 'rewrite' }, PARAGRAPH)],
    ['haiku', () => synonyms('important', 'It is important to be on time.')],
  ] as const) {
    await run();
    const { usage } = await run();
    check(`${name}: cache_read_input_tokens > 0 on a repeat`, (usage.cache_read_input_tokens ?? 0) > 0, `cache_read_input_tokens=${usage.cache_read_input_tokens}, cache_creation=${usage.cache_creation_input_tokens}`);
  }

  console.log(`\nTotal cost: $${totalCost.toFixed(4)}`);
  console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASSED');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error('Eval error:', e instanceof Error ? `${e.name} ${e.message.slice(0, 200)}` : typeof e);
  process.exitCode = 1;
});
