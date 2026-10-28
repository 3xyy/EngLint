import { kindInfo } from '../../core/kinds';
import type { Mode } from '../../core/types';
import { dictionaryItem, rulesItem } from '../settings';
import { useSetting } from '../use-setting';
import { Button } from './controls';

const MODE_WORDS: Record<Mode, string> = { essay: 'in essays', standard: 'in other writing', casual: 'in casual writing' };

const ruleLabel = (kind: string) => kindInfo(kind)?.label ?? kind.replace(/_/g, ' ');

/** The writer's "Stop suggesting" rules and dictionary words, each with Remove. */
export function YourRules() {
  const rules = useSetting(rulesItem);
  const words = useSetting(dictionaryItem);
  if (!rules || !words) return null;

  if (rules.length === 0 && words.length === 0) {
    return (
      <p className="muted your-rules-empty">
        Nothing here yet. Use <b>Stop suggesting</b> or <b>Add “word” to dictionary</b> in a card's ⋯ menu.
      </p>
    );
  }

  return (
    <ul className="your-rules">
      {rules.map((r) => {
        const text = `${ruleLabel(r.kind)} ${MODE_WORDS[r.mode]}`;
        return (
          <li key={`${r.mode}:${r.kind}`} className="your-rule">
            <span>{text}</span>
            <Button
              size="sm"
              aria-label={`Remove ${text}`}
              onClick={() => void rulesItem.getValue().then((all) => rulesItem.setValue(all.filter((x) => !(x.mode === r.mode && x.kind === r.kind))))}
            >
              Remove
            </Button>
          </li>
        );
      })}
      {words.map((w) => (
        <li key={`word:${w}`} className="your-rule">
          <span>“{w}” in your dictionary</span>
          <Button
            size="sm"
            aria-label={`Remove “${w}” from your dictionary`}
            onClick={() => void dictionaryItem.getValue().then((all) => dictionaryItem.setValue(all.filter((x) => x !== w)))}
          >
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}
