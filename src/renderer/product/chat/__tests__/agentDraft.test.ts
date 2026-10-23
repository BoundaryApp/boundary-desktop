import { describe, expect, it } from 'vitest';
import { parseAgentDraft, stripAgentDraftFence } from '../agentDraft';

describe('parseAgentDraft', () => {
  it('returns null without a fence', () => {
    expect(parseAgentDraft('Here is a draft for a recruiter agent.')).toBeNull();
  });

  it('parses a fenced agent-draft block', () => {
    const text = [
      'Here is a draft. Confirm before it exists.',
      '',
      '```agent-draft',
      'displayName: Staff Recruiter',
      'handle: staff-recruiter',
      'role: Own outreach and interview prep.',
      '```',
    ].join('\n');
    expect(parseAgentDraft(text)).toEqual({
      displayName: 'Staff Recruiter',
      handle: 'staff-recruiter',
      role: 'Own outreach and interview prep.',
    });
  });

  it('requires displayName and role', () => {
    expect(
      parseAgentDraft('```agent-draft\ndisplayName: Only Name\n```')
    ).toBeNull();
  });
});

describe('stripAgentDraftFence', () => {
  it('leaves the prose around the fence', () => {
    const text = [
      'Here is a draft.',
      '',
      '```agent-draft',
      'displayName: Staff Recruiter',
      'handle: staff-recruiter',
      'role: Own outreach.',
      '```',
      '',
      'Create it when ready.',
    ].join('\n');
    expect(stripAgentDraftFence(text)).toBe('Here is a draft.\n\nCreate it when ready.');
  });
});
