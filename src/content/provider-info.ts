import { CLAUDE_INFO, providerInfo, type ProviderInfo } from '../core/provider';
import { providerItem } from '../shared/settings';

let info: ProviderInfo = CLAUDE_INFO;
let watching = false;

/**
 * The active provider for status copy (providerInfo), kept current once first asked for. Until the settings are read
 * (and if they can't be) it is Claude: a field's first status can't wait on a storage read.
 */
export function providerInfoNow(): ProviderInfo {
  if (!watching) {
    watching = true;
    try {
      void providerItem.getValue().then((c) => (info = providerInfo(c)), () => {});
      providerItem.watch((c) => (info = providerInfo(c)));
    } catch {
      // no storage here: it stays Claude
    }
  }
  return info;
}
