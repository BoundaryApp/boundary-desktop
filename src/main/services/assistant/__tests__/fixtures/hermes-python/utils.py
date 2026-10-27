"""Stand-in for Hermes's utils.atomic_yaml_write; writes JSON."""
import json
import os


def atomic_yaml_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)
