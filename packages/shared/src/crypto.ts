import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
const { decodeBase64, encodeBase64, decodeUTF8, encodeUTF8 } = naclUtil;

/** Derive a 32-byte symmetric key from a token via SHA-512 truncation. */
export function deriveKey(token: string): Uint8Array {
  const tokenBytes = decodeUTF8(token);
  const hash = nacl.hash(tokenBytes); // 64 bytes (SHA-512)
  return hash.slice(0, 32);
}

/** Encrypt UTF-8 string, return base64(nonce || ciphertext). */
export function encrypt(plaintext: string, key: Uint8Array): string {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const message = decodeUTF8(plaintext);
  const box = nacl.secretbox(message, nonce, key);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce, 0);
  out.set(box, nonce.length);
  return encodeBase64(out);
}

/** Decrypt base64(nonce || ciphertext), throw on tamper or wrong key. */
export function decrypt(b64: string, key: Uint8Array): string {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const buf = decodeBase64(b64);
  const nonce = buf.slice(0, nacl.secretbox.nonceLength);
  const box = buf.slice(nacl.secretbox.nonceLength);
  const message = nacl.secretbox.open(box, nonce, key);
  if (!message) throw new Error('decryption failed');
  return encodeUTF8(message);
}
