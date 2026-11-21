# 0071. Import boundaries between areas

- Date: 2026-11-20
- Status: Proposed
- Related: [0031](0031-checks-on-the-stack-contract-and-drift.md), [0032](0032-circles.md)

## Context

The app has grown to about 200k lines of non-test code across nearly forty areas: main-process services, product UI folders and the shared layers. Nothing recorded which areas may import which. An import graph of the tree on 2026-11-20 showed the process lines holding: no renderer code imports main-process code, and the Circles network process and the host bridge process import nothing outside their own service and `src/shared`. Those properties held by habit, and the coupling between services (the assistant service is imported by most others) could grow one import at a time without anyone deciding it should.

Splitting an area out later, as a package or a separate app, depends on knowing its edges and keeping them from multiplying in the meantime.

## Decision

1. An area is one main-process service (`src/main/services/<name>`), the rest of `src/main` (`main:core`), the files directly in `src/main/services`, one product UI folder (`src/renderer/product/<name>`), the files directly in `src/renderer/product` (`ui:shell`), `src/renderer/components`, the rest of the renderer, `src/shared`, the preload scripts, or one experiment. `scripts/import-areas.mjs` defines this.
2. `bun run check:imports` (`scripts/check-imports.mjs`) runs in `bun run check` and Test Build. It fails on an import from one area into another that its `allow` list does not name. Test files are not checked.
3. The `allow` list holds the edges as of 2026-11-20 and only shrinks: an entry no import uses any more fails the check until it is removed. A new edge goes into the list in the same change, with the reason in the commit. The alternative is to route it through `src/shared` or an existing seam.
4. These need no entry: any import into `src/shared`, and renderer code importing `src/renderer/components`.
5. These have no allowance: main and renderer code importing each other, preload code importing either, shared code importing anything outside `src/shared`, and any import into an experiment from outside it.
6. Process entries bundled on their own (the Circles network process and the host bridge process) keep everything they reach, directly or not, inside their own area and `src/shared`.
7. Code kept outside the public repository lists its own edges under `imports` in its own allowances file, so public files do not name it.
8. Host files are the core app's API for features: `src/main/host/`, `src/renderer/host/`, `src/preloadExperiments.ts` and `src/preloadHost.ts`. Host clients (every experiment and the Circles service) reach the core areas (`main:core`, the files directly in `src/main/services`, `main:secrets`, the rest of the renderer, `ui:shell` and the preload scripts) only through a host file or a named exception. An import of a host file adds no edge, and neither does a host file's own import of the core; the process lines in point 5 still apply to both. A named exception is one `"<area> -> <file>"` pair in `hostExceptions`, kept because only one feature uses the name; code outside the public repository lists its own in that allowances file. An exception no import uses any more fails the check until it is removed.

## Consequences

- Adding an import across areas is a visible decision in the diff. `node scripts/check-imports.mjs --list '<a> -> <b>'` prints the imports behind one edge.
- The check counts area pairs, not imports. A second file in an area that already imports another area passes. That keeps the list short (about 160 public entries) at the cost of not catching coupling that thickens along an existing edge.
- The Circles network process staying within its area is the property a Circles package split relies on; the check now guards it.
- Host files only re-export names from the core. Adding a name to one is a deliberate change to the API features build on, and a core file a host client needs reaches it through a host file rather than a new edge.
- Only relative imports are followed. The project has no path aliases; adding one would need `resolveImport` to know about it.
