import { useEffect, useId, useRef, useState } from 'react';
import { spendTracked } from '../../core/provider';
import type { Dialect } from '../../core/types';
import { capUsdItem, dialectItem, providerItem } from '../../shared/settings';
import { useSetting } from '../../shared/use-setting';
import { useSpend } from '../../shared/use-spend';
import { BadgeToggle } from '../../shared/ui/BadgeToggle';
import { FamilyToggles } from '../../shared/ui/FamilyToggles';
import { LocalChecksToggle } from '../../shared/ui/LocalChecksToggle';
import { ProviderSection } from '../../shared/ui/ProviderSection';
import { SettingsCard } from '../../shared/ui/SettingsCard';
import { SpendMeter } from '../../shared/ui/SpendMeter';
import { StyleProfile } from '../../shared/ui/StyleProfile';
import { YourRules } from '../../shared/ui/YourRules';
import { currentSection, SECTIONS, type SectionId } from './sections';
import './options.css';

/** How far below the window's top a section's top must come to count as the one being read, px. */
const READ_LINE = 96;

/**
 * The section the nav marks: the one being read, or the one a nav click went to. A click's mark holds through its
 * own (smooth) scroll, until the reader scrolls, taps or types; a section near the end may never reach the line.
 */
function useCurrentSection(): [SectionId, (id: SectionId) => void] {
  const [current, setCurrent] = useState<SectionId>(SECTIONS[0].id);
  const clicked = useRef(false);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      if (clicked.current) return;
      const tops = SECTIONS.map(({ id }) => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? null }));
      const id = currentSection(tops, READ_LINE) as SectionId | null;
      if (id) setCurrent(id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    // The reader's own input; a click's smooth scroll sends none of these.
    const release = () => {
      clicked.current = false;
    };
    const input = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    for (const type of input) window.addEventListener(type, release, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      for (const type of input) window.removeEventListener(type, release);
    };
  }, []);
  const go = (id: SectionId) => {
    clicked.current = true;
    setCurrent(id);
  };
  return [current, go];
}

export function App() {
  const cap = useSetting(capUsdItem);
  const dialect = useSetting(dialectItem);
  const provider = useSetting(providerItem);
  const spend = useSpend();
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [current, go] = useCurrentSection();
  const capId = useId();
  const capHelpId = useId();
  const dialectId = useId();

  if (cap === null || dialect === null) return null;

  return (
    <div className="options">
      <aside className="options-side">
        <p className="options-mark">EngLint</p>
        <nav aria-label="Settings sections" className="options-nav">
          {SECTIONS.map(({ id, title }) => (
            <a key={id} href={`#${id}`} aria-current={current === id ? 'location' : undefined} onClick={() => go(id)}>
              {title}
            </a>
          ))}
        </nav>
      </aside>

      <main className="options-main">
        <h1 className="options-title">Settings</h1>
        <ProviderSection id="provider" />

        <SettingsCard id="spending" title="Spending" description="A monthly limit on what EngLint spends through your API key.">
          <div className="setting setting-field">
            <span className="setting-text">
              <label htmlFor={capId} className="setting-name">
                Monthly limit (USD)
              </label>
              <span id={capHelpId} className="setting-help">
                Live checks and tools pause when this month's spend reaches it.
              </span>
            </span>
            <input
              id={capId}
              aria-describedby={capHelpId}
              className="cap-input"
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
          </div>
          {spend && provider && <SpendMeter spend={spend} tracked={spendTracked(provider)} />}
        </SettingsCard>

        <SettingsCard id="writing" title="Writing" description="The English that EngLint checks your spelling and usage against.">
          <div className="setting setting-field">
            <label htmlFor={dialectId} className="setting-name">
              Dialect
            </label>
            <select id={dialectId} value={dialect} onChange={(e) => void dialectItem.setValue(e.target.value as Dialect)}>
              <option value="en-US">English (US)</option>
              <option value="en-GB">English (UK)</option>
              <option value="en-CA">English (Canada)</option>
              <option value="en-AU">English (Australia)</option>
              <option value="en-IN">English (India)</option>
            </select>
          </div>
        </SettingsCard>

        <SettingsCard id="suggestions" title="Suggestions" description="Which kinds of suggestions EngLint underlines as you write.">
          <FamilyToggles />
          <LocalChecksToggle />
        </SettingsCard>

        <SettingsCard id="on-the-page" title="On the page" description="What EngLint adds to the text boxes you write in.">
          <BadgeToggle />
        </SettingsCard>

        <SettingsCard id="style" title="Your writing style" description="Rewrites and synonyms in your own voice.">
          <StyleProfile />
        </SettingsCard>

        <SettingsCard id="rules" title="Your rules" description="Suggestions you've stopped, and the words in your dictionary.">
          <YourRules />
        </SettingsCard>

        <SettingsCard id="docs" title="Google Docs" description="One setting to change in Google Docs itself.">
          <p className="docs-tip">Turn off Google Docs' own spell check: Tools → Spelling and grammar.</p>
        </SettingsCard>
      </main>
    </div>
  );
}
