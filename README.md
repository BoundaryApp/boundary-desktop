# Boundary

A desktop app for running your own AI assistant. Boundary installs and runs the
[sovereign agent stack](https://github.com/kaxline/sovereign-agent-stack) (Hermes Agent, Hermes
WebUI, search, RAG and automation services) in containers on your machine, and gives you a chat
workbench on top of it: projects, agent DMs and channels, coding folders, and a view of what the
stack is using.

Boundary is an Electron app written in TypeScript and React. It is MIT licensed.

## Running it

You need [Bun](https://bun.sh), Node.js 20, and either Docker or nothing at all: on macOS,
Boundary falls back to a bundled Podman engine when Docker isn't available.

```bash
bun install
bun run dev
```

On first launch Boundary walks through setup: it checks for a container engine, asks you to
connect a model (a local LLM server, OpenRouter, or an endpoint on a hosted GPU provider such as
Baseten), then downloads a pinned release of the agent stack into its user data folder and
starts it.

### Developing against your own stack checkout

To run Boundary against a local `sovereign-agent-stack` checkout instead of the pinned download,
clone it next to this repository as `../assistant`, or point `BOUNDARY_ASSISTANT_ROOT` at it:

```bash
bun run dev:local-stack
```

Boundary attaches to a Hermes that is already healthy on the default ports, never resets that
checkout, and leaves it running when you quit. [docs/bundled-podman-fidelity.md](docs/bundled-podman-fidelity.md)
covers running both stacks side by side.

## Tests

```bash
bun run test          # main-process and renderer unit suites
bun run type-check
```

## Packaging

```bash
bun run package       # electron-forge package → out/
bun run dist:mac      # fetches the container runtime, then builds the DMG and ZIP
bun run dist:win
bun run dist:linux
```

`dist:mac` populates `resources/container-runtime` first (`bun run fetch:container-runtime`).
Release signing and the GitHub workflows are described in
[.github/RELEASE_SETUP.md](.github/RELEASE_SETUP.md).

## How this is built

Boundary is built by one developer working with AI coding agents. I decide what the product is
and how it behaves; agents draft most of the code, design studies and specs; I review, test and
correct what they produce before it lands.

Decisions follow a fixed path, and the docs are the record of it. A design question starts as a
study in `docs/*-ux-study/`: clickable HTML mocks of the competing options, side by side. I choose
a direction, and an ADR in `docs/adr/` records the choice, the options I rejected and what follows
from it. Where the work is large, a spec next to the study breaks it into phases with acceptance
criteria. When Boundary needs the agent stack to change, the need is written up as a change
request in `docs/change-requests/` instead of patched in from here.

## Where things are

- `src/main/`: the Electron main process. It runs the container engine and the agent stack, and
  bridges chat to Hermes.
- `src/renderer/`: the React UI.
- `src/preload.ts`: the API the renderer gets from the main process, as `window.electronAPI`.
- `src/shared/ipc/channels.ts`: every IPC channel with its arguments and result, which both
  processes are checked against.
- `resources/`: the Compose overlay for the stack and the bundled container runtime.
- `docs/adr/`: architecture decisions. Start with the [index](docs/adr/README.md).
- `docs/*-ux-study/`: the design studies the ADRs point to.
- `docs/change-requests/`: what Boundary has asked the agent stack to change.
- [`docs/stack-contract.md`](docs/stack-contract.md): what Boundary depends on from the agent stack,
  and the `bun run test:stack` checks that cover it.
- [`docs/testing/release-check.md`](docs/testing/release-check.md): the flows to run in the app before
  each release and each move of the stack pin.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
