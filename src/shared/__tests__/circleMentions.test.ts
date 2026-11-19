import { describe, expect, it } from 'vitest';
import { DEFAULT_ALL_MAX_PEOPLE, keptMentions, mentionsMe, resolveNotifyLevel } from '../circleMentions';

const me = 'a'.repeat(64);
const other = 'b'.repeat(64);

describe('resolveNotifyLevel', () => {
  it('notifies for everything in a small Circle and for mentions in a larger one', () => {
    expect(DEFAULT_ALL_MAX_PEOPLE).toBe(6);
    expect(resolveNotifyLevel('default', 6)).toBe('all');
    expect(resolveNotifyLevel('default', 7)).toBe('mentions');
  });

  it('passes an explicit level through whatever the size', () => {
    expect(resolveNotifyLevel('all', 50)).toBe('all');
    expect(resolveNotifyLevel('mentions', 2)).toBe('mentions');
    expect(resolveNotifyLevel('nothing', 2)).toBe('nothing');
  });
});

describe('mentionsMe', () => {
  it('matches a named member', () => {
    expect(mentionsMe({ members: [me], channel: false }, me, false)).toBe(true);
    expect(mentionsMe({ members: [other], channel: false }, me, true)).toBe(false);
  });

  it('counts a channel mention only when channel mentions are on', () => {
    expect(mentionsMe({ members: [], channel: true }, me, false)).toBe(false);
    expect(mentionsMe({ members: [], channel: true }, me, true)).toBe(true);
  });

  it('is false without mentions', () => {
    expect(mentionsMe(null, me, true)).toBe(false);
  });
});

describe('keptMentions', () => {
  const maya = { identity: 'c'.repeat(64), name: 'Maya' };

  it('keeps a picked person whose @name is still in the text', () => {
    expect(keptMentions('hi @Maya', [maya], false)).toEqual({ members: [maya.identity] });
    expect(keptMentions('@Maya, hi', [maya], false)).toEqual({ members: [maya.identity] });
  });

  it('drops a person whose name was removed or only prefixes another word', () => {
    expect(keptMentions('hi', [maya], false)).toBeUndefined();
    expect(keptMentions('@Mayabelle', [maya], false)).toBeUndefined();
    expect(keptMentions('hi @Mayabelle and @Maya', [maya], false)).toEqual({ members: [maya.identity] });
  });

  it('matches names with punctuation literally', () => {
    const sam = { identity: 'd'.repeat(64), name: 'Dr. Sam (he/him)' };
    expect(keptMentions('ask @Dr. Sam (he/him) now', [sam], false)).toEqual({ members: [sam.identity] });
    expect(keptMentions('ask @Dr Sam (he/him) now', [sam], false)).toBeUndefined();
    expect(keptMentions('hi @a', [{ identity: 'e'.repeat(64), name: '.*' }], false)).toBeUndefined();
  });

  it('lists a person once however many times they were picked', () => {
    expect(keptMentions('@Maya', [maya, maya], false)).toEqual({ members: [maya.identity] });
  });

  it('keeps @channel only while it is in the text', () => {
    expect(keptMentions('@channel go', [], true)).toEqual({ channel: true });
    expect(keptMentions('go', [], true)).toBeUndefined();
    expect(keptMentions('@channels go', [], true)).toBeUndefined();
    expect(keptMentions('@channel go', [], false)).toBeUndefined();
    expect(keptMentions('@channel @Maya', [maya], true)).toEqual({ members: [maya.identity], channel: true });
  });
});
