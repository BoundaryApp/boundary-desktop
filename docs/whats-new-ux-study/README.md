# What's new study

Visual record for [ADR 0059](../adr/0059-release-notes-on-upgrade.md).

- `index.html` is a click-through of all four surfaces: the card in the start-up screen's story
  slot, the slideshow a new version opens, the What's new page, and a guide with numbered
  markers. The bar above the window drives it: launch a new version, skip to the ready app,
  pretend two releases were skipped.

The releases, features and screenshots in it are invented; the screenshots are drawn in HTML. In
the app they are generated from the real interface, and the markers are placed from boxes saved
with each screenshot.

Serve the repo root over HTTP to view, e.g. `python3 -m http.server` then open
`/docs/whats-new-ux-study/`.
