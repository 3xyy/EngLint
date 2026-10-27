import { useSetting } from '../use-setting';
import { showBadgeItem } from '../settings';

/** "Show the EngLint badge": the in-field badge on or off, everywhere (Options and the side panel). */
export function BadgeToggle() {
  const on = useSetting(showBadgeItem);
  if (on === null) return null;
  return (
    <label className="row" style={{ justifyContent: 'flex-start' }}>
      <input type="checkbox" checked={on} onChange={(e) => void showBadgeItem.setValue(e.target.checked)} />
      <span>Show the EngLint badge</span>
    </label>
  );
}
