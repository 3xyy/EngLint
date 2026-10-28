import { useEffect, useId, useState } from 'react';
import type { FamilyToggle, FamilyToggles as Toggles, Mode } from '../../core/types';
import { peekSuggestionFamilies, suggestionFamiliesByModeItem } from '../settings';
import { Switch } from './controls';

const ROWS: { key: FamilyToggle; label: string }[] = [
  { key: 'clarity', label: 'Clarity' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'generic', label: 'Generic phrasing' },
];

const OFF: Toggles = { clarity: false, engagement: false, delivery: false, generic: false };

/** Where a switch is on when only one of Essay and Standard has it on; null when the two agree. */
function scopeOf(essay: boolean, standard: boolean): string | null {
  if (essay === standard) return null;
  return essay ? 'Essays only' : 'Other writing only';
}

/**
 * The four suggestion switches, each after its family's dot. A switch is on when Essay and Standard both have the
 * family on, off when neither does, and half on (with a caption naming where it is on) when they differ. A click on
 * a half-on or off switch turns the family on in both modes, and on an on one turns it off in both. Casual never
 * gets suggestions, so its toggles stay off.
 */
export function FamilyToggles() {
  const [value, setValue] = useState<Record<Mode, Toggles> | null>(null);
  const uid = useId();

  useEffect(() => {
    let live = true;
    void peekSuggestionFamilies().then((v) => live && setValue(v)); // opening a page saves nothing
    const unwatch = suggestionFamiliesByModeItem.watch((v) => live && v && setValue(v));
    return () => {
      live = false;
      unwatch();
    };
  }, []);

  if (!value) return null;

  function flip(key: FamilyToggle, on: boolean) {
    const next = { ...value!, essay: { ...value!.essay, [key]: on }, standard: { ...value!.standard, [key]: on }, casual: { ...OFF } };
    setValue(next);
    void suggestionFamiliesByModeItem.setValue(next);
  }

  return (
    <div className="family-toggles">
      {ROWS.map(({ key, label }) => {
        const on = value.essay[key] && value.standard[key];
        const scope = scopeOf(value.essay[key], value.standard[key]);
        const captionId = `${uid}-${key}`;
        return (
          <label key={key} className="setting">
            <span className="setting-name">
              <span className={`el-dot el-fam-${key}`} aria-hidden="true" />
              {label}
              {scope && (
                <span id={captionId} className="family-scope">
                  {scope}
                </span>
              )}
            </span>
            <Switch
              aria-label={label}
              aria-describedby={scope ? captionId : undefined}
              checked={on}
              mixed={scope !== null}
              onChange={() => flip(key, !on)}
            />
          </label>
        );
      })}
    </div>
  );
}
