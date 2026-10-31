import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadYaml } from '../loadYaml';
import { hermesProfileConfigPath, isBoundaryCdpUrl } from '../hostBridge/hermesProvision';

/**
 * Boundary's one path for writing Hermes profile settings. Boundary works out what each profile
 * should hold, compares that with the profile's `config.yaml` on the host (the stack bind-mounts
 * data/hermes into the container), and writes only what differs: every profile in one
 * `compose exec hermes python3 -` run, as the stack's scripts/model-use.sh does, rather than
 * one `hermes config set` process (about a second of CLI start-up) per key.
 *
 * The plan goes to Python on stdin ahead of the program, so no value (an MCP entry's
 * Authorization header, the browser token in `browser.cdp_url`) reaches argv, the environment
 * or `docker inspect`.
 */

/** What one profile ('' is the default one) should hold. */
export interface DesiredHermesProfile {
  profile: string;
  /** Written when the profile's value differs. */
  set: Array<[string, string]>;
  /** Written only when the profile has no value: a profile's own max_tokens is kept. */
  setIfUnset?: Array<[string, string]>;
  /** Mappings, each written whole as a YAML map so a rotated header or moved URL follows. */
  entries?: Array<[string, Record<string, unknown>]>;
  /** `browser.cdp_url`: Boundary's URL, or '' to clear Boundary's URL. Someone else's is kept. */
  browserCdpUrl?: string;
}

/** The writes one profile needs. */
export interface HermesProfileWrites {
  profile: string;
  /** Through Hermes's own `set_config_value`, which `hermes config set` uses. */
  set: Array<[string, string]>;
  entries: Array<[string, Record<string, unknown>]>;
}

/**
 * Keys Hermes reads on every use rather than at start-up, so changing them needs no restart.
 * Hermes reads `cdp_url` on every browser call (ADR 0027 §4).
 */
const HERMES_LIVE_KEYS = new Set(['browser.cdp_url']);

/**
 * Mapping entries Hermes reads on every request. `providers.boundary-chain` only names the session
 * header: `build_api_kwargs` looks it up through `get_custom_provider_session_affinity_header`,
 * which loads config.yaml by file signature, so adding or dropping a fallback needs no restart
 * (ADR 0033 §9).
 */
const HERMES_LIVE_ENTRIES = new Set(['providers.boundary-chain']);

/**
 * A profile's parsed `config.yaml`: `{}` when the folder exists without one, `null` when it
 * can't be read or parsed, `undefined` when the profile's folder doesn't exist.
 */
export function readHermesProfileConfig(
  dataRoot: string,
  profile: string
): Record<string, unknown> | null | undefined {
  const configPath = hermesProfileConfigPath(dataRoot, profile);
  if (!fs.existsSync(path.dirname(configPath))) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
  try {
    const parsed = loadYaml(text);
    if (parsed === undefined || parsed === null) return {};
    return typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function valueAt(config: Record<string, unknown>, key: string): unknown {
  let node: unknown = config;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** `hermes config set` turns "180" into 180 and "true" into true, so compare as text. */
function sameScalar(current: unknown, desired: string): boolean {
  if (current === undefined || current === null || typeof current === 'object') return false;
  return String(current) === desired;
}

/**
 * The writes that bring `current` to `desired`. An unreadable config (`null`) gets every
 * `set` and entry, but no `setIfUnset` (it may have its own value) and no clear of
 * `browser.cdp_url` (it may not be Boundary's).
 */
export function planHermesProfileWrites(
  desired: DesiredHermesProfile,
  current: Record<string, unknown> | null
): HermesProfileWrites {
  const set: Array<[string, string]> = [];
  const differs = (key: string, value: string) => current === null || !sameScalar(valueAt(current, key), value);
  for (const [key, value] of desired.set) {
    if (differs(key, value)) set.push([key, value]);
  }
  for (const [key, value] of desired.setIfUnset ?? []) {
    if (current !== null && valueAt(current, key) == null) set.push([key, value]);
  }
  if (desired.browserCdpUrl !== undefined) {
    const key = 'browser.cdp_url';
    if (desired.browserCdpUrl) {
      if (differs(key, desired.browserCdpUrl)) set.push([key, desired.browserCdpUrl]);
    } else if (current !== null && isBoundaryCdpUrl(valueAt(current, key))) {
      set.push([key, '']);
    }
  }
  const entries = (desired.entries ?? []).filter(
    ([key, value]) => current === null || !isDeepStrictEqual(valueAt(current, key), value)
  );
  return { profile: desired.profile, set, entries };
}

export function hasHermesWrites(writes: HermesProfileWrites): boolean {
  return writes.set.length > 0 || writes.entries.length > 0;
}

/** True when a write changes something Hermes reads only at start-up. */
export function hermesWritesNeedRestart(writes: readonly HermesProfileWrites[]): boolean {
  return writes.some(
    (w) =>
      w.entries.some(([key]) => !HERMES_LIVE_ENTRIES.has(key)) || w.set.some(([key]) => !HERMES_LIVE_KEYS.has(key))
  );
}

/** `compose exec` args for the one-run apply; the program and plan go on stdin. */
export const HERMES_CONFIG_APPLY_ARGS = ['exec', '-T', 'hermes', 'python3', '-'];

const RESULT_PREFIX = 'HERMES_CONFIG_APPLY ';

/**
 * Runs in the hermes container. Scalars go through Hermes's `set_config_value` under each
 * profile's home, as model-use.sh does, so they are stored exactly as `hermes config set`
 * stores them. Mappings go through the YAML writer the stack's bootstrap uses for header maps,
 * since `config set` takes one scalar. A profile that fails is reported by exception type and
 * key, never by value, and the rest are still written. `set_config_value` refuses a key it
 * considers invalid with `sys.exit(1)`, so SystemExit counts as a profile's failure too.
 */
const HERMES_CONFIG_APPLY_PROGRAM = String.raw`
import contextlib
import io
import json
import os
import sys
from pathlib import Path

from hermes_cli.config import set_config_value
from hermes_constants import reset_hermes_home_override, set_hermes_home_override

sys.path.insert(0, "/opt/hermes")
try:
    import yaml
except ImportError:  # Hermes v0.22+ ships ruamel only; hermes_yaml wraps it
    import hermes_yaml as yaml
from utils import atomic_yaml_write

plan = json.loads(PLAN_JSON)
root = Path(os.environ.get("HERMES_HOME") or "/opt/data")
results = []


def fail(result, exc, key):
    # The first failure is reported; later keys are still written.
    if "error" not in result:
        result["error"] = type(exc).__name__
        if key:
            result["key"] = key


for item in plan["profiles"]:
    name = item["profile"]
    home = root / "profiles" / name if name else root
    result = {"profile": name, "written": 0}
    key = None
    try:
        if not home.is_dir():
            raise FileNotFoundError("no profile folder")
        if item["set"]:
            token = set_hermes_home_override(home)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    for key, value in item["set"]:
                        try:
                            set_config_value(key, value)
                            result["written"] += 1
                        except (Exception, SystemExit) as exc:
                            fail(result, exc, key)
            finally:
                reset_hermes_home_override(token)
        if item["entries"]:
            key = None
            config_path = home / "config.yaml"
            try:
                with open(config_path) as fh:
                    config = yaml.safe_load(fh) or {}
            except FileNotFoundError:
                config = {}  # A new profile without one yet; Hermes fills in its defaults.
            for key, value in item["entries"]:
                node = config
                parts = key.split(".")
                for part in parts[:-1]:
                    child = node.get(part)
                    if not isinstance(child, dict):
                        child = {}
                        node[part] = child
                    node = child
                node[parts[-1]] = value
            atomic_yaml_write(str(config_path), config)
            result["written"] += len(item["entries"])
    except (Exception, SystemExit) as exc:
        fail(result, exc, key)
    results.append(result)
print("${RESULT_PREFIX}" + json.dumps({"profiles": results}))
`;

/** What goes on stdin: the plan as a Python string literal, then the program. */
export function buildHermesConfigApplyInput(writes: readonly HermesProfileWrites[]): string {
  const plan = { profiles: writes.map(({ profile, set, entries }) => ({ profile, set, entries })) };
  // A JSON string literal is a valid Python string literal.
  return `PLAN_JSON = ${JSON.stringify(JSON.stringify(plan))}\n${HERMES_CONFIG_APPLY_PROGRAM}`;
}

export interface HermesConfigApplyResult {
  profile: string;
  written: number;
  /** Exception type of the profile's first failure; the program still writes the keys after it. */
  error?: string;
  /** The key being written at the first failure. */
  key?: string;
}

/** The program's result line, or null when it didn't finish (no such line). */
export function parseHermesConfigApplyOutput(stdout: string): HermesConfigApplyResult[] | null {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as { profiles?: unknown };
    return Array.isArray(parsed.profiles) ? (parsed.profiles as HermesConfigApplyResult[]) : null;
  } catch {
    return null;
  }
}
