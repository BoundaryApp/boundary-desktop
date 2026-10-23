import { describe, expect, it } from 'vitest';
import { bearerToken, checkBridgeRequest, hostAllowed, queryToken, tokenMatches } from '../requestGuard';

const PORT = 47123;
const TOKEN = 'secret-token-abc';

function headers(extra: Record<string, string | undefined> = {}) {
  return { host: `host.docker.internal:${PORT}`, authorization: `Bearer ${TOKEN}`, ...extra };
}

describe('checkBridgeRequest', () => {
  it('passes the container alias and loopback with the right token', () => {
    expect(checkBridgeRequest(headers(), { port: PORT, token: TOKEN })).toBeNull();
    expect(checkBridgeRequest(headers({ host: `127.0.0.1:${PORT}` }), { port: PORT, token: TOKEN })).toBeNull();
    expect(checkBridgeRequest(headers({ host: `localhost:${PORT}` }), { port: PORT, token: TOKEN })).toBeNull();
  });

  it('refuses anything carrying an Origin header, even with a valid token', () => {
    expect(checkBridgeRequest(headers({ origin: 'https://evil.example' }), { port: PORT, token: TOKEN })).toEqual({
      status: 403,
      reason: expect.any(String),
    });
    expect(checkBridgeRequest(headers({ origin: 'null' }), { port: PORT, token: TOKEN })?.status).toBe(403);
  });

  it('refuses a foreign Host (DNS rebinding) and a Host on another port', () => {
    expect(checkBridgeRequest(headers({ host: `rebind.evil.example:${PORT}` }), { port: PORT, token: TOKEN })?.status).toBe(421);
    expect(checkBridgeRequest(headers({ host: 'host.docker.internal:1' }), { port: PORT, token: TOKEN })?.status).toBe(421);
    expect(checkBridgeRequest(headers({ host: 'host.docker.internal' }), { port: PORT, token: TOKEN })?.status).toBe(421);
    expect(checkBridgeRequest(headers({ host: undefined }), { port: PORT, token: TOKEN })?.status).toBe(421);
  });

  it('refuses a missing, wrong or malformed token', () => {
    expect(checkBridgeRequest(headers({ authorization: undefined }), { port: PORT, token: TOKEN })?.status).toBe(401);
    expect(checkBridgeRequest(headers({ authorization: 'Bearer nope' }), { port: PORT, token: TOKEN })?.status).toBe(401);
    expect(checkBridgeRequest(headers({ authorization: TOKEN }), { port: PORT, token: TOKEN })?.status).toBe(401);
    expect(checkBridgeRequest(headers({ authorization: `Basic ${TOKEN}` }), { port: PORT, token: TOKEN })?.status).toBe(401);
  });

  it('never accepts an empty expected token', () => {
    expect(checkBridgeRequest(headers({ authorization: 'Bearer ' }), { port: PORT, token: '' })?.status).toBe(401);
  });
});

describe('helpers', () => {
  it('reads a bearer token case-insensitively and rejects extra words', () => {
    expect(bearerToken({ authorization: 'bearer abc' })).toBe('abc');
    expect(bearerToken({ authorization: 'Bearer abc def' })).toBeUndefined();
  });

  it('compares tokens of different lengths without throwing', () => {
    expect(tokenMatches('a', 'a-much-longer-token')).toBe(false);
    expect(tokenMatches('same', 'same')).toBe(true);
  });

  it('matches Host case-insensitively', () => {
    expect(hostAllowed(`HOST.DOCKER.INTERNAL:${PORT}`, PORT)).toBe(true);
  });
});

describe('query token', () => {
  it('is read from ?token= and accepted only when the caller passes the URL', () => {
    expect(queryToken('/devtools/browser/boundary?token=abc%2Bd')).toBe('abc+d');
    expect(queryToken('/devtools/browser/boundary')).toBeUndefined();
    const headers = { host: `host.docker.internal:${PORT}` };
    const url = `/devtools/browser/boundary?token=${TOKEN}`;
    expect(checkBridgeRequest(headers, { port: PORT, token: TOKEN, url })).toBeNull();
    // The MCP listener never passes the URL, so a query token does nothing there.
    expect(checkBridgeRequest(headers, { port: PORT, token: TOKEN })?.status).toBe(401);
  });
});
