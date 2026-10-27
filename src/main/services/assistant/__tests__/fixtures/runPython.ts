import { spawnSync } from 'node:child_process';

/**
 * Runs Python programs Boundary sends into containers on the host's `python3`, with stand-in
 * modules on PYTHONPATH in place of the container's libraries (ADR 0031 §3).
 */

export const hasPython3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

export const NO_PYTHON3 = 'python3 is not on the PATH, so the embedded Python programs are not run';

export interface PythonRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `python3 -` with `input` on stdin, as `compose exec … python3 -` runs it. */
export function runPython(input: string, pythonPath: string, env: Record<string, string> = {}): PythonRun {
  const out = spawnSync('python3', ['-'], {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? '',
      PYTHONPATH: pythonPath,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      ...env,
    },
  });
  if (out.error) throw out.error;
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}
