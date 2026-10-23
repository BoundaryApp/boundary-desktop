# 0006 · Calendar connect: an arm64 bridge, event details in approvals, credential mirroring, and a calendar allowlist

**Serves:** [calendar connect spec](../calendar-ux-study/spec.md) (Phases 1–3).
**Status:** R1–R3 and R6 delivered in stack `v0.3.3` · R4 declined · R5 waiting on upstream caldav-mcp · R7 open

## Background

Boundary will let people connect CalDAV calendars from Settings and choose which agents can read or change them. It registers each calendar per agent through the Hermes gateway (`mcp.servers.add`, `mcp.servers.set_api_key`, `reload.mcp`) instead of the stack's account files and `make hermes-reload`. That avoids a restart, and it means only agents with access get the entry and the password. Entries are named `calendar-<slug>`, so `reconcile_caldav_accounts` never removes them.

Every entry is `trust: untrusted`. caldav-mcp annotates its 8 query tools `readOnlyHint: true` and its 6 mutations `false` (`caldav_mcp/tools/queries.py`, `mutations.py`), so Hermes asks before every change and never before a read. Nothing below blocks the design; each item has a Boundary fallback. Checked against the stack at `v0.3.2-79-g4d94149`, the running `hermes` container and caldav-mcp v0.1.1.

## R1 · An arm64 caldav-mcp image, in a tagged release (Wanted)

**Why:** upstream publishes `linux/amd64` only (`CHANGELOG.md`, the Apple Silicon note), so on most Macs the `calendar` profile runs under emulation or needs `DOCKER_DEFAULT_PLATFORM`. Boundary also pins `v0.3.1`, whose compose file still uses caldav-mcp `v0.1.0`; the move to `0.1.1` isn't in a tag yet.

**Ask:** a multi-arch caldav-mcp image the stack pins by tag. caldav-mcp is pure Python with a plain `Dockerfile`, so either the stack builds it (as it does for `llm-proxy` and `opencode-mcp`) or the arm64 build goes into upstream's `docker.yaml` workflow. Then cut a stack release that includes it and caldav-mcp `0.1.1`.

**Acceptance:** on Apple Silicon, `docker compose --profile calendar up -d caldav-mcp` from a tagged release starts a native `linux/arm64` container with no platform override.

**Boundary fallback:** the overlay (`resources/assistant/docker-compose.boundary.yml`) sets `platform: linux/amd64` on `caldav-mcp`. The line goes once R1 is in the pinned tag.

**Answer (20 Oct 2026):** done in `v0.3.3` (`851a4f8`). The stack builds caldav-mcp 0.1.1 from upstream commit `ce880c5` as `${IMAGE_PREFIX}-caldav-mcp:0.1.1`, natively on arm64. `CALDAV_MCP_IMAGE` is gone. Boundary moves its pin to `v0.3.3` and needs no `platform:` line. The image is now built on the user's machine the first time the `calendar` profile starts, so the first connect includes a build.

## R2 · The tool call's arguments in MCP trust-gate approvals (Wanted)

**Why:** when an agent adds an event, the approval card should say what it's adding: "Call with Jordan, Friday 11:00–11:30, Personal › Work". `_trust_gate_check` (`tools/mcp_tool_handlers.py`) asks through `request_elicitation_consent` with the tool and server names only, so the card can say "Hermes wants to add an event to Personal" and nothing more. People would approve changes they can't see.

**Ask:** pass the call's arguments to the approval request as structured data, for example `{ "server": "calendar-personal", "tool": "caldav_create_event", "arguments": { … } }`. Run them through the same redaction and length caps as command previews. This helps every `trust: untrusted` server, not only calendars.

**Acceptance:** the gateway's approval request for `caldav_create_event` on an untrusted server carries the tool name and its arguments (summary, start, end, calendar), and `approval.pending` replays them after a reconnect.

**Boundary fallback:** the card maps the tool name to a verb ("add an event", "move an event", "delete an event", "invite someone") and names the account from the server name. If the gateway's live tool events carry the call's arguments, Boundary pairs the approval with the in-flight call instead. Either goes once R2 lands.

**Answer (20 Oct 2026):** done in `v0.3.3` (`68f2184`), documented in the stack's `docs/extending.md` (MCP approvals for untrusted servers). The approval request and its `approval.pending` replay carry `mcp: { server, tool, arguments, tool_call_id }`, with arguments redacted and capped. `choices` is `["once", "deny"]`. Two different calls get separate prompts. Covered by `scripts/test-mcp-trust-details.py`.

## R3 · Exclusions for `mirror_credentials` (Wanted)

**Why:** an agent set to Off shouldn't hold the calendar password. Boundary creates agents with `mirror_credentials` so they have a model, and that copies the default profile's whole `.env` (minus channel bot tokens) into the new profile, including `BOUNDARY_CALENDAR_*_PASSWORD` keys and anything else saved through `set_api_key`.

**Ask:** a `mirror_exclude` list of glob patterns on profile creation (for example `["BOUNDARY_CALENDAR_*"]`), or a mode that mirrors only the model provider's credentials.

**Acceptance:** creating a profile with `mirror_credentials: true` and `mirror_exclude: ["BOUNDARY_CALENDAR_*"]` gives a `.env` with the model credentials and no matching keys.

**Boundary fallback:** right after creating an agent, Boundary removes `BOUNDARY_CALENDAR_*` keys from its `.env` unless the agent was given access (spec Phase 1, item 4). The cleanup goes once R3 lands.

**Answer (20 Oct 2026):** done in `v0.3.3` (`c3e8c22`). `profiles.create` takes `mirror_exclude: ["BOUNDARY_CALENDAR_*"]`. The planned cleanup is dropped. Covered by `scripts/test-mirror-exclude.py`.

## R4 · A real call in `mcp.servers.test` (Later)

**Why:** Boundary tests a sign-in with its own CalDAV probe from the host. caldav-mcp uses the Python `caldav` library from inside the Compose network, so the two can disagree (a redirect the probe follows and the library doesn't, a proxy, TLS). `mcp.servers.test` only lists tools, and caldav-mcp lists them without credentials, so it can't tell a good sign-in from a bad one.

**Ask:** an optional `call: { "tool": …, "arguments": {} }` on `mcp.servers.test`, allowed only for tools annotated `readOnlyHint: true`, returning the tool's success or error text.

**Acceptance:** `mcp.servers.test` with `call: { "tool": "caldav_list_calendars" }` on an entry with a wrong password returns `ok: false` and the server's error. With a valid password, it returns `ok: true`.

**Boundary fallback:** the host probe at the sign-in step, then `mcp.servers.status` (connected, 8 or 14 tools) as the last step of the checklist.

**Answer (20 Oct 2026):** declined for now. The stack suggests probing from inside the caldav-mcp container instead: `docker compose exec -T caldav-mcp python -`, with the credentials on stdin. That uses the same client and network as the agent, which removes the disagreement this item was about. Boundary adopts it (spec decision 4).

## R5 · A calendar allowlist per account (Later)

**Why:** a single iCloud login often holds shared family calendars and work calendars. caldav-mcp shows agents every calendar on the login (`caldav_list_calendars` lists `principal().calendars()`), so people can't give Hermes their own calendars without the shared ones.

**Ask:** an optional `X-Caldav-Calendars` header (calendar URLs) that limits every tool to those calendars, upstreamed to caldav-mcp or carried as a stack patch. Document it in `docs/calendar.md`.

**Acceptance:** with the header set to one calendar URL, `caldav_list_calendars` returns that calendar only, and `caldav_get_events` on another calendar returns an error.

**Boundary fallback:** the sign-in step lists every calendar the account holds, so people see what agents will see. The list becomes checkboxes once R5 lands.

**Answer (20 Oct 2026):** waiting on upstream caldav-mcp.

## R6 · Keep gateway-registered calendars a supported path (Later)

**Why:** Boundary relies on two current behaviours: the bootstrap skips CalDAV entirely when `CALDAV_MCP_ENABLED` is not set, and `reconcile_caldav_accounts` removes only `caldav-*` entries. A change to either (for example, pruning all CalDAV-looking servers) would silently delete Boundary's calendars on the next bootstrap.

**Ask:** document in `docs/calendar.md` that clients may register their own entries through the gateway under another prefix, and keep reconciliation limited to entries the bootstrap created. A comment on `reconcile_caldav_accounts` saying so would be enough.

**Acceptance:** `docs/calendar.md` describes the gateway path, and with `CALDAV_MCP_ENABLED=1` and an account file present, a bootstrap run leaves a `calendar-test` entry and its `.env` key in place.

**Boundary fallback:** none needed today. Boundary's tests pin the `calendar-` prefix and the env key name.

**Answer (20 Oct 2026):** done in `v0.3.3` (`5ca3bd5`). The stack's `docs/calendar.md` documents the gateway path, says the bootstrap owns only `caldav-*` entries, and `make calendar-test` (`scripts/test-caldav-foreign-entries.py`) checks both the enabled and unset cases. The doc adds one caveat: the bootstrap creates `api-server` by cloning the default profile, once. A gateway entry on the default profile at that moment is copied without its password key and fails to authenticate. Boundary registers calendars only after the first bootstrap, and never on `api-server`.

## R7 · `set_api_key` that keeps an entry's own headers (Later)

**Why:** found in the calendar spike (spec Phase 0, S1 and S5) against `hermes-agent v0.22.2`. `mcp.servers.set_api_key` with an `env_var` writes the value to the profile's `.env`, then replaces the entry's `headers` with `Authorization: Bearer ${VAR}`. A server that takes its secret in another header, as caldav-mcp does with `X-Caldav-Password`, loses all its headers. The call also refuses a server that doesn't exist yet, and `mcp.servers.add` refuses one that does, so there's no gateway order that ends with both the key and the right headers. Separately, `mcp.servers.remove` leaves the entry's key in `.env`.

**Ask:** when the entry already has a header whose value references `${env_var}`, `set_api_key` writes the value and leaves the headers alone. And `mcp.servers.remove` takes an option to delete `.env` keys the entry references.

**Acceptance:** after `mcp.servers.add` with `X-Caldav-Password: ${BOUNDARY_CALENDAR_X_PASSWORD}` and `set_api_key` with that `env_var`, `mcp.servers.list` shows the original headers and the key is in `.env`. `mcp.servers.remove` with the option leaves no `BOUNDARY_CALENDAR_X_PASSWORD` in `.env`.

**Boundary fallback:** Boundary writes the key into the profile's `.env` on disk and the entry with `hermes config set`, as it does for the host bridge, and deletes the key itself on removal. Nothing in Boundary changes when R7 lands, so this is for other clients of the gateway.

## Notes

R1 and R5 are caldav-mcp changes (an image build, a header). R2, R3, R4 and R7 are Hermes patches the stack would carry or send upstream. R6 is documentation.
