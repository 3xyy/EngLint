import { useState } from 'react';
import type { Dialect } from '../../core/types';
import { capUsdItem, dialectItem } from '../../shared/settings';
import { useSetting } from '../../shared/use-setting';
import { BadgeToggle } from '../../shared/ui/BadgeToggle';
import { FamilyToggles } from '../../shared/ui/FamilyToggles';
import { LocalChecksToggle } from '../../shared/ui/LocalChecksToggle';
import { ProviderSection } from '../../shared/ui/ProviderSection';
import { StyleProfile } from '../../shared/ui/StyleProfile';
import { YourRules } from '../../shared/ui/YourRules';

export function App() {
  const cap = useSetting(capUsdItem);
  const dialect = useSetting(dialectItem);
  const [capDraft, setCapDraft] = useState<string | null>(null);

  if (cap === null || dialect === null) return null;

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 24 }}>
      <h1>EngLint settings</h1>
      <ProviderSection />

      <section>
        <h2>Spending</h2>
        <label className="row" style={{ justifyContent: 'flex-start' }}>
          <span>Monthly limit (USD)</span>
          <input
            type="number"
            min="0"
            step="1"
            value={capDraft ?? String(cap)}
            onChange={(e) => {
              setCapDraft(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value !== '' && Number.isFinite(n) && n >= 0) void capUsdItem.setValue(n);
            }}
            onBlur={() => setCapDraft(null)}
          />
        </label>
      </section>

      <section>
        <h2>Writing</h2>
        <label className="row" style={{ justifyContent: 'flex-start' }}>
          <span>Dialect</span>
          <select value={dialect} onChange={(e) => void dialectItem.setValue(e.target.value as Dialect)}>
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="en-CA">English (Canada)</option>
            <option value="en-AU">English (Australia)</option>
            <option value="en-IN">English (India)</option>
          </select>
        </label>
      </section>

      <section aria-label="Suggestions">
        <h2>Suggestions</h2>
        <FamilyToggles />
        <LocalChecksToggle />
      </section>

      <section aria-label="On the page">
        <h2>On the page</h2>
        <BadgeToggle />
      </section>

      <section aria-label="Your writing style">
        <h2>Your writing style</h2>
        <StyleProfile />
      </section>

      <section aria-label="Your rules">
        <h2>Your rules</h2>
        <YourRules />
      </section>

      <section>
        <h2>Google Docs</h2>
        <p className="muted">Turn off Google Docs' own spell check: Tools → Spelling and grammar.</p>
      </section>
    </main>
  );
}
