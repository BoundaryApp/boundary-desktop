# Add-on store: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.html](prototype.html) |
| Started | 9 Nov 2026 |
| Builds on | [add-ons spec](../addons-ux-study/spec.md), [shared services spec](../shared-services-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Prototype | Done | — |
| 2 Store layout with today's catalog | Built; in-app check pending | add-ons phase 2 |
| 3 Search, filters and built-in results | Built; in-app check pending | 2 |
| 4 Categories and shelves from the manifest | Not started | 3, add-ons phase 5 (`addon.sh list --json`), [change request 0027](../change-requests/0027-addon-store-metadata.md) |
| 5 Shared with you | Not started | shared services phase 4 |
| 6 Services home screen | Built; in-app check pending | 2 |
| 7 Choose a way before Get | Built; in-app check pending | 2 |

## Goal

A user finds an add-on by browsing or by describing what they want, sees at a glance which ones are already on this Mac and which won't fit, and installs one without leaving the page they found it on.

## Decisions

1. **The store replaces the Add-ons list under Services.** It gets its own sidebar: Discover, Installed, the categories that have at least one add-on, and From your Circles. The container engine's memory sits at the bottom of the sidebar on every store page, because it decides what can be installed.
2. **Every card has one action button, and its label says the state.** **Get** (not installed), **Turn on** (shipped with Boundary, or turned off with data kept), a progress ring with a percentage while installing, **Restart** while waiting for the assistant restart, **Start** when installed but not running, **Open** for an add-on with a web page, **On** for one without, and **View** when it won't fit. The icon tile carries a matching corner mark: a check when installed, a pause sign when not running, dots while installing.
3. **Get opens a short sheet, not the install.** The sheet shows the engine memory bar with the add-on's reservation drawn on it, the access choice where the add-on has one (add-ons decision 7), and whether a restart follows. This keeps the fit check before anything downloads.
4. **Install progress follows the add-on everywhere.** The card's ring, the Installed list, the detail page's steps and the dot on the Services rail icon all show the same install. Starting an install or removal opens its progress page, and while it runs, opening that add-on from anywhere (card, tile, search or the Services home) shows the progress page instead of the detail page. The detail page comes back once the run finishes, fails, is cancelled or waits on the restart. The user can leave the page.
5. **One restart bar across the store.** Every add-on that finished installing and gives agents tools waits for one **Restart assistant**, as add-ons decision 16 describes. After the restart a toast offers a first question to try, taken from the add-on's own examples.
6. **Search matches what people want, not only names.** It looks at names, descriptions, category, the add-on's example questions and a keyword list from the manifest ("contacts" finds Twenty). Results also list matching services Boundary already runs, under **Already in Boundary**, so a search for "web search" or "calendar" doesn't suggest something is missing.
7. **Three filters.** **Fits this Mac**, **Stays on this Mac** and **Hide installed**. Filters apply to Discover, categories and search.
8. **Shelves need at least two add-ons.** Discover shows the featured add-on, **Fits this Mac** (the three smallest that fit with room to spare), a shelf per category with two or more add-ons, and one shelf for the rest. With today's catalog that is one shared shelf, so the page doesn't look empty.
9. **Every add-on states where its data goes.** The detail page and a pill on it say **Stays on this Mac** or **Uses the internet**, with one sentence on what leaves. The manifest carries this; Boundary doesn't guess it.
10. **n8n and LightRAG appear as Included.** They ship with Boundary and are off by default. In the store they show **Turn on** and an **Included** tag, and nothing downloads. Once on, they appear on Services with the other add-ons, where their menu has **Turn off**.
11. **Turned off keeps a state of its own.** An add-on turned off with its data kept shows **Off · data kept** and **Turn on**, and its detail page offers **Remove and delete data…**.
12. **Shared with you sits in the store.** Services people in the user's Circles share (ADR 0048) are listed under From your Circles with **Use in my agent**, since that is where people look for new tools. The flow itself belongs to shared services phase 4.

13. **Services is the home screen; the store is where you get more.** Services shows every service as an icon tile in two rows. **Built in** holds what ships with Boundary and runs with the assistant (Hermes WebUI, SearXNG, GPT Researcher, OpenCode, Calendar), all in the brand tint. **Add-ons** holds what was installed or turned on from the store, in their category tints with the store's corner marks, and ends with a **Get add-ons** tile. A click does the tile's main thing: open it in the browser, start it when it isn't running, or show its install. Right-click or the ⋯ button lists the rest: each page it opens, **Details** and, for n8n and LightRAG, **Turn off**. Turning off or removing a downloaded add-on stays on its page, which says what agents lose. An add-on is on Services when it's installed, connected to an account elsewhere, mid-run, off with data kept, or left over from a failed install; one that's only for sale stays in the store.

14. **Get asks how before anything else, for add-ons that can also connect.** Actual Budget and Twenty can run on this Mac or connect to one the person already runs. Their Get sheet opens on that choice: **Run it on this Mac** and **Connect one you already use**, two cards of equal weight with nothing picked, each with a line on what it does and its figures. A click on a card is the choice, and the same sheet moves to that way's step: the fit, access and Install, or the connect form with its first fields showing. **← Change** at the top of the second step goes back to the choice. On the detail page the two ways sit side by side as cards with buttons of the same weight. Turn on skips the choice, since the data being turned back on is on this Mac.

## Needs from the stack

- **Category, keywords, example questions and a data-leaves flag in the manifest.** These belong in `addon.sh list --json` next to the fields change request 0020 already asks for. Until then Boundary's compiled catalog carries them for today's add-ons. [Change request 0027](../change-requests/0027-addon-store-metadata.md) asks for them.

## Phases

**1 Prototype.** The click-through in this folder.

**2 Store layout with today's catalog.** Sidebar, Discover, Installed, the detail page and the Get sheet, with card actions and tile marks for each state. Uses the compiled catalog and the existing install, restart and Turn off code. Mounted tests for each card state.

**3 Search, filters and built-in results.** Matching as decision 6 describes, with a pure function and unit tests, and the three filters.

**4 Categories and shelves from the manifest.** Category navigation and shelves read from `addon.sh list --json`.

**5 Shared with you.** The From your Circles entry and shelf, once shared services phase 4 exists.

**6 Services home screen.** Decision 13: the Built in and Add-ons tile rows, each tile's click and menu, and the Get add-ons tile. Mounted tests for which add-ons show and what a click does.

**7 Choose a way before Get.** Decision 14 for Actual Budget and Twenty: the choice step in the store's Get sheet, each way's step in the same sheet, and equal cards on Actual's detail page as on Twenty's. Mounted tests for the choice, each way and **← Change**.

## Acceptance criteria

- [ ] Each card's action and tile mark match the add-on's state, including while an install runs on another page.
- [ ] **Get** shows the fit before anything downloads; an add-on that won't fit offers **Make room…** instead.
- [ ] Two installs that finish before a restart share one restart bar and one restart.
- [ ] Searching "contacts" lists Twenty, and searching "web search" lists the built-in search under **Already in Boundary**.
- [ ] With today's catalog, Discover shows no category shelf with a single add-on.
- [ ] An installed add-on opens from its Services tile without visiting the store, and one that's only for sale isn't on Services.
- [x] Get for Actual Budget or Twenty asks whether to run it here or connect one before showing either way's fields, and each way opens with its own fields showing.
- [ ] The Installed list shows running, not running, waiting for restart, installing and off-with-data add-ons, and the engine memory they use.
