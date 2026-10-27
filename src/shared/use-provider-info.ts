import { CLAUDE_INFO, providerInfo, type ProviderInfo } from '../core/provider';
import { providerItem } from './settings';
import { useSetting } from './use-setting';

/** The active provider as status copy names it (providerInfo): Claude until the settings are read. */
export function useProviderInfo(): ProviderInfo {
  const provider = useSetting(providerItem);
  return provider ? providerInfo(provider) : CLAUDE_INFO;
}
