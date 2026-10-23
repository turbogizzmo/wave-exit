/**
 * Projects are encrypted at rest with AES-256-GCM (WebCrypto, no home-made
 * crypto). One random storage key per installation lives in the OS keychain;
 * every file gets its own random 96-bit nonce. Layout: "WXE1" | nonce | ciphertext+tag.
 */

const MAGIC = new TextEncoder().encode("WXE1");
const KEY_NAME = "storage-key";

export interface Keychain {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function storageKey(keychain: Keychain): Promise<CryptoKey> {
  let raw = await keychain.get(KEY_NAME);
  if (!raw) {
    raw = b64(crypto.getRandomValues(new Uint8Array(32)));
    await keychain.set(KEY_NAME, raw);
  }
  return crypto.subtle.importKey("raw", unb64(raw) as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(MAGIC.length + nonce.length + ct.length);
  out.set(MAGIC, 0);
  out.set(nonce, MAGIC.length);
  out.set(ct, MAGIC.length + nonce.length);
  return out;
}

export class UnreadableProject extends Error {}

export async function unseal(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 4 + 12 + 16 || !MAGIC.every((b, i) => sealed[i] === b)) throw new UnreadableProject("not a Wave Exit file");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(4, 16) as Uint8Array<ArrayBuffer> }, key, sealed.subarray(16) as Uint8Array<ArrayBuffer>));
  } catch {
    throw new UnreadableProject("can't be decrypted with this computer's key");
  }
}
