# Build Boundary's bridge as a gatekeeper, not a tunnel

> Research report, 2026-10-07. It predates the finding that `--remote-debugging-port` sets `navigator.webdriver`. [ADR 0027](../adr/0027-host-bridge.md) is the decision; where they differ, the ADR wins.

The prior art supports Boundary's plan. A host-resident broker owns the secrets, the policy and the consent. The agent runs in an isolated container or VM and reaches the broker over an authenticated channel. Docker's own Sandboxes product uses this shape: a host-side proxy injects credentials and "an MCP gateway runs on the host boundary" ([Docker docs](https://docs.docker.com/ai/sandboxes/architecture)). Electron apps such as Claude Desktop and Bitwarden ship the browser half of it, with a signed helper binary that relays to the main app.

What separates the safe versions from the CVE list is simple. Reaching the endpoint must never count as authorization. Our local test (Docker Desktop 4.94.0, 2026-10-07) showed that a server bound only to host `127.0.0.1` is reachable from inside the Hermes container through `host.docker.internal`. So every container and every local process can reach Boundary's listener, and the bearer token is the only real gate.

For browsing, there are three proven ways to drive a signed-in Chrome:

- A dedicated automation profile.
- Chrome 144+'s consent-gated "autoConnect" to the user's real profile.
- A `chrome.debugger` extension.

All three need a host-side relay in Boundary. Full CDP on a real profile is equivalent to session theft, so that relay must filter commands, not just forward them. Hermes 0.21.3 already has two useful hooks. A `cdp_url` containing `/devtools/browser/` skips discovery, and a ticketed `extension_control` lane fails closed. So Boundary can build the bridge without patching Hermes.

## Docker, VS Code and Codex show two broker designs, and only one survives scrutiny

Shipping systems that let sandboxed code touch the host split into two families. In the first, **the transport is the authorization**. VS Code Dev Containers inject Unix sockets and environment variables into every container: `VSCODE_IPC_HOOK_CLI`, git credential sockets, `SSH_AUTH_SOCK`, and `BROWSER`, which "can trigger actions on host via --openExternal". Any process in the container inherits those powers. Hardening guides now tell users to delete the sockets in `postStartCommand` ([devcontainer-security guide](https://tessl.io/registry/daaain/devcontainer-security/files/SECURITY-HARDENING.md)). Docker Desktop Extensions work the same way: declared host binaries run "with user access rights" and there is no consent step per call ([Docker docs](https://docs.docker.com/extensions/extensions-sdk/guides/invoke-host-binaries/)). Docker's CVE-2025-9074 (CVSS 9.3) shows where this ends: containers reached the unauthenticated Engine API at `192.168.65.7:2375` and could create containers and mount host drives ([CVE record](https://cve.circl.lu/cve/CVE-2025-9074)). "Only reachable from inside Docker" is not a security boundary.

The second family **puts a policy-enforcing broker at the boundary**. Docker's MCP Gateway is "a centralized proxy between clients and servers, managing configuration, credentials, and access control" ([Docker docs](https://docs.docker.com/ai/mcp-gateway/)). It supports `before:` and `after:` interceptors that can enforce policy, validate parameters, mask secrets and log for audit ([CLI reference](https://docs.docker.com/reference/cli/docker/mcp/gateway/run/)). Docker Sandboxes (March 2026) add a host proxy that rewrites headers, so agents "see sentinel values instead of real credentials" ([Docker docs](https://docs.docker.com/ai/sandboxes/architecture)). Codex states the split clearly: "The sandbox provides technical enforcement while approvals define when escalation occurs" ([Codex docs](https://learn.chatgpt.com/docs/sandboxing)). Anthropic's sandbox-runtime routes all egress through host-side proxies. It warns that allowlisting Unix sockets risks "exposing powerful system services like Docker" ([GitHub](https://github.com/anthropic-experimental/sandbox-runtime)).

Linux's xdg-desktop-portal is the cleanest consent model. A sandboxed app requests a capability over D-Bus. A trusted backend shows native UI, such as a file chooser. The grant comes back as a narrow handle, and a permission store remembers it ([xdg-desktop-portal docs](https://flatpak.github.io/xdg-desktop-portal/docs/)). Boundary already sits where these designs put the broker: it holds the model key in the llm-proxy (ADR 0026), rewrites localhost URLs for containers, and has an approval UI. The bridge extends an existing trust position rather than creating a new one.

## Twelve shipping apps reveal the pairing patterns worth copying

The most relevant precedents are desktop apps that expose host capabilities to a separate process. The table summarizes them. The right-hand column is the lesson for Boundary.

| App (stack) | Bridge mechanism | Auth / consent | Lesson for Boundary |
|---|---|---|---|
| Claude Desktop + Claude in Chrome (Electron) | Signed helper `Contents/Helpers/chrome-native-host` via native messaging; Unix socket to app ([claudeissues #20316](https://claudeissues.com/issue/20316-bug-claude-in-chrome-fails-when-claude-desktop-native-messaging-host-config-exis)) | `allowed_origins`, plus site permissions and high-risk confirmations ([Anthropic](https://www.anthropic.com/news/claude-for-chrome)) | Closest analogue. A manifest collision with Claude Code broke attach for months, so use a unique host name |
| Bitwarden (Electron) | `desktop_proxy` native host → IPC to app; the app writes its own manifests ([Bitwarden docs](https://contributing.bitwarden.com/getting-started/clients/browser/biometric)) | Optional fingerprint verification per link | App-level pairing on top of the transport |
| KeePassXC (Qt) | `keepassxc-proxy` → Unix socket; NaCl `box` encryption; "associate" key per database ([protocol](https://github.com/keepassxreboot/keepassxc-browser/blob/master/keepassxc-protocol.md)) | User approves and names each association | Best-documented pairing protocol |
| 1Password (native) | Native messaging; verifies the browser's code signature ([1Password community](https://1password.community/discussion/comment/373979)) | Signature check | Authenticates the peer binary |
| Zotero | HTTP on `127.0.0.1:23119`; a custom header forces a CORS preflight ([zotero-dev](https://groups.google.com/g/zotero-dev/c/ElvHhIFAXrY/m/fA7SKKwsAgAJ)) | CSRF gate only | Simple, but any local process can call it |
| Figma desktop (Electron) | MCP at `127.0.0.1:3845/mcp` ([Figma docs](https://developers.figma.com/docs/figma-mcp-server/local-server-installation)) | No documented token | Same shape as Boundary's plan; too permissive to copy |
| LM Studio (Electron) | Local REST; optional API token since 0.4 ([docs](https://lmstudio.ai/docs/developer/core/authentication)) | Off by default | Token should be mandatory |
| Obsidian Local REST API (Electron plugin) | HTTPS `127.0.0.1:27124`, self-signed cert, bearer key ([plugin page](https://community.obsidian.md/plugins/rest-api)) | Static bearer | Workable baseline |
| Discord (Electron) | RPC WebSocket on 127.0.0.1:6463–6472 plus IPC ([Discord docs](https://docs.discord.com/developers/topics/rpc)) | Registered origin + OAuth-style authorize | Explicit authorize step per client |
| Claude Desktop Extensions (.mcpb) | Local MCP servers; sensitive config in the Keychain ([Anthropic](https://www.anthropic.com/engineering/desktop-extensions)) | Admin allow/block | Unsandboxed full privilege enabled zero-click RCE ([CSO Online](https://www.csoonline.com/article/4129820/anthropics-dxt-poses-critical-rce-vulnerability-by-running-with-full-system-privileges.html)) |
| Docker Desktop (Electron UI) | Host binaries, MCP Gateway, Sandboxes proxy | Gateway interceptors; credential injection | The architecture target |
| Playwright MCP `--extension` | WebSocket relay + MV3 extension using `chrome.debugger` ([cdpRelay.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/cdpRelay.ts)) | Approval in the browser, or a token; per-client tab groups | Reference relay implementation |

The incident record is consistent. Zoom's hidden `localhost:19421` server let any website join users to calls; Apple pushed a silent update to remove it ([The Hacker News](https://thehackernews.com/2019/07/zoom-video-conferencing-hacking.html)). The MCP Inspector proxy (CVE-2025-49596, CVSS 9.4) took unauthenticated commands and was exploitable from a web page via `0.0.0.0` plus CSRF ([Recorded Future](https://www.recordedfuture.com/blog/anthropic-mcp-inspector-cve-2025-49596)). Ollama fell to DNS rebinding in about three seconds ([NCC Group](https://www.nccgroup.com/research/technical-advisory-ollama-dns-rebinding-attack-cve-2024-28224/)). A third-party Figma MCP server passed unsanitized input to `child_process.exec` ([The Hacker News](https://thehackernews.com/2025/10/severe-figma-mcp-vulnerability-lets.html)). Every fix converged on the same four controls: a token, a loopback bind, Origin and Host validation, and no shell interpolation.

The MCP spec now encodes these controls. Streamable HTTP servers "MUST validate the `Origin` header", "SHOULD bind only to localhost", and "SHOULD implement proper authentication" ([MCP spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)). The security best-practices draft says local servers should "Require an authorization token". It also says a server "MUST NOT treat possession of a state handle as authentication" ([MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)).

## Three ways to reach a signed-in Chrome, each needing a host relay

Chrome itself changed the rules. Since Chrome 136, `--remote-debugging-port` is ignored for the default profile, because infostealers used it to extract cookies after App-Bound Encryption ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)). Chrome 144 added a sanctioned way back in. The user enables remote debugging at `chrome://inspect/#remote-debugging`. Chrome then opens a WebSocket-only listener on `127.0.0.1` (typically 9222), writes `DevToolsActivePort`, and asks "Allow remote debugging?" for each connection. While the session is active it shows the "controlled by automated software" banner ([Chrome blog](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)). This mode has **no `/json/version` endpoint** ([chrome-devtools-mcp #772](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/772)). Hermes's `/browser connect` deliberately rejects it, because it requires a 2xx from `/json/version` ([hermes-agent #12912](https://github.com/NousResearch/hermes-agent/issues/12912)).

The Hermes 0.21.3 source fills that gap. In `tools/browser_tool_cdp.py`, a `browser.cdp_url` containing `/devtools/browser/` skips discovery and is used as-is. So Hermes can point at `ws://host.docker.internal:<port>/devtools/browser/<ticket>` on a Boundary relay.

A relay is unavoidable for two more reasons. First, Chrome's DevTools server rejects any `Host` header that is not an IP address or `localhost`. That check is the fix for CVE-2018-6101, and it breaks `host.docker.internal` connections ([go-rod #510](https://github.com/go-rod/rod/discussions/510); [NVD](https://nvd.nist.gov/vuln/detail/CVE-2018-6101)). Google's own workaround for VMs is a tunnel that makes the client appear as `127.0.0.1` ([troubleshooting.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md)). Second, Hermes's `browser.use_real_profile` snapshots the host profile from disk, so it cannot work inside Docker.

The three viable routes compare as follows:

| Route | How Boundary implements it | Strengths | Weaknesses |
|---|---|---|---|
| **A. Dedicated Boundary profile** | Launch Chrome with a non-default `--user-data-dir` and `--remote-debugging-port`. The user signs in to the sites the agent needs. Boundary relays CDP | Officially supported since Chrome 136; no extension; no prompt per connection; cookies isolated from the main profile | Separate logins; this is not "your real Chrome" |
| **B. Real profile via M144 autoConnect** | Boundary reads `DevToolsActivePort`, opens one long-lived WebSocket to Chrome over loopback, and relays a filtered CDP stream to Hermes | True real-session access with Google's consent prompt; Hermes works unmodified via the `/devtools/browser/` path | The grant covers the **whole profile**: cookies, storage, all tabs ([Chrome docs](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)). Other clients have hit fragile timeouts while the prompt is pending ([agent-browser #2041](https://github.com/vercel-labs/agent-browser/issues/2041)) |
| **C. Extension (`chrome.debugger`)** | Ship an MV3 extension. Either Playwright-style, with the extension dialling a relay in Boundary, or using Hermes's `extension_control` lane | Tab-scoped; works with any Chrome; per-tab-group isolation is proven in Playwright; Hermes's lane already enforces an action allowlist and fails closed | Boundary must build and publish an extension (none ships with Hermes); "started debugging" infobar on every tab ([claudeissues #69287](https://claudeissues.com/issue/69287-claude-in-chrome-started-debugging-this-browser-banner-shows-on-every-tab-please)); MV3 service worker goes idle ([Claude Code docs](https://code.claude.com/docs/en/chrome)); attach is blocked under some enterprise policies from Chrome 155 (unverified secondary source) |

Route C's Hermes lane deserves attention because Hermes already does the security work. In `extension_control`, a caller holding the bearer key POSTs to `/v1/browser-control/register` and receives a 30-second, single-use ticket bound to the session. The extension then connects to `/v1/browser-control/ws` with that ticket in `Sec-WebSocket-Protocol`. Actions are limited to navigate, click, type, scroll, snapshot, screenshot and tabs. Raw CDP and evaluate are allowed only in developer mode (Hermes 0.21.3 source).

In Boundary, main would hold the Hermes key, mint the ticket, and hand only the ticket to the extension, through native messaging or a loopback socket. That mirrors the KeePassXC pairing pattern. The cost is distribution and upkeep of an extension. Browser MCP shows the risk: it adapted Playwright's extension and has been effectively unmaintained since April 2025 ([GitHub](https://github.com/BrowserMCP/mcp)).

Whichever route Boundary uses, it must filter CDP. CDP exposes `Network.getAllCookies` ([CDP Network](https://cdpstatus.reactnative.dev/devtools-protocol/tot/Network)). `Runtime.evaluate` can read `document.cookie` and make authenticated `fetch()` calls. `Fetch.enable` exposes auth headers. Even Playwright's relay passes through everything it does not fake ([cdpRelayV2.ts](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/cdpRelayV2.ts)). The research found **no published, vetted CDP filtering proxy**, so Boundary would own that allowlist, and it needs review against the current CDP tip-of-tree.

## The agent is the most likely attacker, so consent must be structural

Network attackers are the easier threat to handle. The harder one is Hermes itself after a prompt injection. Giving it a logged-in browser, untrusted web content and any outbound channel completes Willison's "lethal trifecta" ([Simon Willison](https://simonwillison.net/2025/Aug/26/piloting-claude-for-chrome/)).

Every agentic browser has been compromised this way. Brave got Comet to exfiltrate a Gmail OTP through a hidden Reddit comment ([Brave](https://brave.com/blog/comet-prompt-injection/)). Anthropic's mitigations for Claude for Chrome cut attack success only from **23.6% to 11.2%**. Those mitigations were site permissions, confirmations before publishing, purchasing or sharing personal data, default blocks on financial sites, and classifiers ([Anthropic](https://www.anthropic.com/news/claude-for-chrome)). OpenAI's CISO calls prompt injection "a frontier, unsolved security problem" ([Simon Willison](https://simonwillison.net/2025/Oct/22/openai-ciso-on-atlas/)). The Claude Desktop Extensions zero-click RCE came from chaining a calendar connector into a full-privilege local tool. Anthropic declined to fix it, treating it as a matter of user consent ([Infosecurity Magazine](https://www.infosecurity-magazine.com/news/zeroclick-flaw-claude-dxt/)).

The implication for the capability half is concrete. Heuristic guards on AppleScript, such as pattern blocklists in `mcp-applescript` and the Strict, Balanced and Permissive profiles in `mcp-server-osascript` ([Glama](https://glama.ai/mcp/servers/FradSer/mcp-server-osascript)), are weak against a model that can rephrase. Typed, narrow tools are safer: `notify(title, body)`, `clipboard_read()` with confirmation, `run_shortcut(name)` from a user-curated list, and file access through a native picker in the portal style. Raw script or shell tools should require approval for every call.

Boundary should also define the tool list itself rather than accept one from the container. Invariant Labs' tool poisoning and "rug pull" attacks abuse descriptions and `tools/list_changed` notifications ([CSA](https://labs.cloudsecurityalliance.org/research-rb/csa-whitepaper-mcp-security-tool-poisoning-20260506-csa-styl/)). One spec subtlety matters here. Hermes is the MCP client, so MCP elicitation would surface in Hermes's UI rather than Boundary's. Approval should instead block the tool call inside Boundary's own approval UI.

## Recommendations for Boundary

**1. Run one broker host process with two listeners.** Run the broker in an Electron `utilityProcess`, which gives crash isolation and a MessagePort to main ([Electron docs](https://www.electronjs.org/docs/latest/api/utility-process)). Keep main as the policy and consent authority. The process hosts an **MCP Streamable HTTP server** for host capabilities and a separate **CDP relay**, each with its own token, so leaking the capability token does not grant browser control.

One open choice concerns `disclaim: true`. It stops the broker from silently inheriting Boundary's TCC grants for Automation, Accessibility and so on. The cost is that macOS prompts may attribute to the helper rather than Boundary. Test which behaviour you want before shipping AppleScript tools.

**2. Harden the listeners the way the CVEs demand.**

- Bind to `127.0.0.1` only; the local test confirms containers still reach it. Never bind to `0.0.0.0`.
- Use a random port.
- Generate a CSPRNG token of at least 128 bits for each Hermes container launch and compare it in constant time.
- Reject any request that carries an `Origin` header; Hermes's clients do not send one.
- Allowlist `Host` exactly (`host.docker.internal:<port>`, `127.0.0.1:<port>`).
- Send no CORS headers.
- Apply the same checks to WebSocket upgrades.

Deliver the token the way ADR 0026 delivers the model key, by pushing it into container memory, or through a read-only mounted file. Avoid `-e`, because `docker inspect` exposes environment variables.

**3. Expose typed capabilities with portal-style grants.**

- Grants are records on the server, scoped to a capability and resource, with a TTL. They are created at first use through Boundary's existing approval UI and listed in a revocation screen.
- Approval dialogs render Boundary's own parse of the action (path, URL, Shortcut name), never text supplied by the agent.
- Keep an append-only audit log, with secrets redacted.
- Add a "Stop agent" kill switch that revokes tokens, closes relays and pauses the container.

**4. Ship browser control in stages.**

- **First, ship route A**, a Boundary-managed profile. It is supported, isolated and needs no extension. Hermes gets `browser.cdp_url = ws://host.docker.internal:<port>/devtools/browser/<single-use-ticket>`, which uses the verified passthrough. The relay rewrites `Host` to loopback toward Chrome and filters methods deny-by-default:
  - **Block:** cookie and storage reads and writes, `Fetch.*`, `Browser.*`, `Tracing.*`, `IO.read`.
  - **Gate:** `Runtime.evaluate` and its relatives, by origin.
  - **Enforce:** per-site allowlists on every navigation, with banking, email and password managers blocked by default.
- **Then add route B**, the real profile, as an explicit opt-in through the same relay:
  - Read `DevToolsActivePort`.
  - Hold one connection open so Chrome prompts once per bridge session.
  - Use a human-scale timeout, and never delete the file. That deletion is what broke agent-browser.
- **Consider route C**, Hermes's `extension_control` with Boundary minting tickets, only if tab-scoped control in the real profile becomes a must-have. Budget for publishing to the Chrome Web Store, a uniquely named native-messaging host in `Contents/Helpers/`, and reconnect logic for the service worker.

**5. Restrict Hermes's egress while it holds a logged-in session.** Restricting outbound traffic to the llm-proxy and allowlisted sites is the only structural way to break the trifecta. Model-side defenses still let roughly one in ten attacks through.

## Conclusion

Neither the transport nor MCP is the hard part. Loopback HTTP with a token is well understood, and Docker has already validated the host-boundary gateway design. The real work is a **filtering CDP proxy**, which no one has published, and a **grant model** that treats Boundary as a deputy acting on the user's authority rather than the agent's claims. Chrome's own path from Chrome 136 to Chrome 144 shows the direction: real-profile automation is acceptable only with explicit, visible, revocable consent. Boundary can meet that bar by holding the one consented connection and enforcing policy on every message.

Two questions remain open. Does Hermes's MCP client accept an HTTP URL with custom headers in 0.21.3? Does Chrome's autoConnect consent persist across reconnects? Verify both before building. Neither changes the architecture.
