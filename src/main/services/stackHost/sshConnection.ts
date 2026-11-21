import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2';
import type { SshExec } from './sshStackCommands';
import type { SftpOps, SftpStat } from './sshStackFiles';

/** Where and how to reach a stack host (remote stack plan, phase 4). */
export interface SshTarget {
  host: string;
  port?: number;
  username: string;
  /** A private key in OpenSSH or PEM form. Without it, `agent` is used. */
  privateKey?: string;
  passphrase?: string;
  /** An SSH agent's socket (`SSH_AUTH_SOCK`), or `pageant` / an OpenSSH agent pipe on Windows. */
  agent?: string;
}

/**
 * Decides whether to trust the host's key, given its SHA-256 fingerprint as `ssh-keygen -l`
 * prints it (`SHA256:…`). The first connection asks the user; later ones compare with the pinned
 * fingerprint.
 */
export type HostKeyCheck = (fingerprint: string) => boolean | Promise<boolean>;

export interface SshConnection {
  exec: SshExec;
  sftp: SftpOps;
  /**
   * Opens a TCP connection from the host to `host:port` there (`direct-tcpip`), as `ssh -L`
   * does for each connection it accepts. Rejects when the host refuses, such as with
   * `AllowTcpForwarding no` or nothing listening.
   */
  forwardOut(host: string, port: number): Promise<Duplex>;
  /** The host key's fingerprint this connection accepted. */
  hostKeyFingerprint: string;
  /** Resolves when the connection closes, for whatever reason. */
  closed: Promise<void>;
  close(): void;
}

/** `SHA256:<base64 without padding>`, as OpenSSH prints a key's fingerprint. */
function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_MS = 15_000;

function promisify<T>(fn: (cb: (error: Error | undefined | null, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value))));
}

const asStat = (st: Stats): SftpStat => ({
  isFile: () => st.isFile(),
  isDirectory: () => st.isDirectory(),
  isSymbolicLink: () => st.isSymbolicLink(),
  size: st.size,
  mode: st.mode,
});

/** ssh2's SFTP client as `SftpOps`. */
function sftpOps(sftp: SFTPWrapper): SftpOps {
  return {
    readFile: (file) => promisify<Buffer>((cb) => sftp.readFile(file, (error, data) => cb(error, data))),
    writeFile: (file, data, mode) =>
      promisify<void>((cb) =>
        sftp.writeFile(file, data, mode === undefined ? {} : { mode }, (error) => cb(error, undefined))
      ),
    stat: (file) => promisify<Stats>((cb) => sftp.stat(file, cb)).then(asStat),
    lstat: (file) => promisify<Stats>((cb) => sftp.lstat(file, cb)).then(asStat),
    realpath: (file) => promisify<string>((cb) => sftp.realpath(file, cb)),
    readdir: (folder) =>
      promisify<{ filename: string }[]>((cb) => sftp.readdir(folder, cb)).then((list) => list.map((e) => e.filename)),
    mkdir: (folder, mode) =>
      promisify<void>((cb) => sftp.mkdir(folder, mode === undefined ? {} : { mode }, (error) => cb(error, undefined))),
    chmod: (file, mode) => promisify<void>((cb) => sftp.chmod(file, mode, (error) => cb(error, undefined))),
    rename: (from, to) => promisify<void>((cb) => sftp.ext_openssh_rename(from, to, (error) => cb(error, undefined))),
    unlink: (file) => promisify<void>((cb) => sftp.unlink(file, (error) => cb(error, undefined))),
    rmdir: (folder) => promisify<void>((cb) => sftp.rmdir(folder, (error) => cb(error, undefined))),
  };
}

/** ssh2's `exec` as `SshExec`. */
function execOn(client: Client): SshExec {
  return (command, options) =>
    new Promise((resolve, reject) => {
      client.exec(command, (error: Error | undefined, channel: ClientChannel) => {
        if (error) return reject(error);
        let exitCode: number | null = null;
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          resolve({ exitCode });
        };
        // TERM goes to the command (OpenSSH acts on `signal` requests from 7.9). sshd keeps the
        // channel open while anything the command started still holds its output, as `sleep` in a
        // script does, so the run ends here without waiting for the channel to close. As with the
        // local runner, only the command itself is stopped.
        const onAbort = () => {
          try {
            channel.signal('TERM');
            channel.close();
          } catch {
            /* the channel already closed */
          }
          exitCode = null;
          settle();
        };
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener('abort', onAbort, { once: true });
        channel.on('data', (chunk: Buffer) => options.onStdout(chunk));
        channel.stderr.on('data', (chunk: Buffer) => options.onStderr(chunk));
        channel.on('exit', (code: number | null) => {
          if (!settled) exitCode = typeof code === 'number' ? code : null;
        });
        channel.on('close', settle);
        channel.end(options.input ?? undefined);
      });
    });
}

/**
 * Opens one SSH connection to the stack host with an SFTP session on it. Rejects when the host
 * can't be reached, `checkHostKey` refuses its key, or authentication fails.
 */
export async function connectSsh(target: SshTarget, checkHostKey: HostKeyCheck): Promise<SshConnection> {
  const client = new Client();
  let fingerprint = '';
  const config: ConnectConfig = {
    host: target.host,
    port: target.port ?? 22,
    username: target.username,
    privateKey: target.privateKey,
    passphrase: target.passphrase,
    agent: target.privateKey ? undefined : target.agent,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_MS,
    hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
      fingerprint = sshFingerprint(key);
      Promise.resolve(checkHostKey(fingerprint)).then(verify, () => verify(false));
    },
  };

  const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.connect(config);
  });
  // Later errors end the connection; `closed` reports it.
  client.on('error', () => undefined);

  let sftp: SFTPWrapper;
  try {
    sftp = await promisify<SFTPWrapper>((cb) => client.sftp(cb));
  } catch (error) {
    client.end();
    throw error;
  }

  return {
    exec: execOn(client),
    sftp: sftpOps(sftp),
    forwardOut: (host, port) =>
      new Promise<Duplex>((resolve, reject) =>
        // The originator address is informational; sshd logs it and nothing else reads it.
        client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => (error ? reject(error) : resolve(channel)))
      ),
    hostKeyFingerprint: fingerprint,
    closed,
    close: () => client.end(),
  };
}
