import { describe, expect, it } from 'vitest';
import { blockedMethodReason, blockedUrlReason, DEFAULT_BLOCKED_SITES, normalizeSite } from '../cdpPolicy';

describe('blockedMethodReason', () => {
  it('refuses cookie, storage, interception and protocol-exposure methods', () => {
    for (const method of [
      'Network.getAllCookies',
      'Network.getCookies',
      'Storage.getCookies',
      'Fetch.enable',
      'Fetch.getResponseBody',
      'DOMStorage.getDOMStorageItems',
      'IndexedDB.requestData',
      'CacheStorage.requestEntries',
      'IO.read',
      'Target.exposeDevToolsProtocol',
    ]) {
      expect(blockedMethodReason(method), method).toMatch(/doesn't allow/);
    }
  });

  it("allows Fetch only for Hermes's dialog bridge", () => {
    const bridge = { urlPattern: 'http://hermes-dialog-bridge.invalid/*', requestStage: 'Request' };
    expect(blockedMethodReason('Fetch.enable', { patterns: [bridge], handleAuthRequests: false })).toBeNull();
    expect(blockedMethodReason('Fetch.fulfillRequest', { requestId: 'r1' })).toBeNull();
    expect(blockedMethodReason('Fetch.continueRequest', { requestId: 'r1' })).toBeNull();
    // Anything wider stays blocked: all requests, a second pattern, auth interception, no patterns.
    expect(blockedMethodReason('Fetch.enable', {})).toMatch(/doesn't allow/);
    expect(blockedMethodReason('Fetch.enable', { patterns: [{ urlPattern: '*' }] })).toMatch(/doesn't allow/);
    expect(blockedMethodReason('Fetch.enable', { patterns: [bridge, { urlPattern: 'https://*' }] })).toMatch(/doesn't allow/);
    expect(blockedMethodReason('Fetch.enable', { patterns: [bridge], handleAuthRequests: true })).toMatch(/doesn't allow/);
    expect(blockedMethodReason('Fetch.enable', { patterns: [{ urlPattern: 'http://hermes-dialog-bridge.invalid.evil.com/*' }] })).toMatch(/doesn't allow/);
    expect(blockedMethodReason('Fetch.getResponseBody', { requestId: 'r1' })).toMatch(/doesn't allow/);
    expect(blockedMethodReason('Fetch.continueWithAuth', { requestId: 'r1' })).toMatch(/doesn't allow/);
  });

  it('lets the methods a driver needs through', () => {
    for (const method of ['Page.navigate', 'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Network.enable', 'Target.setAutoAttach']) {
      expect(blockedMethodReason(method), method).toBeNull();
    }
  });
});

describe('blockedUrlReason', () => {
  const policy = { blocked: [...DEFAULT_BLOCKED_SITES], allowed: [] as string[] };

  it('blocks listed sites and their subdomains, not lookalikes', () => {
    expect(blockedUrlReason('https://mail.google.com/mail/u/0', policy)).toMatch(/mail.google.com/);
    expect(blockedUrlReason('https://www.paypal.com/signin', policy)).toMatch(/paypal.com/);
    expect(blockedUrlReason('https://secure.chase.com/', policy)).toMatch(/chase.com/);
    expect(blockedUrlReason('https://notchase.com/', policy)).toBeNull();
    expect(blockedUrlReason('https://www.linkedin.com/feed', policy)).toBeNull();
  });

  it('always refuses local files and browser-internal pages', () => {
    expect(blockedUrlReason('file:///Users/me/.ssh/id_rsa', policy)).toMatch(/file:/);
    expect(blockedUrlReason('chrome://settings/passwords', policy)).toMatch(/chrome:/);
    expect(blockedUrlReason('chrome-extension://abc/page.html', policy)).toMatch(/chrome-extension:/);
    expect(blockedUrlReason('view-source:https://example.com', policy)).toMatch(/view-source:/);
  });

  it('lets neutral pages through', () => {
    for (const url of ['about:blank', 'data:text/html,hi', 'not a url']) {
      expect(blockedUrlReason(url, policy), url).toBeNull();
    }
  });

  it('enforces an allowlist when one is set', () => {
    const strict = { blocked: ['bad.example'], allowed: ['linkedin.com'] };
    expect(blockedUrlReason('https://www.linkedin.com/in/x', strict)).toBeNull();
    expect(blockedUrlReason('https://example.com/', strict)).toMatch(/allowed-sites/);
    expect(blockedUrlReason('https://sub.bad.example/', { ...strict, allowed: ['bad.example'] })).toMatch(/blocked/);
  });
});

describe('normalizeSite', () => {
  it('reduces user input to a bare host', () => {
    expect(normalizeSite(' https://WWW.Example.com/path ')).toBe('example.com');
    expect(normalizeSite('*.example.org')).toBe('example.org');
    expect(normalizeSite('sub.example.net')).toBe('sub.example.net');
    expect(normalizeSite('')).toBeNull();
  });
});
