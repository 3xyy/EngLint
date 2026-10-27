import { useEffect, useRef, useState } from 'react';
import { COST_UNKNOWN, costLabel, smartPricing } from '../../core/review-cost';
import { MAX_PROFILE_SOURCE_CHARS, MIN_PROFILE_SOURCE_CHARS, profileBuildCost } from '../../core/style-profile';
import { MAX_PROFILE_CHARS } from '../../core/tool-schema';
import { sendMessage } from '../messages';
import { providerItem, styleProfileItem } from '../settings';
import { toolStatusText } from '../status-text';
import { useProviderInfo } from '../use-provider-info';
import { useSetting } from '../use-setting';
import { useSpend } from '../use-spend';

/**
 * The options page's "Your writing style": the writer pastes pieces, the background describes how they write, and
 * only that description is saved (editable here, deletable). The pasted pieces live in this component's state
 * until a build uses them; they are never written to storage. Only Save writes the profile: a build or an edit is
 * "Not saved yet" (and leaving the page asks first) until then.
 */
export function StyleProfile() {
  const stored = useSetting(styleProfileItem);
  const spend = useSpend();
  const who = useProviderInfo();
  const provider = useSetting(providerItem);
  const [samples, setSamples] = useState('');
  // The profile in its box: the saved one, or a new build the writer hasn't saved yet. null: none.
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The saved text the box last followed. While the box still shows it, a save or delete (here or in another tab)
  // replaces it; an unsaved build or edit stays.
  const followed = useRef<string | null>(null);
  useEffect(() => {
    const prev = followed.current;
    const next = stored?.text ?? null;
    followed.current = next;
    setDraft((d) => (d === prev ? next : d));
  }, [stored]);

  const dirty = draft !== null && draft !== (stored?.text ?? null);
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older Chrome asks only when this is set
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  async function build() {
    setBusy(true);
    setNote(null);
    try {
      const r = await sendMessage('buildStyleProfile', { samples });
      if (r.status === 'ok' && r.profile) {
        setDraft(r.profile);
        setSamples('');
        setNote('Built, and your pasted pieces are cleared. Edit the profile if you like, then click Save.');
      } else {
        setNote(toolStatusText(r.status, spend ?? undefined, who) ?? "Couldn't build the profile. Try again.");
      }
    } catch {
      setNote("Couldn't build the profile. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const text = (draft ?? '').trim().slice(0, MAX_PROFILE_CHARS);
    if (!text) return;
    try {
      await styleProfileItem.setValue({ text, updatedAt: Date.now() });
    } catch {
      setNote("Couldn't save the profile.");
      return;
    }
    setDraft(text);
    setNote('Profile saved.');
  }

  async function remove() {
    try {
      await styleProfileItem.setValue(null);
    } catch {
      setNote("Couldn't delete the profile.");
      return;
    }
    setDraft(null);
    setNote('Profile deleted.');
  }

  const long = samples.trim().length >= MIN_PROFILE_SOURCE_CHARS;
  // Priced on the provider's smart model at the writer's prices: no figure until the settings are read, and the
  // words "Cost not known" for a model with no prices (null), never Claude's price.
  const cost = provider ? costLabel(profileBuildCost(samples.length, smartPricing(provider))) : undefined;
  return (
    <>
      <p className="muted">
        Paste one to three pieces you're proud of. EngLint writes a short description of how you write and uses it for rewrites and
        synonyms. The pieces themselves aren't saved.
      </p>
      <label>
        <span className="muted">Your writing (one to three pieces)</span>
        <textarea
          value={samples}
          maxLength={MAX_PROFILE_SOURCE_CHARS}
          rows={6}
          style={{ width: '100%', boxSizing: 'border-box' }}
          onChange={(e) => setSamples(e.target.value)}
        />
      </label>
      <p className="muted">
        {long ? `${samples.length.toLocaleString('en-US')} of ${MAX_PROFILE_SOURCE_CHARS.toLocaleString('en-US')} characters` : `At least ${MIN_PROFILE_SOURCE_CHARS} characters.`}
      </p>
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn" disabled={busy || !long} onClick={() => void build()}>
          {draft === null ? 'Build my style profile' : 'Rebuild'}
          {cost && ` · ${cost}`}
        </button>
      </div>
      {cost === null && <p className="muted">{COST_UNKNOWN}</p>}
      {draft !== null && (
        <>
          <label>
            <span className="muted">How you write (edit freely)</span>
            <textarea
              value={draft}
              maxLength={MAX_PROFILE_CHARS}
              rows={7}
              style={{ width: '100%', boxSizing: 'border-box' }}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="btn" disabled={draft.trim() === ''} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => void remove()}>
              Delete
            </button>
            {dirty && <span className="muted">Not saved yet</span>}
          </div>
        </>
      )}
      {note && <p role="status">{note}</p>}
    </>
  );
}
