/**
 * Chat eval against the real Claude API (5 streamed turns on Sonnet, one with a selection; costs a few cents).
 *   npx tsx evals/run-chat-eval.ts
 * The key is read from .env as data and never printed. Page text and model output are not printed
 * either: only counts, pass/fail and token usage. It streams through streamChat with the prompts the
 * background chat service builds.
 */
import { makeClient, streamChat } from '../src/background/claude';
import { buildChatMessages, buildChatSystem } from '../src/background/prompts/chat';
import { chatContext } from '../src/core/chat-context';
import { EDITS_SENTINEL, splitAnswer, type ChatTurn, type Edit } from '../src/core/chat-format';
import { costFromUsage, type UsageLike } from '../src/core/cost';
import type { Mode } from '../src/core/types';
import { readEnvKey } from './read-env';

const client = makeClient(readEnvKey());
let totalCost = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

const EMAIL =
  'Hi Dana,\n\nI am writing to inform you that the quarterly report will be delayed until next Friday. We have encountered some issues with the data from the regional offices. Please advise if this timeline is acceptable to you.\n\nRegards,\nSam';

const ESSAY =
  'When I joined the robotics club, I did not know how to code. I spent many afternoons watching older students and asking questions that probably annoyed them. Over time, I learned to write simple programs, and then more complex ones. By senior year, I was the one answering questions. This experience taught me a lot about learning and about patience.';

interface Answer {
  raw: string;
  message: string;
  edits: Edit[];
  usage: UsageLike;
  complete: boolean;
  deltas: number;
}

/** One turn, streamed; the history grows like the background's stored conversation. */
async function ask(mode: Mode, doc: string, history: ChatTurn[], message: string, selection = ''): Promise<Answer> {
  let deltas = 0;
  const s = streamChat(
    client,
    { system: buildChatSystem(mode, 'en-US', chatContext(doc, null)), messages: buildChatMessages(history, message, selection) },
    () => deltas++,
  );
  const out = await s.done;
  totalCost += costFromUsage(out.model, out.usage);
  const { message: text, edits } = splitAnswer(out.text);
  if (out.complete) history.push({ role: 'user', text: message }, { role: 'assistant', text, ...(edits.length ? { edits } : {}) });
  return { raw: out.text, message: text, edits, usage: out.usage, complete: out.complete, deltas };
}

/** The answer format holds: a message, and when the sentinel line is there, edits that parse. */
function formatValid(a: Answer): { ok: boolean; detail: string } {
  const hasSentinel = new RegExp(`(^|\\n)\\s*${EDITS_SENTINEL}\\s*(\\n|$)`).test(a.raw);
  const ok = a.complete && a.message.length > 0 && (!hasSentinel || a.edits.length > 0);
  return {
    ok,
    detail: `${a.deltas} deltas, ${a.message.length}-char message, sentinel: ${hasSentinel}, ${a.edits.length} edits, complete: ${a.complete}, ${a.usage.output_tokens} output tokens, cache read ${a.usage.cache_read_input_tokens ?? 0}`,
  };
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
/** Words in `replacement` that `original` doesn't have (counted with repeats). */
function addedWords(e: Edit): number {
  const pool = new Map<string, number>();
  for (const w of words(e.original)) pool.set(w, (pool.get(w) ?? 0) + 1);
  let added = 0;
  for (const w of words(e.replacement)) {
    const n = pool.get(w) ?? 0;
    if (n > 0) pool.set(w, n - 1);
    else added++;
  }
  return added;
}

/** Drafted essay prose speaks as the writer: a message paragraph with 3+ first-person words outside quotation marks. */
function draftedParagraphs(message: string): number {
  return message
    .split(/\n\s*\n/)
    .map((p) => p.replace(/"[^"]*"|“[^”]*”/g, ''))
    .filter((p) => (p.match(/\b(I|my|me|I'm|I've)\b/g) ?? []).length >= 3).length;
}

/** Whether the message quotes the document: a quoted span of 15+ characters found in it. */
function quotesDoc(message: string, doc: string): boolean {
  const spans = message.match(/"([^"]{15,})"|“([^”]{15,})”/g) ?? [];
  return spans.some((s) => doc.includes(s.slice(1, -1).replace(/[.,]$/, '')));
}

async function main() {
  console.log('Standard email (3 turns)');
  const std: ChatTurn[] = [];
  const s1 = await ask('standard', EMAIL, std, 'Does this email sound friendly enough to send to a coworker?');
  const f1 = formatValid(s1);
  check('standard 1: format valid', f1.ok, f1.detail);
  // The writer selects the first sentence and asks about "this".
  const FIRST = 'I am writing to inform you that the quarterly report will be delayed until next Friday.';
  const s2 = await ask('standard', EMAIL, std, 'Can you rewrite this so it sounds warmer?', FIRST);
  const f2 = formatValid(s2);
  check('standard 2: format valid', f2.ok, f2.detail);
  check('standard 2: at least 1 edit', s2.edits.length >= 1, `${s2.edits.length} edits`);
  check('standard 2: the edits are on the selected sentence', s2.edits.length > 0 && s2.edits.every((e) => FIRST.includes(e.original) || e.original.includes(FIRST)));
  check(
    'standard 2: every edit original occurs exactly once in the email',
    s2.edits.length > 0 && s2.edits.every((e) => EMAIL.split(e.original).length === 2),
    s2.edits.map((e) => `${e.original.length} chars, ${EMAIL.split(e.original).length - 1} found`).join('; '),
  );
  const s3 = await ask('standard', EMAIL, std, 'Should I keep the last sentence?');
  const f3 = formatValid(s3);
  check('standard 3: format valid', f3.ok, f3.detail);
  check('standard: the stable and document blocks are read from the cache on a later turn', (s3.usage.cache_read_input_tokens ?? 0) > 0, `cache_read_input_tokens=${s3.usage.cache_read_input_tokens}`);

  console.log('Essay paragraph (2 turns)');
  const ess: ChatTurn[] = [];
  const e1 = await ask('essay', ESSAY, ess, "What's the weakest sentence here?");
  const g1 = formatValid(e1);
  check('essay 1: format valid', g1.ok, g1.detail);
  check('essay 1: quotes the writer\'s own sentence', quotesDoc(e1.message, ESSAY));
  const e2 = await ask('essay', ESSAY, ess, 'Write me a better conclusion.');
  const g2 = formatValid(e2);
  check('essay 2: format valid', g2.ok, g2.detail);
  check('essay 2: no edit adds more than 3 words', e2.edits.every((e) => addedWords(e) <= 3), e2.edits.map((e) => `${addedWords(e)} added`).join(', ') || 'no edits');
  check('essay 2: no drafted paragraph in the writer\'s voice', draftedParagraphs(e2.message) === 0, `${draftedParagraphs(e2.message)} paragraphs`);
  check('essay 2: coaches (asks or addresses the writer)', /\?|\byou(r)?\b/i.test(e2.message));

  console.log(`\nTotal cost: $${totalCost.toFixed(4)}`);
  console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASSED');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => {
  console.error('Eval error:', e instanceof Error ? `${e.name} ${e.message.slice(0, 200)}` : typeof e);
  console.log(`Total cost so far: $${totalCost.toFixed(4)}`);
  process.exitCode = 1;
});
