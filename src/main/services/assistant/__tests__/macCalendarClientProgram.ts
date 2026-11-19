/**
 * The Python the `calendar-mac` stack case sends into the Hermes container. It reads the stored
 * entry, resolves its `${VAR}` header from the profile's `.env`, and calls the bridge's
 * `/calendar` route. Every failure comes back as one `{"error": {kind, detail}}` line, because
 * the helpers it calls can exit (SystemExit) and a file or key can be missing.
 */
export interface ClientTool {
  name: string;
  readOnlyHint: unknown;
}

export interface ClientSuccess {
  entry: Record<string, unknown>;
  unauthorized: number;
  tools: ClientTool[];
  events: { isError: boolean; text: string };
}

export interface ClientFailure {
  error: { kind: 'missing_input' | 'http' | 'failed'; detail: string };
}

export const MAC_CALENDAR_CLIENT_PROGRAM = `
import json, os, re, sys, urllib.request, urllib.error

class Refused(Exception):
    def __init__(self, kind, detail):
        self.kind = kind
        self.detail = detail

def rpc(url, method, params, header):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": header})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, None

def run():
    missing = [k for k in ("PROFILE_HOME", "SERVER") if not os.environ.get(k)]
    if missing:
        raise Refused("missing_input", "no " + ", ".join(missing))
    import yaml
    home = os.environ["PROFILE_HOME"]
    servers = (yaml.safe_load(open(home + "/config.yaml")) or {}).get("mcp_servers") or {}
    entry = servers.get(os.environ["SERVER"])
    if not entry or not entry.get("url") or not (entry.get("headers") or {}).get("Authorization"):
        raise Refused("missing_input", "no usable entry for " + os.environ["SERVER"])
    env = {}
    for line in open(home + "/.env"):
        if "=" in line:
            k, v = line.rstrip("\\n").split("=", 1)
            env[k] = v
    unset = []
    def fill(m):
        if m.group(1) not in env:
            unset.append(m.group(1))
            return ""
        return env[m.group(1)]
    auth = re.sub(r"\\$\\{(\\w+)\\}", fill, entry["headers"]["Authorization"])
    if unset:
        raise Refused("missing_input", "no " + ", ".join(unset) + " in .env")
    url = entry["url"]
    unauthorized, _ = rpc(url, "tools/list", {}, "Bearer wrong")
    status, listed = rpc(url, "tools/list", {}, auth)
    if status != 200:
        raise Refused("http", "tools/list answered " + str(status))
    tools = [{"name": t["name"], "readOnlyHint": (t.get("annotations") or {}).get("readOnlyHint")} for t in listed["result"]["tools"]]
    status, called = rpc(url, "tools/call", {"name": "caldav_get_events", "arguments": {"calendar_name": "Home", "start": "2026-11-10", "end": "2026-11-11"}}, auth)
    if status != 200:
        raise Refused("http", "tools/call answered " + str(status))
    result = called["result"]
    text = "".join(c.get("text", "") for c in result.get("content", []))
    return {"entry": entry, "unauthorized": unauthorized, "tools": tools,
        "events": {"isError": bool(result.get("isError")), "text": text}}

try:
    out = run()
except Refused as e:
    out = {"error": {"kind": e.kind, "detail": e.detail}}
except (Exception, SystemExit) as e:
    out = {"error": {"kind": "failed", "detail": type(e).__name__ + ": " + str(e)}}
print(json.dumps(out))
sys.stdout.flush()
`;
