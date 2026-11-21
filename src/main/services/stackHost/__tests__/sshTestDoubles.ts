import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import type { SshExec } from '../sshStackCommands';
import type { SftpOps } from '../sshStackFiles';

// SFTP as OpenSSH's sftp-server answers it, over this machine's files: a missing path is status 2
// (NO_SUCH_FILE), any other failure status 4 (FAILURE), `mkdir` makes one folder, `readdir` leaves
// out `.` and `..`, and rename is `posix-rename@openssh.com`, which replaces a file. The real
// client against a real sshd is covered by sshConnection.sshd.test.ts.
export function sftpOverLocalFiles(): SftpOps & { calls: string[] } {
  const calls: string[] = [];
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls.push(name);
      try {
        return await fn(...args);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 2 : 4;
        throw Object.assign(new Error((error as Error).message), { code });
      }
    };
  return {
    calls,
    readFile: wrap('readFile', (file: string) => fsp.readFile(file)),
    writeFile: wrap('writeFile', (file: string, data: Buffer, mode?: number) => fsp.writeFile(file, data, { mode })),
    stat: wrap('stat', (file: string) => fsp.stat(file)),
    lstat: wrap('lstat', (file: string) => fsp.lstat(file)),
    realpath: wrap('realpath', (file: string) => fsp.realpath(file)),
    readdir: wrap('readdir', (folder: string) => fsp.readdir(folder)),
    mkdir: wrap('mkdir', (folder: string, mode?: number) => fsp.mkdir(folder, { mode })),
    chmod: wrap('chmod', (file: string, mode: number) => fsp.chmod(file, mode)),
    rename: wrap('rename', (from: string, to: string) => fsp.rename(from, to)),
    unlink: wrap('unlink', (file: string) => fsp.unlink(file)),
    rmdir: wrap('rmdir', (folder: string) => fsp.rmdir(folder)),
  };
}

// Stands in for sshd: runs the command through `/bin/sh -c`, as a login shell runs `ssh host cmd`.
// On abort it ends the command's whole process group and answers at once, as a closed channel
// does. Records every command.
export function shExec(): { exec: SshExec; commands: string[] } {
  const commands: string[] = [];
  const exec: SshExec = (command, options) =>
    new Promise((resolve) => {
      commands.push(command);
      const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      child.stdout.on('data', options.onStdout);
      child.stderr.on('data', options.onStderr);
      options.signal?.addEventListener(
        'abort',
        () => {
          process.kill(-child.pid!, 'SIGTERM');
          resolve({ exitCode: null });
        },
        { once: true }
      );
      child.on('close', (code) => resolve({ exitCode: code }));
      // A command that exits without reading its input closes the pipe under a pending write.
      // sshd drops that input too; the exit code still arrives through 'close'.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input ?? '');
    });
  return { exec, commands };
}
