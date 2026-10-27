"""Stand-in for the caldav client. STANDIN_CALDAV's "calendars" maps a principal URL to its
calendars ({"name", "url"}); an unknown principal raises. STANDIN_CALDAV_MISSING makes the
import fail, as in an image without the library.
"""
import json
import os

if os.environ.get("STANDIN_CALDAV_MISSING"):
    raise ModuleNotFoundError("No module named 'caldav'")


class NotFoundError(Exception):
    pass


class DAVClient:
    def __init__(self, url, username, password, timeout=None):
        self.url = url


class Calendar:
    def __init__(self, name, url):
        self.name = name
        self.url = url

    def get_display_name(self):
        return self.name


class Principal:
    def __init__(self, client, url):
        self.url = url

    def calendars(self):
        found = json.loads(os.environ["STANDIN_CALDAV"]).get("calendars", {})
        if self.url not in found:
            raise NotFoundError(self.url)
        return [Calendar(c["name"], c["url"]) for c in found[self.url]]
