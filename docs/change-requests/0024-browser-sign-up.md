# 0024 · Browser sign-up: create a login with a generated password, capture a key from a page, a sign-up skill

**Serves:** agent-driven account sign-up. No Boundary spec yet; the first flow is creating an account with an inference provider (for example Prem's dashboard) and then an API key in it.
**Status:** R1–R3 built (unreleased, planned for 0.3.12) · R2 delivers to the viewer through `vault.take`, not `secret.deliver`

## Background

The flow Boundary wants: the agent asks the user which email or username to register and what name to use, opens the provider's sign-up page in its browser, enters the email and name, generates a password the model never sees, stores it, submits the form, tells the user the account exists, and on a yes creates an API key in the dashboard and stores that key without the model seeing it either.

Checked in the `nousresearch/hermes-agent:v0.22.7` image and the stack's v0.3.11 checkout:

- Skills are read from `skills.external_dirs`, which bootstrap points at `/opt/skills` (`compose/hermes/skills`, read-only). The repo skill `browser-login` already teaches the order of the `browser_vault_*` tools for signing in.
- `browser_vault_save_login` (`tools/browser_vault_tool.py`) asks the viewer for an identifier and a password through the `vault.save_login` server request (`gateway/session_vault_prompt.py`), stores a `login` item bound to the open page's origin, and calls `browser_vault_fill`. It has no way to generate a password.
- `browser_vault_fill` fills one field. `select_password_fill` (`agent/vault_login_classifier.py`) picks the best `current-password` control, and the classifier excludes `autocomplete="new-password"` outright. A sign-up form marked up correctly has only `new-password` fields, often two (password and confirm), so the vault fills nothing there.
- `VAULT_KINDS` (`agent/vault_store.py`) is `login`, `payment`, `address`. Nothing stores an API key.
- The `secret` server request (`gateway/session_secret_prompt.py`) saves a value the **user types** into the profile `.env` with `save_env_value_secure`. Nothing reads a value off a page into storage without returning it to the model.
- The browser runs headless in the `hermes` container, so the user can't type into the page themselves.

Boundary already answers `vault.save_login`, `vault.code`, `vault.unlock_prompt` and `secret` (`parkCredentialRequest`, `CredentialInterrupt.tsx`), and lists and removes vault items through `vault.list` and `vault.remove`.

> **Stack reply:** mostly accurate. Corrections:
>
> - **There are no `browser_vault_*` tools in v0.22.7.** Upstream folded the five of them into one
>   `browser_vault` tool that takes an `action` (`list`, `fill`, `save_login`, `enter_code`,
>   `unlock`). The names in this CR came from our `browser-login` skill, which was out of date;
>   it, our hints and our eval case now use the actions. R1 and R2 are new actions on that tool,
>   not new tools.
> - **Redaction already exists.** `agent.redact.register_vault_redaction_value` scrubs registered
>   values from model-facing output, and the fill and code paths use it. R2 registers captured
>   values with it. The registry lives in memory for each profile, so it lasts until the process
>   restarts rather than for one session.
> - **The vault's form inspection reads `maxlength` but not `minlength`, `pattern` or
>   `passwordrules`, and skips read-only inputs.** R1 and R2 each run their own page scan.
> - We didn't check whether the browser is always headless. Upstream has a Bot Desktop takeover
>   lease, and we haven't tried it in this stack. The flow here assumes the user can't reach the page.

## R1 · Create a login with a generated password (Blocking)

**Why:** without it the agent can't finish a sign-up form. Typing a password with `browser_exec` puts it in the model's context and the tool logs, which `browser-login` forbids, and the vault won't fill a `new-password` field.

**Ask:** a tool, for example `browser_vault_create_login(identifier, label="")`, run with the sign-up form open:

1. It asks the viewer through a new server request, for example `vault.create_login` with `{origin, site, identifier}`. The answer either approves a generated password or carries one the user typed. A decline returns `save_declined`, as `save_login` does. Without a viewer that can answer, it returns `prompt_unavailable`.
2. On approval it generates the password inside Hermes (`secrets`), reading `minlength`, `maxlength`, `pattern` and `passwordrules` from the form's `new-password` fields so the site accepts it. Without hints: 24 characters from letters, digits and a few common symbols.
3. It stores a `login` item for the page's origin with the identifier, and fills every visible `new-password` field on the form, which covers a confirm field.
4. It returns the handle, origin, identifier and fill result, never the password.

If the site rejects the password after submit, calling it again with `handle` regenerates and refills the same item rather than adding a second one.

**Acceptance:** on a test page with an email field and two `new-password` fields (one with `maxlength="16"`), the tool fills both with the same 16-character password, the vault holds one item for that origin, and neither the tool result, the session's tool messages nor `browser_exec` logs contain the password. Declining the card leaves the vault unchanged. A tool-eval case checks a model calls it on a sign-up page instead of `browser_vault_save_login`.

**Boundary fallback:** none that completes the flow, since the user can't reach the headless page. The agent tells the user to create the account in their own browser, then signs in with `browser-login`. Boundary adds a card for the new request either way.

> **Stack reply (built, planned for 0.3.12):** done as asked, as an action rather than a tool.
>
> - **Call:** `browser_vault` with `{action: "create_login", identifier, label?, handle?}`.
> - **Request:** `vault.create_login` with `{session_id, origin, site, identifier, regenerate}`. The
>   answer is a `ValueResult` string. `{"generate": true}` (or the bare string `generate`) approves
>   a generated password, `{"password": "..."}` carries one the user typed, and `""` declines
>   (`save_declined`). A card unanswered for 180 seconds counts as a decline. A session with no
>   viewer that can answer returns `prompt_unavailable` without sending the request. The request
>   is registered as a contract, so it appears in the `server_requests` list `client.capabilities`
>   returns; check for it there before relying on it. A client that doesn't handle it leaves the
>   agent waiting the full 180 seconds.
> - **Password:** 24 characters with at least one lowercase letter, uppercase letter, digit and
>   symbol (`-_.!@#%+=?`). It is shortened to the fields' `maxlength`, lengthened to their
>   `minlength`, and follows `passwordrules` for character sets, length and `max-consecutive`.
>   The fill script tests each field's `pattern` in the page before writing anything. If the
>   pattern refuses a candidate, Hermes retries without symbols and at 20, 16 and 12 characters,
>   then returns `password_rules_unmet`.
> - **Fields:** the inputs marked `autocomplete="new-password"`. On a page with none marked, it
>   uses the visible password inputs not marked or labelled as the current password, in the form
>   that looks most like a sign-up. Two password fields beat one, and create/confirm/repeat
>   wording breaks a tie, so a sign-in box in a header or sidebar is left alone. Every target gets
>   the same value, which covers the confirm field. The identifier is not typed by the tool; the
>   agent types it, as with `save_login`.
> - **Storing:** a `login` item in the local vault for the page's origin, written only after every
>   field took the value. If storing fails, the fields are cleared. It lists under **Passwords &
>   Logins** like any login.
> - **Result:** `handle`, `origin`, `identifier`, `identifier_type`, `regenerated`,
>   `fill.filled_fields` and `next`, never the password. Errors carry `error_type`:
>   `prompt_unavailable`, `save_declined`, `no_new_password_field`, `password_rules_unmet`,
>   `identifier_required`, `unknown_handle`, `identifier_mismatch`, `origin_mismatch`,
>   `origin_changed`, `fields_changed`, `fill_failed`, `save_failed`, plus the browser's own
>   `supervisor_required` when no supervised page session exists.
> - **Regenerating:** calling again with `handle` sends the request with `regenerate: true`, then
>   replaces that item's password and refills the form. The vault still holds one item.
>
> Two limits. Only local-vault items can be created or regenerated; nothing is written to
> 1Password or Bitwarden. And the item is bound to the sign-up page's origin only, so a provider
> that signs in on a different host needs the login saved there with `save_login`.
>
> **Acceptance:** met in the image test on a page with an email field and two `new-password`
> fields, one with `maxlength="16"`. Both fields get the same 16-character password, the vault
> holds one item for that origin, and the password is in neither the tool result nor the
> request frame. A later `browser_exec` that reads the field gets `«redacted-vault-secret»`.
> Declining leaves the vault and the fields empty. The test also covers regenerating, a password
> typed in the card, a `pattern` that refuses symbols, a sign-in page (refused before the user
> is asked) and no viewer that can answer. The tool-eval case `browser-signup-create-login`
> checks that a model calls `create_login` and not `save_login` on practice.expandtesting.com's
> register form. It hasn't been run against a live model yet.

## R2 · Capture a secret from a page without showing it to the model (Blocking for the API-key step)

**Why:** a dashboard shows a new API key once. If the agent reads the page to find it, the model has seen the key.

**Ask:** a tool, for example `browser_vault_capture_secret(name, selector="")`, run on the page that shows the value:

1. Without a selector it looks for the value itself: inputs and `code`/`pre` elements whose content looks like a key (long, no spaces, high entropy). With exactly one candidate it uses it; with several it returns their selectors and a masked form of each (last four characters) so the agent can choose without reading them.
2. It asks the viewer to approve, naming the site and `name`, not the value.
3. It stores the value at one of two destinations the call names:
   - `env`: the profile `.env` under `name`, as the `secret` request does, for keys a skill will use.
   - `viewer`: sends the value to the approving viewer in the answer channel only (a server request such as `secret.deliver` with `{name, origin, value}`), for keys the client keeps itself. Boundary uses this for inference keys, which it stores with the OS keychain.
4. It returns `name`, the destination and the last four characters.
5. For the rest of the session Hermes redacts the captured value from any tool output, in case the agent later reads that page.

**Acceptance:** on a test page that shows `sk-test-…` in a read-only input, a capture with destination `env` writes the profile `.env` line and the tool result holds only the last four characters; a following `browser_exec` that prints `document.body.innerText` shows the value redacted. With destination `viewer`, the value appears only in the server request frame to the viewer.

**Boundary fallback:** the agent tells the user where the key is in the dashboard, and the user pastes it into Boundary's settings or the `secret` card.

> **Stack reply (built, planned for 0.3.12):** done, with one change to the `viewer`
> destination.
>
> **Why the change:** a server→client request such as `secret.deliver` goes to every viewer
> attached to the session. Hermes also keeps its params to replay to a viewer that reconnects. The
> key would reach WebUI or a second Boundary window, and would sit in the replay buffer. Hermes'
> own rule is that secrets travel only in a viewer's response frame. So the value stays in
> Hermes, and Boundary fetches it with a method call.
>
> - **Call:** `browser_vault` with `{action: "capture_secret", name, destination: "env" |
>   "viewer", selector?, candidate?}`.
> - **Finding the value:** Hermes reads the page over the supervisor socket. It looks in inputs
>   and text areas (read-only too), and in `code`, `pre`, `kbd`, `samp` and other elements with
>   no child elements. A value counts if it has 20 to 4096 characters, no spaces, only key
>   characters, and either a known key prefix (`sk-`, `pk_`, `ghp_`, `xoxb-` and others) or a mix
>   of letters and digits with high entropy. URLs, paths and e-mail addresses don't count. With
>   one match it goes ahead. With several it returns `several_candidates`, each candidate numbered
>   with `where` (tag plus label, name or id), `last4` and `length`, and the agent calls again
>   with `candidate`. Every value read is registered for redaction straight away.
> - **Names:** both destinations need an environment-variable name (`^[A-Z][A-Z0-9_]{2,63}$`).
>   Names that would change how Hermes or a tool connects or runs are refused before the page is
>   read: `HERMES_*`, `API_SERVER_*`, `GATEWAY_*`, `LD_*`, `PYTHON*` and similar prefixes, names
>   ending in `_URL`, `_HOST`, `_PORT`, `_PROXY`, `_PATH` or `_DIR`, and `PATH`, `HOME` and the
>   proxy variables.
> - **Request:** `vault.capture_secret` with `{session_id, origin, site, name, destination, last4,
>   replaces, capture_id}`. It never contains the value. `"approve"` or `{"approve": true}`
>   approves, and anything else, or no answer in 180 seconds, declines. `replaces` is true when
>   `env` would overwrite an existing value. `capture_id` is set only for `viewer`.
> - **`env`:** saved to the profile `.env` with `save_env_value_secure`, the same call the `secret`
>   card uses. A provider key saved this way also lands in Hermes' credential pool, so Hermes
>   starts using it.
> - **`viewer`:** stored encrypted with the vault's key in `vault/captured.json.enc` under
>   `capture_id`, outside the vault, so `vault.list` never shows it. Boundary calls the new method
>   `vault.take` with `{profile?, id: capture_id}`. It returns `{name, origin, value}` and deletes
>   the capture. An unknown, already taken or hour-old capture is error `5095`. `vault.take` is
>   the only vault method whose result holds a secret.
> - **When to call `vault.take`:** the value is stored after Hermes receives your answer, so a
>   take sent at the same moment as the answer can arrive before the value is stored and get
>   `5095`. Call it once the `browser_vault` tool result arrives (it carries the same
>   `capture_id`), or retry once after a second.
> - **Result:** `name`, `destination`, `origin`, `last4`, `length`, `replaced`, and `capture_id`
>   for `viewer`. Errors: `destination_required`, `bad_name`, `no_secret_found`,
>   `several_candidates`, `bad_candidate`, `bad_selector`, `prompt_unavailable`,
>   `save_declined`, `save_failed`, and `scan_failed` or `supervisor_required` when the page
>   can't be read.
>
> **Acceptance:** met in the image test on a page showing `sk-test-…` in a read-only input.
> `env` writes the `.env` line, and the result and request hold only the last four characters.
> A following `browser_exec` that prints `document.body.innerText` and the input's value shows
> the key redacted. With `viewer`, the value appears only in the `vault.take` response, a second
> take fails, and `vault.list` doesn't show it. The test also covers declining, two keys on one
> page picked by `candidate`, a `selector`, reserved names and a page with no key.
>
> What capture can't handle: a key shown only behind a copy button, with nothing on the page. It
> returns `no_secret_found`, and the skill tells the agent to say where the key is. Catching
> clipboard writes is possible later if a provider you need works this way.
>
> **For Boundary's side:** answer the card with `"approve"`, call `vault.take`, and store the value
> with `osEncryption` as you planned. The `stack-contract.md` row and `test:stack` case would
> cover `vault.capture_secret` and `vault.take` instead of `secret.deliver`.

## R3 · A `browser-signup` skill (Wanted)

**Why:** the steps and their order matter as much as the tools, as `browser-login` showed. The skill should be general; Boundary passes the site and what to do after sign-up in its own prompt, so a change to one provider's dashboard needs no stack release.

**Ask:** a repo skill next to `browser-login` that covers:

- Ask the user for the identifier and any profile fields the form needs (such as name) before opening the page. Never ask for a password.
- Open the sign-up page, list the form's inputs as `browser-login` does, and type the identifier and profile fields.
- Ask the user before ticking a terms or privacy checkbox, quoting the link text.
- Call R1's tool when the `new-password` fields are visible, then submit.
- For an emailed or texted code, `browser_vault_enter_code` with the handle. For a verification link, ask the user to open it and say when it's done.
- Stop at a CAPTCHA and tell the user; never try to get past it.
- After sign-up, use R2's tool for any key the site shows, and never print page text while a key is on screen.

`browser-login` gains a line pointing to `browser-signup` when the open page is a sign-up form.

**Acceptance:** `hermes skills list` shows `browser-signup`. Tool-eval cases check a model asks for the identifier first, uses R1's tool on a sign-up page, and stops at a CAPTCHA.

**Boundary fallback:** Boundary's prompt for the flow carries these steps until the pinned tag has the skill.

> **Stack reply (built, planned for 0.3.12):** done as asked. `compose/hermes/skills/browser-signup`
> is general, with no provider in it:
>
> 1. Ask for the identifier and profile fields before opening the page, and never ask for a
>    password.
> 2. List the form's inputs, then type the identifier and profile fields.
> 3. Ask before ticking a terms or privacy box, quoting its link text.
> 4. Call `create_login` on the password step, then submit.
> 5. For verification, use `enter_code` for a code. For a link, ask the user to open it.
> 6. Stop at a CAPTCHA, or at a payment request on the form.
> 7. Go on to an API key only if asked. When the site shows the key, call `capture_secret`, and
>    don't read or print the page while it's on screen.
>
> `browser-login` (1.5.0) points to it.
>
> The skill tells the agent to ask which `name` and `destination` to use when the request doesn't
> say. Put both in your prompt for the inference-key step (for example
> `name: PREM_API_KEY, destination: viewer`) so it doesn't stop to ask.
>
> **Acceptance:** `hermes skills list` in the v0.22.7 image with the repo skills mounted shows
> `browser-signup`. Three tool-eval cases:
>
> - `browser-signup-asks-first`: no tools besides loading a skill.
> - `browser-signup-create-login`: `create_login` after `browser_exec` on practice.expandtesting.com.
> - `browser-signup-captcha`: Google's reCAPTCHA demo, at most four `browser_exec` calls and no
>   vault call.
>
> The scorer sees tool names only, so whether the reply asks for the identifier, or tells the user
> about the CAPTCHA, is a manual check. The cases haven't been run against a live model yet.

## Boundary's side

Boundary adds cards for `vault.create_login` and `vault.capture_secret`, checks `client.capabilities` for both before the flow offers them, fetches a `viewer` capture with `vault.take` once the tool result arrives and stores it with `osEncryption`, and lists items made by R1 under **Passwords & Logins** like any other login. Each lands with a `docs/stack-contract.md` row and a `test:stack` case once the pinned tag has the request.
