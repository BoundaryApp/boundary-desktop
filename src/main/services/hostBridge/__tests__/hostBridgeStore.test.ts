import { beforeEach, describe, expect, it } from 'vitest';
import {
  addHostBridgeGrant,
  ensureHostBridgeToken,
  hasHostBridgeGrant,
  listHostBridgeGrants,
  revokeHostBridgeGrant,
  rotateHostBridgeToken,
  rotateHostBridgeTokens,
} from '../hostBridgeStore';

beforeEach(() => {
  rotateHostBridgeTokens();
  for (const grant of listHostBridgeGrants(0)) revokeHostBridgeGrant(grant.capability, grant.resource);
});

describe('host-bridge tokens', () => {
  it('creates a long random token once and keeps it', async () => {
    const first = await ensureHostBridgeToken('mcp');
    expect(first.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    expect(await ensureHostBridgeToken('mcp')).toBe(first);
    expect(await ensureHostBridgeToken('browser')).not.toBe(first);
  });

  it('issues new tokens after rotation', async () => {
    const before = await ensureHostBridgeToken('mcp');
    rotateHostBridgeTokens();
    expect(await ensureHostBridgeToken('mcp')).not.toBe(before);
  });

  it('rotates one token and keeps the other', async () => {
    const mcp = await ensureHostBridgeToken('mcp');
    const browser = await ensureHostBridgeToken('browser');
    rotateHostBridgeToken('browser');
    expect(await ensureHostBridgeToken('mcp')).toBe(mcp);
    expect(await ensureHostBridgeToken('browser')).not.toBe(browser);
  });
});

describe('host-bridge grants', () => {
  it('grants, scopes and revokes a capability', () => {
    expect(hasHostBridgeGrant('notify')).toBe(false);
    addHostBridgeGrant('notify');
    expect(hasHostBridgeGrant('notify')).toBe(true);
    expect(hasHostBridgeGrant('clipboard_read')).toBe(false);
    revokeHostBridgeGrant('notify');
    expect(hasHostBridgeGrant('notify')).toBe(false);
  });

  it('ignores expired grants', () => {
    addHostBridgeGrant('notify', '*', new Date(1_000).toISOString());
    expect(hasHostBridgeGrant('notify', '*', 2_000)).toBe(false);
    expect(hasHostBridgeGrant('notify', '*', 500)).toBe(true);
  });
});
