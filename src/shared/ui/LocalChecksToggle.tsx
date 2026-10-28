import { useId } from 'react';
import { useSetting } from '../use-setting';
import { localChecksItem } from '../settings';
import { Switch } from './controls';

export const LOCAL_CHECKS_HELP = "Underlines from EngLint's built-in checker appear as you type and work without the API.";

/** "Instant local checks": the built-in checker on or off, everywhere (Options and the side panel). */
export function LocalChecksToggle() {
  const on = useSetting(localChecksItem);
  const helpId = useId();
  if (on === null) return null;
  return (
    <label className="setting">
      <span className="setting-text">
        <span className="setting-name">Instant local checks</span>
        <span id={helpId} className="setting-help">
          {LOCAL_CHECKS_HELP}
        </span>
      </span>
      <Switch aria-label="Instant local checks" aria-describedby={helpId} checked={on} onChange={(v) => void localChecksItem.setValue(v)} />
    </label>
  );
}
