import { afterEach, describe, expect, it, vi } from 'vitest';

describe('localStackMode', () => {
  const prevLocal = process.env.BOUNDARY_LOCAL_STACK;
  const prevRoot = process.env.BOUNDARY_ASSISTANT_ROOT;

  afterEach(() => {
    if (prevLocal === undefined) {
      delete process.env.BOUNDARY_LOCAL_STACK;
    } else {
      process.env.BOUNDARY_LOCAL_STACK = prevLocal;
    }
    if (prevRoot === undefined) {
      delete process.env.BOUNDARY_ASSISTANT_ROOT;
    } else {
      process.env.BOUNDARY_ASSISTANT_ROOT = prevRoot;
    }
    vi.resetModules();
  });

  it('detects BOUNDARY_LOCAL_STACK=1', async () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    process.env.BOUNDARY_LOCAL_STACK = '1';
    vi.doMock('../AssistantStackStore', () => ({
      getAssistantRootOverride: () => null,
    }));
    const { isLocalAssistantStackMode } = await import('../localStackMode');
    expect(isLocalAssistantStackMode()).toBe(true);
  });

  it('detects BOUNDARY_ASSISTANT_ROOT', async () => {
    delete process.env.BOUNDARY_LOCAL_STACK;
    process.env.BOUNDARY_ASSISTANT_ROOT = '/tmp/assistant';
    vi.doMock('../AssistantStackStore', () => ({
      getAssistantRootOverride: () => null,
    }));
    const { isLocalAssistantStackMode } = await import('../localStackMode');
    expect(isLocalAssistantStackMode()).toBe(true);
  });

  it('is false when unset', async () => {
    delete process.env.BOUNDARY_LOCAL_STACK;
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    vi.doMock('../AssistantStackStore', () => ({
      getAssistantRootOverride: () => null,
    }));
    const { isLocalAssistantStackMode } = await import('../localStackMode');
    expect(isLocalAssistantStackMode()).toBe(false);
  });
});

describe('resetBoundaryAssistantStack local guards', () => {
  const prevLocal = process.env.BOUNDARY_LOCAL_STACK;
  const prevRoot = process.env.BOUNDARY_ASSISTANT_ROOT;

  afterEach(() => {
    if (prevLocal === undefined) {
      delete process.env.BOUNDARY_LOCAL_STACK;
    } else {
      process.env.BOUNDARY_LOCAL_STACK = prevLocal;
    }
    if (prevRoot === undefined) {
      delete process.env.BOUNDARY_ASSISTANT_ROOT;
    } else {
      process.env.BOUNDARY_ASSISTANT_ROOT = prevRoot;
    }
    vi.resetModules();
  });

  it('throws when BOUNDARY_LOCAL_STACK is set', async () => {
    process.env.BOUNDARY_LOCAL_STACK = '1';
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    vi.doMock('../AssistantStackStore', () => ({
      getAssistantRootOverride: () => null,
    }));
    const { resetBoundaryAssistantStack } = await import('../provisionSovereignStack');
    await expect(resetBoundaryAssistantStack()).rejects.toThrow(/local assistant stack/i);
  });
});
