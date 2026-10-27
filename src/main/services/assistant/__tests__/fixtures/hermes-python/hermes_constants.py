"""Stand-in for Hermes's home override: a module-level value set and reset by token."""
import os
from pathlib import Path

_override = None


def set_hermes_home_override(home):
    global _override
    token = _override
    _override = Path(home)
    return token


def reset_hermes_home_override(token):
    global _override
    _override = token


def get_hermes_home():
    return _override or Path(os.environ.get("HERMES_HOME") or "/opt/data")
