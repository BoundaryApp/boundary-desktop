# Credential handling plan

- Date: 2026-10-02, revised 2026-10-03 and 2026-10-06
- Status: In progress
- Related: [ADR 0006](adr/0006-tool-approval-interrupt.md), [ADR 0015](adr/0015-inference-provider-slots.md)

## Goal

Users can give agents credentials to act on their behalf, and:

1. The model never sees the raw value.
2. The value is encrypted at rest wherever Boundary stores it.
3. The agent's own tools can't read credentials they weren't given.
4. The user can see which agent holds what, and revoke it.

Judge every item below against the threat model. Security work that doesn't reduce a real risk is friction.

## Threat model

Everything runs on the user's own machine, so the attacker that matters isn't on the network. It's **content the agent reads**: a web page, a search result, an email, a calendar invite, a Signal message, a README in a repo. That text tells the model to read something and send it somewhere. It takes three things together:

1. Untrusted text reaches the model (web search, browser, calendar, Signal).
2. The agent can read secrets (shell and file tools).
3. There's a way to send data out (internet, web fetches, `send_message`, git push, webhooks).

The stack has all three. **Accidents are more common than attacks:** a user pastes a key into chat, the agent prints a `.env` into the transcript, commits a key to a repo, or a key ends up in a log.

What's at stake:

| Asset | Value | Notes |
|---|---|---|
| Stack-internal passwords (Neo4j, n8n, dashboard, proxy admin) | Low | Only reachable on loopback once ports are bound there |
| Model API key, local inference | None | A placeholder |
| Model API key, cloud (e.g. OpenRouter) | Account spend | A per-key credit limit on the provider caps this better than any plumbing |
| User credentials the agent uses (CalDAV, Signal session, Buzz keys, vault logins, skill API keys) | High | Real accounts |
| `.env` files and keys in the user's own projects in the workspace | High | **Probably the largest exposure.** Secrets plumbing doesn't cover it; only shadowing those files does |
| Everything the agent reads, with cloud inference | High (privacy) | Files, memories, calendar data and any secret the agent opens go to the provider. For most users this matters more than a stolen key |

What changes with cloud inference: the key becomes worth stealing, everything the agent reads leaves the machine, and capable models follow injected multi-step instructions better (they also resist them better).

Out of scope: an attacker who already runs code as the user on the host, and a malicious Hermes plugin or skill. Plugins and skills run inside Hermes, and Hermes leaves those to operator review.

## Done

What shipped:

- The model key no longer appears in host argv when Boundary runs `hermes config set`, and errors are redacted (`hermesConfigSetExec.ts`).
- **Credential prompt.** Hermes's `secret`, `vault.unlock_prompt`, `vault.save_login` and `vault.code` requests show a masked card in the ADR 0006 slot.
  - The value goes renderer → main → WebSocket once and is never logged.
  - The renderer event never carries a value.
  - With no window to ask, main answers "skipped".
  - Code: `hermesCredentialRequests.ts`, `CredentialInterrupt.tsx`.
  - This matters most for the commonest real leak: without it, users paste keys into chat.
- **Passwords & Logins (2026-10-06).** Settings → Passwords & Logins manages each agent's Hermes vault: list, add, replace and remove website logins, and unlock or lock 1Password and Bitwarden. Design study: [passwords-logins-study](passwords-logins-study/index.html).
  - Main calls `vault.list`, `vault.add`, `vault.remove`, `vault.sources`, `vault.unlock` and `vault.lock` on the gateway, scoped to the agent's Hermes profile. Passwords go renderer → main → WebSocket once and are scrubbed from error text.
  - The add form resolves site names and pasted URLs to the exact sign-in origin, and warns when a known site's form lives elsewhere (`linkedin.com` vs `www.linkedin.com`). Hermes fills only on the exact origin it saved.
  - Hermes has no update call, so Replace password adds the new login before removing the old one.
  - After a login is saved from chat, the thread links to it in Passwords & Logins.
  - Code: `hermesVault.ts`, `PasswordsLoginsPanel.tsx`, `vaultSites.ts`.
  - This is the first piece of the Credentials page (item 9). Cards and addresses, which the vault also stores, aren't on the screen yet.
- **Browser sign-in fix (2026-10-06).** Agent sign-ins failed because `browser_exec` couldn't start. browser-harness keeps its daemon sockets under `$HOME`, which is the `data/hermes` bind mount. A socket left there survived Docker Desktop VM restarts (and a Mac reboot), after which the container could neither connect to it nor delete it (EOPNOTSUPP on virtiofs). `BH_RUNTIME_DIR=/tmp/browser-harness` keeps the sockets on the container's own disk. The stack sets it from `259fd1f` (Boundary's overlay set it until the pin moved there).
  - The stack also adds a `browser-login` skill (open the sign-in page, check the vault, then fill or save) and a tool-eval case for that order. New Boundary agents' SOUL says the same; drop that once every supported stack ships the skill.

## Upstream stack state (2026-10-03, updated 2026-10-06)

The stack (`kaxline/sovereign-agent-stack`) committed the following and now tags releases with a CHANGELOG: `v0.1.0` is `259fd1f`, `v0.2.0` is `d094bdf`, `v0.3.0` is `0fd3bef`, `v0.3.1` is `3559c4d`, `v0.3.3` is `10a6f6e`, `v0.3.4` is `0c34fd2`, `v0.3.6` is `ad7717d`, `v0.3.7` is `23a9dcc`. Boundary pins `v0.3.7` (see item 5). `docs/extending.md` documents how a second copy like Boundary's runs (`CONTAINER_PREFIX`, `IMAGE_PREFIX`, port variables, volume merges by container path).

- **Per-service environment.** The root `.env` is never mounted into a container. Each service lists the variables it reads, and published ports are bound to `127.0.0.1`.
- **`hermes-worker`.** An SSH-only Alpine container with no secrets and no `data/hermes`. Every profile gets `terminal.backend: ssh`, and `env_passthrough` is cleared. Terminal, file tools and `execute_code` run there.
- **`llm-proxy`.** Holds the model keys. Inference is reachable only inside the compose network, and clients send the placeholder `local-llm`. The admin API on `127.0.0.1:4001` is behind `LLM_PROXY_ADMIN_TOKEN` and only changes memory.
- **CalDAV passwords.** `config.yaml` holds `${CALDAV_<SLUG>_PASSWORD}`, and the value lives in the profile `.env`.

Remaining gaps:

- ~~**The worker can't be turned off.**~~ Resolved upstream: `HERMES_TERMINAL_BACKEND=ssh|local` picks `compose/hermes/terminal-<backend>.yml`. `local` defines no worker and keeps workspace mounts on `hermes`.
- ~~**The proxy still loads keys from the root `.env` at startup.**~~ Resolved: since v0.3.0 the proxy starts without a key, reports restarts (`boot_id`) and can hold routes until a push (`LLM_PROXY_AWAIT_PUSH`). Boundary keeps the key off disk (item 7, ADR 0026).
- **One chat route.** All profiles and chats share one upstream.
- **Inference has no client auth.** Any container, including the worker, can spend on the key.
- **Parent-folder workspace.** If the workspace contains the stack itself, the worker can read the stack's `.env`, its own SSH key and `data/hermes`. This is the case in the developer's own setup, though not in Boundary's. Secret shadowing covers OpenCode only.
- **Unrestricted egress.** The worker can still reach the internet.

### SSH worker benchmark (2026-10-03)

Method: the real Hermes `LocalEnvironment` and `SSHEnvironment` classes from image `v2026.9.14`, run against a fresh worker built from the stack's image. The test tree had 500 files. This was a separate compose project; the live stack wasn't touched.

| Operation (p50) | Local | SSH worker |
|---|---|---|
| Environment start | 237 ms | 160 ms |
| Run a command | 6 ms | 14 ms (p95 15 ms) |
| `read_file` | 0.8 ms | 15 ms (p95 26 ms) |
| `write_file` | 30 ms | 45 ms |
| `search_files` by content | 63 ms | 43 ms |
| `search_files` by name | 11 ms | 55 ms |
| Command after a 5.5 s idle gap (file sync due) | 16 ms | 22 ms |

**Speed: not a problem.** SSH adds about 8–45 ms per tool call, against model turns that take seconds.

**Missing tools: the real cost.** The worker image has only `bash`, `tar`, `grep` and `find`:

- No `python3`, so `execute_code` fails.
- No `git`, so the agent can't use git in the workspace.
- No `rg`, so search falls back to slower grep and find.
- No `node` or browser, so the browser tool breaks if Hermes places it on the backend. Under ssh, Hermes's `auto` placement probably does that, though the stack's docs say the browser stays in `hermes`. This needs a live check.

All of these are fixed by adding packages to the worker image.

## Work, in priority order

### Now (Boundary only, no upstream dependency) — done 2026-10-03, except 4

1. **Credential-prompt follow-ups — done.** A thread asks main for prompts still waiting whenever it mounts or changes chat (`hermes-chat:credential-pending`). Prompts aren't filtered by session, because the renderer holds stored ids and Hermes sends runtime ids; approvals work the same way. A live-stack test is still due before release.
2. **No raw secrets to the renderer (E, F, G) — done.**
   - Provider drafts return a masked `boundary-stored-secret:` token (`storedSecretToken.ts`). The form sends it back unchanged, and main resolves it in every handler that takes form values: discover, list deployments, list models, start setup, adopt endpoint.
   - Scraped account API keys are encrypted in memory and dropped from creation results, which had been logged and saved to tasks. The Credentials tab shows a preview, and Copy writes to the clipboard from main.
   - The install log no longer prints env values, and the Credentials tab copy now matches what is stored: memory only, until quit.
3. **Cloud inference disclosure — done.** First-run setup, the Settings OpenRouter card and the chat inference menu say that messages and anything the agent reads go to the provider. Settings suggests a credit limit. The menu no longer labels OpenRouter "on this machine".
4. **Credential mirroring (D) — re-scoped, not changed.**
   - What `mirror_credentials` actually does: it copies the default profile's whole `.env` (minus channel bot tokens), `auth.json` and model into each new agent. That `.env` includes CalDAV passwords and keys saved through the credential prompt.
   - Turning it off leaves the new agent with **no model**. Boundary would have to configure each new profile's model itself, and in local-stack mode it skips the `compose exec` path it would use.
   - The gain is small: all profiles live in the same `/opt/data` and the same Hermes process, and the worker can read none of them.
   - Move it to the Credentials page (item 9), where giving each agent its credentials and model is designed properly. After the proxy lands, the model part is just a placeholder key and base URL.

### After the stack commits and tags a release

5. **Bump the pin and rework the overlay.** Audited against `259fd1f` on 2026-10-06. Blockers first:
   - ~~**Moving the pin deletes user data.**~~ Fixed 2026-10-06 (`projectTreeSwap.ts`). On a ref change Boundary stops its containers by Compose project label, stages the new tree beside the old one, carries `data/` and the generated secrets across (`PRESERVED_PROJECT_PATHS`), swaps the trees and keeps the old code as `project.previous`. A journal (`.upgrade.json`) lets the next launch finish an interrupted swap. setup.sh then re-runs over the kept `.env`. Still needs an upgrade test from a real `edf2465` install.
   - ~~**Container names and ports.**~~ Done 2026-10-06: `boundary-llm-proxy` and `boundary-opencode-mcp` (plus `boundary-caldav-mcp`), Boundary-specific image tags for the two new builds, and the proxy admin port (4001, or 14001 when offset) in the port logic. `hermes-worker` isn't defined with the local backend.
   - ~~**`python3` on the host.**~~ Done: `runSovereignSetup` checks for Python 3.9+ before `setup.sh` and says how to install the Command Line Tools.
   - ~~**The hermes volume list.**~~ Done: the overlay no longer uses `volumes: !override` on the Hermes services. Compose merges volumes by container path, so Boundary lists only its data-path mounts and every upstream mount (patches, cont-init scripts, the terminal fragment) comes through. The generated `docker-compose.projects.yml` now lists only project binds and is rewritten before each start. `HERMES_TERMINAL_BACKEND=local` for now; verified with `docker compose config` against `259fd1f`.
   - ~~**Boundary's own `05-patch-text-tool-call`.**~~ Removed with `BOUNDARY_HERMES_PATCHES_DIR`; upstream's `05-patch-tool-calling` runs instead.
   - **Existing bugs fixed on the way:** the overlay mounted files that don't exist at `edf2465`, so those patches never ran in the shipped app (the bump turns them on for the first time; test accordingly). Host-folder project binds were written as `"path":/opt/projects/slug`, which isn't valid YAML, so any host-folder project broke compose.
   - **Pinned to `259fd1f` (2026-10-06).** Still to verify on a real machine: first run, an upgrade from `edf2465`, and a model change (which now also recreates `llm-proxy`).
   - **Pinned to `v0.3.7` (2026-10-30).** Same images as v0.3.6 apart from llm-proxy, which the pin change's `up -d --build` rebuilds. `setup.sh` and `sync-buzz-profile.sh` run under macOS's `/bin/bash` 3.2 again (change request 0016), so installs and upgrades no longer fail as they did on rc.6, and `setup.sh` writes the n8n credentials itself under 3.2. On an install that hasn't configured Buzz, `sync-buzz-profile.sh` no longer writes `platforms.buzz.enabled: false` to the `browser` and `api-server` configs; pins already written stay. The proxy's fallback upstreams are off until configured, and `llmProxyAdmin.ts` ignores the new `fallbacks` field. Rendered against the v0.3.7 tree with Boundary's overlay and profiles, the only change is `LLM_CONNECT_TIMEOUT` and `LLM_PROXY_FALLBACKS_FILE` on `llm-proxy`. Still to verify on a real machine: a first install and an upgrade from a v0.3.6 install from a packaged build.
   - **Pinned to `v0.3.6` (2026-10-29).** Same Hermes Agent and WebUI as v0.3.4. v0.3.5 adds the dashboard's one-time sign-in route (`/auth/handoff`, change request 0012), and its `setup.sh` writes `HERMES_DASHBOARD_HANDOFF_SECRET` into `.env`. The pin change re-runs `setup.sh`, which fills the key in on upgraded installs too, so **Open in browser** on the Tasks pane signs in without the dashboard password. v0.3.5 also builds OpenCode from 1.17.6 instead of `latest`, so the pin change's `up -d --build` can move an install that built a newer `latest` back to 1.17.6. v0.3.6 adds the opt-in `multiplex` gateway topology and the `messages` profile; Boundary keeps `standalone` and doesn't enable `messages`. Rendered against the v0.3.6 tree with Boundary's overlay and profiles, the service list is unchanged; `hermes` gains nine overlay mounts and the topology, handoff and `TMPDIR` variables, and `hermes-worker` is identical. `gateway-compat-proxy` exits under `standalone`, so 8643 and 8644 stay with their own gateways. Still to verify on a real machine: a first install, an upgrade from a v0.3.4 install, and **Open in browser** landing on the board signed in.
   - **Pinned to `v0.3.4` (2026-10-25).** Hermes Agent v0.22.5 with WebUI 0.52.492, mcp-searxng 2.7.0, SearXNG 2026.10.24, and a hermes-worker on alpine 3.24. The new `005-remap-hermes-uid` cont-init sets the hermes uid and gid without `usermod`, whose chown of the `data/hermes` bind fails on Docker Desktop and left a newly created `hermes` container with setup half done (no `API_SERVER_KEY`, no skills sync) until a restart. Boundary needs no code change for it: `stackImagePins.ts` moves both Hermes image tags from the new `.env.example`, and the pin change's `up -d --build` rebuilds the worker and recreates `hermes` after it, so `hermes` adds the worker's new SSH host keys to `known_hosts` when it starts. Nothing in Boundary uses the control socket path, `sessions.auto_prune` or the searxng MCP endpoint that changed. Rendered against the v0.3.4 tree with Boundary's overlay, all 8 core services resolve. Still to verify on a real machine: a first install and an upgrade from a v0.3.3 install.
   - **Pinned to `v0.3.3` (2026-10-21).** Hermes Agent v0.22.2 with WebUI 0.52.458, n8n 2.43.7, LightRAG v1.5.7, and the gateway overlays change request 0006 asked for (`mirror_exclude`, call arguments in MCP approvals, a native arm64 `caldav-mcp`). setup.sh never rewrites an image key already in `.env`, so after setup.sh Boundary now sets every `*_IMAGE` / `*_IMAGE_TAG` key to the new tree's `.env.example` and drops the ones it no longer lists (`stackImagePins.ts`); without that, an upgraded install would keep Hermes v2026.9.14, which the v0.3.3 overlays no longer patch. Before swapping trees, Boundary copies `data/hermes`, `data/n8n`, `data/rag_storage` and `data/neo4j` to `assistant-stack/backups/data-at-<old ref>` (APFS clones, newest backup only; `stackDataBackup.ts`), since n8n 2.x migrates its SQLite store forward on first start. The overlay binds `n8n-import`'s `/home/node/.n8n` to `data/n8n` like `n8n`'s, and drops the `postgres` override (that service moved to the `n8n-postgres-legacy` profile; stopping by project label removes the old container). `prompt.submit` no longer sends `profile`: the gateway now refuses one that differs from the session's (`4081`), which room turns did by naming each member's profile on a default-profile session. New agents are created with `mirror_exclude: ["BOUNDARY_CALENDAR_*"]`. llm-proxy and `lightrag-mcp` are rebuilt by the pin change's `up -d --build`, and Boundary already writes `model.max_tokens` to the profiles it creates (`hermesProfileLimits.ts`). Rendered against the v0.3.3 tree with Boundary's profiles, all 17 services resolve. Still to verify on a real machine: an upgrade from a v0.3.1 install.
   - **Pinned to `v0.3.1` (2026-10-07).** The gateway contract declares `history_budget` on `session.create` / `session.resume` and the `history_*` reply fields. On v0.3.0, Hermes v2026.9 refused the budget with `4000` and Boundary's fallback ran every DM with no budget, so this is the first pin where the DM horizon line appears. Boundary now retries without the budget only on that refusal, and logs it. Compose only gains three read-only `/bootstrap` mounts on `hermes`; rendered against the v0.3.1 tree with every profile, all services resolve and the mounts come through. The pin-change path (setup.sh, one `up -d --build`) covers the upgrade steps. `npm run test:hermes:live` checks the budget is accepted first time against a running stack. Also in this release: re-prompts for reasoning-only replies holding malformed tool-call markup and for replies asking for a password in chat, `browser_exec` hints and trailing-expression values, and `browser_vault_save_login` pointing at `browser_vault_fill`.
   - **Pinned to `v0.3.0` (2026-10-06).** Adds the proxy's `boot_id`, `pushed` and `LLM_PROXY_AWAIT_PUSH`, streaming fixes, and per-profile stale-stream and auto-title settings. Compose only gains environment variables, so the overlay is unchanged; rendered against the v0.3.0 tree with every profile, all 18 services resolve. The proxy image is built locally, so after any pin change Boundary runs one `up -d --build` (tracked as `imagesBuiltRef` in the provision marker); unchanged images come from the build cache.
   - **Pinned to `v0.2.0` (2026-10-06).** Container names and image tags come from `CONTAINER_PREFIX=boundary-` and `IMAGE_PREFIX=boundary-assistant` in the compose environment, and host-only ports from the stack's own variables. The overlay keeps only data mounts, the Hermes and LightRAG publishes (their port variables are also read in the container) and OpenCode's settings. Rendered against the v0.1.0 setup in offset-port mode, the only differences are the Neo4j container name (`boundary-lightrag-neo4j`), OpenCode's own image tag and three empty proxy key-file variables.
   - **SSH worker (2026-10-06).** `HERMES_TERMINAL_BACKEND=ssh`: shell, file and `execute_code` tools run in `boundary-hermes-worker`, which has no secrets, no published port and no `data/hermes`. The generated overlay gives the worker the host-folder project binds read-write and the context roots read-only, gives hermes read-only project binds for `projects.list`, and pre-creates `data/projects/<slug>` because hermes's `/opt/projects` is read-only. Adding a folder recreates the worker with hermes. A missing worker key is regenerated before start. Verified with `docker compose config`; still to check live: `execute_code`, git, the browser (stays in hermes), writes to project folders, and that the worker can't read saved credentials. Local-stack mode still writes context-root binds onto `hermes` in the sibling checkout's override, which is wrong under its default ssh backend.
   - Then, as before:
   - Rename the `llm-proxy` and `hermes-worker` containers to `boundary-*`, and give the admin port a Boundary port.
   - `hermes`: add the worker-key mount, `09-install-worker-key` and `/opt/projects:ro`; drop the workspace mount.
   - The worker gets Boundary's workspace.
   - `hermesProjectsOverlay.ts` adds project folders to `hermes`; move them to `hermes-worker`.
   - Coordinate with the overlay patch-mount fix.
6. **Drive the proxy from Boundary — done 2026-10-06.**
   - A model change pushes the endpoint and key to `POST /admin/upstreams` (chat and LightRAG routes) with `LLM_PROXY_ADMIN_TOKEN` from the stack `.env` (setup.sh generates it). No proxy restart. If the push fails, Boundary recreates the proxy, which reads `.env`.
   - Hermes profiles get `provider: custom`, `base_url: http://llm-proxy:4000/v1`, the model and the placeholder key `local-llm`, matching the stack's bootstrap. This also overwrites the real key earlier Boundary versions stored in each profile. OpenCode's `opencode.local.json` gets the same proxy URL and placeholder.
   - Retired `.env` lines (`OPENAI_*`, `FAST_LLM`, `SMART_LLM`, `STRATEGIC_LLM`) are removed; `OPENAI_API_KEY` held a copy of the real key. In local-stack mode these lines are left alone.
   - Per-chat slot overrides still run the full apply (push plus Hermes restart), so switching slots works through the one proxy route.
   - Code: `llmProxyAdmin.ts`, `applyLlmConnectionToHermes`. Still to check live: chat on a local model and on OpenRouter, a slot switch, LightRAG and GPT Researcher answering after a switch.
7. **Stop writing the key to disk (A) — done 2026-10-06.**
   - A Boundary-managed stack's `.env` keeps blank `LLM_BINDING_API_KEY` and `LIGHTRAG_LLM_BINDING_API_KEY`. The proxy starts without a key, and Boundary pushes it on every launch and model change, so it lives only in the proxy's memory and in Boundary's encrypted store.
   - On start, Boundary blanks a key an older version left in `.env`. If the stack is already running, it recreates `llm-proxy` once so `docker inspect` no longer shows the key; the launch push then gives it back.
   - While Boundary runs, `llmProxyKeyKeeper.ts` checks the proxy every 30 s and pushes again when a route lost its key or points elsewhere (proxy crash, Docker restart, a compose recreate). If a push fails right after a recreate, Boundary retries for about 10 s, then leaves it to the keeper.
   - Trade-off: when Boundary isn't running, a restarted proxy has no key until Boundary next starts. Hermes's messaging gateways and scheduled jobs can't reach a keyed model in that window. Accepted for now; see decision 5 and [ADR 0026](adr/0026-model-key-lives-in-proxy-memory.md).
   - Local-stack mode is unchanged: Boundary doesn't drive the developer's proxy, so it still writes the key to that `.env`.
   - Follow-up from the stack developer's review (2026-10-06): Boundary uses the proxy's `boot_id` and `pushed` to tell when to push again, sets `LLM_PROXY_AWAIT_PUSH=chat,lightrag`, sets `model.model` and the stale-stream timeout on every model change, and leaves tool-use enforcement at `auto`. The proxy features shipped in stack v0.3.0, which Boundary pins (item 5). See ADR 0026 decisions 2, 4 and 5.
8. **Verify on the managed stack:** `execute_code`, the browser, git, writes to project folders, and credentials saved through the prompt staying unreadable from the worker.

### Next release

9. **Credentials page (Phase 5, in scope).** A list backed by `safeStorage` showing each credential, which agent profiles hold it and when it was last pushed, with Revoke. It includes giving each new agent its credentials, replacing Hermes's copy-everything mirroring (item 4).
   - Website logins are done: Passwords & Logins (see Done). The rest of the page (model, skill and MCP keys) can sit beside it in Settings.
   - The model key is revoked through the proxy admin API.
   - Skill and MCP keys go through Hermes RPC (`mcp.servers.set_api_key`, `model.disconnect`).
   - Smaller than first planned: optional password-manager references (`op://`) are deferred.
10. **Outbound actions.** Require approval, or at least clear visibility, before the agent sends data out: messages, webhooks, git push, requests to unknown hosts. Per the threat model, this reduces more risk than further secrets plumbing.
11. **Account-creation draft (I).** Move it into `safeStorage` or drop draft saving.

### Dropped or deferred

- Hermes's Docker terminal sandbox. It needs the container socket, which defeats the isolation.
- `model.save_key`: superseded by the proxy.
- Per-client inference tokens and egress policy as asks to the stack. Revisit if unattended use grows.
- Enforcing `.boundary-security-policy.json` (H). Stop writing it instead, since nothing reads it.

## Asks for the stack developer

Framed as general improvements; Boundary is one consumer. In priority order:

1. **Commit and tag a release with a changelog**, so downstream users can pin a version.
2. **Let the proxy start without keys.** Read keys from the admin API, or from a file or command at startup (`*_FILE` / `/run/secrets`). This helps password-manager users and makes rotation clean.
3. **A full worker image.** `python3`, `git`, `rg`, and either a browser or a pinned `bot_desktop.placement: gateway`, so the agent works the same with the worker on.
4. **A switch for the worker** (e.g. `HERMES_TERMINAL_BACKEND=ssh|local`), defaulting to ssh. It helps debugging, setups without the worker, and anyone who measures and decides they don't need it.
5. **Shadow workspace secrets for the worker**, the way OpenCode's are, and have `make doctor` warn when the workspace contains the stack itself.
6. **A stable integration surface.**
   - Container names and ports from variables.
   - A documented extension directory for patches and mounts, so customising the stack doesn't mean replacing its volume list.
   - Setup that works with Podman, macOS bash 3.2 and no host `node`, with a machine-readable `--json` mode.
   - The proxy admin API documented as a supported interface.
7. **Named proxy routes**, so one stack can use local and cloud models at once.

## Decisions

1. **2026-10-02:** a key visible through `docker inspect` is acceptable for now. *Superseded 2026-10-06 by item 7: the proxy starts without a key.*
2. **2026-10-03:** containment comes from the stack's SSH worker, not Hermes's Docker sandbox. The benchmark shows SSH speed is fine. Keep the worker on by default once its image has the tools above.
3. **2026-10-02:** the Credentials page is in scope for the next release.
4. **2026-10-03:** further secrets plumbing gets prioritised against the threat model. Outbound-action control and cloud-inference disclosure come ahead of more proxy features.
5. **2026-10-06:** the model key stays off disk and lives only in the proxy's memory. Known gap: while Boundary is closed, a restarted proxy has no key, so gateways, scheduled jobs and WebUI fail until Boundary opens. The key-file route is the fallback if that bites. See [ADR 0026](adr/0026-model-key-lives-in-proxy-memory.md).
