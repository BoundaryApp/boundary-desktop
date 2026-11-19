"""Stand-in for PyYAML: the test writes config.yaml as JSON, which is valid YAML."""
import json
import os


def safe_load(stream):
    if os.environ.get("STANDIN_YAML_EXIT"):
        raise SystemExit(2)
    text = stream.read()
    return json.loads(text) if text.strip() else None
