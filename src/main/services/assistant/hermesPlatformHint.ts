import {
  buildHermesConfigGetExec,
  buildHermesConfigSetExec,
  parseHermesConfigGet,
} from './hermesConfigSetExec';
import type { HermesConfigCompose } from './hermesProfileLimits';

/**
 * Hermes has no built-in platform hint for Boundary's session source, so Boundary writes its
 * own into each profile that serves it (the stack's docs/hermes.md, "Platform hints"). The
 * key must match BOUNDARY_SESSION_SOURCE in hermesGatewaySession.ts.
 */
export const BOUNDARY_PLATFORM_HINT_KEY = 'agent.platform_hints.boundary';

/**
 * Describes the bracketed room line that buildChannelHeader (hermesChannels.ts) writes and
 * the wake rules in runChannelWakeTurns; change it with them. Plain text: a value starting
 * with `[` or `{` would be parsed as YAML by `hermes config set`.
 */
export const BOUNDARY_PLATFORM_HINT =
  'You are running inside Boundary, a desktop app. A conversation is either a direct chat ' +
  'with the user or a channel, where the user and several agents share one transcript. In a ' +
  'channel, a bracketed line starting "Boundary channel" names the channel, its members, the ' +
  'member you are answering as and, on a hand-off, who replied last. Trust it over what you ' +
  'infer from the history, because earlier assistant turns may be other agents\' replies. ' +
  'Posts above the user\'s @ message were left without an @; read them as background and ' +
  'answer what the @ message asks. To hand work to another member, @ them by the handle in ' +
  'that line, which wakes them after you. Each member answers at most once per round, so @ ' +
  'only members you need. Replies render as Markdown.';

/**
 * Write the hint to one profile ('' is the default one) unless `config get` already prints
 * it. Any other answer, unreadable output included, writes it.
 */
export async function applyBoundaryPlatformHint(
  compose: HermesConfigCompose,
  profile: string
): Promise<void> {
  const { stdout } = await compose(
    buildHermesConfigGetExec(profile, BOUNDARY_PLATFORM_HINT_KEY).args,
    { timeout: 60_000 }
  );
  if (parseHermesConfigGet(stdout) === BOUNDARY_PLATFORM_HINT) return;
  const { args, env } = buildHermesConfigSetExec(
    profile,
    BOUNDARY_PLATFORM_HINT_KEY,
    BOUNDARY_PLATFORM_HINT
  );
  await compose(args, { timeout: 60_000, env });
}
