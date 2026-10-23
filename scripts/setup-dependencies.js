import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const pathWithBun = [join(homedir(), '.bun', 'bin'), process.env.PATH]
  .filter(Boolean)
  .join(':');

execSync('bun install', {
  stdio: 'inherit',
  env: { ...process.env, PATH: pathWithBun },
});
