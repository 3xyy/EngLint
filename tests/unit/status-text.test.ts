import { describe, expect, it } from 'vitest';
import type { CheckStatus } from '../../src/core/types';
import {
  APPLY_FAILED,
  APPLY_FAILED_COPIED,
  BILLING_URL,
  helpLink,
  linksToSettings,
  spendText,
  statusText,
  toolStatusText,
} from '../../src/shared/status-text';

const CLAUDE = { name: 'Claude', keyless: false };
const named = (name: string) => ({ name, keyless: false });

describe('statusText', () => {
  it('has no banner for ok and a message for every other status', () => {
    expect(statusText('ok', undefined, CLAUDE)).toBeNull();
    const others: CheckStatus[] = [
      'off_site', 'paused_cap', 'key_missing', 'key_invalid', 'out_of_credit', 'rate_limited', 'overloaded', 'offline',
      'bad_response', 'docs_fallback', 'endpoint_blocked',
    ];
    for (const s of others) expect(statusText(s, { spent: 1, cap: 25 }, CLAUDE), s).toBeTruthy();
  });

  it('shows the spend when paused by the cap', () => {
    expect(statusText('paused_cap', { spent: 25.004, cap: 25 }, CLAUDE)).toBe(
      'Monthly limit reached ($25.00 of $25). Live checks are paused.',
    );
  });

  it('treats rate_limited and overloaded alike', () => {
    expect(statusText('rate_limited', undefined, CLAUDE)).toBe('Claude is busy. Retrying shortly.');
    expect(statusText('overloaded', undefined, CLAUDE)).toBe('Claude is busy. Retrying shortly.');
  });

  it('out of credit says so and links to the Console billing page', () => {
    expect(statusText('out_of_credit', undefined, CLAUDE)).toBe('Your Claude account is out of API credit. Add credit in the Claude Console.');
    expect(BILLING_URL).toBe('https://platform.claude.com/settings/billing');
    expect(helpLink('out_of_credit', CLAUDE)).toEqual({ href: BILLING_URL, label: 'Open billing' });
    for (const s of ['ok', 'key_invalid', 'paused_cap', 'bad_response'] as CheckStatus[]) expect(helpLink(s, CLAUDE)).toBeNull();
    expect(linksToSettings('out_of_credit')).toBe(false); // the fix is in the Console, not in EngLint's settings
  });

  it('links only key problems to settings', () => {
    expect(['key_missing', 'key_invalid', 'offline', 'paused_cap'].map((s) => linksToSettings(s as CheckStatus))).toEqual([
      true, true, false, false,
    ]);
  });

  it('formats the spend meter', () => {
    expect(spendText(3.456, 25)).toBe('$3.46 of $25 this month');
  });
});

describe('a failed apply', () => {
  it('reads the same everywhere: copied to the clipboard, or not', () => {
    expect(APPLY_FAILED_COPIED).toBe("Couldn't apply here — copied to clipboard.");
    expect(APPLY_FAILED).toBe("Couldn't apply here.");
  });
});

describe('toolStatusText', () => {
  const PAUSED = 'Rewrites, synonyms, chat and reviews are paused until next month or until you raise the limit in settings.';
  // Every status, so a new one can't slip through without a decision.
  const expected: Record<CheckStatus, string | null> = {
    ok: null,
    rate_limited: 'Claude is busy right now. Try again in a moment.',
    overloaded: 'Claude is busy right now. Try again in a moment.',
    bad_response: "Couldn't get a usable answer from Claude. Try again.",
    paused_cap: `Monthly limit reached. ${PAUSED}`,
    offline: "Can't reach Claude. Check your connection.",
    off_site: 'EngLint is off for this site.',
    key_missing: 'Add your Claude API key to start checking.',
    key_invalid: 'Your API key was rejected. Check it in settings.',
    out_of_credit: 'Your Claude account is out of API credit. Add credit in the Claude Console.',
    docs_fallback: "Google Docs live checking isn't available right now.",
    endpoint_blocked: "EngLint isn't allowed to reach Claude yet. Open Settings to allow it.",
  };

  it('has the tools wording for every status', () => {
    for (const [status, text] of Object.entries(expected)) expect(toolStatusText(status as CheckStatus, undefined, CLAUDE), status).toBe(text);
  });

  it('uses the live-check wording for every status it does not change', () => {
    for (const s of ['ok', 'offline', 'off_site', 'key_missing', 'key_invalid', 'out_of_credit', 'docs_fallback'] as CheckStatus[]) {
      expect(toolStatusText(s, undefined, CLAUDE), s).toBe(statusText(s, undefined, CLAUDE));
    }
  });

  it('shows the spend when paused by the cap', () => {
    expect(toolStatusText('paused_cap', { spent: 25.004, cap: 25 }, CLAUDE)).toBe(`Monthly limit reached ($25.00 of $25). ${PAUSED}`);
  });
});

describe('status copy names the provider', () => {
  it('says who is busy, unreachable or answering oddly', () => {
    expect(statusText('rate_limited', undefined, named('Google Gemini'))).toBe('Google Gemini is busy. Retrying shortly.');
    expect(statusText('overloaded', undefined, named('Claude'))).toBe('Claude is busy. Retrying shortly.');
    expect(statusText('offline', undefined, named('Groq'))).toBe("Can't reach Groq. Check your connection.");
    expect(statusText('bad_response', undefined, named('Groq'))).toBe('Got an unexpected answer from Groq. Will retry on your next edit.');
    expect(statusText('key_missing', undefined, named('OpenAI'))).toBe('Add your OpenAI API key to start checking.');
    expect(toolStatusText('rate_limited', undefined, named('OpenRouter'))).toBe('OpenRouter is busy right now. Try again in a moment.');
    expect(toolStatusText('bad_response', undefined, named('OpenRouter'))).toBe("Couldn't get a usable answer from OpenRouter. Try again.");
    expect(toolStatusText('endpoint_blocked', undefined, named('OpenRouter'))).toBe("EngLint isn't allowed to reach OpenRouter yet. Open Settings to allow it.");
  });
  it('the Claude Console is named, and linked, only for Claude', () => {
    expect(statusText('out_of_credit', undefined, named('Google Gemini'))).toBe('Your Google Gemini account is out of credit.');
    expect(helpLink('out_of_credit', named('Google Gemini'))).toBeNull();
    expect(helpLink('out_of_credit', CLAUDE)).toEqual({ href: BILLING_URL, label: 'Open billing' });
  });
  it('a blocked endpoint is fixed in settings', () => {
    expect(linksToSettings('endpoint_blocked')).toBe(true);
  });
  it('a server that takes no key and refuses the request is never said to have rejected a key', () => {
    const ollama = { name: 'Ollama', keyless: true };
    const refused = 'Ollama refused the request. Check that it accepts requests from browser extensions.';
    expect(statusText('key_invalid', undefined, ollama)).toBe(refused);
    expect(toolStatusText('key_invalid', undefined, ollama)).toBe(refused);
    expect(statusText('key_invalid', undefined, named('OpenAI'))).toBe('Your API key was rejected. Check it in settings.');
  });
});
