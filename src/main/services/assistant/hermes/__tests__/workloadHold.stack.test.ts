/**
 * Stack contract: holding local turns (workload scheduling plan, Phase 1a). Runs only under
 * `bun run test:stack`.
 *
 * A fake model server on this machine reports `parallel: 1` the way LM Studio does, and counts
 * requests in flight. Three real Hermes turns (AIAgent in the Hermes container, each in its own
 * session) are sent at once through Boundary's own scheduler and limit lookup, and reach the
 * fake server at host.docker.internal. The upstream must never see two requests at once, and
 * every turn must finish. It also checks that one Hermes turn sends its model calls one at a
 * time, which the hold relies on: a turn with two calls in flight would fill a second slot.
 *
 * Each turn runs in a temporary Hermes home under the container's /tmp, removed afterwards.
 * Nothing is written to the stack's data folder.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HERMES_ROUTER_SESSION_HEADER } from '../../../inference/inferenceRouterService';
import { execInHermes, probeStack, pythonJsonInHermes, skipNote, type StackTarget } from '../../__tests__/stackHarness';
import { requestTurnSlot, resetWorkloadSchedulerForTests } from '../workloadScheduler';
import { resolveRepliesAtOnce } from '../workloadLimits';

const probe = await probeStack();

const TEMP_PREFIX = '/tmp/boundary-stack-workload.';
const MODEL = 'contract-model';
/** Long enough that overlapping turns would overlap at the server. */
const REPLY_DELAY_MS = 1_500;

/** One real turn in session `SESSION_ID` against the fake server at `BASE_URL`. */
const TURN_PROGRAM = `
import json, os, sys
sys.path.insert(0, "/opt/hermes")
base = os.environ["BASE_URL"]
turn_home = os.path.join(os.environ["HERMES_HOME"], os.environ["SESSION_ID"])
os.makedirs(turn_home)
os.environ["HERMES_HOME"] = turn_home
with open(os.path.join(turn_home, "config.yaml"), "w") as config:
    json.dump({"model": {"default": "${MODEL}", "base_url": base, "provider": "custom", "context_length": 128000},
        "providers": {"boundary-chain": {"base_url": base, "session_affinity_header": "${HERMES_ROUTER_SESSION_HEADER}"}}}, config)
try:
    from run_agent import AIAgent
    agent = AIAgent(model="${MODEL}", base_url=base, api_key="x", provider="custom", session_id=os.environ["SESSION_ID"],
        quiet_mode=True, enabled_toolsets=[], skip_context_files=True, skip_memory=True)
    result = agent.run_conversation("hi")
    print(json.dumps({"reply": (result or {}).get("final_response")}))
except (Exception, SystemExit) as error:
    print(json.dumps({"error": repr(error)}))
sys.stdout.flush()
os._exit(0)
`;

interface FakeServer {
  port: number;
  inFlight: number;
  maxInFlight: number;
  /** The session header of each completion request, in arrival order. */
  sessions: Array<string | undefined>;
  close: () => Promise<void>;
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  const body = { id: 'x', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] };
  return `data: ${JSON.stringify(body)}\n\n`;
}

async function startFakeServer(): Promise<FakeServer> {
  const state = { inFlight: 0, maxInFlight: 0, sessions: [] as Array<string | undefined> };
  const server = http.createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // LM Studio's own list, which Boundary reads the parallel count from.
    if (req.method === 'GET' && req.url === '/api/v1/models') {
      json({ models: [{ key: MODEL, loaded_instances: [{ id: MODEL, config: { context_length: 128000, parallel: 1 } }] }] });
      return;
    }
    if (req.method === 'GET') {
      json({ object: 'list', data: [{ id: MODEL, object: 'model', context_length: 128000 }] });
      return;
    }
    state.sessions.push(req.headers[HERMES_ROUTER_SESSION_HEADER.toLowerCase()] as string | undefined);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      setTimeout(() => {
        res.end(chunk({ role: 'assistant', content: 'ok' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
        state.inFlight -= 1;
      }, REPLY_DELAY_MS);
    });
  });
  // Docker Desktop forwards host.docker.internal to the Mac's loopback.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get inFlight() {
      return state.inFlight;
    },
    get maxInFlight() {
      return state.maxInFlight;
    },
    sessions: state.sessions,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!probe.ok)(`Holding local turns for the model server${skipNote(probe)}`, () => {
  const target = (probe.ok ? probe.target : null) as StackTarget;
  let home = '';
  let fake: FakeServer;

  beforeAll(async () => {
    fake = await startFakeServer();
    const made = await execInHermes(target, ['mktemp', '-d', `${TEMP_PREFIX}XXXXXX`]);
    home = made.stdout.trim();
    if (made.code !== 0 || !home.startsWith(TEMP_PREFIX)) {
      throw new Error(`couldn't make a temporary Hermes home in ${target.container}: ${made.stderr.trim()}`);
    }
  });

  afterAll(async () => {
    resetWorkloadSchedulerForTests();
    if (home.startsWith(TEMP_PREFIX)) await execInHermes(target, ['rm', '-rf', '--', home]);
    await fake?.close();
  });

  const runTurn = (sessionId: string) =>
    pythonJsonInHermes<{ reply?: string; error?: string }>(target, TURN_PROGRAM, {
      env: { HERMES_HOME: home, SESSION_ID: sessionId, BASE_URL: `http://host.docker.internal:${fake.port}/v1` },
    });

  it('three sessions sent at once reach the server one at a time, and all finish', async () => {
    const limit = await resolveRepliesAtOnce({ endpointUrl: `http://127.0.0.1:${fake.port}/v1`, modelId: MODEL });
    expect(limit).toMatchObject({ limit: 1, reported: 1 });

    const heldIds: string[] = [];
    const send = async (sessionId: string) => {
      const slot = await requestTurnSlot({
        requestId: `req-${sessionId}`,
        sessionIds: [sessionId],
        server: limit.server,
        limit: limit.limit,
        signal: new AbortController().signal,
        onHeld: () => heldIds.push(sessionId),
      });
      if (slot.kind !== 'admitted') throw new Error(`${sessionId} was withdrawn`);
      try {
        return await runTurn(sessionId);
      } finally {
        slot.release();
      }
    };

    const results = await Promise.all(['hold-a', 'hold-b', 'hold-c'].map(send));

    expect(results).toEqual([{ reply: 'ok' }, { reply: 'ok' }, { reply: 'ok' }]);
    expect(new Set(heldIds)).toEqual(new Set(['hold-b', 'hold-c']));
    expect(fake.maxInFlight).toBe(1);
    // Each turn's calls came in one block: none of another session's calls came between them.
    const order = fake.sessions.filter((id, i) => id !== fake.sessions[i - 1]);
    expect(order).toEqual(['hold-a', 'hold-b', 'hold-c']);
  }, 180_000);
});
