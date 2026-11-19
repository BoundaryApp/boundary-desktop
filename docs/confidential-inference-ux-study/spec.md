# Confidential inference: living spec

| | |
| --- | --- |
| Status | Accepted |
| Visuals | [prototype.html](prototype.html) (click-through) |
| Decisions | [ADR 0047](../adr/0047-confidential-provider-pools.md) |
| Started | 8 Nov 2026 |
| Builds on | [inference UX study](../inference-ux-study/spec.md), [ADR 0033](../adr/0033-inference-chains.md), [ADR 0043](../adr/0043-circles-live-in-the-chat.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Prototype of every flow | Done | — |
| 2 Catalog, ranking and eligibility, with a fake adapter | Built; live check pending | 1 |
| 3 Confidential providers card, pool rung, pool settings | Built behind BOUNDARY_CONFIDENTIAL_POOL; live check pending | 2 |
| 4 Chat chip, provenance and the private-project stop | Built behind BOUNDARY_CONFIDENTIAL_POOL; live check pending | 3 |
| 5 Spend log and help page | Built behind BOUNDARY_CONFIDENTIAL_POOL; live check pending | 3 |
| 6 Prem and NEAR AI adapters against live accounts | Built behind BOUNDARY_CONFIDENTIAL_POOL; live check pending | 2; user's accounts; the six fake-adapter assumptions in ADR 0047 |

## Goal

A user adds accounts at confidential providers with their own keys, puts a confidential pool in a stack, and each chat goes to the cheapest provider that meets their settings. They can see, next to every control that affects it, what a provider can and can't see and why a provider was or wasn't used.

## Decisions

1. **Providers live under Inference, in Model sources.** A **Confidential providers** card sits between Local and OpenRouter. ADR 0043 moved models to the Inference screen, so ADR 0047's "Settings gets a card" becomes this card.
2. **The card states the tradeoff on its face.** Under the card's description, a panel says what each provider sees (when you send, how long messages are, which model) and that each added provider is one more company that sees it, with a link to the help page.
3. **Adding a provider is four steps: choose, what it sees, key, check.**
   - **Choose** lists every provider in Boundary's list with its trust level, the reason for it, a cost per turn for each model and how it bills. Providers already added are disabled. One below the user's minimum level is marked but can still be added.
   - **What it sees** is the consent step from ADR 0047 decision 7: what the provider can't read, what it sees, who bills, and that it joins every pool for a model it carries, including models it adds later. Its button reads **Add** and the provider's name.
   - **Key** names where to make a key and says the key is stored with the keychain and goes only to that provider. A provider-specific note goes here, such as Prem's 38,000-token limit on new accounts.
   - **Check** runs four checks and lists each: key accepted (with balance), hardware checked against the level, models listed, and a test tool call. A failed hardware check doesn't add the provider. A failed tool call adds it but says pools skip it for chats that use tools.
4. **A pool is a rung in the Chat stack.** It's labelled **Confidential** and the model's name. Its detail line gives the provider count, the provider new chats go to and a cost per turn. Selecting it opens the side panel: providers that serve, cheapest first, with prices and a cost per turn; providers that don't, each with one reason; and the settings the pool follows. A pool can be first only in the app stack; chat and project stacks refuse a pool in first place.
5. **One reason per provider that isn't used,** checked in the order ADR 0047 decision 7 filters: not added, below the trust level, precision, then what's wrong now (rate limit, balance, failed check).
6. **The cost per turn is labelled as an estimate** with the turn it assumes: 75,000 tokens in, 60% cached, 2,500 out.
7. **Pool settings is one sheet for all pools.** It holds the lowest level for chats (B by default), the lowest level for private projects (A by default), the lowest precision (fp8 by default), whether providers that don't state precision count (on by default), and **Prefer one provider** with its threshold (10, 20 or 50%).
8. **Trust levels are shown as a lettered badge everywhere a provider is named,** with the level's name in its tooltip and full text in pool settings, the add flow and the help page.
9. **A chat names its provider in two places.** The composer chip shows the model, the provider and its level badge. The line under each reply names the model, provider and level. When the provider changes mid-chat, one marker above the next reply reads "<provider> took over: <reason>". A reply whose provider can't be told for certain, such as one written while two turns overlapped, shows no line. Falling back to the stack's next model works as in ADR 0033 §3.
10. **A private project that no provider qualifies for stops the send** and lists, for each added provider, why it doesn't qualify. It offers **Allow level B for this project**, **Add a level A provider** and **Use Local for this chat**. Allowing level B is stored on the project, shown in its inspector with what it means, and can be undone there.
11. **Problems show on the card, with the fix beside them:** **Top up at** a provider for an empty balance, **Check again** for a failed hardware check, and the time a rate limit ends. Boundary's provider list shows a callout when it's more than 7 days old, or when a new one fails its signature, with the date of the list still in use.
12. **Spend is a table by provider over 30 days:** turns, tokens in and out, estimated cost and balance. A note says how the estimate is made, that the invoice is what's paid, and that the counts hold no chat content.
13. **The help page is the user doc ADR 0047 decision 10 asks for.** It covers what sealed hardware protects, what providers still see, the three levels, why the answering provider changes, accounts and billing, and that pools need Boundary running. It also covers private projects and the five-minute skip of a provider that just failed.

## Changes to ADR 0047 from this study

The prototype now places Chutes at level C, as the amended decision 6 says.

Approved with the prototype on 8 November 2026 and folded into the ADR: the card's location (decision 1), a precision floor in place of equal precision (decision 3), trust levels defined by what the adapter checks, with other facts in the level's reason and a per-project override (decision 6), and tool support tested when a provider is added and applied per request (decision 7).

## Acceptance criteria

1. [x] The **Confidential providers** card shows under Model sources, with the what-it-sees panel and a link to the help page.
2. [x] Adding a provider goes through the four steps, and nothing joins a pool before the user presses **Add** on the what-it-sees step.
3. [x] A refused key, a failed hardware check and a failed tool test each show the state drawn in the prototype.
4. [x] A pool rung's side panel lists serving providers cheapest first and each unused provider with one reason.
5. [x] Changing a pool setting changes which providers the side panel lists, without a restart.
6. [x] A chat's chip and reply lines name the provider; a provider change adds one marker.
7. [x] A private project with no qualifying provider stops the send with the three actions, and **Allow level B** shows in the project's inspector.
8. [x] Card callouts appear for a rate limit, an empty balance, a failed check, a list older than 7 days and a list that fails its signature.
9. [x] Spend shows 30 days by provider with the estimate note.
10. [x] The help page ships with the text in the prototype, updated for anything the build changes.
