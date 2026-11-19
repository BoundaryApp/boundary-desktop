import { describe, expect, it, vi } from 'vitest';
import { HermesGatewaySession } from '../hermesGatewaySession';
import type { JsonRpcGatewayClient } from '../vendor';

async function createParams(opts?: Parameters<HermesGatewaySession['createSessionWithSeed']>[0]) {
  const sent: Record<string, unknown>[] = [];
  const session = new HermesGatewaySession();
  vi.spyOn(session, 'ensureConnected').mockResolvedValue({
    request: async (_method: string, params: Record<string, unknown>) => {
      sent.push(params);
      return { session_id: 'new' };
    },
  } as unknown as JsonRpcGatewayClient);
  await session.createSessionWithSeed(opts);
  return sent[0];
}

describe('createSessionWithSeed hidden', () => {
  it('sends hidden when asked', async () => {
    expect(await createParams({ hidden: true })).toMatchObject({ hidden: true });
  });

  it('leaves hidden out otherwise', async () => {
    expect(await createParams({ title: 'Chat' })).not.toHaveProperty('hidden');
  });
});

async function resumeParams(opts?: Parameters<HermesGatewaySession['resumeSession']>[1]) {
  const sent: Record<string, unknown>[] = [];
  const session = new HermesGatewaySession();
  vi.spyOn(session, 'ensureConnected').mockResolvedValue({
    request: async (_method: string, params: Record<string, unknown>) => {
      sent.push(params);
      return { session_id: 's', messages_omitted: true };
    },
  } as unknown as JsonRpcGatewayClient);
  await session.resumeSession('s', opts);
  return sent[0];
}

describe('session context', () => {
  it('is sent on create and resume, null included, and left out when not given', async () => {
    expect(await createParams({ context: 'voice' })).toMatchObject({ context: 'voice' });
    expect(await createParams({ context: null })).toHaveProperty('context', null);
    expect(await createParams({})).not.toHaveProperty('context');
    expect(await resumeParams({ context: 'voice' })).toMatchObject({ context: 'voice' });
    expect(await resumeParams({ context: null })).toHaveProperty('context', null);
    expect(await resumeParams({ omitMessages: true })).not.toHaveProperty('context');
  });
});
