# 0029 · A hosted Twenty whose MCP lists every record tool, and a guardrail stop clients don't see

**Serves:** Twenty workspaces connected from Boundary ([shared services spec](../shared-services-ux-study/spec.md)); chat turn endings.
**Status:** R1–R2 in stack 0.3.14 (67d752a) · R3 in 0.3.15: the overlay `patch-guardrail-halt-stream.py` streams the stop note as `message.delta` · Boundary maps `no_catalog`

## Background

`docs/crm.md` ("What Hermes sees") says Twenty's MCP lists seven tools, whatever the workspace holds: `get_tool_catalog`, `learn_tools`, `execute_tool`, `list_object_metadata_names`, `list_skills`, `load_skills` and `search_help_center`. `addons/twenty/addon.json` lists and pins the same seven. The bootstrap writes no `tools.include` for instances (`compose/hermes/bootstrap-api-profile.sh`, above `addon_instances_plan`), because the role on the API key is the boundary.

A hosted workspace connected with `crm.sh add` on v0.3.13 lists something else. Hermes registered 309 tools for it (`MCP server 'crm-<slug>' (HTTP): registered 309 tool(s)` in `agent.log`):

- `list_object_metadata_names`, `list_skills`, `load_skills` and `search_help_center` are there.
- `get_tool_catalog`, `learn_tools` and `execute_tool` are not.
- Record and action tools are listed directly: `find_many_*`, `create_one_*`, `group_by_*`, `send_email`, `draft_email`, `create_complete_dashboard`, and 47 `delete_*` or `destroy_*` tools.
- Eight names are longer than 64 characters with the `mcp__crm_<slug>__` prefix, and Hermes logs `exceeds the 64-char provider limit` for each. Hermes also logs `suspicious description content` for `create_complete_dashboard`.

The server's Twenty version is unknown. The local instance is pinned at `twentycrm/twenty:v2.55.0`.

On a local model (qwen3.6-35b-a3b), two chat turns on the default profile asked for prospects in that workspace. Each ran `list_object_metadata_names`, `list_skills` and `load_skills` over and over, never reached a record tool, and stopped on the tool-loop guardrail (`tool_loop_guardrails.hard_stop_enabled`) after three identical calls. A possible cause is that the skills point to catalog tools this server doesn't have. That hasn't been checked against the skills' text.

The pins in `tools.tool_search.always_include` name three tools this server doesn't have, and none of the record tools.

## R1 · Handle a Twenty MCP that lists record tools directly (Wanted)

**Why:** the stack's Twenty support assumes the seven-tool catalog surface. On a server without it, an agent gets 309 tools, unpinned, with no way to reach records through the pinned path.

**Ask:** decide what a Twenty instance registers when its server lacks `get_tool_catalog`/`execute_tool`. Some options:

1. Register it with a `tools.include` of the read tools (`find_*`, `group_by_*`, `list_*`, `search_*`) plus, on a write instance, the write tools the manifest names, and pin the read tools.
2. Refuse the workspace at `crm.sh add` with a message naming the missing catalog tools and the server's tool count.
3. Keep registering everything, but document the case in `docs/crm.md` and leave the choice to the key's role.

**Acceptance:** with a server that lists the 309 tools above, the chosen behaviour holds after both bootstraps run, and `make doctor`'s Twenty check reports the server's tool count and whether the catalog tools are present.

**Boundary fallback:** none. Boundary shows the guardrail's stop note (R3) so the user sees why a turn ended.

> **Stack reply (fixed on stack main at 67d752a, unreleased):** the hosted server has the
> catalog tools. Twenty 2.56 changed what bare `/mcp` returns: from 2.56 on it lists every record
> tool, and `?mode=meta` returns the seven-tool catalog. 2.55 (the local pin) treats `?mode=meta`
> as its default, so one URL works on both. A local `TWENTY_IMAGE` past 2.55 would have hit the
> same thing, and the skills-text theory is moot.
>
> None of the three options: the stack registers each workspace at `<url>/mcp?mode=meta`, and the
> next bootstrap run rewrites existing `crm-<slug>` entries. Seven pins, no `tools.include`, and
> the key's role is still the boundary. `crm.sh connect` and `crm-add` list tools at `?mode=meta`
> with one key and fail with a new error, `no_catalog` (exit 4 in JSON mode, in the manifest's
> `instances.errors`), when a catalog tool is missing. When the list can't be read they warn and
> go on. `make doctor` prints each workspace's tool count and whether the catalog tools are there,
> as a FAIL when they aren't. Live-checked on Twenty 2.57.1: bare `/mcp` listed 237 tools (rw) and
> 125 (ro), `?mode=meta` listed 7 on both, and records came back through `execute_tool`.
>
> **Boundary:** `connectTwentyWorkspace` maps the `crm.sh add` message to `no-catalog`, and the
> connect sheet says the server doesn't list the tools agents use. Dormant until the pin moves
> past v0.3.13.

## R2 · Check tool names against the 64-character limit (Later)

**Why:** a name over the limit gets a warning in the log and nothing the user sees.

**Ask:** have `crm.sh add` (or the doctor check) list a workspace's tool names that are too long once prefixed, and say what Hermes does with them.

**Acceptance:** adding the workspace above prints the eight names.

**Boundary fallback:** none.

> **Stack reply (fixed on stack main at 67d752a):** Hermes doesn't drop over-long names. It cuts
> them to 55 characters plus `_` and 8 hex digits of the name's SHA-256, and the tool stays
> callable. With `?mode=meta` the long record-tool names don't appear. The bug was in the
> bootstrap's pins, which used the uncut name, so a slug of 28 or more characters left the
> `list_object_metadata_names` pin matching nothing. Pins now apply the same cut, and no listing
> was added to `crm.sh add`.

## R3 · A guardrail stop arrives only in `message.complete` (Later)

**Why:** when the tool-loop guardrail halts a turn, `agent/turn_tool_round.py` sets the stop note as `final_response` and streams it only when the stream isn't held. `tui_gateway/prompt_turn.py` then sends it as the completion's `text`. A client that builds the reply from `message.delta` alone shows an empty turn. Boundary did, as "<agent> finished without a reply".

**Ask:** say whether `message.complete.text` is the reply a client must show when no deltas arrived, and note it in the gateway contract. If it should also stream, that's a Hermes change upstream rather than a stack one.

**Acceptance:** the gateway docs state the rule.

**Boundary fallback:** built. `unstreamedFinalText` in `hermesChatSessions.ts` shows a completed turn's `text` when nothing streamed, skipping error and interrupted turns and replies marked `response_previewed`. It stays even once R3 is answered, since it follows the rule either way.

> **Stack reply:** `message.complete.text` is the reply a client shows when no `message.delta`
> arrived, unless `response_previewed` is true. A bot-mode session sends `text: ""` when it
> withheld a silence marker: keep the streamed text then. `response_transformed: true` means
> `text` replaces what streamed. Documented in the stack's docs/hermes.md, "The reply a client
> shows". `unstreamedFinalText` matches the rule.
>
> The guardrail stop goes unstreamed only when `_hold_stream` is set, which needs a plugin with a
> `hold_stream` transform, and this stack loads none. On the default profile the stop note should
> have arrived as a `message.delta`, so something else made those turns look empty.
>
> **Stack follow-up (cause found from code):** the dashboard gateway
> (`tui_gateway/prompt_turn.py`) passes its `message.delta` emitter as `stream_callback`, which
> `turn_context.py` stores as `agent._stream_callback`. Gateway agents never set
> `agent.stream_delta_callback`. Model text still streams because
> `_deliver_to_stream_callbacks` (`agent/stream_delivery.py`) calls both callbacks, but the
> guardrail halt in `agent/turn_tool_round.py` calls only `stream_delta_callback`, which is None on
> a gateway turn. So every guardrail stop over the dashboard gateway arrives only as
> `message.complete.text`, on Hermes v0.22.7 and v0.23.1 alike. The upstream fix is to send the
> halt text through `agent._deliver_to_stream_callbacks`. Whether to file it upstream, and to add a
> stack overlay meanwhile, waits on the owner's decision. `unstreamedFinalText` stays either way.
