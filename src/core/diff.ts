import DiffMatchPatch from 'diff-match-patch';

export interface DiffPart {
  op: 'same' | 'add' | 'del';
  text: string;
}

const TOKEN = /\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}]/gu;

/** Word-level diff: tokens (words, whitespace runs, punctuation) are mapped to chars so no word is ever split. */
export function wordDiff(from: string, to: string): DiffPart[] {
  const tokens: string[] = [];
  const ids = new Map<string, number>();
  const encode = (text: string) =>
    (text.match(TOKEN) ?? [])
      .map((tok) => {
        let id = ids.get(tok);
        if (id === undefined) {
          id = tokens.length;
          tokens.push(tok);
          ids.set(tok, id);
        }
        return String.fromCharCode(id);
      })
      .join('');
  const a = encode(from);
  const b = encode(to);
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(a, b, false);
  dmp.diff_cleanupSemantic(diffs);
  const ops = { [-1]: 'del', 0: 'same', 1: 'add' } as const;
  const parts: DiffPart[] = [];
  for (const [code, chars] of diffs) {
    const text = Array.from(chars, (ch) => tokens[ch.charCodeAt(0)]).join('');
    if (text === '') continue;
    const op = ops[code as -1 | 0 | 1];
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.text += text;
    else parts.push({ op, text });
  }
  return parts;
}
