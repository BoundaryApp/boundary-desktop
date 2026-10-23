import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_FALLBACK,
  builtinAgent,
  builtinAgentName,
  clashesWithBuiltinAgent,
} from '../../../../../shared/hermesAgentIdentity';
import type { AgentProfile } from '../../../../../shared/types/hermesChat';

const atlas: AgentProfile = { ...BUILTIN_AGENT_FALLBACK, displayName: 'Atlas', handle: 'Atlas' };
const ana: AgentProfile = {
  slug: 'ana',
  displayName: 'Ana',
  handle: 'Ana',
  role: 'Researcher',
  builtIn: false,
  createdAt: '2026-09-22T00:00:00.000Z',
};

describe('hermesAgentIdentity', () => {
  it('falls back to Hermes before agents load', () => {
    expect(builtinAgent(undefined)).toBe(BUILTIN_AGENT_FALLBACK);
    expect(builtinAgentName([])).toBe('Hermes');
    expect(BUILTIN_AGENT_FALLBACK.slug).toBe('assistant');
  });

  it('reads the stored built-in record when it exists', () => {
    expect(builtinAgentName([ana, atlas])).toBe('Atlas');
  });

  it('matches names and handles case-insensitively, ignoring a leading @', () => {
    expect(clashesWithBuiltinAgent('hermes')).toBe(true);
    expect(clashesWithBuiltinAgent(' @HERMES ')).toBe(true);
    expect(clashesWithBuiltinAgent('Hermes Jr')).toBe(false);
    expect(clashesWithBuiltinAgent('')).toBe(false);
    expect(clashesWithBuiltinAgent('Atlas', [atlas])).toBe(true);
    expect(clashesWithBuiltinAgent('Hermes', [atlas])).toBe(false);
  });
});
