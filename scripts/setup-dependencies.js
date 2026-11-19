import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Windows names the variable `Path`; a second `PATH` key beside it would be ambiguous for the child.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
const pathWithBun = [join(homedir(), '.bun', 'bin'), process.env[pathKey]]
  .filter(Boolean)
  .join(delimiter);

execSync('bun install', {
  stdio: 'inherit',
  env: { ...process.env, [pathKey]: pathWithBun },
});
