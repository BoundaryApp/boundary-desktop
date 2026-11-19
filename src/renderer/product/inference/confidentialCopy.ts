import type { CanonicalModel, PoolMoveReason, Precision, TrustLevel } from '../../../shared/types/confidential';
import type { ConfidentialProviderView, PoolExclusion } from '../../../shared/types/confidentialState';

/**
 * Words the confidential pool screens share (ADR 0047, confidential inference spec), taken from
 * the study's prototype so the card, the sheets and the pool panel say the same thing.
 */

interface LevelCopy {
  /** The level's name, for a badge's tooltip and pool settings. */
  name: string;
  /** What was checked, in a few words. */
  short: string;
  /** The full text for the add flow, pool settings and the help page. */
  text: string;
}

/** One line of the What it sees step: `ok` is a check mark, `warn` a caution mark. */
interface SeesLine {
  look: 'ok' | 'warn';
  title: string;
  text: string;
}

const levels: Record<TrustLevel, LevelCopy> = {
  A: {
    name: 'Checked hardware and code',
    short: 'Hardware and code checked',
    text: 'Your Mac checks the sealed hardware and the exact build running inside it against published source.',
  },
  B: {
    name: 'Checked hardware',
    short: 'Hardware checked',
    text: 'Your Mac checks the sealed hardware, but can’t yet check which build runs inside it. You trust the provider to run what it says.',
  },
  C: {
    name: 'Not fully checked',
    short: 'Not fully checked',
    text: 'Your Mac can’t check the whole path: a gateway decrypts and forwards your request to another provider, or the provider’s hardware check can’t be enforced on every request.',
  },
};

/** What a provider's exclusion sentence names: its level and precision, and the pool's minimums. */
interface ExclusionContext {
  level: TrustLevel;
  floor: TrustLevel;
  precision: Precision | null;
  lowestPrecision: Precision;
}

/** Why a provider isn't used, in one sentence (spec decision 5). */
export function exclusionText(reason: PoolExclusion, ctx: ExclusionContext): string {
  switch (reason) {
    case 'not-added':
      return 'Not added. Pools only use providers you add.';
    case 'below-level':
      return `Level ${ctx.level} is below your minimum, ${ctx.floor}.`;
    case 'precision':
      return ctx.precision
        ? `Runs at ${ctx.precision}, below your lowest precision, ${ctx.lowestPrecision}.`
        : `Runs below your lowest precision, ${ctx.lowestPrecision}.`;
    case 'precision-unstated':
      return 'Doesn’t state its precision, and your pool only takes stated ones.';
    case 'no-price':
      return 'Boundary has no price for it, so the pool can’t rank it.';
    case 'no-tools':
      return 'A test tool call didn’t come back, so it can’t serve chats that use tools.';
    case 'context':
      return 'Its context window is too short for this model’s chats.';
    case 'input-types':
      return 'It doesn’t take every kind of input this model does.';
    case 'key-unavailable':
      return 'Boundary can’t read the key you stored for it. Remove it and add it again with its key.';
    case 'no-balance':
      return 'Its balance is empty. It refuses requests until you top up.';
    case 'rate-limited':
      return 'It’s rate-limiting your account.';
    case 'attestation-failed':
      return 'Its hardware check failed. It isn’t used until a check passes.';
    case 'unhealthy':
      return 'It isn’t answering. It isn’t used until it does.';
    case 'model-not-offered':
      return 'Doesn’t offer this model.';
  }
}

type ProviderProblem = NonNullable<ConfidentialProviderView['problem']>;

/** What stops an added provider now: the pill's label, its tone and the sentence for a callout. */
interface ProblemCopy {
  label: string;
  tone: 'warn' | 'bad';
  text: string;
}

function problem(kind: ProviderProblem, name: string, rateLimitedUntil: number | null): ProblemCopy {
  switch (kind) {
    case 'key-unavailable':
      return {
        label: 'Key unreadable',
        tone: 'bad',
        text: `Boundary can’t read the key it stored for ${name}, so pools skip it. Remove ${name} and add it again with its key.`,
      };
    case 'rate-limited': {
      const until = rateLimitedUntil
        ? ` until about ${new Date(rateLimitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : '';
      return { label: 'Rate-limited', tone: 'warn', text: `${name} is rate-limiting this account${until}.` };
    }
    case 'no-balance':
      return {
        label: 'Balance empty',
        tone: 'bad',
        text: `Your ${name} balance is $0.00. ${name} refuses requests until you top up.`,
      };
    case 'attestation-failed':
      return {
        label: 'Check failed',
        tone: 'bad',
        text: `${name}’s hardware check failed. It isn’t used until a check passes. Nothing was sent.`,
      };
    case 'unhealthy':
      return { label: 'Not answering', tone: 'warn', text: `${name} isn’t answering. Pools skip it until it does.` };
  }
}

/** The names of canonical model ids, in the order given; an id the list doesn't name shows as is. */
export function modelNames(ids: string[], models: CanonicalModel[]): string {
  return ids.map((id) => models.find((model) => model.id === id)?.name ?? id).join(', ');
}

/** A cost per turn: three decimals under ten cents, as the prototype shows it. */
export function formatTurnCost(value: number): string {
  return formatUsd(value, value < 0.1 ? 3 : 2);
}

/** US dollars, as balances and prices show. */
export function formatUsd(value: number, digits = 2): string {
  return `$${value.toFixed(digits)}`;
}

/** True for a real cost too small to show in cents. */
const underACent = (value: number): boolean => value > 0 && value < 0.01;

/** A cost for the Spend sheet and a provider's last 30 days: tiny but real costs read under a cent. */
export function formatSpendCost(value: number): string {
  return underACent(value) ? 'under $0.01' : formatUsd(value);
}

/** A provider's last 30 days on its sheet: `1 turn · about $0.61`, `3 turns · under $0.01`. */
export function formatLastThirtyDays(turns: number, cost: number): string {
  const count = `${turns} ${turns === 1 ? 'turn' : 'turns'}`;
  return `${count} · ${underACent(cost) ? '' : 'about '}${formatSpendCost(cost)}`;
}

/**
 * Token counts as the Spend sheet shows them: 1.2M, 840K, 950. The unit is chosen after rounding
 * to one decimal, so 999,950 reads 1M rather than 1000K.
 */
export function formatTokens(value: number): string {
  const short = (n: number): string => n.toFixed(1).replace(/\.0$/, '');
  const whole = Math.round(value);
  if (whole < 1_000) return String(whole);
  const thousands = Math.round(value / 100) / 10;
  if (thousands < 1_000) return `${short(thousands)}K`;
  return `${short(Math.round(value / 100_000) / 10)}M`;
}

function sees(name: string, billing: string): SeesLine[] {
  return [
    {
      look: 'ok',
      title: 'Can’t read',
      text: 'What you write, what the model replies, or files and tool results in a chat.',
    },
    {
      look: 'warn',
      title: 'Sees',
      text: 'When you send, how long each request and reply is, which model you use, and your account. Each provider you add sees this for the chats it serves.',
    },
    {
      look: 'warn',
      title: 'Bills you',
      text: `${billing}, at ${name}. Boundary doesn’t bill you or see your payment details.`,
    },
    {
      look: 'ok',
      title: 'Joins your pools',
      text: `${name} serves any pool for a model it carries, when it’s cheapest and meets your settings. New models it adds join too. Remove it here to stop that.`,
    },
  ];
}

/** Why a chat moved to another provider, as its marker says it (spec decision 9). */
const movedReasons: Record<Exclude<PoolMoveReason, 'new-session'>, string> = {
  'rate-limited': 'rate limited',
  'no-balance': 'out of balance',
  'bad-key': 'key refused',
  unreachable: 'not answering',
  'attestation-failed': 'hardware check failed',
  server: 'server error',
  'stopped-serving': 'no longer serves this model',
};

export const CONFIDENTIAL_COPY = {
  levels,
  problem,
  sees,
  cardLead:
    'Providers that run models in sealed hardware, so they can’t read your prompts. You bring an account at each. When a chat starts, Boundary sends it to the cheapest one that meets your settings and keeps it there.',
  tradeoff: {
    title: 'What each provider sees.',
    text: 'When you send, how long your messages are, and which model you use. Not what you wrote. Each provider you add is one more company that sees this.',
  },
  /** A private project's inspector row while it allows level B (spec decision 10). */
  levelBAllowed: {
    label: 'Level B providers allowed',
    text: 'Chats here may use providers whose hardware is checked but whose code in the enclave isn’t.',
    undo: 'Don’t allow',
  },
  /** A private project's stopped send when no added provider meets its level (spec decision 10). */
  privateStop: {
    title: (floor: TrustLevel): string => `No provider you’ve added meets this project’s level ${floor}.`,
    noneAdded: (model: string): string => `You haven’t added a provider that carries ${model}.`,
    nothingSent: 'Nothing was sent.',
    allowLevelB: 'Allow level B for this project',
    addLevelA: 'Add a level A provider',
    useLocal: 'Use Local for this chat',
  },
  /** Who answered a chat: the chip and the line under each reply (spec decision 9). */
  servedBy: (model: string, provider: string): string => `${model} · ${provider}`,
  /** The marker above the first reply after a chat moved provider; null when it didn't move. */
  tookOver: (provider: string, moved: PoolMoveReason | null): string | null =>
    moved && moved !== 'new-session' ? `${provider} took over: ${movedReasons[moved]}` : null,
  turnNote:
    'A turn is an estimate: 75,000 tokens in, 60% of them cached, and 2,500 out. A chat stays on its provider, so its cache isn’t lost; new chats go to whoever is first then.',
  spend: {
    title: 'Spend, last 30 days',
    note: 'Boundary counts the tokens each reply reports and multiplies by the prices it knew then. Your providers’ invoices are what you pay; they may differ. Boundary keeps these counts on this Mac, without any chat content.',
    noCounts: (n: number): string =>
      n === 1
        ? '1 turn reported no token counts and isn’t in the estimate.'
        : `${n} turns reported no token counts and aren’t in the estimate.`,
    removed: 'Removed',
    empty: 'No turns in the last 30 days.',
  },
  /** The How pools work sheet (prototype help page; ADR 0047 decision 10). */
  help: {
    title: 'How pools work',
    sections: [
      {
        heading: null,
        paragraphs: [
          'A confidential provider runs models inside sealed hardware: a processor and GPU that encrypt their memory and can prove to your Mac what they are. Your Mac encrypts each request so that only that hardware can open it. The provider’s staff, its cloud host and Boundary can’t read what you write or what the model replies.',
          'A pool is one model served by every provider you’ve added that carries it. When a chat starts, Boundary sends it to the cheapest provider in the pool that meets your settings, and keeps the chat there.',
        ],
      },
      {
        heading: 'What providers still see',
        paragraphs: [
          'Each provider sees when you send, how long each request and reply is, which model you use, and your account with them. It doesn’t see the content. The more providers you add, the more companies see this for some of your chats. Prefer one provider in Pool settings keeps your chats on one provider unless it fails or another is cheaper by more than the amount you set.',
        ],
      },
      {
        heading: 'Trust levels',
        levels: true,
        paragraphs: [
          'Boundary’s provider list sets each provider’s level and gives the reason, which you can read under the provider’s details. The list is signed; if a new list fails its check, Boundary keeps the last one that passed. By default chats use level B or better, and private projects use level A.',
        ],
      },
      {
        heading: 'Which provider answers',
        paragraphs: [
          'The cheapest provider changes as prices change, so two chats with the same model can go to different providers. Each reply’s line under it names the provider that wrote it. Boundary compares cost for a whole turn, including cached input, because a chat that stays on one provider reuses its cache. A provider is skipped while it’s rate-limiting you or has no balance, if its hardware check fails, if it runs the model at a lower precision than you allow, if its context is too short for the chat, or, for chats that use tools, if its tool test failed. One that fails to answer is skipped for five minutes.',
        ],
      },
      {
        heading: 'Private projects',
        paragraphs: [
          'Chats in a private project go only to your local model or to providers at the level set for private projects, level A unless you change it in Pool settings. If none qualifies, the send stops and says why. You can allow level B for one project; its inspector shows that and lets you undo it.',
        ],
      },
      {
        heading: 'Accounts and billing',
        paragraphs: [
          'You sign up and pay at each provider yourself, and each has its own balance to keep topped up. Boundary stores your keys on this Mac and doesn’t bill you. The spend Boundary shows is an estimate from the tokens each reply reports; your providers’ invoices are what you pay.',
        ],
      },
      {
        heading: 'When Boundary is closed',
        paragraphs: [
          'Confidential pools need Boundary running, because the encryption happens in the app. Scheduled jobs and messaging gateways that run while Boundary is closed can’t use them.',
        ],
      },
    ] as Array<{ heading: string | null; paragraphs: string[]; levels?: true }>,
  },
};
