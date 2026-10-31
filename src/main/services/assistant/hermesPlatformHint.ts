import { APP_NAME } from '../../../shared/buildIdentity';
/**
 * Hermes has no built-in platform hint for Boundary's session source, so Boundary writes its
 * own into each profile that serves it. Hermes reads `platform_hints` at the top of
 * `config.yaml` and refuses `agent.platform_hints.*` as a wrong-prefix key; the stack's
 * docs/hermes.md ("Platform hints") shows the nested form, which Hermes never reads. The key
 * must match BOUNDARY_SESSION_SOURCE in hermesGatewaySession.ts.
 */
export const BOUNDARY_PLATFORM_HINT_KEY = 'platform_hints.boundary';

/**
 * Describes the bracketed room line that buildChannelHeader (hermesChannels.ts) writes and
 * the wake rules in runChannelWakeTurns; change it with them. Plain text: a value starting
 * with `[` or `{` would be parsed as YAML by `hermes config set`.
 */
export const BOUNDARY_PLATFORM_HINT =
  `You are running inside ${APP_NAME}, a desktop app. A conversation is either a direct chat ` +
  'with the user or a channel, where the user and several agents share one transcript. In a ' +
  'channel, a bracketed line starting "Boundary channel" names the channel, its members, the ' +
  'member you are answering as and, on a hand-off, who replied last. Trust it over what you ' +
  'infer from the history, because earlier assistant turns may be other agents\' replies. ' +
  'Posts above the user\'s @ message were left without an @; read them as background and ' +
  'answer what the @ message asks. To hand work to another member, @ them by the handle in ' +
  'that line, which wakes them after you. Each member answers at most once per round, so @ ' +
  'only members you need. Any @handle in your reply wakes that member, so name members ' +
  'without the @ unless you want them to reply. Replies render as Markdown.';
