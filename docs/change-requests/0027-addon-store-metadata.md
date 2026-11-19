# 0027 · Add-on store fields in the manifest

**Serves:** [add-on store spec](../addon-store-ux-study/spec.md), phase 4
**Status:** Open

## Background

Boundary's Services screen now lists add-ons as a store. People can browse by category, search and filter, and each card gives a one-line summary, an example question to ask the agent, and whether the add-on's data stays on this Mac. Every one of those facts is about the add-on itself, so the add-on's manifest should carry them, as it already carries the title and the tagline.

Boundary keeps these facts in its own code today, in `src/renderer/product/addons/storeItems.ts`. That covers Twenty, n8n and LightRAG, but it means each add-on the stack ships needs a Boundary release before the store can describe it, and Boundary can guess wrong about what an add-on sends where.

Checked on stack `main` at 54c8434 (after the v0.3.12 tag):

- `addons/*/addon.json` requires `title`, `tagline` and `description` (`REQUIRED` in `scripts/lib/addon_manifest.py`). The three manifests there (gptr, actual, bitwarden) set them.
- `permissions.egress` is a list of strings, and `EGRESS_WORDS` is `llm-proxy`, `search`, `postgres`, `internet`. gptr and actual both list `internet`.
- `addon.sh list --json` builds each entry in `listing()` (`scripts/lib/addon_store.py`). It returns `id`, `shortId`, `title`, `tagline`, `permissions`, `platform`, `enabled`, `settings`, `instances`, `missing` and `schema`. It doesn't return `description`.
- `validate()` checks the fields it knows and ignores any others at the top level. So a new top-level block passes today but isn't checked, and `list --json` doesn't pass it through.

Every item below goes in one optional top-level `store` object, so that fields for display stay apart from the fields that run the add-on. All of them are Wanted. Boundary's compiled list stays as the fallback for any add-on whose manifest lacks them.

## R1 · A category (Wanted)

**Why:** the store's left rail and its shelves group add-ons by category. If Boundary assigns the category, a new add-on lands under **Other** until a Boundary release moves it.

**Ask:** `store.category`, one id from a fixed set that `addon_manifest.py` owns and `validate()` checks. Boundary needs these to start: `work` (CRM, projects, email-like tools), `knowledge` (documents, notes, research), `automation` (workflows, schedules), `money` (budgets, finance), `security` (passwords, logins), `media`, `home`. Add others as add-ons need them; Boundary shows an id it doesn't know under **Other**.

The stack owns the ids and Boundary owns how they look: display names, order, colours and icons.

**Acceptance:** `validate()` refuses a `store.category` outside the set. gptr, actual and bitwarden set one (we'd expect `knowledge`, `money` and `security`).

**Boundary fallback:** `STORE_CATEGORIES` and the per-add-on `category` in `storeItems.ts`.

## R2 · Search keywords (Wanted)

**Why:** people search for what they want done, not for a product's name. "contacts" should find Twenty, and "zapier" should find n8n. The add-on's author knows those words better than Boundary does.

**Ask:** `store.keywords`, a list of lowercase words or short phrases, at most 20. Leave out the title and words already in the tagline, since Boundary searches those anyway.

**Acceptance:** `validate()` refuses a non-list, an empty string, uppercase letters, or more than 20 entries.

**Boundary fallback:** the `keywords` in `storeItems.ts`. Boundary searches the manifest's keywords in place of its own once an add-on has them.

## R3 · Example questions (Wanted)

**Why:** each card and detail page shows one thing to ask the agent once the add-on is on ("Who did I meet from Acme last month?"). An example question explains an add-on faster than a description does, and it doubles as search text.

**Ask:** `store.tryAsking`, a list of 1 to 3 questions in plain words, each under 80 characters, phrased as a person would type them into chat. Boundary shows the first and searches all of them.

**Acceptance:** `validate()` refuses an empty list, more than 3 entries, or an entry of 80 characters or more.

**Boundary fallback:** `ADDON_FACTS.twenty.tryAsking` for Twenty. Other add-ons show none.

## R4 · What leaves this Mac (Wanted)

**Why:** the store has a **Stays on this Mac** filter, and each detail page states where the add-on's data goes (spec decision 9). Boundary shouldn't guess this.

Boundary plans to read **Stays on this Mac** from `permissions.egress`: an add-on stays on this Mac when the list doesn't include `internet`. Please confirm that reading, or say what else counts. For example, does `search` mean queries go out through the search gate to outside engines?

**Ask:** where `permissions.egress` includes `internet`, a `store.dataLeaves` sentence saying what leaves and where it goes, e.g. "Budget data is read from and written to the Actual server you connect." `validate()` requires it when `internet` is listed.

**Acceptance:** gptr and actual have a `store.dataLeaves`. A manifest with `internet` in `egress` and no `store.dataLeaves` fails `validate()`.

**Boundary fallback:** the `staysLocal` flag in `storeItems.ts`, and no sentence.

## R5 · `list --json` returns `description` and `store` (Wanted)

**Why:** Boundary reads `addon.sh list --json` and not the manifest files (0020 R1, agreed). The detail page needs the long description, and R1 to R4 need the `store` block.

**Ask:** add `description` and `store` to each entry from `listing()`, passed through as they are in the manifest. Return `store` as `{}` when a manifest has none.

**Acceptance:** `scripts/addon.sh list --json` on a stack with the three current manifests returns both fields on each entry.

**Boundary fallback:** the compiled summaries in `src/main/services/addons/addonCatalog.ts`.

## Not asked here

Twenty, n8n and LightRAG have no manifests yet. Change request 0020 (R1, R10) and 0022 R2 already ask for them. When they're written, please include a `store` block. Boundary's suggestions:

| Add-on | `category` | `keywords` | `tryAsking` | `dataLeaves` |
| --- | --- | --- | --- | --- |
| Twenty (local) | `work` | crm, contacts, customers, people, sales, deals, leads, companies, pipeline | Who did I meet from Acme last month? | none (stays on this Mac) |
| n8n | `automation` | workflows, zapier, schedule, webhooks, cron, integrations | Run my weekly report workflow. | Workflows call whatever services you connect them to. |
| LightRAG | `knowledge` | rag, documents, files, pdf, graph, neo4j, notes | What do my notes say about the Q3 plan? | none (stays on this Mac) |

A connected (hosted) Twenty workspace sends data to that workspace's server. Since that's a choice made per instance, Boundary will say so on the connect flow rather than read it from the manifest.
