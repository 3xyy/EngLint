import { describe, expect, it } from 'vitest';
import { isPageDisabled, isSiteDisabled, toggleSite, webHost } from '../../src/core/sites';

describe('site toggle', () => {
  it('disable adds exact host', () => {
    expect(toggleSite(['a.com'], 'b.com', false)).toEqual(['a.com', 'b.com']);
  });
  it('disabling a subdomain leaves the parent entry alone', () => {
    expect(toggleSite(['example.com'], 'mail.example.com', false)).toEqual(['example.com', 'mail.example.com']);
  });
  it('enable removes only the exact host', () => {
    expect(toggleSite(['example.com', 'mail.example.com', 'x.com'], 'mail.example.com', true)).toEqual([
      'example.com',
      'x.com',
    ]);
    expect(toggleSite(['example.com'], 'mail.example.com', true)).toEqual(['example.com']);
  });
  it('case-insensitive', () => {
    expect(isSiteDisabled(['Example.com'], 'EXAMPLE.com')).toBe(true);
    expect(toggleSite(['Example.com'], 'EXAMPLE.COM', true)).toEqual([]);
    expect(toggleSite([], 'EXAMPLE.COM', false)).toEqual(['example.com']);
  });
  it('no duplicates', () => {
    expect(toggleSite(['a.com'], 'A.com', false)).toEqual(['a.com']);
  });
  it('isSiteDisabled is exact only', () => {
    expect(isSiteDisabled(['example.com'], 'mail.example.com')).toBe(false);
    expect(isSiteDisabled(['mail.example.com'], 'example.com')).toBe(false);
  });
});

describe('a frame inside a page (cross-origin iframes)', () => {
  it('is off when its own host or its top-level host is switched off', () => {
    expect(isPageDisabled(['example.com'], 'widget.vendor.com', 'example.com')).toBe(true);
    expect(isPageDisabled(['widget.vendor.com'], 'widget.vendor.com', 'example.com')).toBe(true);
    expect(isPageDisabled(['EXAMPLE.com'], 'widget.vendor.com', 'example.COM')).toBe(true);
    expect(isPageDisabled(['other.com'], 'widget.vendor.com', 'example.com')).toBe(false);
  });
  it('without a known top-level host, only its own host counts', () => {
    expect(isPageDisabled(['example.com'], 'widget.vendor.com', null)).toBe(false);
    expect(isPageDisabled(['example.com'], 'widget.vendor.com', undefined)).toBe(false);
    expect(isPageDisabled(['widget.vendor.com'], 'widget.vendor.com', null)).toBe(true);
  });
  it('webHost: the hostname of an http(s) URL, else null', () => {
    expect(webHost('https://Example.com:8443/a?b#c')).toBe('example.com');
    expect(webHost('http://127.0.0.1:5173/x')).toBe('127.0.0.1');
    for (const url of [undefined, '', 'not a url', 'chrome://extensions', 'file:///tmp/a.html', 'about:blank']) {
      expect(webHost(url), String(url)).toBeNull();
    }
  });
});
