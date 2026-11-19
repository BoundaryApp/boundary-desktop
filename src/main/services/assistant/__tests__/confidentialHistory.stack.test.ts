/**
 * A Hermes history through the confidential adapters' request reduction. Hermes builds the tool
 * calls with `_assistant_tool_call_dict` and sanitizes the history with the chat completions
 * transport, as it does before a request to Boundary's router; Boundary's `plainRequest` and
 * NEAR's `encryptRequest` then run on what Hermes would send. The history is synthetic, with
 * marker strings in every field that must not reach a provider in plain text. Nothing is sent
 * to a provider, and nothing in the stack is written.
 */
import { describe, expect, it } from 'vitest';
import { plainRequest } from '../../inference/confidential/adapterKit';
import { encryptRequest, newClientKeys } from '../../inference/confidential/near/nearCrypto';
import { probeStack, pythonJsonInHermes, skipNote, type StackTarget } from './stackHarness';

const probe = await probeStack();

/** One model id Hermes treats as a Gemini-signature consumer, and one it doesn't. */
const MODELS = ['google/gemma-3-27b-it', 'qwen/qwen3-30b'];

const HISTORY_PROGRAM = String.raw`
import json, sys
from types import SimpleNamespace as NS
sys.path.insert(0, "/opt/hermes")
from agent.chat_completion_helpers import _assistant_tool_call_dict
from agent.transports.chat_completions import ChatCompletionsTransport
from agent.message_sanitization import deterministic_call_id
from agent.codex_responses_adapter import _split_responses_tool_id, _derive_responses_function_call_id

agent = NS(_deterministic_call_id=deterministic_call_id, _split_responses_tool_id=_split_responses_tool_id,
           _derive_responses_function_call_id=_derive_responses_function_call_id)

def call(index, call_id, name, args, extra=None, sig=None):
    fn = NS(name=name, arguments=args)
    if sig:
        fn.thought_signature = sig
    tc = NS(id=call_id, type="function", function=fn)
    if extra is not None:
        tc.extra_content = extra
    return _assistant_tool_call_dict(agent, tc, index)

calls = [
    call(0, None, "read_file", '{"path":"ARGMARK.md"}', {"google": {"thought_signature": "SIGMARK"}}, "SIGMARK"),
    call(1, "toolu_01IDMARK", "terminal", '{"command":"ls ARGMARK"}'),
]
history = [
    {"role": "system", "content": "SYSMARK"},
    {"role": "user", "content": "USERMARK", "timestamp": 1, "message_id": "m1"},
    {"role": "assistant", "content": "", "reasoning": "REASONMARK", "reasoning_content": "REASONMARK",
     "reasoning_details": [{"type": "reasoning.text", "text": "REASONMARK"}], "finish_reason": "tool_calls",
     "tool_calls": calls},
    {"role": "tool", "tool_call_id": calls[0]["id"], "name": "read_file", "tool_name": "read_file", "content": "RESULTMARK"},
    {"role": "tool", "tool_call_id": calls[1]["id"], "content": [{"type": "text", "text": "RESULTMARK"}]},
]
out = {}
for model in json.loads(${JSON.stringify(JSON.stringify(MODELS))}):
    out[model] = ChatCompletionsTransport().convert_messages(
        history, model=model, base_url="http://host.docker.internal:4000/v1", provider="custom")
print(json.dumps(out))
`;

type Message = Record<string, unknown> & { tool_calls?: Array<Record<string, unknown>> };

describe.skipIf(!probe.ok)(`A Hermes history through the confidential adapters${skipNote(probe)}`, () => {
  const target = (probe.ok ? probe.target : null) as StackTarget;
  let histories: Promise<Record<string, Message[]>> | null = null;

  it.each(MODELS)('sends no reasoning, signature or Hermes id plain for %s', async (model) => {
    histories ??= pythonJsonInHermes<Record<string, Message[]>>(target, HISTORY_PROGRAM);
    const messages = (await histories)[model];
    expect(messages).toHaveLength(5);

    // What Hermes leaves in, so this test notices when the sanitizer changes.
    const hermesCall = messages[2].tool_calls?.[0] as { function: Record<string, unknown> };
    expect(hermesCall.function.thought_signature).toBe('SIGMARK');
    expect(messages[2].reasoning_content).toBe('REASONMARK');

    const plain = plainRequest({ model, messages }) as { messages: Message[] };
    for (const call of plain.messages[2].tool_calls ?? []) {
      expect(Object.keys(call).sort()).toEqual(['function', 'id', 'type']);
      expect(Object.keys(call.function as object).sort()).toEqual(['arguments', 'name']);
    }
    expect(Object.keys(plain.messages[2]).sort()).toEqual(['content', 'role', 'tool_calls']);

    const near = encryptRequest({ model, messages }, newClientKeys().publicKeyHex);
    const wire = JSON.stringify(near);
    for (const marker of ['SYSMARK', 'USERMARK', 'REASONMARK', 'SIGMARK', 'ARGMARK', 'RESULTMARK', 'IDMARK', 'read_file', 'terminal']) {
      expect(wire, marker).not.toContain(marker);
    }
    const [, , assistant, first, second] = (near as { messages: Message[] }).messages;
    expect(assistant.tool_calls?.map((c) => c.id)).toEqual(['call_1', 'call_2']);
    expect([first.tool_call_id, second.tool_call_id]).toEqual(['call_1', 'call_2']);
  });
});
