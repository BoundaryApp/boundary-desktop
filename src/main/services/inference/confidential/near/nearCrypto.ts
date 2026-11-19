/**
 * NEAR AI Cloud end-to-end encryption, version 2, with every field encrypted.
 *
 * Each field is encrypted on its own: an ephemeral X25519 key, ECDH with the recipient's
 * Ed25519 key converted to X25519, HKDF-SHA256 (no salt, info "ed25519_encryption") to a
 * 32-byte key, then XChaCha20-Poly1305 with a random 24-byte nonce and no AAD. The wire value
 * is hex of `eph_pub(32) || nonce(24) || ciphertext+tag`. Replies use the same layout to the
 * client's key. Checked against nearai-cloud-verifier `py/encrypted_agent_loop_verifier.py`.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { isRecord, plainRequest, UnsupportedContent } from '../adapterKit';

export interface NearClientKeys {
  /** Ed25519 public key, 64 lowercase hex characters. Sent as `X-Client-Pub-Key`. */
  publicKeyHex: string;
  /** Ed25519 secret key (32-byte seed). Never leaves this process. */
  secretKey: Uint8Array;
}

const HKDF_INFO = utf8ToBytes('ed25519_encryption');
const EPH_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
const MODEL_KEY_RE = /^[0-9a-fA-F]{64}$/;
const REPLY_TEXT_FIELDS = ['content', 'reasoning_content', 'reasoning', 'refusal'] as const;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function newClientKeys(): NearClientKeys {
  const secretKey = ed25519.utils.randomSecretKey();
  return {
    publicKeyHex: bytesToHex(ed25519.getPublicKey(secretKey)),
    secretKey,
  };
}

function fieldKey(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, HKDF_INFO, 32);
}

/** The model key as 64 lowercase hex characters, so encryption and `X-Model-Pub-Key` use the same value. */
function normalisedModelKey(modelKeyHex: string): string {
  if (typeof modelKeyHex !== 'string' || !MODEL_KEY_RE.test(modelKeyHex)) {
    throw new Error('NEAR model key isn’t a 32-byte hex value');
  }
  return modelKeyHex.toLowerCase();
}

function modelX25519(modelKeyHex: string): Uint8Array {
  const key = normalisedModelKey(modelKeyHex);
  try {
    return ed25519.utils.toMontgomery(hexToBytes(key));
  } catch {
    throw new Error('NEAR model key isn’t a valid Ed25519 point');
  }
}

function sealTo(recipientX25519: Uint8Array, plaintext: string): string {
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = fieldKey(x25519.getSharedSecret(eph, recipientX25519));
  const nonce = randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(plaintext));
  const wire = new Uint8Array(EPH_BYTES + NONCE_BYTES + ct.length);
  wire.set(ephPub, 0);
  wire.set(nonce, EPH_BYTES);
  wire.set(ct, EPH_BYTES + NONCE_BYTES);
  return bytesToHex(wire);
}

export function encryptField(plaintext: string, modelKeyHex: string): string {
  return sealTo(modelX25519(modelKeyHex), plaintext);
}

export function decryptField(hex: string, client: NearClientKeys): string {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) throw new Error('NEAR field isn’t hex');
  const wire = hexToBytes(hex);
  if (wire.length < EPH_BYTES + NONCE_BYTES + TAG_BYTES) throw new Error('NEAR field is too short for v2');
  try {
    const eph = wire.subarray(0, EPH_BYTES);
    const nonce = wire.subarray(EPH_BYTES, EPH_BYTES + NONCE_BYTES);
    const ct = wire.subarray(EPH_BYTES + NONCE_BYTES);
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(client.secretKey), eph);
    return utf8.decode(xchacha20poly1305(fieldKey(shared), nonce).decrypt(ct));
  } catch {
    throw new Error('NEAR field didn’t decrypt');
  }
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Seals `field` when it is a string; any other value with content throws, since NEAR would send it plain. */
function sealString(record: Record<string, unknown>, field: string, to: Uint8Array): void {
  const value = record[field];
  if (!isPresent(value)) return;
  if (typeof value !== 'string') throw new UnsupportedContent();
  record[field] = sealTo(to, value);
}

/** A copy of a `{ type: 'function', function: {...} }` entry with `fields` sealed; any other shape throws. */
function sealFunctionEntry(entry: unknown, to: Uint8Array, fields: string[]): Record<string, unknown> {
  if (!isRecord(entry) || entry.type !== 'function' || !isRecord(entry.function)) throw new UnsupportedContent();
  const fn: Record<string, unknown> = { ...entry.function };
  for (const field of fields) sealString(fn, field, to);
  return { ...entry, function: fn };
}

/**
 * Tool call ids as NEAR gets them: `call_1`, `call_2` and so on, numbered by first appearance in
 * the request, so a call and its result still match. NEAR doesn't encrypt ids, and Hermes's
 * fallback id is a truncated SHA-256 of the tool name and arguments; an id from another provider
 * also names that provider. Numbering by first appearance keeps a growing history's aliases stable.
 */
function idAliases(): (id: unknown) => unknown {
  const aliases = new Map<string, string>();
  return (id) => {
    if (typeof id !== 'string') return id;
    let alias = aliases.get(id);
    if (alias === undefined) {
      alias = `call_${aliases.size + 1}`;
      aliases.set(id, alias);
    }
    return alias;
  };
}

/**
 * Seals a message `plainRequest` already reduced to role, content, name, refusal, tool calls and
 * tool call id, with each id through `alias`.
 */
function sealMessage(message: Record<string, unknown>, to: Uint8Array, alias: (id: unknown) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...message };
  for (const field of ['content', 'name', 'refusal']) sealString(out, field, to);
  if (isPresent(out.tool_call_id)) out.tool_call_id = alias(out.tool_call_id);
  if (Array.isArray(out.tool_calls)) {
    out.tool_calls = out.tool_calls.map((call: unknown): unknown => {
      const sealed = sealFunctionEntry(call, to, ['name', 'arguments']);
      if (isPresent(sealed.id)) sealed.id = alias(sealed.id);
      return sealed;
    });
  }
  return out;
}

function sealTool(tool: unknown, to: Uint8Array): Record<string, unknown> {
  const out = sealFunctionEntry(tool, to, ['name', 'description']);
  const fn = out.function as Record<string, unknown>;
  if (fn.parameters !== undefined) fn.parameters = sealTo(to, JSON.stringify(fn.parameters));
  return out;
}

/** Top-level fields NEAR gets as numbers or booleans. A value of another type is dropped. */
const NUMBER_FIELDS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'n', 'presence_penalty', 'frequency_penalty', 'seed'];
const BOOLEAN_FIELDS = ['stream', 'parallel_tool_calls'];
/** An effort level such as `high`: one lowercase word, so free text can't pass as one. */
const EFFORT_RE = /^[a-z]{1,16}$/;
/** `response_format` types that carry no text. `json_schema` would send its schema plain. */
const PLAIN_RESPONSE_FORMATS = new Set(['text', 'json_object']);
/** String `tool_choice` values. Any other string is dropped. */
const TOOL_CHOICE_MODES = new Set(['auto', 'none', 'required']);

function isEffort(value: unknown): value is string {
  return typeof value === 'string' && EFFORT_RE.test(value);
}

/** The entries of `value` whose values are booleans or finite numbers, or undefined when there are none. */
function primitiveFlags(value: unknown): Record<string, boolean | number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, boolean | number> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (typeof flag === 'boolean' || (typeof flag === 'number' && Number.isFinite(flag))) out[key] = flag;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The top-level fields NEAR gets besides `messages`, `tools` and `tool_choice`. NEAR encrypts
 * none of them, so only values that can't carry text pass: listed numbers and booleans, a
 * one-word `reasoning_effort`, `stream_options.include_usage`, `reasoning` as `enabled` and
 * `effort`, the boolean and number entries of `chat_template_kwargs`, and a `response_format`
 * of `text` or `json_object`. Everything else is dropped, so an unexpected field from Hermes
 * doesn't fail the turn. `stop` and any other `response_format` throw `UnsupportedContent`,
 * since dropping them would change the reply without saying so.
 */
function plainTopLevel(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.model !== 'string') throw new UnsupportedContent();
  if (isPresent(body.stop)) throw new UnsupportedContent();
  const out: Record<string, unknown> = { model: body.model };
  for (const field of NUMBER_FIELDS) {
    if (typeof body[field] === 'number' && Number.isFinite(body[field])) out[field] = body[field];
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof body[field] === 'boolean') out[field] = body[field];
  }
  if (isEffort(body.reasoning_effort)) out.reasoning_effort = body.reasoning_effort;
  if (isRecord(body.stream_options) && typeof body.stream_options.include_usage === 'boolean') {
    out.stream_options = { include_usage: body.stream_options.include_usage };
  }
  if (isRecord(body.reasoning)) {
    const reasoning: Record<string, unknown> = {};
    if (typeof body.reasoning.enabled === 'boolean') reasoning.enabled = body.reasoning.enabled;
    if (isEffort(body.reasoning.effort)) reasoning.effort = body.reasoning.effort;
    if (Object.keys(reasoning).length > 0) out.reasoning = reasoning;
  }
  const templateFlags = primitiveFlags(body.chat_template_kwargs);
  if (templateFlags) out.chat_template_kwargs = templateFlags;
  if (isPresent(body.response_format)) {
    const format = body.response_format;
    if (!isRecord(format) || typeof format.type !== 'string' || !PLAIN_RESPONSE_FORMATS.has(format.type)) {
      throw new UnsupportedContent();
    }
    out.response_format = { type: format.type };
  }
  return out;
}

/**
 * A copy of a chat request, reduced by `plainRequest` (which drops earlier turns' reasoning and
 * log probabilities) and `plainTopLevel`, with every field NEAR encrypts under
 * `X-Encrypt-All-Fields` sealed and tool call ids replaced by `idAliases`. Throws `UnsupportedContent` for anything that would otherwise
 * carry text NEAR leaves plain: non-text content, a non-string text field, `messages` or `tools`
 * that isn't a list, top-level `functions`, `prediction` or `stop`, a `response_format` other than
 * `text` or `json_object`, and tool calls, tools or an object `tool_choice` whose type isn't
 * `function`. A string `tool_choice` other than `auto`, `none` or `required` is dropped.
 */
export function encryptRequest(body: Record<string, unknown>, modelKeyHex: string): Record<string, unknown> {
  const to = modelX25519(modelKeyHex);
  if (isPresent(body.functions) || isPresent(body.prediction)) throw new UnsupportedContent();
  if (isPresent(body.tools) && !Array.isArray(body.tools)) throw new UnsupportedContent();
  const plain = plainRequest(body);
  const out = plainTopLevel(plain);
  const alias = idAliases();
  if (Array.isArray(plain.messages)) out.messages = plain.messages.map((m: Record<string, unknown>): unknown => sealMessage(m, to, alias));
  if (Array.isArray(plain.tools)) out.tools = plain.tools.map((t: unknown): unknown => sealTool(t, to));
  if (typeof plain.tool_choice === 'string' && TOOL_CHOICE_MODES.has(plain.tool_choice)) out.tool_choice = plain.tool_choice;
  else if (isRecord(plain.tool_choice)) out.tool_choice = sealFunctionEntry(plain.tool_choice, to, ['name']);
  return out;
}

function openField(record: Record<string, unknown>, field: string, client: NearClientKeys): void {
  const value = record[field];
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new Error(`NEAR reply field ${field} isn’t a string`);
  record[field] = decryptField(value, client);
}

/** A reply's top-level fields Boundary passes on; they carry no model output. */
const REPLY_TOP_LEVEL = ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier', 'usage'] as const;

/** The listed fields of `record` that are present. */
function picked(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in record) out[field] = record[field];
  return out;
}

/**
 * A reply message or delta reduced to `role`, the encrypted text fields (decrypted) and tool calls
 * as `index`, `id`, `type` and `function.{name, arguments}`. Anything else (`function_call`,
 * `nearai_tool_result`, `audio`) is outside what NEAR encrypts, so it is dropped rather than passed
 * on as if the model had sent it.
 */
function openReplyMessage(message: unknown, client: NearClientKeys): unknown {
  if (!isRecord(message)) return message;
  const out = picked(message, ['role', ...REPLY_TEXT_FIELDS]);
  for (const field of REPLY_TEXT_FIELDS) openField(out, field, client);
  if (Array.isArray(message.tool_calls)) {
    out.tool_calls = message.tool_calls.map((call: unknown): unknown => {
      if (!isRecord(call)) return call;
      const kept = picked(call, ['index', 'id', 'type']);
      if (!isRecord(call.function)) return kept;
      const fn = picked(call.function, ['name', 'arguments']);
      openField(fn, 'name', client);
      openField(fn, 'arguments', client);
      return { ...kept, function: fn };
    });
  }
  return out;
}

/**
 * A copy of a completion or stream chunk with every encrypted reply field decrypted, keeping only
 * the fields listed here. Each choice keeps `index`, `finish_reason` and its message or delta;
 * `logprobs`, `stop_reason` and other plain fields are dropped.
 */
export function decryptReplyObject(obj: Record<string, unknown>, client: NearClientKeys): Record<string, unknown> {
  const out = picked(obj, REPLY_TOP_LEVEL);
  if (!Array.isArray(obj.choices)) return out;
  out.choices = obj.choices.map((choice: unknown): unknown => {
    if (!isRecord(choice)) return choice;
    const kept = picked(choice, ['index', 'finish_reason']);
    if ('message' in choice) kept.message = openReplyMessage(choice.message, client);
    if ('delta' in choice) kept.delta = openReplyMessage(choice.delta, client);
    return kept;
  });
  return out;
}

export function nearHeaders(client: NearClientKeys, modelKeyHex: string): Record<string, string> {
  return {
    'X-Signing-Algo': 'ed25519',
    'X-Client-Pub-Key': client.publicKeyHex,
    'X-Model-Pub-Key': normalisedModelKey(modelKeyHex),
    'X-Encryption-Version': '2',
    'X-Encrypt-All-Fields': 'true',
  };
}
