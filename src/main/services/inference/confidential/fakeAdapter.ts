import type { AdapterChatResult, AdapterFailure, ConfidentialAdapter, ListedOffer } from './adapter';

/**
 * A scripted confidential provider for tests and for building the pool before real accounts
 * exist. It behaves the way Boundary assumes real providers do. Each assumption is listed in
 * `FAKE_ADAPTER_ASSUMPTIONS` and in ADR 0047's open questions, and stays an assumption until a
 * live check against that provider confirms it.
 */

export const FAKE_ADAPTER_ASSUMPTIONS: readonly { id: string; claim: string }[] = [
  {
    id: 'tools-pass-through',
    claim: 'A tool call in the request comes back as `tool_calls` over the encrypted route.',
  },
  {
    id: 'context-reported',
    claim: "The provider's models endpoint reports each model's context length.",
  },
  {
    id: 'cached-tokens-reported',
    claim: 'Each reply reports cached input tokens in `usage.prompt_tokens_details.cached_tokens`.',
  },
  {
    id: 'errors-classifiable',
    claim: 'Rate limits, an empty balance, a bad key and a failed hardware check can each be told apart from the response.',
  },
  {
    id: 'balance-readable',
    claim: 'The account balance can be read through the API with the same key, or the provider says it cannot.',
  },
  {
    id: 'attestation-per-session',
    claim: "The provider's hardware evidence can be fetched and checked at the start of each session without sending a prompt.",
  },
];

export interface FakeAdapterScript {
  offers: ListedOffer[];
  balance: number | null;
  attestation: 'pass' | 'fail' | 'unreachable';
  toolsWork: boolean;
  keyResult: 'ok' | AdapterFailure;
  /** Consumed in order; the last repeats. */
  chatResults: Array<'ok' | AdapterFailure>;
  /**
   * What a chat answers. `echo-tools` (the default) calls the request's first tool, as tests of
   * tool pass-through expect. `dev-text` answers in text and never calls a tool, so a dev build
   * can chat through the pool without a tool loop.
   */
  chatReply?: 'echo-tools' | 'dev-text';
  /** The provider's name in the `dev-text` reply. */
  name?: string;
}

/** The text a dev stand-in answers with. */
function devReplyText(name: string): string {
  return `This reply came from ${name}’s dev stand-in. No provider was called and nothing you wrote left this Mac.`;
}

function devTextReply(request: { stream?: boolean; model?: string }, name: string): Response {
  const text = devReplyText(name);
  const usage = { prompt_tokens: 1_000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } };
  const model = request.model ?? 'dev';
  if (!request.stream) {
    return Response.json({
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    });
  }
  const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({ id: 'dev-1', object: 'chat.completion.chunk', model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
  const events = [
    chunk({ delta: { role: 'assistant', content: text }, finish_reason: null }),
    chunk({ delta: {}, finish_reason: 'stop' }, { usage }),
    'data: [DONE]\n\n',
  ];
  return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function reply(request: { tools?: { function?: { name?: string } }[] }): Response {
  const tool = request.tools?.[0]?.function?.name;
  const message = tool
    ? { role: 'assistant', content: null as string | null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool, arguments: '{}' } }] }
    : { role: 'assistant', content: 'ready' };
  return Response.json({
    choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1_000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600 } },
  });
}

export function createFakeAdapter(providerId: string, script: FakeAdapterScript): ConfidentialAdapter {
  let turn = 0;
  return {
    providerId,
    checkKey: async () => (script.keyResult === 'ok' ? { ok: true } : { ok: false, failure: script.keyResult }),
    verifyAttestation: async () => {
      if (script.attestation === 'pass') return { ok: true };
      if (script.attestation === 'unreachable') return { ok: false, detail: 'scripted unreachable check', unreachable: true };
      return { ok: false, detail: 'scripted hardware check failure' };
    },
    listModels: async () => script.offers,
    readBalance: async () => script.balance,
    testToolCall: async () => script.toolsWork,
    chat: async (body: string): Promise<AdapterChatResult> => {
      const result = script.chatResults[Math.min(turn, script.chatResults.length - 1)] ?? 'ok';
      turn += 1;
      if (result !== 'ok') return { ok: false, failure: result };
      const request: unknown = JSON.parse(body);
      if (script.chatReply === 'dev-text') {
        return { ok: true, response: devTextReply(request as Parameters<typeof devTextReply>[0], script.name ?? providerId) };
      }
      return { ok: true, response: reply(request as Parameters<typeof reply>[0]) };
    },
  };
}
