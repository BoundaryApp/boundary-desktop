import { describe, expect, it, vi } from 'vitest';

vi.mock('../hermesDashboardAuth', () => ({ mintDashboardWsTicket: vi.fn() }));

import { mapTranscriptMessages } from '../hermesGatewaySession';

describe('mapTranscriptMessages', () => {
  it('keeps the stored time and durable row id', () => {
    expect(
      mapTranscriptMessages([
        { role: 'user', text: 'hi', timestamp: 1767225600, row_id: 11 },
        { role: 'assistant', text: 'hello', timestamp: 1767225605.5, row_id: 12 },
      ])
    ).toEqual([
      { role: 'user', content: 'hi', timestamp: 1767225600, rowId: 11 },
      { role: 'assistant', content: 'hello', timestamp: 1767225605.5, rowId: 12, toolCount: 0 },
    ]);
  });

  it('omits time and row id when the row has none', () => {
    expect(
      mapTranscriptMessages([{ role: 'user', content: 'hi', timestamp: null, row_id: null }])
    ).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops hidden rows, so a Continue instruction never shows as a prompt', () => {
    expect(
      mapTranscriptMessages([
        { role: 'user', text: 'hi', row_id: 1 },
        { role: 'assistant', text: 'half', row_id: 2 },
        { role: 'user', text: 'Continue from where you stopped.', row_id: 3, display_kind: 'hidden' },
        { role: 'assistant', text: 'the rest', row_id: 4 },
      ]).map((m) => m.content)
    ).toEqual(['hi', 'half', 'the rest']);
  });

  it('drops tool rows and empty text', () => {
    expect(
      mapTranscriptMessages([
        { role: 'tool', text: 'ran', row_id: 3 },
        { role: 'assistant', text: '', row_id: 4 },
      ])
    ).toEqual([]);
  });

  it('attaches the files a turn wrote to its reply, not the files it only read', () => {
    expect(
      mapTranscriptMessages([
        { role: 'user', text: 'write it', row_id: 1 },
        { role: 'tool', name: 'read_file', args: { path: '/opt/projects/p/notes.md' } },
        { role: 'tool', name: 'write_file', args: { path: '/opt/projects/p/letter.md' } },
        { role: 'tool', name: 'patch', args: { path: '/opt/projects/p/letter.md' } },
        { role: 'assistant', text: 'Done.', row_id: 5 },
        { role: 'user', text: 'thanks', row_id: 6 },
        { role: 'assistant', text: 'Anytime.', row_id: 7 },
      ])
    ).toEqual([
      { role: 'user', content: 'write it', rowId: 1 },
      {
        role: 'assistant',
        content: 'Done.',
        rowId: 5,
        files: ['/opt/projects/p/letter.md'],
        toolCount: 3,
      },
      { role: 'user', content: 'thanks', rowId: 6 },
      { role: 'assistant', content: 'Anytime.', rowId: 7, toolCount: 0 },
    ]);
  });

  it('drops files from a turn that never got a reply', () => {
    expect(
      mapTranscriptMessages([
        { role: 'user', text: 'try', row_id: 1 },
        { role: 'tool', name: 'write_file', args: { path: '/opt/projects/p/a.md' } },
        { role: 'user', text: 'again', row_id: 2 },
        { role: 'assistant', text: 'ok', row_id: 3 },
      ]).at(-1)
    ).toEqual({ role: 'assistant', content: 'ok', rowId: 3, toolCount: 0 });
  });

  it('counts tools over the whole turn, including calls stored after the reply text', () => {
    const replies = mapTranscriptMessages([
      { role: 'user', text: 'check the folder', row_id: 1 },
      { role: 'assistant', text: 'Let me look.', row_id: 2 },
      { role: 'tool', name: 'search_files', args: { path: '/opt/projects/p' } },
      { role: 'tool', name: 'terminal', args: { command: 'ls' } },
      { role: 'assistant', text: 'Found four files.', row_id: 5 },
      { role: 'user', text: 'create a file', row_id: 6 },
      { role: 'assistant', text: '<action>Write file</action><result>ok</result>', row_id: 7 },
    ]).filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.toolCount)).toEqual([2, 2, 0]);
  });
});

describe('mapTranscriptMessages · kanban tasks filed', () => {
  it('attaches the tasks a turn filed to its reply, in call order', () => {
    const [, reply] = mapTranscriptMessages([
      { role: 'user', text: 'audit licenses and draft notes', row_id: 1 },
      {
        role: 'tool',
        name: 'kanban_create',
        args: { title: 'Audit dependency licenses', assignee: 'researcher', body: 'all deps' },
      },
      { role: 'tool', name: 'kanban_create', args: { title: ' Draft release notes ', assignee: 'writer' } },
      { role: 'tool', name: 'kanban_show', args: { task_id: 't_1' } },
      { role: 'assistant', text: 'On the board.', row_id: 5 },
    ]);
    expect(reply.tasksFiled).toEqual([
      { title: 'Audit dependency licenses', assignee: 'researcher' },
      { title: 'Draft release notes', assignee: 'writer' },
    ]);
  });

  it('keeps tasks filed after the reply text on that reply, and none on the next turn', () => {
    const replies = mapTranscriptMessages([
      { role: 'user', text: 'file it', row_id: 1 },
      { role: 'assistant', text: 'Filing it now.', row_id: 2 },
      { role: 'tool', name: 'kanban_create', args: { title: 'Bump Electron', assignee: 'coder' } },
      { role: 'user', text: 'thanks', row_id: 4 },
      { role: 'assistant', text: 'Anytime.', row_id: 5 },
    ]).filter((m) => m.role === 'assistant');
    expect(replies.map((m) => m.tasksFiled)).toEqual([
      [{ title: 'Bump Electron', assignee: 'coder' }],
      undefined,
    ]);
  });
});
