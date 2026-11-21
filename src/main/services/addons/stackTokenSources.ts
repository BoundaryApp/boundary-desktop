import type { PlainOutcome } from './addonScript';

// From stack v0.3.16 (docker-compose.yml at 1e50da5), compose bind-mounts token files that the
// stack's own start (`scripts/up.sh`, `make ensure-local`) creates, and Boundary drives compose
// itself:
// - both Hermes bootstraps mount `${ASSISTANT_DATA_ROOT}/web-browser/secrets/agent`;
// - `bitwarden-broker` mounts `${ASSISTANT_DATA_ROOT}/web-browser/secrets/credentials`;
// - `hermes` and `bitwarden-broker` mount `${BITWARDEN_HOST_DATA_DIR}/broker-api`, whose
//   `api-token` the broker and the Hermes plugin share.
// `setup.sh` creates them too, but `scripts/web-browser-secrets.sh` only warns and exits 0 when it
// can't write. Podman refuses `up` when a source is missing; Docker creates a folder there, which
// keeps the token from ever being written (the script then warns and skips it).

export type TokenScript = 'web-browser-secrets.sh' | 'vault.sh';

/** A mounted token path: `file` when it holds something, `missing` when absent or empty. */
export type TokenSourceState = 'file' | 'missing' | 'folder';

export interface TokenSource {
  /** Shown in the error, so the person can find it. */
  path: string;
  state: TokenSourceState;
}

export interface StackTokenSourceDeps {
  /** Whether the stack's tree has `scripts/web-browser-secrets.sh`, which v0.3.16 added. */
  hasTokenScripts: () => Promise<boolean>;
  /** `agent` and `credentials` under `${ASSISTANT_DATA_ROOT}/web-browser/secrets`. */
  browserTokens: () => Promise<TokenSource[]>;
  /** `broker-api/api-token` under `BITWARDEN_HOST_DATA_DIR`, which `.env` may put anywhere on this machine. */
  brokerToken: () => Promise<TokenSource>;
  run: (script: TokenScript, args: string[]) => Promise<PlainOutcome>;
  /** Metadata only: never a token or its contents. */
  log: (message: string, data: Record<string, unknown>) => void;
}

function folderError(file: string): Error {
  return new Error(
    `${file} is a folder, where the agent stack expects a token file. Stop the assistant, delete that empty folder, and start it again.`
  );
}

/** Creates the token files v0.3.16's compose mounts when any is missing. Rejects with a message for the person when one can't be made. */
export async function ensureStackTokenSources(deps: StackTokenSourceDeps): Promise<void> {
  if (!(await deps.hasTokenScripts())) return;
  const steps: { script: TokenScript; args: string[]; read: () => Promise<TokenSource[]> }[] = [
    { script: 'web-browser-secrets.sh', args: [], read: deps.browserTokens },
    { script: 'vault.sh', args: ['api-token'], read: async () => [await deps.brokerToken()] },
  ];

  for (const step of steps) {
    const before = await step.read();
    const folder = before.find((source) => source.state === 'folder');
    if (folder) throw folderError(folder.path);
    if (before.every((source) => source.state === 'file')) continue;

    const { code } = await deps.run(step.script, step.args);
    deps.log('token sources', { script: step.script, code });
    for (const source of await step.read()) {
      if (source.state === 'folder') throw folderError(source.path);
      if (source.state === 'missing') {
        throw new Error(`The agent stack’s token file ${source.path} couldn’t be created (scripts/${step.script} exited ${code}).`);
      }
    }
  }
}
