import { afterEach, describe, expect, it } from 'vitest';
import { shExec } from './sshTestDoubles';

describe('shExec', () => {
  const uncaught: unknown[] = [];
  const record = (error: unknown) => uncaught.push(error);

  afterEach(() => {
    process.off('uncaughtException', record);
    uncaught.length = 0;
  });

  it('answers a command that exits without reading its input, with no write error', async () => {
    process.on('uncaughtException', record);
    const { exec } = shExec();
    // Larger than a pipe buffer, so the write is still pending when `exit` closes the read end.
    const input = 'x'.repeat(1 << 20);
    for (let i = 0; i < 5; i++) {
      await expect(
        exec('exit 3', { input, onStdout: () => undefined, onStderr: () => undefined })
      ).resolves.toEqual({ exitCode: 3 });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncaught).toEqual([]);
  });
});
