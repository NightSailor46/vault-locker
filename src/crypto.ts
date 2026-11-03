// Web Crypto helpers. Uses only globalThis.crypto so it runs on desktop,
// mobile and in Node's test runner. No Obsidian imports here.

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const KEY_BYTES = 32;
export const RECOVERY_BYTES = 20;

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export function randomBytes(n: number): Uint8Array {
	const out = new Uint8Array(n);
	globalThis.crypto.getRandomValues(out);
	return out;
}

// Key that wraps a folder key, derived from the user's password.
export async function deriveKeyFromPassword(
	password: string,
	salt: Uint8Array,
	iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
	if (!password) throw new Error("Password is empty");
	const base = await subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
	return subtle.deriveKey(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

// Recovery keys are already random, so HKDF is enough (no slow hashing).
export async function deriveKeyFromRecovery(recovery: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
	const base = await subtle.importKey("raw", recovery, "HKDF", false, ["deriveKey"]);
	return subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("vault-locker recovery v1") },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function importFolderKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.length !== KEY_BYTES) throw new Error("Folder key must be 32 bytes");
	return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, plain: Uint8Array, aad?: Uint8Array): Promise<{ iv: Uint8Array; data: Uint8Array }> {
	const iv = randomBytes(IV_BYTES);
	const params: AesGcmParams = aad ? { name: "AES-GCM", iv, additionalData: aad } : { name: "AES-GCM", iv };
	const data = new Uint8Array(await subtle.encrypt(params, key, plain));
	return { iv, data };
}

// Throws if the key is wrong or the data was changed.
export async function open(key: CryptoKey, iv: Uint8Array, data: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
	const params: AesGcmParams = aad ? { name: "AES-GCM", iv, additionalData: aad } : { name: "AES-GCM", iv };
	return new Uint8Array(await subtle.decrypt(params, key, data));
}

// Recovery key shown to the user: base32, groups of 4 (RFC 4648 alphabet).
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function formatRecoveryKey(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const b of bytes) {
		value = ((value << 8) | b) & 0xffff;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out.match(/.{1,4}/g)!.join("-");
}

export function parseRecoveryKey(text: string): Uint8Array {
	// Forgive look-alikes: the key never uses 0, 1 or 8, so read them as O, I and B.
	const clean = text.toUpperCase().replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B").replace(/[^A-Z2-7]/g, "");
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of clean) {
		value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	if (out.length !== RECOVERY_BYTES) {
		const want = Math.ceil((RECOVERY_BYTES * 8) / 5);
		throw new Error(`Recovery key has ${clean.length} characters but should have ${want}. Check for a missed or doubled group.`);
	}
	return new Uint8Array(out);
}

export function toBase64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
	const s = atob(text);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}
