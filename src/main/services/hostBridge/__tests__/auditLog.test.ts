import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendAudit, trimForAudit } from '../auditLog';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bridge-audit-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'audit.jsonl');
}

describe('audit log', () => {
  it('appends one JSON line per entry with a timestamp', () => {
    const file = tempLog();
    appendAudit({ tool: 'notify', decision: 'allowed', args: { title: 'a' }, outcome: 'shown' }, file);
    appendAudit({ tool: 'notify', decision: 'denied', args: { title: 'b' } }, file);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ tool: 'notify', decision: 'allowed', args: { title: 'a' }, outcome: 'shown' });
    expect(typeof lines[0].ts).toBe('string');
  });

  it('moves a full file aside and starts a new one', () => {
    const file = tempLog();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1));
    appendAudit({ tool: 'notify', decision: 'allowed', args: {} }, file);
    expect(fs.existsSync(file.replace(/\.jsonl$/, '.1.jsonl'))).toBe(true);
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('never throws, even when the path is unusable', () => {
    expect(() => appendAudit({ tool: 'notify', decision: 'allowed', args: {} }, '/dev/null/nope/audit.jsonl')).not.toThrow();
  });

  it('cuts long strings', () => {
    const trimmed = trimForAudit({ body: 'y'.repeat(1000), n: 3 });
    expect(String(trimmed.body)).toMatch(/^y{300}… \(1000 chars\)$/);
    expect(trimmed.n).toBe(3);
  });
});
