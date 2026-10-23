import { describe, expect, it } from 'vitest';
import {
  approvalAlwaysDescription,
  approvalCommandCollapsed,
  approvalKicker,
  approvalWhy,
} from '../approvalCopy';

describe('approvalCopy', () => {
  it('names the tool on the default kicker', () => {
    expect(approvalKicker({ toolName: 'terminal' })).toBe(
      'Approval needed · terminal'
    );
  });

  it('uses reviewer copy when smart-denied', () => {
    expect(approvalKicker({ toolName: 'terminal', smartDenied: true })).toBe(
      'Reviewer flagged · terminal'
    );
    expect(
      approvalWhy({ toolName: 'terminal', smartDenied: true })
    ).toMatch(/high risk/i);
  });

  it('explains execute_code as a whole-script gate', () => {
    expect(approvalWhy({ toolName: 'execute_code' })).toMatch(/whole run/i);
  });

  it('explains protected writes as one-shot', () => {
    expect(
      approvalWhy({
        toolName: 'write_file',
        allowSession: false,
        allowPermanent: false,
      })
    ).toMatch(/one-shot/i);
  });

  it('defaults to folder-changing command copy', () => {
    expect(approvalWhy({ toolName: 'terminal' })).toMatch(/change files/i);
  });

  it('does not mention Hermes in always-allow copy', () => {
    expect(approvalAlwaysDescription()).not.toMatch(/hermes/i);
    expect(approvalAlwaysDescription()).toMatch(/durable allowlist/i);
  });

  it('collapses long commands', () => {
    expect(approvalCommandCollapsed('rm -rf scratch')).toBe(false);
    expect(approvalCommandCollapsed('x'.repeat(281))).toBe(true);
  });
});
