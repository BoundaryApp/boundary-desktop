"""Stand-in for hermes_cli.config.set_config_value. Config files are JSON, which is valid YAML.

STANDIN_REFUSE_KEYS (comma-separated) are refused with sys.exit(1), as Hermes refuses a key it
considers invalid. STANDIN_FAIL_KEYS raise PermissionError.
"""
import json
import os
import sys

from hermes_constants import get_hermes_home


def _keys(name):
    return {k for k in os.environ.get(name, "").split(",") if k}


def _coerce(value):
    # `hermes config set` stores "180" as 180 and "true" as true.
    if value.lower() in ("true", "false"):
        return value.lower() == "true"
    try:
        return int(value)
    except ValueError:
        return value


def set_config_value(key, value):
    if key in _keys("STANDIN_REFUSE_KEYS"):
        print(f"Invalid config key: {key}", file=sys.stderr)
        sys.exit(1)
    if key in _keys("STANDIN_FAIL_KEYS"):
        raise PermissionError("config.yaml is read-only")
    path = get_hermes_home() / "config.yaml"
    config = json.loads(path.read_text() or "{}") if path.exists() else {}
    node = config
    parts = key.split(".")
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = _coerce(value)
    path.write_text(json.dumps(config))
    print(f"Set {key} = {value}")
