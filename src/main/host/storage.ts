/** Host API: OS-encrypted storage and secret redaction. Re-exports only. */
export {
  decryptFromBase64,
  encryptToBase64,
  isOsEncryptionAvailable,
  replaceCiphertext,
  tryDecryptFromBase64,
} from '../services/secrets/osEncryption';
export { redactSecrets } from '../services/secrets/redact';
