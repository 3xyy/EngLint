import { useId, useState } from 'react';
import type { FamilyToggle, LocatedIssue } from '../../core/types';
import { sendMessage } from '../../shared/messages';
import { APPLY_FAILED_COPIED, SPEND_NOT_TRACKED, spendText, UNREACHABLE_FIELD } from '../../shared/status-text';
import { StatusBanner, StatusPill } from '../../shared/ui/StatusBanner';
import { pageStatus } from '../../shared/page-status';
import { keyNeeded, spendTracked } from '../../core/provider';
import { disabledSitesItem, providerItem } from '../../shared/settings';
import { isSiteDisabled } from '../../core/sites';
import { familyName, shownFamily } from '../../core/kinds';
import { suggestionToggle } from '../../core/match';
import { BadgeToggle } from '../../shared/ui/BadgeToggle';
import { Button, DiffPreview, IconButton, Segmented, TypeLabel, type SegmentedOption } from '../../shared/ui/controls';
import { FamilyToggles } from '../../shared/ui/FamilyToggles';
import { CheckIcon, SparkleIcon, TargetIcon, XIcon } from '../../shared/ui/icons';
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
/** The panel's sections as tabs (a segmented control): arrow keys, Home and End move between them. */
const TABS: readonly SegmentedOption<PanelTab>[] = (['issues', 'tools', 'chat', 'review'] as const).map((id) => ({
  value: id,
  label: id[0]!.toUpperCase() + id.slice(1),
  id: `tab-${id}`,
  controls: `pane-${id}`,
}));

/** As many words before an issue as the model and the local checker keep (prompts/live-check.ts, precedingWords). */
const BEFORE_WORDS = 5;

/**
 * The text a card shows before its change. The panel never gets the field's text, only each issue's `before` (the
 * words just before it, already in the tab state): "…" leads when it holds as many words as are kept (the sentence
 * goes on before them), and a space separates it from the change unless the change starts with punctuation or
 * `before` ends with an opening quote or bracket.
 */
export function contextBefore(before: string, original: string): string {
  const words = before.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const text = (words.length >= BEFORE_WORDS ? '…' : '') + words.join(' ');
  const joined = /^[,.;:!?)\]}’”%…]/.test(original) || /[(\[{“‘]$/.test(text);
  return joined ? text : `${text} `;
}

/** What a card's buttons act on, for screen readers (the buttons' own names are one word, as their tooltips). */
function changeText(issue: LocatedIssue): string {
  if (issue.replacement === null) return `About '${issue.original}'`;
  return issue.replacement === '' ? `Delete '${issue.original}'` : `Replace '${issue.original}' with '${issue.replacement}'`;
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
  const changeId = useId();
  const note = issue.replacement === null;
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    // Clicking the card outside its buttons jumps (mouse convenience); keyboard and screen readers use Show in text.
    <li className={`item el-fam-${shownFamily(issue)}`} data-issue={issue.id} onClick={onJump}>
      <TypeLabel issue={issue} className="item-type" />
      <DiffPreview
        className="item-diff"
        before={contextBefore(issue.before, issue.original)}
        after=""
        original={issue.original}
        replacement={issue.replacement}
      />
      <span id={changeId} className="sr-only">
        {changeText(issue)}
      </span>
      {/* The reason, with the buttons beside its last line; a note's wider Rewrite button goes on a row of its own. */}
      <div className={note ? 'item-foot item-foot-note' : 'item-foot'}>
        {issue.reason && <p className="item-why">{issue.reason}</p>}
        <div className="item-actions">
          {note ? (
            <Button size="sm" className="item-rewrite" aria-describedby={changeId} onClick={stop(onRewrite)}>
              <SparkleIcon size={14} />
              Rewrite sentence
            </Button>
          ) : (
            <IconButton label="Accept" icon={<CheckIcon />} className="item-accept" aria-describedby={changeId} onClick={stop(onAccept)} />
          )}
          <IconButton label="Dismiss" icon={<XIcon />} aria-describedby={changeId} onClick={stop(onDismiss)} />
          <IconButton label="Show in text" icon={<TargetIcon />} tipAlign="end" aria-describedby={changeId} onClick={stop(onJump)} />
        </div>
      </div>
    </li>
  );
}

function Group({
  title,
  family,
  issues,
  render,
}: {
  title: string;
  family: FamilyToggle | 'correctness';
  issues: LocatedIssue[];
  render: (i: LocatedIssue) => React.ReactNode;
}) {
  if (issues.length === 0) return null;
  return (
    <section className="group" aria-label={`${title} (${issues.length})`}>
      <h2 className="panel-group-head">
        <span className={`el-dot el-fam-${family}`} aria-hidden="true" />
        <span className="panel-group-name">{title}</span> <span className="panel-count">{issues.length}</span>
      </h2>
      <ul className="items">{issues.map(render)}</ul>
    </section>
  );
}

/** This month's spend: the text, after a thin bar filled to its share of the limit (none when spending isn't tracked). */
function SpendMeter({ spend, tracked }: { spend: { spent: number; cap: number } | null; tracked: boolean }) {
  if (!spend) return <footer className="panel-foot">{' '}</footer>;
  if (!tracked) return <footer className="panel-foot">{SPEND_NOT_TRACKED}</footer>;
  const share = spend.cap > 0 ? Math.min(1, spend.spent / spend.cap) : 1;
  return (
    <footer className="panel-foot">
      <span className="panel-spend" aria-hidden="true" data-full={share >= 1 ? '' : undefined}>
        <span className="panel-spend-fill" style={{ width: `${Math.round(share * 10000) / 100}%` }} />
      </span>
      {spendText(spend.spent, spend.cap)}
    </footer>
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
  const known = !!(key && spend && disabled && provider);
  const status = known
    ? pageStatus({
        tabState: state,
        keySaved: key!.saved || !keyNeeded(provider!), // a local server needs no key
        spent: spend!.spent,
        cap: spend!.cap,
        siteDisabled: !!state && isSiteDisabled(disabled!, state.host),
      })
    : 'ok';

  const fieldId = state ? (state.activeFieldId ?? Object.keys(state.fields)[0] ?? null) : null;
  const issues = state && fieldId ? (state.fields[fieldId] ?? []) : [];
  const errors = issues.filter((i) => i.severity === 'error');
  // Grouped by the same toggle the underlines use, under the names the cards give: generic phrasing apart.
  const inGroup = (family: FamilyToggle) => issues.filter((i) => i.severity !== 'error' && suggestionToggle(i) === family);

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
      <header className="panel-head">
        <h1 className="panel-mark">EngLint</h1>
        {known && <StatusPill status={status} active={!!state} className="panel-pill" />}
      </header>

      <StatusBanner status={status} spend={spend} />
      {message && <p className="notice" role="alert">{message}</p>}

      <Segmented as="tab" label="Panel sections" options={TABS} value={tab} onChange={setTab} className="panel-tabs" />

      {/* Every pane stays mounted: the Tools keep watching for a stash, and an answer keeps streaming. */}
      <div role="tabpanel" id="pane-issues" aria-labelledby="tab-issues" className="pane" hidden={tab !== 'issues'}>
        <div className="panel-toolbar">
          <Button size="sm" disabled={errors.length === 0} onClick={() => void acceptAll()}>
            Accept all errors
            {errors.length > 0 && (
              <>
                {' '}
                <span className="panel-count">{errors.length}</span>
              </>
            )}
          </Button>
          <Button size="sm" disabled={!state} onClick={() => void checkEverything()}>
            Check everything
          </Button>
        </div>

        <Group title={familyName('correctness')} family="correctness" issues={errors} render={render} />
        {(['clarity', 'engagement', 'delivery', 'generic'] as const).map((family) => (
          <Group key={family} title={familyName(family)} family={family} issues={inGroup(family)} render={render} />
        ))}
        {status === 'ok' && state && issues.length === 0 && (
          <div className="panel-empty">
            <CheckIcon size={20} />
            <p>Nothing to fix here.</p>
          </div>
        )}
        {!state && status === 'ok' && <p className="muted panel-hint">Click into a text box to start checking.</p>}

        <details className="panel-settings">
          <summary>Settings</summary>
          <div className="panel-settings-body">
            <FamilyToggles />
            <LocalChecksToggle />
            <h3>Your rules</h3>
            <YourRules />
            <h3>On the page</h3>
            <BadgeToggle />
          </div>
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
            delivery: inGroup('delivery').length + inGroup('generic').length, // the Overview counts generic phrasing as Delivery
          }}
          spend={spend}
        />
      </div>

      <SpendMeter spend={spend} tracked={!provider || spendTracked(provider)} />
    </main>
  );
}
