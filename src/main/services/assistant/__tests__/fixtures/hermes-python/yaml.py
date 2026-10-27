"""Stand-in for PyYAML's safe_load, reading the JSON the other stand-ins write."""
import json


def safe_load(stream):
    text = stream.read()
    return json.loads(text) if text.strip() else None
