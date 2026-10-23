# Contributing

Bug reports and pull requests are welcome. For anything larger than a fix, open an issue first so
we can agree on the approach before you write it.

## Before you open a pull request

Run both checks; CI runs the same ones.

```bash
bun run test
bun run type-check
```

If you add, remove or upgrade a dependency, run `bun run notices` and commit the regenerated
`resources/licenses/THIRD_PARTY_NOTICES.md`.

Keep a pull request to one change. Write commit messages that say what changed and why in a
sentence or two.

## Decisions and designs

Decisions that shape the app are recorded as ADRs in [docs/adr/](docs/adr/README.md). If your
change contradicts one, say so in the pull request and propose an amendment rather than working
around it. UI work follows the design study the relevant ADR names (`docs/*-ux-study/`) and the
tokens in `src/renderer/styles/tokens.css` ([ADR 0018](docs/adr/0018-design-tokens-and-primitives.md)).

## Changes to the agent stack

Boundary runs the [sovereign agent stack](https://github.com/kaxline/sovereign-agent-stack) but
doesn't patch it. If a feature needs the stack or Hermes to behave differently, write it up in
[docs/change-requests/](docs/change-requests/README.md) and keep a fallback in Boundary until the
stack ships it.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
