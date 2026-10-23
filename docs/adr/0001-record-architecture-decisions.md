# 0001. Record architecture decisions

- Date: 2026-09-20
- Status: Accepted
- Deciders: product / engineering (this repo)

## Context

Chat UX, stack, and host-folder decisions were living in a canvas, a study kit, and chat history. Nothing in the repo made those choices durable or citable.

## Decision

Architecture and product-structure decisions are written as numbered ADRs under `docs/adr/`. The [README](README.md) is the tree. A later ADR that reverses one of these must set the old record to `Superseded` and link the replacement.

## Consequences

- New chat chrome, project, and telemetry work cites an ADR instead of restating the study.
- Canvases and HTML mocks remain illustrations. The ADR is the decision.
- Small implementation details (library pins, IPC shapes) stay in code and the study canvas unless they change product structure.
