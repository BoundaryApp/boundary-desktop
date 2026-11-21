import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendEvent = vi.fn();
const buildCodingAccessRequest = vi.fn();
const noteChatToolCall = vi.fn();

vi.mock('../../../../ipc', () => ({ sendEvent: (...args: unknown[]) => sendEvent(...args) }));
vi.mock('../../coding/codingAccessRequests', () => ({
  buildCodingAccessRequest: (...args: unknown[]) => buildCodingAccessRequest(...args),
}));
vi.mock('../hermesChatProjects', () => ({ conversationProjectId: (id: string) => `project-of-${id}` }));
vi.mock('../../../addons/bitwardenRuntime', () => ({ noteChatToolCall: (name: string) => noteChatToolCall(name) }));

const { onToolComplete, toolPayload } = await import('../hermesToolReactions');

const sender = { id: 1 } as never;

describe('toolPayload', () => {
  it('reads a tool event, with the defaults the chat shows for missing fields', () => {
    expect(toolPayload(undefined, 3)).toEqual({
      toolId: 'tool-3',
      name: 'tool',
      args: undefined,
      paths: [],
      summary: undefined,
      resultText: undefined,
      durationSec: undefined,
    });
    expect(
      toolPayload(
        {
          tool_id: 't1',
          name: 'read_file',
          args: { path: '/work/notes.md' },
          duration_s: 1.5,
          summary: null,
          result_text: 'ok',
        },
        1
      )
    ).toEqual({
      toolId: 't1',
      name: 'read_file',
      args: { path: '/work/notes.md' },
      paths: ['/work/notes.md'],
      summary: undefined,
      resultText: 'ok',
      durationSec: 1.5,
    });
  });

  it('drops a duration that is not a number', () => {
    expect(toolPayload({ duration_s: '2' }, 1).durationSec).toBeUndefined();
  });
});

describe('onToolComplete', () => {
  beforeEach(() => {
    sendEvent.mockReset();
    buildCodingAccessRequest.mockReset().mockReturnValue(null);
    noteChatToolCall.mockReset();
  });

  const complete = (payload: Record<string, unknown>) =>
    onToolComplete({ sender, requestId: 'req-1', sessionId: 'sess-1', tool: toolPayload(payload, 1) });

  it('asks for coding access when the tool hit a folder outside the coding folders', () => {
    buildCodingAccessRequest.mockReturnValue({ path: '/elsewhere' });
    complete({ name: 'coding_start_task', args: { cwd: '/elsewhere' }, summary: 'shown', result_text: 'raw' });
    expect(buildCodingAccessRequest).toHaveBeenCalledWith({
      toolName: 'coding_start_task',
      resultText: 'raw',
      args: { cwd: '/elsewhere' },
      sessionId: 'sess-1',
      requestId: 'req-1',
      projectId: 'project-of-sess-1',
    });
    expect(sendEvent).toHaveBeenCalledWith(sender, 'coding-folders:access-request', { path: '/elsewhere' });
  });

  it('reads the summary when the tool sent no result, and sends nothing when no access is needed', () => {
    complete({ name: 'read_file', summary: 'shown' });
    expect(buildCodingAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({ resultText: 'shown', args: null })
    );
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("notes the agent's Bitwarden login request, and no other tool", async () => {
    complete({ name: 'read_file' });
    complete({ name: 'bitwarden_request_access' });
    await vi.waitFor(() => expect(noteChatToolCall).toHaveBeenCalledTimes(1));
    expect(noteChatToolCall).toHaveBeenCalledWith('bitwarden_request_access');
  });
});
