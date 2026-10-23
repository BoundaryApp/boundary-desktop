# CalDAV sign-in probe, run inside the caldav-mcp container as `python -`.
# The caller prepends `CREDS_JSON = <json string literal>` to this file and sends the
# result on stdin, so the credentials never appear in argv or the environment.
# Prints one JSON line: {"status": "ok"|"rejected"|"unreachable", ...}. Never prints the password.
#
# A sign-in counts as good only when the server names the user's principal
# (DAV current-user-principal with an href). Some servers answer an anonymous
# PROPFIND with 207, and the caldav library falls back to the URL it was given
# when no principal comes back, so "the library found a principal" proves nothing.
import json
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlsplit

import caldav
import requests

creds = json.loads(CREDS_JSON)  # noqa: F821 (prepended by the caller)
NS = {"d": "DAV:"}
BODY = ('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
        '<d:current-user-principal/></d:prop></d:propfind>')


def redact(text):
    pw = creds["password"]
    return text.replace(pw, "[REDACTED]") if pw else text


def candidates(url):
    parts = urlsplit(url if "://" in url else "https://" + url)
    base = f"{parts.scheme}://{parts.netloc}"
    if parts.path in ("", "/"):
        return [base + "/.well-known/caldav", base + "/"]
    return [url]


def principal_href(url, auth):
    """(status, href or None, final url). Follows the well-known redirect."""
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
        # No principal, or <d:unauthenticated/>: the server didn't accept these credentials.
        return "rejected", None, resp.url
    return "ok", urljoin(resp.url, href.text.strip()), resp.url


def run():
    auth = (creds["username"], creds["password"])
    last = None
    for url in candidates(creds["url"].strip()):
        try:
            status, href, final = principal_href(url, auth)
        except Exception as exc:
            last = {"status": "unreachable", "url": url, "error": redact(f"{type(exc).__name__}: {exc}")[:300]}
            continue
        if status == "unreachable":
            last = {"status": "unreachable", "url": url, "error": href}
            continue
        if status == "rejected":
            return {"status": "rejected", "url": final}
        try:
            client = caldav.DAVClient(url=final, username=auth[0], password=auth[1], timeout=20)
            principal = caldav.Principal(client=client, url=href)
            cals = [{"name": c.get_display_name() or c.name, "url": str(c.url)} for c in principal.calendars()]
        except Exception as exc:
            return {"status": "unreachable", "url": final, "error": redact(f"{type(exc).__name__}: {exc}")[:300]}
        return {"status": "ok", "url": final, "principal": href, "calendars": cals}
    return last


print(json.dumps(run()))
