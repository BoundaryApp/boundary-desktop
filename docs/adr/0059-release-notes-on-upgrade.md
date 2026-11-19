# 0059. Release notes shown on an upgrade, with generated guide screenshots

- Date: 2026-11-13
- Status: Proposed
- Related: [0029](0029-full-window-startup-screen.md), [0037](0037-updates-in-the-rail.md)

## Context

Testers on a fast release train upgrade every few days and have no idea what changed. The
updater's card (0037) carries three lines from a text file, shows after an in-app update, and
collapses on a timer, so it misses anyone who installed a build by hand and says too little to
teach a feature.

Two other things were going spare. The start-up screen (0029) holds a reader for a minute or more
while the stack comes up, and fills it with the same tool story every time. And a feature that
needs a walkthrough has nowhere to put one: screenshots in a document go stale the week the
layout moves, and the numbers drawn on them go stale faster.

## Decision

1. **Notes are per release, bundled with the build.** A release's slides, its guides and their
   screenshots ship inside the app. They work before the stack is up, and they are reviewed in
   the change that ships the feature. A build pointed at no content has no release notes, and
   every surface below stays off, so a build can ship without them.
2. **The slideshow opens on the first launch of a version that has notes**, for an install that
   ran an earlier version. A first install gets nothing: changes since a version it never ran
   mean nothing to it. An install whose earlier version isn't known — one that predates release
   notes — is treated as an upgrade, with only the current release counted as new.
3. **One click closes it; one click stops it.** The footer's **Don't show again** closes the
   slideshow and turns future ones off, with an Undo in a toast that follows. Escape, the
   backdrop, the close button and **Done** all close it. Closing it any way marks the release
   read.
4. **It shows the current release only.** A reader who skipped releases gets a chip saying how
   many they haven't seen; one click opens the full page at the newest of them. Catching up is a
   choice, not a longer slideshow.
5. **An upgrade stays pending until its notes are read.** It isn't tied to the launch that
   upgraded, so a start-up that fails or is quit early doesn't lose them.
6. **The start-up screen shows the same slides while it waits.** On a launch with unread notes
   the story slot (0029) carries them instead of the tool story, under the same rule that decides
   when the slot appears, so a quick launch still shows nothing and a first run keeps the tools.
   The card ignores the popup setting: it fills a wait rather than interrupting. **Read more**
   opens the slideshow over the start-up screen, and it stays open when the app becomes ready.
7. **A rail button opens every release.** It sits in the bottom group above **Report a bug**,
   renders only when a build bundles notes, and carries a dot while something is unread. The page
   lists each release newest first, with its slides as blocks and the guides no slide links to;
   a release is marked read once its section scrolls into view.
8. **A guide is one step at a time.** Each step is a screenshot with a numbered marker per
   callout and the callouts as a numbered list; hovering either highlights the pair.
9. **Markers are placed from boxes saved with the screenshot, not typed in.** The generator
   renders the app from made-up data, saves the PNG, and saves the box of every element the
   step's callouts name, as fractions of the image. The app draws the markers and rings over the
   image at view time. They stay sharp at any size, they can respond to a hover, and a
   regenerated screenshot moves them with the layout. An element is named by a
   `data-guide-anchor` attribute in the app's own markup, and an anchor the generator can't find
   fails the run.
10. **A slide can ship without a screenshot.** Text says more than a picture of a screen the
    generator cannot yet fill with believable data. A slide that rings part of a screenshot must
    have one.

## Consequences

- The notes for a release are written when it is cut, by whoever cuts it. Nothing writes them
  from commit messages, and a release with no notes simply has none.
- Text can't be fixed after a release ships. A correction waits for the next one.
- Each build carries the screenshots of the releases it keeps (the last ten), which is tens of
  files rather than hundreds.
- A guide step's screenshot needs the generator to render that screen from made-up data. A screen
  the generator can't fill yet can't have a guide, and its slide ships as text.
- The updater's card (0037) hands over for a version that has notes: marking the release read
  closes it, so nobody gets both. A build with no notes keeps the card as it was.
- Marking a release read on scroll means a reader who scrolls past a section without reading it
  loses its dot.
