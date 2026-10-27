"""Stand-in for requests.request, serving a fake CalDAV server described by STANDIN_CALDAV (JSON):

  username, password  the account the server accepts; other credentials get 401
  routes              {url: {"final": url after redirects, "principal": href}}; others get 404
  errors              {url: message} raises ConnectionError for that url
"""
import json
import os


class ConnectionError(Exception):
    pass


class Response:
    def __init__(self, status_code, url, content=b""):
        self.status_code = status_code
        self.url = url
        self.content = content


def request(method, url, data=None, auth=None, timeout=None, headers=None):
    server = json.loads(os.environ["STANDIN_CALDAV"])
    if url in server.get("errors", {}):
        raise ConnectionError(server["errors"][url])
    route = server.get("routes", {}).get(url)
    if method != "PROPFIND" or route is None:
        return Response(404, url)
    if auth != (server["username"], server["password"]):
        return Response(401, url)
    body = ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>'
            f'<d:current-user-principal><d:href>{route["principal"]}</d:href></d:current-user-principal>'
            '</d:prop></d:propstat></d:response></d:multistatus>')
    return Response(207, route["final"], body.encode())
