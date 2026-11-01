# 0019 · Faster stack start on every launch

**Serves:** app launch time. Boundary starts the stack on each launch and stops it on quit ([updates plan](../updates-plan.md)).
**Status:** Open

## Background

Two launches of rc.13 on Docker, at stack v0.3.7 (`23a9dcc`), took 266.8s in `compose up -d`. The app window appeared at 0.5s, and neither run needed a pull or a build. All other timed services were healthy by 36s. Everything Hermes depends on then reported healthy at about 128s, and Hermes turned healthy at about 266s. Both marks repeated to within half a second, which points at fixed work rather than slow services.

| Time in `compose up -d` | Wait | Likely cause |
| --- | --- | --- |
| 0 to 36s | Other services start and turn healthy | None needed |
| 2 to 128s | `hermes-api-bootstrap` runs | Serial config writes |
| 128 to 266s | `hermes-browser-bootstrap` runs, then Hermes starts and passes its healthcheck | The split isn't measured yet |

The 128s mark is the API bootstrap exiting. Compose only begins Hermes's dependency wait once `hermes-browser-bootstrap` has started, and that service waits for the API bootstrap, so every dependency reported healthy at the same moment. This is read from Compose's `waitDependencies` and start order, not observed directly. On a development Mac with a busier local stack, the two bootstraps ran for 272s and 183s, so the browser bootstrap is likely most of the second stretch. Boundary now logs each bootstrap's end, so later runs will show the split.

The `cont-init` figure comes from that same Mac. A new Hermes container spent 79s in `cont-init`, 70s of it before `019-pin-profile-gateways`, and a restarted one spent about 6s. Boundary now quits with `compose stop`, so most launches restart the container. New containers remain for the first run, stack upgrades and any config change.

Boundary has already shortened the healthcheck intervals in its overlay, so these items are what remains. Please replace these figures with your own if a profile of the scripts shows something different.

## R1 · Don't repeat the bootstrap when nothing changed (Blocking)

**Why:** Compose starts exited one-shots again on every `up` (`startService`, Compose v2.38.2), so the bootstrap runs on every launch even when the containers are kept. `bootstrap-api-profile.sh` runs once per profile and makes dozens of `hermes config set` and YAML calls. Each `hermes config set` is a new Python process, and the writes land on the data bind mount.

**Ask:** make an unchanged bootstrap finish in seconds. Either of these would do:

- Write a stamp under the profile's data directory holding a hash of the bootstrap's inputs (scripts, relevant environment, Hermes image tag), and exit early when it matches.
- Batch each profile's writes into one Python process that loads `config.yaml`, applies them and writes once.

The first gives the larger saving. The second also shortens first run and upgrades. Both together would be ideal.

**Acceptance:** with no change to scripts, environment or image, both bootstrap containers finish in under 5s each on `compose up -d`. Changing an input runs the full bootstrap. If the stack has settings that must be re-applied on every start, it says which ones.

**Boundary fallback:** none today. Boundary could override the bootstrap's `command` in its overlay with its own stamp check, but only the stack knows the full set of inputs, so that risks skipping a needed write.

## R2 · Shorten Hermes's `cont-init` in a new container (Wanted)

**Why:** the first launch, every stack upgrade and any config change create a new Hermes container. The patch scripts then redo their work on the image's files before the gateway starts.

**Ask:** report which `cont-init` scripts account for the time, and apply the patches at image build time if the stack can move to its own derived image. Say what fills the time between `cont-init` finishing and port 9119 answering, since the healthcheck probes the dashboard rather than `/health`.

**Acceptance:** a new Hermes container passes its healthcheck within 45s of starting on an idle Mac, with all patches in place.

**Boundary fallback:** `compose stop` on quit covers ordinary relaunches. New containers stay slow.

## R3 · Gate Hermes only on what it needs at start (Later)

**Why:** `hermes` waits for `service_healthy` on `opencode-mcp`, `lightrag-mcp`, `sql-mcp-ro` and `sql-mcp-rw` among others, and `opencode` waits on `gptr-mcp`. One slow sidecar therefore holds chat. Chat could open before coding or research tools are ready if Hermes picks up an MCP server that arrives late.

**Ask:** confirm how Hermes treats an MCP server that is down at gateway start. If it reconnects, relax these gates to `service_started`, and drop `opencode`'s wait on `gptr-mcp` if it's only a registration.

**Acceptance:** with `gptr-mcp` stopped, Hermes turns healthy and connects to it once it starts, with no Hermes restart.

**Boundary fallback:** Boundary's overlay keeps the shorter probe intervals, at the cost of more probes while the stack runs.
