import { describe, expect, it } from 'vitest';
import { blockedCookiesReason, blockedMethodReason, blockedUrlReason, DEFAULT_BLOCKED_SITES, normalizeSite } from '../cdpPolicy';

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

describe('blockedMethodReason per client (ADR 0065)', () => {
  const broker = [
    'Target.getTargetInfo',
    'Target.attachToTarget',
    'Target.detachFromTarget',
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'Network.setCookies',
    'Page.reload',
  ];

  it('allows the credential client what a fill and a handover send, and nothing else', () => {
    for (const method of broker) expect(blockedMethodReason(method, {}, 'credentials'), method).toBeNull();
    for (const method of ['Page.navigate', 'Target.createTarget', 'Network.getAllCookies', 'Input.dispatchKeyEvent', 'Fetch.enable', 'Target.setAutoAttach']) {
      expect(blockedMethodReason(method, {}, 'credentials'), method).toMatch(/credential client/);
    }
  });

  it('keeps the cookie write refused for the agent; reload stays the agent\'s, as in the stack gateway', () => {
    expect(blockedMethodReason('Network.setCookies', {}, 'agent')).toMatch(/doesn't allow/);
    expect(blockedMethodReason('Network.setCookies')).toMatch(/doesn't allow/);
    // compose/web-browser/gateway/rules.py refuses Page.reload to neither client; drivers reload pages.
    expect(blockedMethodReason('Page.reload', {}, 'agent')).toBeNull();
  });
});

describe('blockedCookiesReason', () => {
  const policy = { blocked: ['bank.example'], allowed: [] as string[] };
  const page = 'https://app.shop.example/account';

  it('takes cookies for the page host and its parent domains', () => {
    expect(blockedCookiesReason([{ name: 'a', value: '1', domain: 'app.shop.example' }], page, policy)).toBeNull();
    expect(blockedCookiesReason([{ name: 'a', value: '1', domain: '.shop.example' }], page, policy)).toBeNull();
    expect(blockedCookiesReason([{ name: 'a', value: '1', url: 'https://app.shop.example/' }], page, policy)).toBeNull();
    expect(blockedCookiesReason([], page, policy)).toBeNull();
  });

  it('refuses another site, a bare top-level domain, a missing domain and an unknown page', () => {
    expect(blockedCookiesReason([{ name: 'a', value: '1', domain: 'other.example' }], page, policy)).toMatch(/only takes cookies/);
    expect(blockedCookiesReason([{ name: 'a', value: '1', domain: '.example' }], page, policy)).toMatch(/only takes cookies/);
    expect(blockedCookiesReason([{ name: 'a', value: '1', domain: 'com' }], 'https://shop.com/', policy)).toMatch(/only takes cookies/);
    expect(blockedCookiesReason([{ name: 'a', value: '1' }], page, policy)).toMatch(/only takes cookies/);
    expect(blockedCookiesReason([{ name: 'a', value: '1', domain: 'shop.example' }], undefined, policy)).toMatch(/only takes cookies/);
    expect(blockedCookiesReason('not a list', page, policy)).toMatch(/only takes cookies/);
  });

  it('applies the site policy to the cookie domain', () => {
    expect(blockedCookiesReason([{ name: 'a', value: '1', domain: 'login.bank.example' }], 'https://login.bank.example/', policy)).toMatch(/bank.example/);
  });
});
