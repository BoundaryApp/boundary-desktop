# 0027. A host bridge gives Hermes the host's browser and capabilities

- Date: 2026-10-07
- Status: Accepted (2026-10-07), amended 2026-10-07 (route A uses a debugging pipe, not a port)
- Parent: [0001](0001-record-architecture-decisions.md)
- Related: [0026](0026-model-key-lives-in-proxy-memory.md) (secrets pushed from Boundary), [0006](0006-tool-approval-interrupt.md) (approval UI), [prior-art.md](../host-bridge/prior-art.md)

## Context

Hermes runs in Docker. Its browser tools launch a headless Chromium inside the container, with a fresh profile and no logins. It can't reach the user's Chrome, files, clipboard, notifications or Shortcuts. Hermes running directly on the Mac could reach those things. What it does to get them doesn't change:

- **Browser.** Every Hermes 0.21.3 browser mode drives Chrome over the DevTools Protocol (CDP): it launches its own Chromium, copies the real profile (`browser.use_real_profile`), or attaches to a `browser.cdp_url`. From Docker it can't launch the Mac's Chrome binary or read the profile folder. Chrome also rejects a `Host` header of `host.docker.internal`, the fix for CVE-2018-6101.
- **Everything else.** Hermes has no way to cross the container boundary. That boundary is the sandbox.

What we know, from research and from local tests on 2026-10-07 (Docker Desktop 4.94.0, Chrome 155):

1. **Every container can reach a host service bound to 127.0.0.1** through `host.docker.internal`. The bridge's token is the only real gate.
2. **The prior art is a broker at the boundary, not a tunnel.** Docker Sandboxes and the MCP Gateway are the model ([prior-art.md](../host-bridge/prior-art.md)). The incident record says the same thing: Zoom's localhost server, MCP Inspector (CVE-2025-49596), Ollama's DNS-rebinding bug, and Docker CVE-2025-9074. Each fix converged on a token, a loopback-only bind, `Origin` and `Host` checks, and no shell interpolation.
3. **`--remote-debugging-port` sets `navigator.webdriver = true`** on every page, even with no client attached. Defensive sites check this.
   - Two things cleared it, and with either one BrowserScan read "Normal":
     - `--disable-blink-features=AutomationControlled`, which works with Hermes's own Playwright driver;
     - an extension that attaches `chrome.debugger` only for input.
   - Chrome 144's consent-gated `chrome://inspect` toggle never set it on the user's own Chrome, whether switched on or with a client attached.
4. **The `Runtime.enable` leak no longer reproduces** on Chrome 155, even with stock Playwright.
5. **Hermes needs no patches for either half.**
   - A `browser.cdp_url` containing `/devtools/browser/` is used as-is, with no `/json/version` discovery (`tools/browser_tool_cdp.py`).
   - Hermes's MCP client speaks Streamable HTTP with a `url` and `headers`, and expands `${VAR}` in config from the profile's secret scope (`tools/mcp_tool_transport.py`, `mcp_tool_config.py`). `/reload-mcp` reconnects with the config re-read.
6. **Prompt injection is unsolved.** Anthropic's mitigations in Claude for Chrome cut attack success from 23.6% to 11.2%, not to zero. An agent holding signed-in sessions, untrusted page content and a way out completes the "lethal trifecta".

## Decision

1. **Boundary runs one host bridge, and main is the authority.**
   - The bridge runs in an Electron `utilityProcess`. Main owns policy, grants, approvals and tokens, and talks to it over a MessagePort.
   - It has two listeners, each with its own token, so a leaked capability token never grants browser control:
     - an **MCP server** (Streamable HTTP) for host capabilities;
     - a **browser relay** for CDP.
   - The bridge lives only while Boundary runs. With Boundary closed, Hermes's bridge tools fail with "Boundary isn't running", the same gap 0026 accepts for the model key.

2. **Both listeners are hardened the way the CVEs demand.**
   - Bind to `127.0.0.1` on a random port; never `0.0.0.0`.
   - Require a bearer token of at least 128 bits from a CSPRNG, compared in constant time.
   - Reject any request that carries an `Origin` header; Hermes's clients don't send one, and browsers always do.
   - Accept only an exact `Host`: `host.docker.internal:<port>` or `127.0.0.1:<port>`.
   - Send no CORS headers.
   - Apply the same checks to WebSocket upgrades.

3. **Tokens reach Hermes through its profile secrets, not compose env.**
   - Boundary generates the tokens when it provisions the stack and keeps them with `safeStorage` (0015).
   - It writes `BOUNDARY_BRIDGE_TOKEN` and `BOUNDARY_BROWSER_TOKEN` to each Hermes profile's `.env`.
   - Hermes's config refers to them as `${BOUNDARY_BRIDGE_TOKEN}`. They never appear in `docker inspect`.
   - Rotation happens on stack re-provision, or from Settings, followed by `/reload-mcp` or a gateway restart.
   - `hermes-webui` mounts the same Hermes data folder and can read the tokens. It is part of the trusted Hermes stack; the other containers (OpenCode, n8n, LightRAG and so on) can't.

4. **Browser, first: a Boundary-managed Chrome profile through the relay (route A).** Amended 2026-10-07: a debugging pipe, not a port.
   - The bridge process launches the user's Google Chrome with:
     - its own `--user-data-dir` under Boundary's app data (`userData/agent-browser/profile`);
     - `--remote-debugging-pipe`;
     - `--disable-blink-features=AutomationControlled`.
   - **Why a pipe and not a port.** A debugging port has no authentication. Every container can reach host loopback, and Chrome only checks that the `Host` header is an IP, which a container can send. So the agent's shell in `hermes-worker` could find the port and bypass the relay's filter. With the pipe, Chrome has no socket at all, and the bridge is the only way in.
   - **One pipe, several clients.** Hermes opens more than one CDP connection (its driver, plus a dialog supervisor), but a pipe is a single connection. A multiplexer in the bridge (`cdpMux.ts`) shares it:
     - per-client id spaces;
     - sessions private to the client that attached them;
     - browser-wide auto-attach and target discovery emulated per client, so clients can't override Chrome's single setting for each other.
   - Chrome starts on Hermes's first connection, or when the user opens it from Settings to sign in. It stays open until Boundary quits, so logins and tabs carry across agent sessions.
   - Hermes connects to `ws://host.docker.internal:<browser port>/devtools/browser/boundary?token=<browser token>`, set as `browser.cdp_url` on each profile when the user turns the browser on.
     - The `/devtools/browser/` path makes Hermes skip `/json/version` discovery, which the relay doesn't serve.
     - The token is in the query because the driver takes a URL, not headers. Hermes masks CDP query strings in its logs.
     - Hermes reads `cdp_url` on every browser call, so turning the browser on or off needs no restart.
   - Off by default. The user turns it on in Settings → Agent browser, which also opens Chrome for signing in.
   - Why this route first: Chrome supports it, it needs no extension, the spike shows Hermes's own driver passes the static detectors on it, and the agent only ever holds the logins the user chose to put in that profile.

5. **The relay filters CDP; it does not just forward it.**
   - The first release blocks the methods that read or export credentials wholesale:
     - `Network.getAllCookies`, `Network.getCookies`, `Network.setCookie(s)`;
     - `Storage.getCookies`, `Storage.setCookies`;
     - `DOMStorage.*`, `IndexedDB.*`, `CacheStorage.*`;
     - `Fetch.*` interception and `IO.read`.
     - It also refuses `Target.exposeDevToolsProtocol` (gives page script a CDP binding) and `Target.attachToBrowserTarget`.
     - It answers `Browser.close` itself and disconnects only that client, so a driver's "close" never quits the user's agent browser.
     - One exception to the `Fetch.*` block: Hermes answers page dialogs (alert, confirm) through a "dialog bridge". A page script requests `http://hermes-dialog-bridge.invalid/`, and Hermes intercepts that request. So `Fetch.enable` passes when every pattern is that fake host and auth interception is off, along with the calls that answer paused requests. Nothing else can be intercepted.
   - It logs every other method it sees, per client connection, to the debug log.
   - Once a release of agent-browser has been traced, the filter becomes an allowlist of what it actually calls.
   - `Runtime.evaluate` stays: Playwright needs it, and an origin-scoped gate on it is a follow-up. Until then, site policy (decision 6) and egress (consequences) carry that risk.

6. **Browsing has a site policy owned by Boundary.**
   - The relay checks every `Page.navigate`, new tab and attach against an allowlist and a blocklist that the user edits in Settings → Agent browser.
   - While Hermes is connected, a page that moves to a blocked site (a link, a redirect, script) is closed.
   - Banking, email and password-manager domains are blocked by default.
   - `file:` and browser-internal pages (`chrome:`, `chrome-extension:` and so on) are always refused, because the agent's browser runs on the Mac.
   - A blocked navigation fails the tool call with a reason Hermes can relay.

7. **Host capabilities are typed MCP tools with portal-style grants.**
   - Boundary defines the tool list. It never forwards one from the container, and it never changes the list mid-session without asking again.
   - The first tools are `desktop_notification`, `open_url`, `clipboard_read`, `clipboard_write`, `pick_files`, `read_file` and `write_file`.
     - The three file tools only work on paths granted through a native picker.
     - `clipboard_read` and `write_file` ask every time.
     - What "Always allow" covers, as built in phase 4:
       - `open_url`: one site.
       - `clipboard_write` and `desktop_notification`: every call.
       - `pick_files`: no approval step; choosing files in the picker is the consent, and it grants `read_file` on exactly those files for 24 hours.
       - `write_file`: no approval step; the Save dialog is the consent, every time.
   - Raw shell and AppleScript tools are out of scope. Shortcuts come later as `run_shortcut(name)` from a list the user curates.
   - Grants are records in main, scoped to a capability and a resource, with an expiry. They are created at first use through the approval interrupt (0006), and Settings lists them for revocation.
   - The approval shows Boundary's own reading of the call (path, URL, Shortcut name), never text the agent wrote.
   - Every call goes to an append-only audit log with secrets redacted.
   - A "Stop agent" control revokes both tokens and closes the relay.

8. **The real profile comes next, through Chrome's own remote-debugging toggle (route B).**
   - The user turns on `chrome://inspect/#remote-debugging` in their own Chrome.
   - Boundary reads `DevToolsActivePort` from the profile folder and holds one connection, so Chrome asks for consent once per bridge session. It waits as long as a person needs to click Allow, and never deletes the file; deleting it is what broke agent-browser (#2041).
   - Hermes reaches it through the same relay, filter and site policy as route A.
   - Unlike a launch-flag port, the toggle's listener is WebSocket-only, with no `/json` discovery. Its path carries a random id that only `DevToolsActivePort` on the Mac knows, and Chrome asks for consent on each connection. A container that finds the port can't use it, which is why route B can keep a port while route A needs the pipe.
   - The spike checked this on the user's Chrome 155: `navigator.webdriver` stayed false with the toggle on and with a client attached. Route B therefore needs no masking flag, and it needs no extension.
   - **Route C**, a Boundary extension that attaches `chrome.debugger` only for input, is the fallback. It is equally clean in the spike (no flag, trusted input) and scoped to tabs rather than the whole profile. It costs a published extension, a native-messaging helper, and keeping the extension's background worker alive. Build it only if whole-profile access through route B proves too broad for users to accept. It would plug into Hermes's `browser.extension_control` lane, with Boundary minting the single-use tickets.

## Consequences

- **The bridge is a new trust boundary that Boundary owns.** A bug in token checks or `Host`/`Origin` handling is the class of bug in the CVEs above. The listeners get unit tests for each check before any capability ships.
- **Route A is a separate profile, not the user's real Chrome.** The user signs in again to the sites the agent needs. That is also its safety property.
- **The masking flag is an evasion flag, and Google may change it.** If Chrome drops or fingerprints it, route A goes back to `webdriver = true`. Routes B and C don't depend on it. Re-run the spike, including the route B check, on each Chrome major version.
- **Route B gives Hermes the whole real profile once the user approves.** That means every tab, cookie and signed-in session, limited only by the relay's filter and site policy. Chrome shows its automation banner while connected. Boundary's UI has to say plainly what turning it on grants, and make disconnecting one click.
- **Static checks are only one layer of detection.** Sites like LinkedIn also limit by behaviour, and LinkedIn's user agreement prohibits automated access. The agent should browse at human pace, and Boundary shouldn't present agent browsing of such sites as safe for the account.
- **`Runtime.evaluate` remains the biggest browser hole.** Script in a signed-in page can read `document.cookie` and make authenticated requests. The site policy limits where that can happen. Restricting Hermes's outbound network while a browser session is attached, to llm-proxy plus allowlisted sites, is the structural fix. It belongs in its own ADR, because it changes the compose network.
- **Two browser modes exist.** Without route A configured, Hermes keeps its in-container Chromium. The browser tools must say which one they're using.
- **Code:**
  - `src/main/services/hostBridge/`:
    - `bridgeProcess.ts` is the utilityProcess entry, bundled to `.vite/build/hostBridge.js` by `vite.hostBridge.config.ts`.
    - `bridgeServer.ts` holds both listeners; `requestGuard.ts` does the token, `Origin` and `Host` checks.
    - `mcpProtocol.ts` and `toolCatalog.ts` are the MCP server.
    - `hostBridgeService.ts` runs the process from main; `hostTools.ts` handles policy, approval, the action and the audit entry.
    - Supporting modules: `approvals.ts`, `hostBridgeStore.ts` (tokens, ports, grants), `auditLog.ts` (`userData/host-bridge/audit.jsonl`), and `hermesProvision.ts`.
  - `applyLlmConnectionToHermes` in `AssistantStackService.ts` provisions Hermes before its restart.
  - Approval card: `HostBridgeApproval.tsx` and `useHostBridgeApprovals.ts`, in `WorkbenchThread`'s interrupt slot.
  - Browser (route A), all in `src/main/services/hostBridge/`:
    - Bridge process: `chromePipe.ts` (Chrome on the pipe), `cdpMux.ts` (the multiplexer), `cdpPolicy.ts` (blocked methods and sites) and `browserRelay.ts` (glue).
    - Main: `browserConfig.ts` (Chrome path, profile folder, site lists), and `applyHostBridgeBrowserToHermes` in `AssistantStackService.ts` (`browser.cdp_url`).
    - Settings: `AgentBrowserPanel.tsx`.
    - `browserRelay.live.test.ts` drives the relay against the real Chrome with `BOUNDARY_LIVE_CHROME=1`.
  - Settings → Computer access (`ComputerAccessPanel.tsx`) lists grants, with Revoke and Revoke all.

## Phases

1. **Spike (done).**
2. **Bridge skeleton (done 2026-10-07).**
   - `utilityProcess`, both listeners with hardening and tests, and token provisioning into the profile `.env`.
   - One MCP tool (`desktop_notification`) end to end, with an approval and an audit entry.
   - Implementation notes:
     - The MCP server is hand-rolled: POST only, JSON responses, no sessions or SSE. It covers `initialize`, `ping`, `tools/list` and `tools/call`; this keeps the security-critical surface small and avoids bundling an SDK.
     - Hermes 0.21.3's own MCP client (Python SDK 2.0) negotiated `2025-11-25`, listed and called the tool from inside the container, and got a 401 on a wrong token.
     - Ports are picked once and kept, so Hermes's config is stable across launches. If a port is taken, the bridge takes a free one and the next launch re-provisions Hermes.
     - Approvals deny after 120 seconds. Hermes's call timeout is 180 seconds.
     - **The tool was first called `notify`.** Asked to "send me a notification", Hermes picked its own `send_message` tool and delivered to Signal. It's now `desktop_notification`, and its description says it never posts to a chat platform. The grant keeps the name `notify`, so earlier "Always allow" answers still apply.
     - **The config entry carries a tool-list fingerprint** (`X-Boundary-Tool-Catalog`). Hermes keeps the tool list it fetched when it connected. A changed catalog therefore changes the config, which makes Boundary restart Hermes once so it lists the tools again.
     - Agent profiles under `profiles/<slug>` aren't provisioned yet; only the default, `api-server` and `browser` profiles are.
     - **Local-stack mode gets the bridge too.** It still leaves the developer's model settings alone (0026 §6).
       - Boundary adds the token lines and the `boundary` MCP entry to the dev stack's profiles, writing only what is missing or different.
       - It restarts `hermes` only when something changed, so an unchanged launch doesn't interrupt the dev stack.
       - While Boundary is closed, that Hermes logs failed connections to the `boundary` server and runs without its tools.
3. **Route A (done 2026-10-07).**
   - Chrome launcher, relay with the denylist and method logging, `browser.cdp_url` wiring, and site policy.
   - Implementation notes:
     - Chrome runs on a debugging pipe, and a multiplexer shares it (decision 4).
     - Chrome announces a new page's session before it replies to `Target.createTarget`, and Playwright depends on that order. The multiplexer holds the reply until the client's session on the new page is announced.
     - The live test on Chrome 155:
       - Playwright connected, opened and read a page, and took a screenshot, with `navigator.webdriver` false.
       - It was refused Gmail, `file://` and `context.cookies()`.
       - A second raw client attached to the same page at the same time.
       - The page was still there after Playwright disconnected and reconnected.
     - The bundle needs Node module resolution: `ws` ships a browser stub that only throws.
     - `--test-type` hides Chrome's "unsupported command-line flag" bar for the masking flag. Over the pipe without the masking flag, `navigator.webdriver` is `true`; with both flags it is `false`.
     - In-app check with the dev stack (Hermes 0.21.3, browser-use backend):
       - Hermes's `browser_exec` harness and its dialog supervisor connected through the relay with nothing blocked.
       - It opened the user's signed-in LinkedIn feed in Boundary's Chrome and summarised it.
       - It got a blocked-sites error for Gmail.
       - With the switch off, Hermes used its own in-container Chromium, as designed.
     - Hermes's harness used: `Target.getTargets`, `Target.createTarget`, `Target.attachToTarget`, `Target.getTargetInfo`, `Page.enable`, `Page.navigate`, `DOM.enable`, `Runtime.enable`, `Runtime.evaluate`, `Network.enable`, `Network.disable` and `Input.dispatchMouseEvent`. Its dialog supervisor used: `Target.setAutoAttach` (per session), `Page.addScriptToEvaluateOnNewDocument` and the dialog-bridge `Fetch.enable`.
     - When the switch is off and Hermes hits a logged-out page, it may try a saved vault login in its throwaway in-container browser. Worth steering away from for sites that watch for new-device logins.
   - Still to do: turn the denylist into an allowlist. Start from the two traces above plus the live test's Playwright trace: `Browser.getVersion`, `Browser.setDownloadBehavior`, `Target.setAutoAttach`, `Target.createTarget`, `Target.getTargetInfo`, `Page.enable`, `Page.getFrameTree`, `Page.setLifecycleEventsEnabled`, `Page.addScriptToEvaluateOnNewDocument`, `Page.createIsolatedWorld`, `Page.navigate`, `Page.getLayoutMetrics`, `Page.captureScreenshot`, `Runtime.enable`, `Runtime.runIfWaitingForDebugger`, `Runtime.evaluate`, `Runtime.callFunctionOn`, `Runtime.releaseObject`, `Network.enable`, `Log.enable`, `Emulation.setFocusEmulationEnabled` and `Emulation.setEmulatedMedia`.
4. **Remaining host capabilities (built 2026-10-08; in-app check pending).**
   - The six tools from decision 7 besides `desktop_notification`: `open_url`, `clipboard_write`, `clipboard_read`, `pick_files`, `read_file`, `write_file`.
   - Settings → Computer access for grants.
   - Implementation notes:
     - Every tool goes through one gate in `hostTools.ts`: check the grant, otherwise ask, then audit. A call without an "Always allow" description shows only Allow and Deny.
     - Limits:
       - `open_url`: http(s) only, 2,048 characters.
       - Clipboard: 100,000 characters.
       - `pick_files`: up to 20 files.
       - `read_file`: up to 1 MB of UTF-8 text; files containing a NUL byte are treated as binary and refused.
       - `write_file`: 5 MB; only the base name of `suggested_name` is used, starting in Downloads.
     - The audit never holds clipboard text or file contents, even on invalid calls; only sizes, counts and paths.
     - Native dialogs bring Boundary's window forward first, so the picker isn't hidden behind another app.
     - Expired grants (picked files) are pruned whenever a grant is added.
     - The tool-catalog fingerprint changed, so the next launch restarts Hermes once to list the new tools.
     - `pick_files` returns a `how_to_read` note with the paths. Without it, Hermes opened the host paths with its own file tools, inside the container, and found nothing.
     - The chat shows a note while Hermes can't use the tools. Hermes parks an MCP server after 5 failed reconnects and retries it only every 300 s. So after Boundary relaunches, the chat can be ready minutes before the tools. Meanwhile Hermes improvises (`notify-send`, Signal). Several Hermes processes connect: one per gateway profile, plus the dashboard. Each retries on its own schedule, and the first to connect needn't be the one serving the chat; on 2026-10-08 the chat's process reconnected 33 s after the first. So the bridge gives each client an MCP session at `initialize`, used only to tell clients apart, and counts the sessions that list the tools. Main tracks `off` → `waiting` → `connected`. It says `connected` once as many clients have connected as last launch, or 330 s after the bridge started (every parked process has had its retry by then). The count is stored for next time.
     - The stack (assistant `73b2c10`, 2026-10-08) added a wake: `POST /v1/mcp/servers/{name}/reconnect` on the API server revives a parked server in every profile, and `mcp_servers.<name>.parked_retry_interval` shortens the parked retry. Boundary calls the wake once Hermes is healthy after a start. It also provisions `keepalive_interval: 15`, `parked_retry_interval: 15` and `connect_timeout: 60`, the stack's guidance for an app-hosted server; 10 s gave up on a bridge that was down when Hermes started, instead of parking it where a wake can reach it. An accepted wake (202) cuts the fallback to 30 s: every parked process reconnects within about a second, and the stack keeps a request live for 30 s. An older stack answers the wake with 404, and the 330 s fallback still applies there. There's no way to see Hermes drop the connection while Boundary runs, since it's POST only, so `connected` holds until the bridge stops. Closing the gap needs a reconnect hook in the stack.
5. **Real profile through route B.** Route C only if whole-profile access proves too broad.
