import { APP_NAME } from './buildIdentity';
/**
 * Plain-language versions of assistant-stack start-up errors (ADR 0029). The raw
 * message stays available under Show details; this is what the user reads first.
 */

export type StartupErrorKind =
  | 'disk'
  | 'port'
  | 'runtime'
  | 'rate-limit'
  | 'download'
  | 'network'
  | 'checksum'
  | 'python'
  | 'upgrade'
  | 'health'
  | 'slow-start'
  | 'setup'
  | 'compose'
  | 'unknown';

export interface StartupErrorDescription {
  kind: StartupErrorKind;
  /** Headline: what went wrong, in the user's terms. */
  title: string;
  /** What it means and what to do next. */
  body: string;
}

interface Rule {
  kind: StartupErrorKind;
  test: RegExp;
  title: string;
  /** `null` uses the raw message, for errors already written for users. */
  body: string | null;
}

// First match wins, so specific causes come before the wrappers that carry them
// (a port clash arrives inside "Compose exited with code 1: …").
const RULES: Rule[] = [
  {
    kind: 'disk',
    test: /no space left on device|ENOSPC/i,
    title: 'This Mac is out of disk space',
    body: 'Your tools need room for their downloads. Free up some space, then try again.',
  },
  {
    kind: 'runtime',
    test: /only one VM can be active/i,
    title: 'Another container engine is running',
    body: `This Mac can run one Podman machine at a time. If another copy of ${APP_NAME} is open, quit it. Otherwise stop the other machine, then try again.`,
  },
  {
    kind: 'port',
    test: /port is already allocated|address already in use|EADDRINUSE/i,
    title: `Another app is using a port ${APP_NAME} needs`,
    body:
      'Something else on this Mac is using one of the network ports your tools need, often another copy of these tools or a developer server. Quit it, then try again.',
  },
  {
    kind: 'runtime',
    test: /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|socket not found|podman machine|unable to connect to podman/i,
    title: 'The container engine isn’t responding',
    body:
      `${APP_NAME} runs each tool in a container, and the engine that runs them didn’t answer. If you use Docker Desktop, open it and wait until it says it’s running, then try again.`,
  },
  {
    kind: 'rate-limit',
    test: /toomanyrequests|too many requests|rate limit/i,
    title: `The download server asked ${APP_NAME} to slow down`,
    body: 'Too many downloads came from this network in a short time. Wait a few minutes, then try again.',
  },
  {
    // The server answered, so the connection is fine; the file isn't there or the server failed.
    kind: 'download',
    test: /failed to download[^(]*\((4|5)\d\d/i,
    title: 'The download isn’t available right now',
    body:
      `The server didn’t return the files ${APP_NAME} asked for. It may be having trouble. Try again later, and if it keeps happening, check for a ${APP_NAME} update.`,
  },
  {
    kind: 'network',
    test: /fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNRESET|ETIMEDOUT|network is unreachable|TLS handshake timeout|i\/o timeout|dial tcp|failed to download/i,
    title: 'Couldn’t download your tools',
    body: `${APP_NAME} couldn’t reach the internet to download them. Check your connection, then try again.`,
  },
  {
    kind: 'checksum',
    test: /checksum/i,
    title: 'The download was damaged',
    body: `Part of the download didn’t match what ${APP_NAME} expected, so it wasn’t used. Try again to download it fresh.`,
  },
  {
    kind: 'python',
    test: /setup needs Python/i,
    title: 'Setup needs Python 3',
    body: null,
  },
  {
    kind: 'upgrade',
    test: /before upgrading it/i,
    title: 'Couldn’t update your tools',
    body: `${APP_NAME} stops your tools to update them, and they didn’t stop. Try again.`,
  },
  {
    kind: 'health',
    test: /did not become healthy|did not answer on/i,
    title: 'Your assistant didn’t respond in time',
    body:
      'The assistant didn’t answer its health check before the time limit. A busy or slow Mac can cause this. Try again, and if it happens again, the details show what it was doing.',
  },
  {
    // Before 'setup': the tail of a timed-out `up` can name config.yaml.
    kind: 'slow-start',
    test: /compose timed out/i,
    title: 'Starting your tools took too long',
    body:
      'The first start downloads and builds every tool, and this one ran past the time limit. Try again: finished downloads are kept, so the next start picks up where this one stopped.',
  },
  {
    kind: 'setup',
    test: /setup\.sh|config\.yaml/i,
    title: 'One-time setup didn’t finish',
    body: 'The step that prepares your tools stopped with an error. Try again, and if it fails the same way, the details show its output.',
  },
  {
    kind: 'compose',
    test: /compose exited/i,
    title: 'Some of your tools didn’t start',
    body: 'One or more tools stopped while starting. Try again, and if it fails the same way, the details show which one and why.',
  },
];

export function describeStartupError(raw: string | null | undefined): StartupErrorDescription {
  const message = (raw ?? '').trim();
  const rule = RULES.find((r) => r.test.test(message));
  if (!rule) {
    return {
      kind: 'unknown',
      title: 'Your assistant didn’t start',
      body: 'Something went wrong while starting your tools. Try again, and if it fails the same way, the details show what happened.',
    };
  }
  return { kind: rule.kind, title: rule.title, body: rule.body ?? message };
}
