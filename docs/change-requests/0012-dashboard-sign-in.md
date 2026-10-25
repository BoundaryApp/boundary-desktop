# 0012 · Dashboard sign-in from Boundary, a task deep link, and a board without the dashboard shell

**Serves:** [task activity spec](../kanban-activity-ux-study/spec.md) (**Open board** and **Open in board**).
**Status:** R1–R3 delivered (stack overlay on `feat/dashboard-board-links`, unreleased) · Boundary wired

## Background

Boundary's task surfaces link to the Hermes board (`<dashboard>/kanban`) for drag-and-drop triage. Today that link opens the system browser, which has no dashboard session, so the user lands on `/login` and has to type the dashboard password from the stack's `.env`. Boundary is moving the board into its own window as a view of the Tasks list, so the board also has to work embedded. All three items were checked against `hermes-agent v0.22.2 (2026.9.24)` in the stack's `hermes` container.

Boundary already signs in to the dashboard from main for the kanban REST calls and WS tickets: `loginToDashboard` in `src/main/services/assistant/hermes/hermesDashboardAuth.ts` sends `POST /auth/password-login` with `HERMES_DASHBOARD_PASSWORD`. That session lives in Node's `fetch` and can't be handed to a browser. Hermes has no route that turns a one-time token in a URL into a session cookie: only `/auth/password-login` (a JSON POST) and `/auth/callback` set the cookies, and `/auth/native/*` returns bearer tokens to a desktop app rather than cookies.

## R1 · Sign a browser in from a one-time link (Wanted)

**Why:** "Open in board" should land on the board, in the user's browser or in Boundary, without a password prompt and without Boundary putting the dashboard password anywhere a page can read it.

**Ask:** a dashboard auth provider plugin (the `DashboardAuthProvider` seam that `plugins/dashboard_auth/basic` and the others use) that exchanges a short-lived, single-use code minted by Boundary for a normal dashboard session, plus a URL Boundary can open with that code. A shape that would work for Boundary:

- The code is an HMAC over `{ nonce, exp, next }` with a secret in the stack's `.env` (for example `HERMES_DASHBOARD_HANDOFF_SECRET`). Boundary reads it the way it reads `HERMES_DASHBOARD_PASSWORD` now. `exp` is at most 60 s out, and the provider remembers used nonces until they expire.
- Sessions are minted like `basic`'s (HMAC-signed access and refresh tokens with a configured secret), so they survive a container restart and `verify_session` / `refresh_session` work as they do for basic.
- `/auth/login` passes only `provider` and `next` to `start_login`, so the code needs another way in. Either the plugin registers a handoff route (for example `GET /auth/boundary?code=…`) that verifies the code and sets the session cookies the same way `_complete_login` does, or `start_login` redirects to a loopback endpoint in Boundary that acts as the IdP and sends the browser back to `/auth/callback`. Boundary prefers the handoff route, because the IdP route needs a listener in Boundary and a port the stack has to know.
- `next` goes through the same check as today's login (`_validate_post_login_target`).

**Acceptance:** opening the handoff URL with a fresh code, in a browser with no Hermes cookies, lands on `next` (for example `/kanban`) signed in. A used or expired code lands on `/login`. Password sign-in at `/login` keeps working for direct use. A session started this way survives `docker restart hermes`.

**Boundary fallback:** the in-app board signs its own Electron session in with `POST /auth/password-login`, sent from main with the password it already holds. **Open in browser** opens `/kanban` and the user signs in by hand. With R1, Boundary stops sending the password for the board view, and both paths open the handoff URL.

> **Stack reply (delivered):** the route is `GET /auth/handoff?code=<code>`, and the code is the shape you proposed: an HMAC-SHA256 over `{v: 1, nonce, exp, next}` with `HERMES_DASHBOARD_HANDOFF_SECRET` from `.env`, which `setup.sh` now generates. `exp` is at most 60 s out, and each nonce is accepted once. The format and a Node snippet are in `docs/extending.md`.
>
> It isn't a new auth provider, for two reasons. First, a `DashboardAuthProvider` can't register a route: neither the provider nor the plugin context has a hook for one. Second, every session provider is listed on `/login`, so a `boundary` provider would add a sign-in button that leads nowhere. Instead, an overlay adds the route to `dashboard_auth/routes.py` and the gate's public paths, and mints the session with the existing `basic` provider. You get the same tokens a password sign-in gets, so `verify_session` and refresh work unchanged and the session survives `docker restart hermes` (tested).
>
> One correction to Background: `start_login` receives only `redirect_uri`. `next` travels in the PKCE cookie. The conclusion holds either way: a code has no way in.
>
> - **Redirects:** a valid code goes to `next`, checked by `_validate_post_login_target`, else `/`. A used or expired code goes to `/login?next=<next>`. A forged or malformed code goes to `/login`.
> - **Off by default:** with the secret unset, the route answers 404.
> - **Password sign-in:** `/login` is unchanged.
> - **Access log:** the code is written to the dashboard's access log. That's harmless once it's used, but don't log the URL on your side.
>
> **Boundary:** for the in-app board you don't need a link. Sign in from main with `POST /auth/password-login`, as `loginToDashboard` does, and copy the session cookies into the board window's session (`session.cookies.set`). The password never reaches a page. Use the handoff URL for **Open in browser**.

## R2 · Open the board on one task (Wanted)

**Why:** "Open in board" starts from a task's page. The board should open with that task selected, not at the top of the board.

**Ask:** `/kanban?task=<id>` opens with that task's detail drawer open and its card scrolled into view. An unknown id opens the board as usual.

**Acceptance:** loading `/kanban?task=t_…` for a task on the board shows its drawer without a click.

**Boundary fallback:** the board opens at the top, and the user finds the card.

> **Stack reply (delivered):** `/kanban?task=<id>` opens the drawer once the board has loaded and scrolls the card into view. Tasks belong to a board, and the dashboard remembers the last board it showed (in `localStorage`), so send `&board=<slug>` whenever you know the board. The link's board is shown without replacing the remembered one. An archived task opens too. An unknown id opens the board as usual. Closing the drawer drops `task` from the URL, so a reload doesn't reopen it. The query survives a redirect to `/login` and back.

## R3 · The board without the dashboard shell (Wanted)

**Why:** inside Boundary the board sits under Boundary's own navigation. The dashboard's nav and header then add a second app frame, and they lead to dashboard pages (config, sessions, logs) that Boundary doesn't mean to expose there.

**Ask:** an embed mode for the kanban page, for example `/kanban?embed=1`, that renders the plugin without the dashboard's nav and header. The drawer, drag-and-drop and filters stay. Links that leave the board open in a new window (`target="_blank"`), so Boundary can send them to the browser.

**Acceptance:** `/kanban?embed=1` shows only the board, and every board action works as it does in the full dashboard.

**Boundary fallback:** the embedded board shows the full dashboard, nav included.

> **Stack reply (delivered):** `?embed=1` on any dashboard URL hides the sidebar, the mobile header and the page header. It's set in the served `index.html` before the app renders, so the dashboard's nav never flashes. It lasts for the tab (`sessionStorage`) until `?embed=0`. Banners such as the memory-pressure warning stay. The drawer, drag-and-drop and filters are untouched.
>
> Links that leave the board already open in a new window: a comment's markdown links and the docs link both carry `target="_blank"`, so no change was needed there.
>
> **Boundary:** hiding the dashboard's nav doesn't limit what the session can reach. The same cookies open `/config`, `/sessions` and the chat terminal. In the board window, refuse navigation away from `/kanban` (`will-navigate`, `setWindowOpenHandler`) and send those URLs to the system browser.

## Notes

R1 fits the auth provider plugin seam, so it can ship from the stack. The `hermes` service runs the upstream image directly, so the plugin needs a mount or a derived image. R2 and R3 are changes to the kanban plugin's frontend and the dashboard shell: an upstream change or a patch the stack carries.
