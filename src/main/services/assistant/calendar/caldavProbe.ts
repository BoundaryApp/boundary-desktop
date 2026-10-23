import type { CalendarInfo, CalendarTestResult } from '../../../../shared/types/calendars';
import { CALDAV_MCP_SERVICE } from './calendarModel';

/**
 * The sign-in test (spec decision 4). It runs inside the caldav-mcp container, with the same
 * `caldav` client and network the agent uses, as `python -`. The credentials are prepended to the
 * program as `CREDS_JSON = …` and the whole program goes on stdin, so they never reach argv, the
 * environment or `docker inspect`. docs/calendar-ux-study/spike/caldav-probe.py is the version the
 * spike ran.
 *
 * A sign-in is good only when the server names the user's principal. Some servers answer an
 * anonymous PROPFIND with 207, and the `caldav` library falls back to the URL it was given when no
 * principal comes back, so "the library found a principal" proves nothing.
 */
export const CALDAV_PROBE_PROGRAM = String.raw`
import json
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlsplit

import caldav
import requests

creds = json.loads(CREDS_JSON)
NS = {"d": "DAV:"}
BODY = ('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        '<d:current-user-principal/></d:prop></d:propfind>')


def redact(text):
    pw = creds["password"]
    return text.replace(pw, "[REDACTED]") if pw else text


def candidates(url):
    parts = urlsplit(url)
    base = f"{parts.scheme}://{parts.netloc}"
    if parts.path in ("", "/"):
        return [base + "/.well-known/caldav", base + "/"]
    return [url]


def principal_href(url, auth):
    resp = requests.request("PROPFIND", url, data=BODY, auth=auth, timeout=20,
                            headers={"Depth": "0", "Content-Type": "application/xml"})
    if resp.status_code in (401, 403):
        return "rejected", None, resp.url
    if resp.status_code != 207:
        return "unreachable", f"HTTP {resp.status_code}", resp.url
    root = ET.fromstring(resp.content)
    node = root.find(".//d:current-user-principal", NS)
    href = node.find("d:href", NS) if node is not None else None
    if href is None or not (href.text or "").strip():
        return "rejected", None, resp.url
    return "ok", urljoin(resp.url, href.text.strip()), resp.url


def run():
    auth = (creds["username"], creds["password"])
    last = None
    for url in candidates(creds["url"].strip()):
        try:
            status, href, final = principal_href(url, auth)
        except Exception as exc:
            last = {"status": "unreachable", "error": redact(f"{type(exc).__name__}: {exc}")[:300]}
            continue
        if status == "unreachable":
            last = {"status": "unreachable", "error": href}
            continue
        if status == "rejected":
            return {"status": "rejected"}
        try:
            client = caldav.DAVClient(url=final, username=auth[0], password=auth[1], timeout=20)
            principal = caldav.Principal(client=client, url=href)
            cals = [{"name": c.get_display_name() or c.name or "", "url": str(c.url)} for c in principal.calendars()]
        except Exception as exc:
            return {"status": "unreachable", "error": redact(f"{type(exc).__name__}: {exc}")[:300]}
        return {"status": "ok", "url": final, "calendars": cals}
    return last or {"status": "unreachable", "error": "No address to try"}


print("CALDAV_PROBE " + json.dumps(run()))
`;

export interface CaldavCredentials {
  url: string;
  username: string;
  password: string;
}

/** The program sent on stdin: the credentials as a Python string literal, then the probe. */
export function caldavProbeInput(creds: CaldavCredentials): string {
  // A JSON string literal is a valid Python string literal.
  const literal = JSON.stringify(JSON.stringify(creds));
  return `CREDS_JSON = ${literal}\n${CALDAV_PROBE_PROGRAM}`;
}

export function caldavProbeArgs(): string[] {
  return ['exec', '-T', CALDAV_MCP_SERVICE, 'python', '-'];
}

function calendarsFrom(value: unknown): CalendarInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c): c is { name?: unknown; url?: unknown } => Boolean(c) && typeof c === 'object')
    .map((c) => ({ name: typeof c.name === 'string' ? c.name : '', url: typeof c.url === 'string' ? c.url : '' }))
    .filter((c) => c.url);
}

/** Read the probe's result line. Anything else is an error, with the password scrubbed. */
export function parseCaldavProbeOutput(stdout: string, password: string): CalendarTestResult {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('CALDAV_PROBE '));
  if (!line) return { status: 'error', error: 'The calendar service didn’t answer the sign-in test.' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line.slice('CALDAV_PROBE '.length)) as Record<string, unknown>;
  } catch {
    return { status: 'error', error: 'The calendar service gave an answer Boundary couldn’t read.' };
  }
  const scrub = (text: string) => (password ? text.split(password).join('[REDACTED]') : text);
  if (parsed.status === 'ok' && typeof parsed.url === 'string') {
    return { status: 'ok', url: parsed.url, calendars: calendarsFrom(parsed.calendars) };
  }
  if (parsed.status === 'rejected') return { status: 'rejected' };
  if (parsed.status === 'unreachable') {
    return { status: 'unreachable', error: scrub(String(parsed.error ?? 'No answer')) };
  }
  return { status: 'error', error: 'The calendar service gave an answer Boundary couldn’t read.' };
}
