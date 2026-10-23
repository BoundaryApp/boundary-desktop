import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR 0023 §8: the built-in agent's name comes from its stored record, never a literal.
const here = dirname(fileURLToPath(import.meta.url));
const chatDir = join(here, '..');
const NAMES = ['Assistant', 'Hermes'];

describe('built-in agent name', () => {
  it('is never hardcoded in chat UI files', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(chatDir).filter((f) => /\.tsx?$/.test(f))) {
      const lines = readFileSync(join(chatDir, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const name of NAMES) {
          if (new RegExp(`['"\`]${name}['"\`]|['"\`][^'"\`]*· ${name}['"\`]`).test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
