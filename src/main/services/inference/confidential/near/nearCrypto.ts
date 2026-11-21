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
import { plainRequest, plainTopLevel, replyObject, TOOL_CHOICE_MODES, UnsupportedContent } from '../adapterKit';
import { isRecord } from '../../../../../shared/utils/isRecord';

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

/**
 * A copy of a completion or stream chunk with every encrypted reply field decrypted, reduced to
 * the fields `replyObject` keeps.
 */
export function decryptReplyObject(obj: Record<string, unknown>, client: NearClientKeys): Record<string, unknown> {
  return replyObject(obj, (value) => decryptField(value, client));
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
