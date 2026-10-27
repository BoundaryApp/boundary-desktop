import { describe, expect, it } from 'vitest';
import { messageCustom } from '../messageCustom';

const withCustom = (custom: Record<string, unknown>) => ({ metadata: { custom } });

describe('messageCustom', () => {
  it('reads the keys history and live turns write', () => {
    const custom = messageCustom(
      withCustom({
        ts: 1_700_000_000,
        rowId: 12,
        files: ['/work/a.md', 3],
        tasksFiled: [{ title: 'Draft' }],
        toolCount: 2,
        ending: 'stopped',
        noReply: { reason: 'failed', error: 'model offline' },
        agentSlug: 'ana',
        segments: [
          { agentSlug: 'ana', text: 'one' },
          { agentSlug: null, text: 'two' },
        ],
      })
    );
    expect(custom).toEqual({
      ts: 1_700_000_000,
      rowId: 12,
      files: ['/work/a.md'],
      tasksFiled: [{ title: 'Draft' }],
      toolCount: 2,
      ending: 'stopped',
      noReply: { reason: 'failed', error: 'model offline' },
      agentSlug: 'ana',
      segments: [
        { agentSlug: 'ana', text: 'one' },
        { agentSlug: null, text: 'two' },
      ],
    });
  });

  it('drops values of the wrong shape instead of trusting them', () => {
    expect(
      messageCustom(
        withCustom({
          noReply: { reason: 42 },
          ending: 'paused',
          agentSlug: 7,
          toolCount: '3',
          files: 'a.md',
          segments: [{ text: 1 }],
        })
      )
    ).toEqual({});
    expect(messageCustom(withCustom({ noReply: { reason: 'made-up' } }))).toEqual({});
  });

  it('reads a message with no metadata as empty', () => {
    expect(messageCustom(undefined)).toEqual({});
    expect(messageCustom({})).toEqual({});
  });
});
