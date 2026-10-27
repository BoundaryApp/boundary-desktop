# 0031. Checks on the stack contract and on drift

- Date: 2026-10-27
- Status: Proposed
- Parent: [0001](0001-record-architecture-decisions.md)

## Context

Boundary's type check, unit tests and lint run in CI on every build, and they pass. A review of the codebase, and then the first runs of the refactored app against a real agent stack, found failures those checks can't see. They fall into four groups.

**Assumptions about the stack.** Boundary depends on the stack's ports, HTTP endpoints, gateway methods and events, and on the Hermes `config.yaml` keys it writes. Unit tests replace all of these with fakes, which encode what Boundary believes, not what the stack does. Three failures came from that gap:

- Boundary wrote its platform hint to `agent.platform_hints.boundary`, the key the stack's docs give. Hermes reads `platform_hints` at the top level and refuses the nested key by calling `sys.exit(1)`. The hint had never reached a model.
- The in-container program that writes Hermes settings caught `Exception` but not `SystemExit`, so that one refused key stopped the stack from starting, and the error carried no detail.
- Hermes's default `smart` approval mode lets a guardian model run low-risk flagged commands without asking, which a test plan assumed it wouldn't.

**Drift inside the codebase.** Unused exports and files, copies of the same helper that had drifted apart (some into user-visible bugs), and IPC channels typed on one side only built up over months. Each was found by a one-off scan, not by a check that runs again.

**Behaviour only the assembled UI shows.** A room post that woke no agent left an empty reply on screen, and a settings write in the background sent the app back to its start-up screen. The unit tests of the pieces involved passed; the bug was in how the chat runtime and app lifecycle used them.

**Missing evidence.** Chat turns write nothing to the debug log, so whether a turn ran at all could only be inferred from the code.

## Decision

1. **A stack contract test suite.** `bun run test:stack` runs against the pinned Hermes image and a running stack, in the pattern of the existing live tests. It is not part of the default test run or CI. It checks, for each dependency:
   - every `config.yaml` key Boundary writes, through Hermes's own key validation;
   - the settings program, run in the container against a temporary Hermes home, including a key Hermes refuses;
   - the gateway capabilities, methods and events Boundary uses, over the dashboard's `/api/ws`;
   - the HTTP endpoints Boundary calls, with the status codes and response fields it reads.

   It runs before the stack pin moves and before a change to code that talks to the stack is merged.
2. **The contract is listed in one place.** A table in this repository names each dependency: ports, endpoints, gateway methods and events, `config.yaml` keys, files Boundary reads under the stack's data folder. Each row says where Boundary uses it and which check covers it. Moving the stack pin means reading the stack's changelog against that table. The stack's docs are a claim to check against Hermes's source in the pinned image, not proof.
3. **Embedded programs get their own tests.** Code Boundary sends to run elsewhere, such as the Python it pipes into the Hermes container, is tested by running it with stand-in modules for the host's libraries, covering a failed write, an exit and a missing profile. These tests need only `python3`, so they run in CI.
4. **Drift checks run in CI.** Lint and the build fail on:
   - unused exports and files;
   - repeated blocks above a set size;
   - main or preload code that sends or receives IPC without the typed helpers;
   - unhandled promises, and `switch` statements that miss a case of a union.
5. **Integration tests for the chat screen and app lifecycle.** A small set of renderer tests mounts the real chat runtime, thread and lifecycle state with a fake bridge and checks what is drawn. Each bug found by hand in these areas adds one.
6. **Chat turns log their metadata.** Each turn writes one debug-log line when it starts and one when it ends: request and session ids, the speaker, how it was triggered (sent, woken, posted without a turn), timings and how it finished. No message text, titles or tool arguments.
7. **A manual release check.** A short list of flows, covering a first chat, a channel hand-off, an approval, Stop agent and adding a folder, is run in the app before each release and each move of the stack pin. The flows are in [the release check](../testing/release-check.md).

## Consequences

- Changes that touch the stack need a running stack to merge. The contract tests are slower than unit tests and can't run in hosted CI.
- The contract table needs updating whenever Boundary starts or stops depending on something. A dependency missing from it has no check.
- Some current code fails the new lint rules. Each rule lands with the fixes it needs, or with an allowance list that only shrinks.
- The debug log grows by two lines per turn. It stays free of chat content.
- Fakes in unit tests stay: they cover Boundary's own logic. The contract tests cover what the fakes assume.
