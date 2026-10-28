import { useId } from 'react';
import { useSetting } from '../use-setting';
import { showBadgeItem } from '../settings';
import { Switch } from './controls';

const BADGE_HELP = "The count of what EngLint found, at the corner of the box you're writing in.";

/** "Show the EngLint badge": the in-field badge on or off, everywhere (Options and the side panel). */
export function BadgeToggle() {
  const on = useSetting(showBadgeItem);
  const helpId = useId();
  if (on === null) return null;
  return (
    <label className="setting">
      <span className="setting-text">
        <span className="setting-name">Show the EngLint badge</span>
        <span id={helpId} className="setting-help">
          {BADGE_HELP}
        </span>
      </span>
      <Switch aria-label="Show the EngLint badge" aria-describedby={helpId} checked={on} onChange={(v) => void showBadgeItem.setValue(v)} />
    </label>
  );
}
