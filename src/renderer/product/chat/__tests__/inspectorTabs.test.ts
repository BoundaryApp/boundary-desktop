import { describe, expect, it } from 'vitest';
import {
  conversationInspectorKey,
  defaultInspectorTab,
  inspectorTabsFor,
} from '../inspectorTabs';

describe('inspectorTabs (ADR 0023)', () => {
  it('gives each kind its tabs and default', () => {
    const cases = [
      [{ kind: 'channel', hasAgent: false }, ['room', 'project'], 'room'],
      [{ kind: 'hermes', hasAgent: true }, ['session', 'project'], 'project'],
      [{ kind: 'dm', hasAgent: true }, ['agent', 'project'], 'agent'],
      [{ kind: 'side', hasAgent: true }, ['agent', 'project'], 'agent'],
      [{ kind: null, hasAgent: false }, ['project'], 'project'],
    ] as const;
    for (const [ctx, tabs, def] of cases) {
      expect(inspectorTabsFor(ctx)).toEqual(tabs);
      expect(defaultInspectorTab(ctx)).toBe(def);
    }
  });

  it('keys the conversation so tabs reset when it changes', () => {
    expect(conversationInspectorKey({ kind: 'channel', channelId: 'ch1', threadId: 't1' })).toBe(
      'channel:ch1'
    );
    expect(conversationInspectorKey({ kind: 'dm', threadId: 't2', agentSlug: 'ana' })).toBe('dm:ana');
    expect(conversationInspectorKey({ kind: 'hermes', threadId: 't3' })).toBe('hermes:t3');
    expect(conversationInspectorKey({ kind: 'side', threadId: 't4', agentSlug: 'ana' })).toBe(
      'side:t4'
    );
  });
});
