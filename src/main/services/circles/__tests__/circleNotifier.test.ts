import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  CircleMentions,
  CircleMessage,
  CircleNotifyGlobal,
  CircleNotifyPrefs,
  DirectMessage,
} from '../../../../shared/types/circles';
import { createCircleNotifier, plainPreview, type CircleNotice } from '../circleNotifier';

const ME = 'a'.repeat(64);
const KEY = 'b'.repeat(64);

let seq = 0;
function msg(over: Partial<CircleMessage> & { mentions?: CircleMentions | null } = {}): CircleMessage {
  seq += 1;
  return {
    author: 'c'.repeat(64),
    id: `m${seq}`,
    circleKey: KEY,
    channel: 'general',
    name: 'Maya',
    agent: null,
    text: 'hello there',
    at: 1000 + seq,
    confirmed: true,
    edited: false,
    deleted: null,
    shared: null,
    call: null,
    mine: false,
    ...over,
  } as CircleMessage;
}

type Described = { name: string; people: number; channelNames: Record<string, string> };

interface Setup {
  people: number;
  prefs: CircleNotifyPrefs;
  global: CircleNotifyGlobal;
  circle: Described | null;
  describe: Mock<(circleKey: string) => Promise<Described | null>>;
}

describe('circle notifier', () => {
  let shown: CircleNotice[];
  let logs: Record<string, unknown>[];
  let s: Setup;
  let notifier: ReturnType<typeof createCircleNotifier>;

  beforeEach(() => {
    vi.useFakeTimers();
    seq = 0;
    shown = [];
    logs = [];
    s = {
      people: 5,
      prefs: { level: 'default', channelMentions: true },
      global: { enabled: true, showText: true },
      circle: null,
      describe: vi.fn<(circleKey: string) => Promise<Described | null>>(),
    };
    s.describe.mockImplementation(async () =>
      s.circle ?? { name: 'Book Club', people: s.people, channelNames: { general: 'general' } },
    );
    notifier = createCircleNotifier({
      identity: () => ME,
      describe: (k) => s.describe(k),
      prefs: () => s.prefs,
      global: () => s.global,
      show: (n) => shown.push(n),
      log: (d) => logs.push(d),
    });
  });

  afterEach(() => {
    notifier.dispose();
    vi.useRealTimers();
  });

  async function flush(ms = 1500): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('shows a post by someone else after 1,500 ms and not before', async () => {
    const m = msg();
    notifier.onMessage(m);
    await flush(1499);
    expect(shown).toEqual([]);
    await flush(1);
    expect(shown).toEqual([
      {
        title: 'Maya in #general · Book Club',
        body: 'hello there',
        open: { circleKey: KEY, channel: 'general', ref: { author: m.author, id: m.id } },
      },
    ]);
  });

  it('shows nothing for the user’s own message', async () => {
    notifier.onMessage(msg({ mine: true }));
    await flush();
    expect(shown).toEqual([]);
  });

  it('shows nothing for a deleted message', async () => {
    notifier.onMessage(msg({ deleted: 'author', text: '' }));
    await flush();
    expect(shown).toEqual([]);
  });

  it('shows nothing for the viewed, focused channel', async () => {
    notifier.setViewing({ circleKey: KEY, channel: 'general', focused: true });
    notifier.onMessage(msg());
    await flush();
    expect(shown).toEqual([]);
  });

  it('drops a queued message when its channel becomes viewed and focused before the flush', async () => {
    notifier.onMessage(msg());
    notifier.setViewing({ circleKey: KEY, channel: 'general', focused: true });
    await flush();
    expect(shown).toEqual([]);
    expect(logs[0]).toMatchObject({ queued: 1, shown: 0, dropped: { read: 0, viewing: 1, level: 0 } });
  });

  it('still notifies for the viewed channel when the window is not focused', async () => {
    notifier.setViewing({ circleKey: KEY, channel: 'general', focused: false });
    notifier.onMessage(msg());
    await flush();
    expect(shown).toHaveLength(1);
  });

  it('still notifies for a different channel than the viewed one', async () => {
    notifier.setViewing({ circleKey: KEY, channel: 'random', focused: true });
    notifier.onMessage(msg());
    await flush();
    expect(shown).toHaveLength(1);
  });

  it('drops a message whose channel was read before the flush', async () => {
    notifier.onMessage(msg());
    notifier.noteRead(KEY, 'general');
    await flush();
    expect(shown).toEqual([]);
    expect(logs[0]).toMatchObject({ dropped: { read: 1 } });
  });

  it('keeps a message queued after noteRead', async () => {
    notifier.onMessage(msg());
    notifier.noteRead(KEY, 'general');
    notifier.onMessage(msg());
    await flush();
    expect(shown).toHaveLength(1);
  });

  it('shows the newest text of a message edited inside the window', async () => {
    const m = msg();
    notifier.onMessage(m);
    notifier.onChange({ kind: 'changed', message: { ...m, text: 'hello there, edited', edited: true } });
    await flush();
    expect(shown.map((n) => n.body)).toEqual(['hello there, edited']);
  });

  it('a reaction-only change notifies nothing', async () => {
    const m = msg();
    notifier.onChange({
      kind: 'changed',
      message: { ...m, reactions: [{ emoji: '👍', count: 1, mine: false, people: [] }] as never },
    });
    await flush();
    expect(shown).toEqual([]);
  });

  it('drops a queued message deleted inside the window', async () => {
    const m = msg();
    notifier.onMessage(m);
    notifier.onMessage(msg({ text: 'second' }));
    notifier.onChange({ kind: 'changed', message: { ...m, text: '', deleted: 'author' } });
    await flush();
    expect(shown.map((n) => n.body)).toEqual(['second']);
  });

  it('drops a queued message that is gone when its order settles', async () => {
    const m = msg();
    notifier.onMessage(m);
    notifier.onChange({ kind: 'gone', circleKey: KEY, channel: 'general', author: m.author, id: m.id });
    await flush();
    expect(shown).toEqual([]);
  });

  it('ignores a change to a message that isn’t queued', async () => {
    const m = msg();
    notifier.onMessage(m);
    notifier.onChange({ kind: 'changed', message: msg({ text: 'not queued' }) });
    notifier.onChange({ kind: 'gone', circleKey: KEY, channel: 'random', author: m.author, id: m.id });
    await flush();
    expect(shown.map((n) => n.body)).toEqual(['hello there']);
  });

  it('on default with 7 people shows a plain message as nothing', async () => {
    s.people = 7;
    notifier.onMessage(msg());
    await flush();
    expect(shown).toEqual([]);
  });

  it('on default with 7 people shows a member mention', async () => {
    s.people = 7;
    notifier.onMessage(msg({ mentions: { members: [ME], channel: false } }));
    await flush();
    expect(shown.map((n) => n.title)).toEqual(['Maya mentioned you in #general · Book Club']);
  });

  it('shows an @channel mention when channelMentions is on', async () => {
    s.people = 7;
    notifier.onMessage(msg({ mentions: { members: [], channel: true } }));
    await flush();
    expect(shown.map((n) => n.title)).toEqual(['Maya mentioned #general · Book Club']);
  });

  it('ignores an @channel mention on level mentions when channelMentions is off', async () => {
    s.prefs = { level: 'mentions', channelMentions: false };
    notifier.onMessage(msg({ mentions: { members: [], channel: true } }));
    await flush();
    expect(shown).toEqual([]);
  });

  const toMe = { author: ME, id: 'e'.repeat(16) };

  it('on mentions only, a reply to me notifies as a reply', async () => {
    s.prefs = { level: 'mentions', channelMentions: true };
    notifier.onMessage(msg({ reply: toMe }));
    await flush();
    expect(shown.map((n) => n.title)).toEqual(['Maya replied to you in #general · Book Club']);
  });

  it('titles an agent reply to me with the agent', async () => {
    s.prefs = { level: 'mentions', channelMentions: true };
    notifier.onMessage(msg({ reply: toMe, agent: { slug: 'hermes', name: 'Hermes' } }));
    await flush();
    expect(shown.map((n) => n.title)).toEqual(['Maya’s Hermes replied to you in #general · Book Club']);
  });

  it('prefers the reply title over the mention title', async () => {
    s.prefs = { level: 'mentions', channelMentions: true };
    notifier.onMessage(msg({ reply: toMe, mentions: { members: [ME], channel: false } }));
    await flush();
    expect(shown.map((n) => n.title)).toEqual(['Maya replied to you in #general · Book Club']);
  });

  it('does not notify for a reply to someone else on mentions only', async () => {
    s.prefs = { level: 'mentions', channelMentions: true };
    notifier.onMessage(msg({ reply: { author: 'd'.repeat(64), id: 'e'.repeat(16) } }));
    await flush();
    expect(shown).toEqual([]);
  });

  // The notifier drops messages flagged `mine`, so this sets `mine: false` with my own identity as
  // author, which is what reaches it for a message of mine that this device didn't send. It proves
  // the notifier's reply exclusion (author is me) rather than the `mine` drop.
  it('does not treat my reply to my own message as a reply to me', async () => {
    const own = { author: ME, reply: toMe };
    s.prefs = { level: 'mentions', channelMentions: true };
    notifier.onMessage(msg(own));
    await flush();
    expect(shown).toEqual([]);

    s.prefs = { level: 'all', channelMentions: true };
    notifier.onMessage(msg(own));
    await flush();
    expect(shown.map((n) => n.title)).toEqual(['Maya in #general · Book Club']);
  });

  it('does not notify for a reply under level nothing', async () => {
    s.prefs = { level: 'nothing', channelMentions: true };
    notifier.onMessage(msg({ reply: toMe }));
    await flush();
    expect(shown).toEqual([]);
  });

  it('uses "Replied to you" when text is off', async () => {
    s.prefs = { level: 'mentions', channelMentions: true };
    s.global = { ...s.global, showText: false };
    notifier.onMessage(msg({ reply: toMe }));
    await flush();
    expect(shown.map((n) => n.body)).toEqual(['Replied to you']);
  });

  it('counts a reply as the mention in a summary', async () => {
    s.prefs = { level: 'all', channelMentions: true };
    const reply = msg({ name: 'Sam', reply: toMe });
    notifier.onMessage(msg());
    notifier.onMessage(reply);
    notifier.onMessage(msg());
    notifier.onMessage(msg());
    await flush();
    expect(shown[0].body).toBe('4 new messages · Sam mentioned you');
    expect(shown[0].open.ref).toEqual({ author: reply.author, id: reply.id });
  });

  it('level nothing drops a direct mention', async () => {
    s.prefs = { level: 'nothing', channelMentions: true };
    notifier.onMessage(msg({ mentions: { members: [ME], channel: false } }));
    await flush();
    expect(shown).toEqual([]);
    expect(logs[0]).toMatchObject({ level: 'nothing', dropped: { level: 1 } });
  });

  it('shows nothing when notifications are disabled globally', async () => {
    s.global = { enabled: false, showText: true };
    notifier.onMessage(msg());
    await flush();
    expect(shown).toEqual([]);
  });

  it('uses generic bodies when showText is off', async () => {
    s.global = { enabled: true, showText: false };
    notifier.onMessage(msg());
    notifier.onMessage(msg({ mentions: { members: [ME], channel: false } }));
    await flush();
    expect(shown.map((n) => n.body)).toEqual(['New message', 'Mentioned you']);
  });

  it('names the agent on an agent post', async () => {
    notifier.onMessage(msg({ agent: { slug: 'hermes', name: 'Hermes' } }));
    await flush();
    expect(shown[0].title).toBe('Maya’s Hermes in #general · Book Club');
  });

  it('uses the call body for a call start with no text', async () => {
    notifier.onMessage(msg({ text: '', call: { id: 'call1' } }));
    await flush();
    expect(shown[0].body).toBe('Maya started a call in #general');
  });

  it('uses the call body even when showText is off', async () => {
    s.global = { enabled: true, showText: false };
    notifier.onMessage(msg({ text: '', call: { id: 'call1' } }));
    await flush();
    expect(shown[0].body).toBe('Maya started a call in #general');
  });

  it('treats a post whose call has ended as an ordinary message', async () => {
    notifier.onMessage(msg({ text: 'we talked', call: { id: 'call1', ended: 5 } }));
    await flush();
    expect(shown[0].body).toBe('we talked');
  });

  it('uses the channel’s display name from describe', async () => {
    s.circle = { name: 'Book Club', people: 5, channelNames: { c1: 'plans' } };
    notifier.onMessage(msg({ channel: 'c1' }));
    await flush();
    expect(shown[0].title).toBe('Maya in #plans · Book Club');
    expect(shown[0].open.channel).toBe('c1');
  });

  it('sends four messages as one summary that opens the newest mention', async () => {
    const mention = msg({ name: 'Sam', mentions: { members: [ME], channel: false } });
    notifier.onMessage(msg());
    notifier.onMessage(mention);
    notifier.onMessage(msg());
    notifier.onMessage(msg());
    await flush();
    expect(shown).toEqual([
      {
        title: 'Book Club',
        body: '4 new messages · Sam mentioned you',
        open: { circleKey: KEY, channel: 'general', ref: { author: mention.author, id: mention.id } },
      },
    ]);
    expect(logs[0]).toMatchObject({ queued: 4, shown: 1, summary: true });
  });

  it('opens the newest message by arrival order when the summary has no mention', async () => {
    notifier.onMessage(msg());
    notifier.onMessage(msg());
    notifier.onMessage(msg());
    const last = msg({ at: 1 });
    notifier.onMessage(last);
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0].body).toBe('4 new messages');
    expect(shown[0].open.ref).toEqual({ author: last.author, id: last.id });
  });

  it('sends three messages as three notices in order', async () => {
    const ms = [msg(), msg(), msg()];
    ms.forEach((m) => notifier.onMessage(m));
    await flush();
    expect(shown.map((n) => n.open.ref.id)).toEqual(ms.map((m) => m.id));
  });

  it('counts only kept messages toward the summary threshold', async () => {
    s.people = 7;
    for (let i = 0; i < 5; i++) notifier.onMessage(msg());
    notifier.onMessage(msg({ mentions: { members: [ME], channel: false } }));
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Maya mentioned you in #general · Book Club');
  });

  it('batches each Circle separately', async () => {
    const other = 'd'.repeat(64);
    notifier.onMessage(msg());
    await flush(1000);
    notifier.onMessage(msg({ circleKey: other }));
    await flush(500);
    expect(shown).toHaveLength(1);
    await flush(1000);
    expect(shown).toHaveLength(2);
  });

  it('starts a new window for messages after a flush', async () => {
    notifier.onMessage(msg());
    await flush();
    notifier.onMessage(msg());
    await flush(1499);
    expect(shown).toHaveLength(1);
    await flush(1);
    expect(shown).toHaveLength(2);
  });

  it('shows nothing and does not throw when the Circle is gone', async () => {
    s.describe.mockResolvedValue(null);
    notifier.onMessage(msg());
    await expect(flush()).resolves.toBeUndefined();
    expect(shown).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ shown: 0, reason: 'no circle' });
  });

  it('drops the batch and logs a reason when describe rejects', async () => {
    s.describe.mockRejectedValue(new Error('secret text'));
    notifier.onMessage(msg());
    await expect(flush()).resolves.toBeUndefined();
    expect(shown).toEqual([]);
    expect(logs[0]).toMatchObject({ shown: 0, reason: 'describe failed' });
    expect(JSON.stringify(logs)).not.toContain('secret');
  });

  it('shows nothing after dispose', async () => {
    notifier.onMessage(msg());
    notifier.dispose();
    await flush();
    expect(shown).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('uses New message for a code-block-only post', async () => {
    notifier.onMessage(msg({ text: '```\ncode\n```' }));
    await flush();
    expect(shown[0].body).toBe('New message');
  });

  it('keeps log payloads free of names, text and long strings', async () => {
    s.people = 7;
    notifier.onMessage(msg({ text: 'x'.repeat(100), mentions: { members: [ME], channel: false } }));
    await flush();
    expect(logs).toHaveLength(1);
    const log = logs[0];
    for (const k of ['title', 'body', 'name', 'text']) expect(log).not.toHaveProperty(k);
    expect(log).toMatchObject({ circle: KEY.slice(0, 8), queued: 1, shown: 1, summary: false, level: 'mentions' });
    for (const [k, v] of Object.entries(log)) {
      if (typeof v === 'string' && k !== 'level') expect(v.length).toBeLessThanOrEqual(16);
    }
  });

  describe('direct messages', () => {
    const MAYA = 'c'.repeat(64);
    const dm = (over: Partial<DirectMessage> = {}): DirectMessage => {
      seq += 1;
      return {
        id: `d${seq}`.padEnd(16, '0'),
        author: MAYA,
        mine: false,
        text: 'Running late',
        at: 2000 + seq,
        reply: null,
        edited: false,
        deleted: false,
        delivery: null,
        neverSent: false,
        ...over,
      };
    };

    it('names the person and the Circle, and opens the conversation', async () => {
      const m = dm();
      notifier.onDirect(KEY, MAYA, 'Maya', m);
      await flush();
      expect(shown).toEqual([
        {
          title: 'Maya · Direct message in Book Club',
          body: 'Running late',
          open: { circleKey: KEY, channel: `dm:${MAYA}`, ref: { author: MAYA, id: m.id } },
        },
      ]);
    });

    it('notifies under Mentions only and stays silent under Nothing', async () => {
      s.prefs = { level: 'mentions', channelMentions: true };
      notifier.onDirect(KEY, MAYA, 'Maya', dm());
      notifier.onMessage(msg());
      await flush();
      expect(shown.map((n) => n.title)).toEqual(['Maya · Direct message in Book Club']);
      shown = [];
      s.prefs = { level: 'nothing', channelMentions: true };
      notifier.onDirect(KEY, MAYA, 'Maya', dm());
      await flush();
      expect(shown).toEqual([]);
    });

    it('stays silent while the conversation is open and focused, not while a channel is', async () => {
      notifier.setViewing({ circleKey: KEY, channel: `dm:${MAYA}`, focused: true });
      notifier.onDirect(KEY, MAYA, 'Maya', dm());
      await flush();
      expect(shown).toEqual([]);
      notifier.setViewing({ circleKey: KEY, channel: 'general', focused: true });
      notifier.onDirect(KEY, MAYA, 'Maya', dm());
      await flush();
      expect(shown).toHaveLength(1);
    });

    it('hides the text when message text is off, and ignores the user’s own and deleted ones', async () => {
      s.global = { enabled: true, showText: false };
      notifier.onDirect(KEY, MAYA, 'Maya', dm({ mine: true }));
      notifier.onDirect(KEY, MAYA, 'Maya', dm({ deleted: true, text: '' }));
      notifier.onDirect(KEY, MAYA, 'Maya', dm({ text: 'Secret plans' }));
      await flush();
      expect(shown.map((n) => n.body)).toEqual(['New message']);
    });

    it('follows an edit and drops a delete inside the batch window', async () => {
      const edited = dm();
      const deleted = dm();
      notifier.onDirect(KEY, MAYA, 'Maya', edited);
      notifier.onDirect(KEY, MAYA, 'Maya', deleted);
      notifier.onDirectChange(KEY, MAYA, 'Maya', { ...edited, text: 'Ten minutes late', edited: true });
      notifier.onDirectChange(KEY, MAYA, 'Maya', { ...deleted, text: '', deleted: true });
      await flush();
      expect(shown.map((n) => n.body)).toEqual(['Ten minutes late']);
    });

    it('opens a summary at the newest DM and says so', async () => {
      for (let i = 0; i < 3; i += 1) notifier.onMessage(msg());
      const last = dm();
      notifier.onDirect(KEY, MAYA, 'Maya', last);
      await flush();
      expect(shown).toEqual([
        {
          title: 'Book Club',
          body: '4 new messages · Maya sent you a direct message',
          open: { circleKey: KEY, channel: `dm:${MAYA}`, ref: { author: MAYA, id: last.id } },
        },
      ]);
    });
  });
});

describe('plainPreview', () => {
  it('removes link syntax and bold markers', () => {
    expect(plainPreview('**Hi** [there](https://x.test)')).toBe('Hi there');
  });
  it('keeps image alt text', () => {
    expect(plainPreview('see ![a cat](https://x.test/c.png) now')).toBe('see a cat now');
  });
  it('removes fenced code blocks entirely', () => {
    expect(plainPreview('before ```\ncode\n``` after')).toBe('before after');
  });
  it('removes inline backticks and heading, quote and strike markers', () => {
    expect(plainPreview('# Title\n> `quoted` ~~gone~~ _it_')).toBe('Title quoted gone it');
  });
  it('cuts to 150 characters ending in an ellipsis', () => {
    const out = plainPreview('a'.repeat(200));
    expect(out).toHaveLength(150);
    expect(out.endsWith('…')).toBe(true);
  });
  it('leaves exactly 150 characters alone', () => {
    expect(plainPreview('a'.repeat(150))).toBe('a'.repeat(150));
  });
});
