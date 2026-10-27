import { kindInfo } from '../../core/kinds';
import type { Mode } from '../../core/types';
import { dictionaryItem, rulesItem } from '../settings';
import { useSetting } from '../use-setting';

const MODE_WORDS: Record<Mode, string> = { essay: 'in essays', standard: 'in other writing', casual: 'in casual writing' };

const ruleLabel = (kind: string) => kindInfo(kind)?.label ?? kind.replace(/_/g, ' ');

/** The writer's "Stop suggesting" rules and dictionary words, each with Remove. */
export function YourRules() {
  const rules = useSetting(rulesItem);
  const words = useSetting(dictionaryItem);
  if (!rules || !words) return null;

  if (rules.length === 0 && words.length === 0) {
    return <p className="muted">Nothing here yet. Use “Stop suggesting” or “Add to dictionary” on a card.</p>;
  }

  return (
    <ul className="your-rules">
      {rules.map((r) => {
        const text = `${ruleLabel(r.kind)} ${MODE_WORDS[r.mode]}`;
        return (
          <li key={`${r.mode}:${r.kind}`} className="row">
            <span>{text}</span>
            <button
              type="button"
              className="btn"
              aria-label={`Remove ${text}`}
              onClick={() => void rulesItem.getValue().then((all) => rulesItem.setValue(all.filter((x) => !(x.mode === r.mode && x.kind === r.kind))))}
            >
              Remove
            </button>
          </li>
        );
      })}
      {words.map((w) => (
        <li key={`word:${w}`} className="row">
          <span>“{w}” in your dictionary</span>
          <button
            type="button"
            className="btn"
            aria-label={`Remove “${w}” from your dictionary`}
            onClick={() => void dictionaryItem.getValue().then((all) => dictionaryItem.setValue(all.filter((x) => x !== w)))}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
