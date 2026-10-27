import { describe, expect, it } from 'vitest';
import type { TabState } from '../../src/background/tab-state';
import { pageStatus } from '../../src/shared/page-status';

const tab = (status: TabState['status']): TabState => ({ host: 'h', mode: 'standard', status, activeFieldId: null, fields: {}, frames: {}, pageId: 'p' });
const base = { tabState: null, keySaved: true, spent: 0, cap: 25, siteDisabled: false };

describe('pageStatus', () => {
  it('no key wins over everything', () => {
    expect(pageStatus({ ...base, keySaved: false, siteDisabled: true, spent: 99, tabState: tab('offline') })).toBe('key_missing');
  });
  it('a disabled site wins over the cap and the last check', () => {
    expect(pageStatus({ ...base, siteDisabled: true, spent: 99, tabState: tab('offline') })).toBe('off_site');
  });
  it('reaching the cap pauses, even before any check', () => {
    expect(pageStatus({ ...base, spent: 25 })).toBe('paused_cap');
    expect(pageStatus({ ...base, spent: 24.99 })).toBe('ok');
  });
  it('otherwise the last check status, or ok', () => {
    expect(pageStatus({ ...base, tabState: tab('rate_limited') })).toBe('rate_limited');
    expect(pageStatus({ ...base, tabState: tab('out_of_credit') })).toBe('out_of_credit');
    expect(pageStatus(base)).toBe('ok');
  });
});
