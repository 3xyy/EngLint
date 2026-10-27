import { useEffect, useId, useRef, useState } from 'react';
import {
  isUsable,
  permissionPattern,
  PRESETS,
  providerInfo,
  providerName,
  validateBaseURL,
  type KeySlot,
  type PresetId,
  type ProviderConfig,
} from '../../core/provider';
import type { CheckStatus } from '../../core/types';
import { sendMessage } from '../messages';
import { providerItem } from '../settings';
import { helpLink, statusText } from '../status-text';
import { useKeyStatus } from '../use-key-status';
import { useProviderInfo } from '../use-provider-info';
import { useSetting } from '../use-setting';
import { useSpend } from '../use-spend';

type Choice = 'anthropic' | PresetId;
type Note = { text: string; link?: { href: string; label: string } | null };

const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
const UNPRICED = "Spending isn't tracked for this model, so your monthly limit can't protect you. Add its prices from your provider's pricing page.";

const choiceOf = (c: ProviderConfig): Choice => (c.active === 'compatible' && c.compatible ? c.compatible.preset : 'anthropic');

/**
 * The options page's "AI provider": Claude (its key, as before) or an OpenAI-compatible provider (key, endpoint, the
 * two models from the endpoint's own list, and their prices). Choosing Claude, or a provider already set up, takes
 * effect at once; any other provider takes effect on Save, which also asks Chrome for access to its endpoint.
 * Switching never deletes a key or the other provider's settings.
 */
export function ProviderSection() {
  const saved = useSetting(providerItem);
  const [choice, setChoice] = useState<Choice | null>(null);
  const selectId = useId();
  if (saved === null) return null;
  const current = choice ?? choiceOf(saved);

  function pick(next: Choice) {
    if (!saved) return;
    setChoice(next);
    const ready = next !== 'anthropic' && saved.compatible?.preset === next && isUsable({ active: 'compatible', compatible: saved.compatible });
    if (next === 'anthropic') void providerItem.setValue({ ...saved, active: 'anthropic' });
    else if (ready) void providerItem.setValue({ ...saved, active: 'compatible' });
  }

  return (
    <section aria-label="AI provider">
      <h2>AI provider</h2>
      {/* Labelled by id, not by wrapping: a select inside its label would add its option to the label's name. */}
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <label htmlFor={selectId}>Provider</label>
        <select id={selectId} value={current} onChange={(e) => pick(e.target.value as Choice)}>
          <option value="anthropic">Claude (recommended)</option>
          {PRESET_IDS.map((id) => (
            <option key={id} value={id}>
              {PRESETS[id].label}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">EngLint is tuned and tested on Claude. Other providers work, but their suggestions haven't been measured.</p>
      {current === 'anthropic' ? <ClaudeKey /> : <CompatibleForm key={current} preset={current} saved={saved} />}
    </section>
  );
}

/** Claude's key: paste, save, test, remove (the key goes to the background's own store, never back to the page). */
function ClaudeKey() {
  const { status: keyState, refresh } = useKeyStatus('anthropic');
  const spend = useSpend();
  const who = useProviderInfo();
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const noKey = keyState !== null && !keyState.saved;

  // Onboarding: with no key saved, the cursor starts in the key field.
  const focused = useRef(false);
  useEffect(() => {
    if (noKey && !focused.current) {
      focused.current = true;
      inputRef.current?.focus();
    }
  }, [noKey]);

  async function save(): Promise<boolean> {
    const key = draft.trim();
    if (!key) return false;
    await sendMessage('setApiKey', { slot: 'anthropic', key }); // stored by the background, outside chrome.storage
    setDraft('');
    refresh();
    return true;
  }

  async function remove() {
    setResult(null);
    await sendMessage('clearApiKey', { slot: 'anthropic' });
    refresh();
  }

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      await save(); // a typed key is tested as well as saved
      const r = await sendMessage('testKey', undefined);
      setResult(
        r.ok && r.usage
          ? { text: `Key works ✓ (${r.usage.input_tokens} input / ${r.usage.output_tokens} output tokens)` }
          : { text: statusText(r.status, spend ?? undefined, who) ?? 'The test failed.', link: helpLink(r.status, who) },
      );
    } catch {
      setResult({ text: "Couldn't run the test. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={noKey ? { border: '2px solid #1a73e8', borderRadius: 8, padding: '0 16px 8px' } : undefined}>
      <h3>Claude API key</h3>
      {noKey && (
        <ol>
          <li>
            Get a key at{' '}
            <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">
              platform.claude.com
            </a>{' '}
            → API keys
          </li>
          <li>Paste it here and click Save</li>
          <li>Click Test key</li>
        </ol>
      )}
      <p className="muted">
        {keyState?.saved ? (keyState.last4 ? `Key saved (ends in …${keyState.last4})` : 'Key saved') : 'No key saved yet.'}
      </p>
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <input
          ref={inputRef}
          type="password"
          aria-label="Claude API key"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: 320 }}
        />
        <button type="button" className="btn" onClick={() => void save()} disabled={!draft.trim()}>
          Save
        </button>
        <button type="button" className="btn" onClick={() => void test()} disabled={busy}>
          Test key
        </button>
        {keyState?.saved && (
          <button type="button" className="btn" onClick={() => void remove()}>
            Remove key
          </button>
        )}
      </div>
      <Result note={result} />
    </div>
  );
}

function Result({ note }: { note: Note | null }) {
  if (!note) return null;
  return (
    <p role="status">
      {note.text}
      {note.link && (
        <>
          {' '}
          <a href={note.link.href} target="_blank" rel="noopener noreferrer">
            {note.link.label}
          </a>
        </>
      )}
    </p>
  );
}

/**
 * Where the model list stands: not asked yet (no valid address), waiting for a click on the first button (the key,
 * Chrome's permission, or a custom address to ask), loading, listed, or failed (the writer types the names).
 */
type ModelList = { state: 'idle' | 'waiting' | 'loading' | 'failed' } | { state: 'listed'; models: string[] };
/** Statuses a Save fixes: the list is waiting for it, not failed. */
const FIXED_BY_SAVE = new Set<CheckStatus>(['key_missing', 'endpoint_blocked']);

type PriceDraft = { input: string; output: string };

/** A model's prices as typed, or null unless both are numbers of at least 0 (USD per 1M tokens). */
function priceOf(d: PriceDraft | undefined): { input: number; output: number } | null {
  if (!d || d.input.trim() === '' || d.output.trim() === '') return null;
  const input = Number(d.input);
  const output = Number(d.output);
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? { input, output } : null;
}

/** One OpenAI-compatible provider: its key, endpoint, models and prices, saved together. */
function CompatibleForm({ preset, saved }: { preset: PresetId; saved: ProviderConfig }) {
  const p = PRESETS[preset];
  const slot: KeySlot = `compatible:${preset}`;
  const custom = preset === 'custom';
  const from = saved.compatible?.preset === preset ? saved.compatible : null;
  const spend = useSpend();
  const { status: keyState, refresh: refreshKey } = useKeyStatus(slot);
  const [keyDraft, setKeyDraft] = useState('');
  const [baseURL, setBaseURL] = useState(from?.baseURL ?? (custom ? '' : p.baseURL));
  const [jsonSchema, setJsonSchema] = useState(from?.structuredOutputs ?? false);
  const [fast, setFast] = useState(from?.fastModel ?? '');
  const [smart, setSmart] = useState(from?.smartModel ?? '');
  // Prices are kept by model id, whichever provider they were typed for.
  const [prices, setPrices] = useState<Record<string, PriceDraft>>(() =>
    Object.fromEntries(Object.entries(saved.compatible?.prices ?? {}).map(([m, v]) => [m, { input: String(v.input), output: String(v.output) }])),
  );
  const [urlError, setUrlError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<ModelList>({ state: 'idle' });
  const [listAgain, setListAgain] = useState(0);
  // The last click Chrome allowed: the address it was for, and the key typed then. That key lists the models but stays
  // here: it is stored only by the Save that stores the config, so a stored key always goes with its address.
  const [clicked, setClicked] = useState<{ endpoint: string; key: string } | null>(null);

  const endpoint = custom ? baseURL.trim() : p.baseURL;
  const addressOk = validateBaseURL(endpoint).ok;
  const keyKnown = !p.needsKey || keyState !== null;
  const keyReady = !p.needsKey || !!keyState?.saved;
  // The stored Custom key belongs to the saved Custom address (the background gives it for no other).
  const savedAddress = custom ? from?.baseURL.trim() || null : null;
  const here = clicked?.endpoint === endpoint ? clicked : null;
  const typedKey = p.needsKey ? (here?.key ?? '') : '';
  // The list request carries the key typed at the click, else the stored one where it may go: so a custom address is
  // asked only as saved or as clicked for, never while it is typed.
  const canList = !p.needsKey || typedKey !== '' || (keyReady && (!custom || endpoint === savedAddress));
  // A custom address the stored key wasn't saved for needs its own key typed before anything is sent.
  const needsOwnKey = custom && endpoint !== savedAddress && keyDraft.trim() === '';

  useEffect(() => {
    if (!addressOk || !keyKnown) return setList({ state: 'idle' });
    if (!canList) return setList({ state: 'waiting' });
    let live = true;
    setList({ state: 'loading' });
    sendMessage('listModels', { slot, baseURL: endpoint, ...(typedKey ? { key: typedKey } : {}) }).then(
      (r) => {
        if (!live) return;
        if (r.ok) setList(r.models.length > 0 ? { state: 'listed', models: r.models } : { state: 'failed' });
        else setList({ state: FIXED_BY_SAVE.has(r.status) ? 'waiting' : 'failed' });
      },
      () => live && setList({ state: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [slot, endpoint, addressOk, keyKnown, canList, typedKey, listAgain]);

  const showModels = list.state === 'listed' || list.state === 'failed';
  // One handler, two names: until the models show, the click is what loads them.
  const firstButton = showModels ? 'Save' : 'Load models';

  /**
   * Save (or Load models), and Test (which saves first): checks the address, asks Chrome for access to it, asks for
   * the model list (with a typed key, not stored yet), then, once Chrome allowed it and both models are chosen, stores
   * the typed key (a Custom key with its address) and the config together. `then` runs after that store.
   */
  function save(then?: (next: ProviderConfig) => Promise<void>) {
    setNote(null);
    const checked = validateBaseURL(endpoint);
    if (!checked.ok) return setUrlError(checked.reason);
    setUrlError(null);
    if (needsOwnKey) return setNote({ text: 'Enter the API key for this address.' });
    // Before any await: Chrome grants a permission only during the click (the user gesture).
    const permitted = browser.permissions.request({ origins: [permissionPattern({ preset, baseURL: endpoint })!] }).catch(() => false);
    void finishSave(permitted, then);
  }

  async function finishSave(permitted: Promise<boolean>, then?: (next: ProviderConfig) => Promise<void>) {
    setBusy(true);
    try {
      const granted = await permitted;
      const kept = Object.entries(prices).flatMap(([m, d]) => {
        const price = priceOf(d);
        return price ? [[m, price] as const] : [];
      });
      const next: ProviderConfig = {
        active: 'compatible',
        compatible: {
          preset,
          baseURL: endpoint,
          fastModel: fast.trim(),
          smartModel: smart.trim(),
          structuredOutputs: custom ? jsonSchema : p.structuredOutputs,
          prices: Object.fromEntries(kept),
        },
      };
      const name = providerName(next);
      // Chrome refused: nothing is stored, and nothing is asked. The provider in use and its settings stay as they were.
      if (!granted) return setNote({ text: `EngLint needs permission to reach ${name}. Click ${firstButton} again and choose Allow.` });
      const key = p.needsKey ? keyDraft.trim() : '';
      // The access, a typed key, or this click on a custom address may be what the list waited for.
      if (list.state !== 'listed') {
        setClicked({ endpoint, key });
        setListAgain((n) => n + 1);
      }
      if (!fast.trim() || !smart.trim()) return setNote({ text: 'Choose a fast model and a smart model, then click Save.' });
      // One Save: the key, bound in the background to the address it is for, then the config that uses it.
      if (key) {
        await sendMessage('setApiKey', { slot, key, ...(custom ? { baseURL: endpoint } : {}) }); // outside chrome.storage
        setKeyDraft('');
        refreshKey();
      }
      await providerItem.setValue(next);
      if (then) await then(next);
      else setNote({ text: `Saved. EngLint now uses ${name}.` });
    } catch {
      setNote({ text: "Couldn't save. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function test(next: ProviderConfig) {
    const who = providerInfo(next);
    const r = await sendMessage('testKey', undefined).catch(() => null);
    if (!r) setNote({ text: "Couldn't run the test. Try again." });
    else if (r.ok) setNote({ text: `Works: ${r.model ?? next.compatible?.fastModel} answered.` });
    else if (r.modelNotFound) setNote({ text: `Model not found: ${r.model}.` });
    else setNote({ text: statusText(r.status, spend ?? undefined, who) ?? 'The test failed.', link: helpLink(r.status, who) });
  }

  async function removeKey() {
    setNote(null);
    await sendMessage('clearApiKey', { slot });
    refreshKey();
  }

  const active = saved.active === 'compatible' && saved.compatible?.preset === preset;
  const priceFields = (model: string) => {
    const d = prices[model] ?? { input: '', output: '' };
    const set = (part: keyof PriceDraft, value: string) => setPrices((all) => ({ ...all, [model]: { ...d, [part]: value } }));
    return (
      <div role="group" aria-label={`Prices for ${model}`} className="prices">
        <label className="field">
          <span>Input price ($ per million tokens)</span>
          <input type="number" min="0" step="any" inputMode="decimal" value={d.input} onChange={(e) => set('input', e.target.value)} />
        </label>
        <label className="field">
          <span>Output price ($ per million tokens)</span>
          <input type="number" min="0" step="any" inputMode="decimal" value={d.output} onChange={(e) => set('output', e.target.value)} />
        </label>
        {!priceOf(d) && <p className="setting-warning">{UNPRICED}</p>}
      </div>
    );
  };

  return (
    <div className="provider-form">
      {!active && <p className="muted">EngLint keeps using {providerName(saved)} until you click Save.</p>}
      {p.needsKey && (
        <>
          <label className="field">
            <span>API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={keyState?.saved ? 'Paste a new key to replace it' : 'Paste your key'}
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
          </label>
          <div className="row" style={{ justifyContent: 'flex-start', marginTop: -4 }}>
            <span className="muted">
              {keyState?.saved ? (keyState.last4 ? `Key saved (ends in …${keyState.last4})` : 'Key saved') : 'No key saved yet.'}
            </span>
            {keyState?.saved && (
              <button type="button" className="btn" onClick={() => void removeKey()}>
                Remove key
              </button>
            )}
          </div>
        </>
      )}
      <label className="field">
        <span>Endpoint</span>
        <input
          type="url"
          readOnly={!custom}
          autoComplete="off"
          spellCheck={false}
          placeholder={custom ? 'https://api.example.com/v1' : undefined}
          value={custom ? baseURL : p.baseURL}
          onChange={(e) => {
            setBaseURL(e.target.value);
            setUrlError(null);
          }}
        />
      </label>
      {urlError && (
        <p role="alert" className="field-error">
          {urlError}
        </p>
      )}
      {custom && (
        <label className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
          <input type="checkbox" checked={jsonSchema} onChange={(e) => setJsonSchema(e.target.checked)} />
          <span>This endpoint supports JSON schema</span>
        </label>
      )}

      {list.state === 'waiting' && (
        <p className="muted">
          {!keyReady ? 'Enter your API key and click Load models.' : needsOwnKey ? 'Enter the API key for this address, then click Load models.' : 'Click Load models to list its models.'}
        </p>
      )}
      {list.state === 'loading' && <p className="muted">Loading the model list…</p>}
      {list.state === 'failed' && <p className="muted">Couldn't load the model list. Type the model names.</p>}
      {showModels && (
        <>
          <ModelField label="Fast model (live checks, synonyms, tone)" value={fast} onChange={setFast} list={list} />
          {fast.trim() && priceFields(fast.trim())}
          <ModelField label="Smart model (rewrites, reviews, chat)" value={smart} onChange={setSmart} list={list} />
          {smart.trim() && smart.trim() !== fast.trim() && priceFields(smart.trim())}
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn primary" onClick={() => save()} disabled={busy}>
          {firstButton}
        </button>
        <button type="button" className="btn" onClick={() => save(test)} disabled={busy}>
          Test
        </button>
      </div>
      <Result note={note} />
    </div>
  );
}

/** A model picker: the endpoint's list (a saved model it no longer lists stays an option), or a text field when there is no list. */
function ModelField({ label, value, onChange, list }: { label: string; value: string; onChange(v: string): void; list: ModelList }) {
  const id = useId();
  if (list.state !== 'listed') {
    return (
      <label className="field">
        <span>{label}</span>
        <input type="text" autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  const options = value && !list.models.includes(value) ? [value, ...list.models] : list.models;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a model</option>
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}
