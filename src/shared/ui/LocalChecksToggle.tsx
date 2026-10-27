import { useId } from 'react';
import { useSetting } from '../use-setting';
import { localChecksItem } from '../settings';

export const LOCAL_CHECKS_HELP = "Underlines from EngLint's built-in checker appear as you type and work without the API.";

/** "Instant local checks": the built-in checker on or off, everywhere (Options and the side panel). */
export function LocalChecksToggle() {
  const on = useSetting(localChecksItem);
  const helpId = useId();
  if (on === null) return null;
  return (
    <div className="local-checks">
      <label className="row" style={{ justifyContent: 'flex-start' }}>
        <input
          type="checkbox"
          checked={on}
          aria-describedby={helpId}
          onChange={(e) => void localChecksItem.setValue(e.target.checked)}
        />
        <span>Instant local checks</span>
      </label>
      <p id={helpId} className="muted setting-help">
        {LOCAL_CHECKS_HELP}
      </p>
    </div>
  );
}
