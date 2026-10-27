import { useRef, useState } from 'react';
import type { LocatedIssue } from '../../core/types';
import { sendMessage } from '../../shared/messages';
import { APPLY_FAILED_COPIED, SPEND_NOT_TRACKED, spendText, UNREACHABLE_FIELD } from '../../shared/status-text';
import { StatusBanner } from '../../shared/ui/StatusBanner';
import { pageStatus } from '../../shared/page-status';
import { keyNeeded, spendTracked } from '../../core/provider';
import { disabledSitesItem, providerItem } from '../../shared/settings';
import { isSiteDisabled } from '../../core/sites';
import { suggestionToggle } from '../../core/match';
import { BadgeToggle } from '../../shared/ui/BadgeToggle';
import { FamilyToggles } from '../../shared/ui/FamilyToggles';
import { LocalChecksToggle } from '../../shared/ui/LocalChecksToggle';
import { YourRules } from '../../shared/ui/YourRules';
import { useKeyStatus } from '../../shared/use-key-status';
import { useSetting } from '../../shared/use-setting';
import { useSpend } from '../../shared/use-spend';
import { useCurrentTabId, useTabState } from '../../shared/use-tab-state';
import { Chat } from './Chat';
import { Review } from './review/Review';
import { Tools } from './Tools';
import './panel.css';

type PanelTab = 'issues' | 'tools' | 'chat' | 'review';
const TABS: { id: PanelTab; label: string }[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'tools', label: 'Tools' },
  { id: 'chat', label: 'Chat' },
  { id: 'review', label: 'Review' },
];

/** The panel's sections as tabs: arrow keys, Home and End move between them (the ARIA tabs pattern). */
function TabBar({ tab, onChange }: { tab: PanelTab; onChange(tab: PanelTab): void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label="Panel sections" className="tabs">
      {TABS.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          className="tab"
          aria-selected={tab === t.id}
          aria-controls={`pane-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const to = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as Record<string, number>)[e.key];
            if (to === undefined) return;
            e.preventDefault();
            const at = (to + TABS.length) % TABS.length;
            onChange(TABS[at]!.id);
            buttons.current[at]?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Item({
  issue,
  onJump,
  onAccept,
  onRewrite,
  onDismiss,
}: {
  issue: LocatedIssue;
  onJump(): void;
  onAccept(): void;
  onRewrite(): void;
  onDismiss(): void;
}) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    // Clicking the non-button area jumps (mouse convenience); keyboard and screen readers use the Go-to button.
    <li className="item" onClick={onJump}>
      <div className="item-fixrow">
        {issue.replacement === null ? (
          <button type="button" className="item-rewrite" onClick={stop(onRewrite)}>
            Rewrite this sentence
          </button>
        ) : issue.replacement === '' ? (
          <button type="button" className="item-fix delete" aria-label={`Delete '${issue.original}'`} onClick={stop(onAccept)}>
            <s>{issue.original}</s>
          </button>
        ) : (
          <button
            type="button"
            className="item-fix"
            aria-label={`Replace '${issue.original}' with '${issue.replacement}'`}
            onClick={stop(onAccept)}
          >
            {issue.replacement}
          </button>
        )}
      </div>
      <div className="item-bar">
        <button
          type="button"
          className="item-goto"
          aria-label={`Go to '${issue.original}'`}
          title="Show in text"
          onClick={stop(onJump)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="5" />
            <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
          </svg>
        </button>
        <button type="button" className="item-dismiss" aria-label={`Dismiss '${issue.original}'`} onClick={stop(onDismiss)}>
          Dismiss
        </button>
      </div>
    </li>
  );
}

function Group({ title, issues, render }: { title: string; issues: LocatedIssue[]; render: (i: LocatedIssue) => React.ReactNode }) {
  if (issues.length === 0) return null;
  const heading = `${title} (${issues.length})`;
  return (
    <section className="group" aria-label={heading}>
      <h2>{heading}</h2>
      <ul>{issues.map(render)}</ul>
    </section>
  );
}

export function App() {
  const tabId = useCurrentTabId();
  const state = useTabState(tabId);
  const spend = useSpend();
  const { status: key } = useKeyStatus();
  const disabled = useSetting(disabledSitesItem);
  const provider = useSetting(providerItem);
  const [message, setMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>('issues');
  const status =
    key && spend && disabled && provider
      ? pageStatus({
          tabState: state,
          keySaved: key.saved || !keyNeeded(provider), // a local server needs no key
          spent: spend.spent,
          cap: spend.cap,
          siteDisabled: !!state && isSiteDisabled(disabled, state.host),
        })
      : 'ok';

  const fieldId = state ? (state.activeFieldId ?? Object.keys(state.fields)[0] ?? null) : null;
  const issues = state && fieldId ? (state.fields[fieldId] ?? []) : [];
  const errors = issues.filter((i) => i.severity === 'error');
  // Grouped by the same toggle the underlines use; generic phrasing is a Delivery item.
  const inGroup = (family: 'clarity' | 'engagement' | 'delivery') =>
    issues.filter((i) => {
      if (i.severity === 'error') return false;
      const t = suggestionToggle(i);
      return (t === 'generic' ? 'delivery' : t) === family;
    });

  /** Runs a message to the field's frame; a gone frame or script becomes an inline note, never a crash. */
  async function toField<T>(fn: (target: { tabId: number; frameId: number }) => Promise<T>): Promise<T | undefined> {
    if (tabId === null || !state || !fieldId) return undefined;
    setMessage(null);
    try {
      return await fn({ tabId, frameId: state.frames[fieldId] ?? 0 });
    } catch {
      setMessage(UNREACHABLE_FIELD);
      return undefined;
    }
  }

  async function accept(issue: LocatedIssue) {
    const r = await toField((t) => sendMessage('applyFix', { fieldId: fieldId!, issueId: issue.id }, t));
    if (r === undefined) return setMessage((m) => m ?? UNREACHABLE_FIELD);
    if (!r.ok) setMessage(APPLY_FAILED_COPIED);
  }

  async function rewrite(issue: LocatedIssue) {
    const r = await toField((t) => sendMessage('rewriteSentence', { fieldId: fieldId!, issueId: issue.id }, t));
    if (r === undefined) return setMessage((m) => m ?? UNREACHABLE_FIELD);
    if (!r.opened) setMessage("Couldn't open that sentence. Click into the text box and try again.");
  }

  async function acceptAll() {
    const r = await toField((t) => sendMessage('acceptAllErrors', { fieldId: fieldId! }, t));
    if (r === undefined) return setMessage((m) => m ?? UNREACHABLE_FIELD);
    if (r.failed > 0) setMessage(`${r.failed} fix${r.failed === 1 ? '' : 'es'} couldn't be applied.`);
  }

  async function checkEverything() {
    if (tabId === null) return;
    setMessage(null);
    const frames = new Set(Object.values(state?.frames ?? {}));
    if (frames.size === 0) frames.add(0);
    const results = await Promise.allSettled([...frames].map((frameId) => sendMessage('recheckAll', undefined, { tabId, frameId })));
    if (results.every((r) => r.status === 'rejected')) setMessage(UNREACHABLE_FIELD);
  }

  const render = (i: LocatedIssue) => (
    <Item
      key={i.id}
      issue={i}
      onJump={() => void toField((t) => sendMessage('jumpTo', { fieldId: fieldId!, issueId: i.id }, t))}
      onAccept={() => void accept(i)}
      onRewrite={() => void rewrite(i)}
      onDismiss={() => void toField((t) => sendMessage('dismissIssue', { fieldId: fieldId!, issueId: i.id }, t))}
    />
  );

  return (
    <main className="panel">
      <header>
        <h1>EngLint</h1>
      </header>

      <StatusBanner status={status} spend={spend} />
      {message && <p className="notice" role="alert">{message}</p>}

      <TabBar tab={tab} onChange={setTab} />

      {/* Every pane stays mounted: the Tools keep watching for a stash, and an answer keeps streaming. */}
      <div role="tabpanel" id="pane-issues" aria-labelledby="tab-issues" className="pane" hidden={tab !== 'issues'}>
        <div className="actions">
          <button type="button" className="btn" disabled={errors.length === 0} onClick={() => void acceptAll()}>
            Accept all errors
          </button>
          <button type="button" className="btn" disabled={!state} onClick={() => void checkEverything()}>
            Check everything
          </button>
        </div>

        <Group title="Errors" issues={errors} render={render} />
        <Group title="Clarity" issues={inGroup('clarity')} render={render} />
        <Group title="Engagement" issues={inGroup('engagement')} render={render} />
        <Group title="Delivery" issues={inGroup('delivery')} render={render} />
        {status === 'ok' && state && issues.length === 0 && <p className="muted">No issues in this text box.</p>}
        {!state && status === 'ok' && <p className="muted">Click into a text box to start checking.</p>}

        <details className="panel-settings">
          <summary>Settings</summary>
          <FamilyToggles />
          <LocalChecksToggle />
          <h3>Your rules</h3>
          <YourRules />
          <h3>On the page</h3>
          <BadgeToggle />
        </details>
      </div>

      <div role="tabpanel" id="pane-tools" aria-labelledby="tab-tools" className="pane" hidden={tab !== 'tools'}>
        <Tools tabId={tabId} fallbackHost={state?.host ?? null} spend={spend} onStash={() => setTab('tools')} />
      </div>

      <div role="tabpanel" id="pane-chat" aria-labelledby="tab-chat" className="pane" hidden={tab !== 'chat'}>
        <Chat
          tabId={tabId}
          fieldId={fieldId}
          frameId={fieldId ? (state?.frames[fieldId] ?? 0) : 0}
          spend={spend}
          shown={tab === 'chat'}
        />
      </div>

      <div role="tabpanel" id="pane-review" aria-labelledby="tab-review" className="pane" hidden={tab !== 'review'}>
        <Review
          tabId={tabId}
          pageId={state?.pageId ?? null}
          fieldId={fieldId}
          frameId={fieldId ? (state?.frames[fieldId] ?? 0) : 0}
          shown={tab === 'review'}
          counts={{
            errors: errors.length,
            clarity: inGroup('clarity').length,
            engagement: inGroup('engagement').length,
            delivery: inGroup('delivery').length,
          }}
          spend={spend}
        />
      </div>

      <footer className="muted">{!spend ? ' ' : provider && !spendTracked(provider) ? SPEND_NOT_TRACKED : spendText(spend.spent, spend.cap)}</footer>
    </main>
  );
}
