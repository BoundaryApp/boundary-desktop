# 0065. The browser relay has a second client for the credential backend

- Date: 2026-11-15
- Status: Proposed
- Amends: [0027](0027-host-bridge.md) §3, §5, §7
- Related: [stack contract](../stack-contract.md#browser-relay-credential-client-stack-0316), [CR 0038](../change-requests/0038-bitwarden-broker-host-route.md)

## Context

From stack 0.3.16 (stack commit f48d62c) the Bitwarden broker no longer reaches the agent's tab through the agent's `cdp_url`. It runs on networks of its own and opens each browser provider as a separate CDP client, with a token of its own (`compose/bitwarden-broker/broker/browsers.py`, `cdp.py`). Its provider table names Boundary's relay `boundary` and reads two files from the Bitwarden add-on's `secrets` folder, which it mounts read-only at `/secrets`: `boundary.url` (the endpoint, no token or query) and `boundary.token`. Both are read on every fill and handover. Without them every fill and sign-in handover in Boundary's browser fails with `cdp_unavailable`.

Over that connection the broker sends `Target.getTargetInfo`, `Target.attachToTarget` (flatten), `Runtime.evaluate`, `Runtime.callFunctionOn` and `Target.detachFromTarget` for a fill, plus `Network.setCookies` and `Page.reload` for a handover (`_handover_write`). The relay refuses `Network.setCookies` to every client (0027 §5). The stack's own browser gateway (`compose/web-browser/gateway/rules.py`) gives its credential client an allowlist of exactly those seven methods and its agent client the denylist the relay already has.

Boundary's reply to the stack's CR item 4.1 (2026-11-12) agreed to a second accepted token, a per-client label in the mux log, and rotation apart from the agent's token. The stack's view, which this keeps, is that site policy applies to the broker too.

## Decision

1. **A second client role.** The relay accepts two kinds of token on its browser listener. The agent's token (`BOUNDARY_BROWSER_TOKEN`) opens any `/devtools/browser/…` path except `/devtools/browser/credentials`; the credential token opens that path only. The token picks the role; a token on the other role's path is refused like an unknown one (401).
2. **The credential client gets an allowlist.** The seven methods above, plus `Browser.close`, which the relay answers by disconnecting that client. `Runtime.evaluate`, `Runtime.callFunctionOn`, `Network.setCookies` and `Page.reload` must name a session that client attached itself. `Network.setCookies` takes only cookies whose domain (or `url` host) is the attached page's host or a parent domain of it, the rule the broker applies itself (`cookie_domain_allowed`). The agent's denylist is unchanged: `Network.setCookies` stays refused to it, and `Page.reload` stays allowed, as in the stack's gateway.
3. **Site policy applies to both.** The credential client can't attach to a page on a blocked site (the existing attach check), `Target.getTargetInfo` on such a page answers "No target", and a cookie domain on a blocked site is refused.
4. **The credential client never starts Chrome.** It only writes into a page the agent opened, so while Chrome isn't running its upgrade is refused with 503.
5. **Its token lives for one run of the bridge.** Main makes a new 256-bit token each time the bridge starts, keeps it in memory, and sends it to the bridge process in `start`. It is never in the keychain. The running bridge replaces it every 24 hours and still accepts the previous one for 60 seconds, so a fill whose broker read the file just before the rotation still connects. The agent's token, Hermes's `.env` and Hermes itself are untouched by this rotation. Stop agent and Rotate tokens restart the bridge, which also replaces this token.
6. **Boundary writes the broker's two files.** On bridge ready, on every rotation, after the add-on's folders are made and on each stack apply, main writes `boundary.token` and `boundary.url` (`ws://host.docker.internal:<browser port>/devtools/browser/credentials`) into the add-on's `secrets` folder, resolved as `vault.sh` does (`BITWARDEN_HOST_DATA_DIR`, else `./data/addons/bitwarden` under the stack root). Each file is written to a temporary name at mode 0600 and renamed into place. Nothing is written when the folder doesn't exist: the add-on isn't set up, and Boundary doesn't create its folders for it. When the bridge stops (quit, Stop agent, Rotate tokens, or an unexpected exit) both files are removed. Neither value is logged; the log line names the outcome and the port.
7. **The mux log names the role.** Clients are labelled `agent-<n>` and `credentials-<n>`, and a `cdp client connected` line marks each connection, so a fill can be followed in the debug log.

## Consequences

- The relay's security model widens: a holder of the credential token can run script in, set cookies for and reload any page the agent can reach, without the agent's denylist. The token is readable by the broker's container and by any other container that mounts the add-on's `secrets` folder (at f48d62c, the one-shot `bitwarden-setup` tool mounts it read-write).
- A broker on the stack's current networks can't reach the relay at all: both are `internal: true`, and on Docker Desktop `host.docker.internal` neither resolves nor routes from such a network. CR 0038 asks the stack for a route; until then fills in Boundary's browser still fail with `cdp_unavailable`.
- The mux log's client labels change from `client-<n>` to `agent-<n>`.
- 0027 §5's note that the filter becomes an allowlist later now holds for the credential client only.
- Bug reports mask the current credential tokens along with the stored bridge tokens.
