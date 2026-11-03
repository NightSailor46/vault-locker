// On-disk formats: the per-folder `.vaultlocker` header and `.vlock` files.
// See Design.md section 3.

import {
	KEY_BYTES,
	PBKDF2_ITERATIONS,
	RECOVERY_BYTES,
	SALT_BYTES,
	deriveKeyFromPassword,
	deriveKeyFromRecovery,
	fromBase64,
	importFolderKey,
	open,
	randomBytes,
	seal,
	toBase64,
} from "./crypto.ts";

export const HEADER_NAME = ".vaultlocker";
export const LOCKED_EXT = ".vlock";
export const FORMAT_VERSION = 1;
export const MAX_ITERATIONS = 10_000_000;
const MAGIC = new Uint8Array([0x56, 0x4c, 0x4b, 0x31]); // "VLK1"
const PREFIX_BYTES = MAGIC.length + 1 + 12;

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const dec = new TextDecoder();

export type FolderState = "locked" | "unlocked" | "locking" | "unlocking";

export interface WrappedKey {
	iv: string;
	data: string;
}

export interface FolderHeader {
	format: number;
	id: string;
	kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
	recoverySalt: string;
	byPassword: WrappedKey;
	byRecovery: WrappedKey;
	state: FolderState;
	hideNames: boolean;
}

export interface NewFolder {
	header: FolderHeader;
	folderKey: CryptoKey;
	recoveryKey: Uint8Array;
}

function headerAad(id: string): Uint8Array {
	return enc.encode(`vault-locker header v1 ${id}`);
}

async function wrap(kek: CryptoKey, raw: Uint8Array, id: string): Promise<WrappedKey> {
	const { iv, data } = await seal(kek, raw, headerAad(id));
	return { iv: toBase64(iv), data: toBase64(data) };
}

async function unwrap(kek: CryptoKey, w: WrappedKey, id: string): Promise<CryptoKey> {
	const raw = await open(kek, fromBase64(w.iv), fromBase64(w.data), headerAad(id));
	return importFolderKey(raw);
}

export async function createFolderHeader(password: string, hideNames = false, iterations = PBKDF2_ITERATIONS): Promise<NewFolder> {
	const id = toBase64(randomBytes(12));
	const raw = randomBytes(KEY_BYTES);
	const salt = randomBytes(SALT_BYTES);
	const recoverySalt = randomBytes(SALT_BYTES);
	const recoveryKey = randomBytes(RECOVERY_BYTES);
	const byPassword = await wrap(await deriveKeyFromPassword(password, salt, iterations), raw, id);
	const byRecovery = await wrap(await deriveKeyFromRecovery(recoveryKey, recoverySalt), raw, id);
	const folderKey = await importFolderKey(raw);
	raw.fill(0);
	const header: FolderHeader = {
		format: FORMAT_VERSION,
		id,
		kdf: { name: "PBKDF2-SHA256", iterations, salt: toBase64(salt) },
		recoverySalt: toBase64(recoverySalt),
		byPassword,
		byRecovery,
		state: "unlocked",
		hideNames,
	};
	return { header, folderKey, recoveryKey };
}

export class WrongPasswordError extends Error {
	constructor() {
		super("Wrong password or recovery key");
		this.name = "WrongPasswordError";
	}
}

export async function unlockWithPassword(h: FolderHeader, password: string): Promise<CryptoKey> {
	const kek = await deriveKeyFromPassword(password, fromBase64(h.kdf.salt), h.kdf.iterations);
	try {
		return await unwrap(kek, h.byPassword, h.id);
	} catch {
		throw new WrongPasswordError();
	}
}

export async function unlockWithRecovery(h: FolderHeader, recoveryKey: Uint8Array): Promise<CryptoKey> {
	const kek = await deriveKeyFromRecovery(recoveryKey, fromBase64(h.recoverySalt));
	try {
		return await unwrap(kek, h.byRecovery, h.id);
	} catch {
		throw new WrongPasswordError();
	}
}

// Re-wraps the folder key under a new password. Files are not touched.
export async function changePassword(h: FolderHeader, oldPassword: string, newPassword: string, iterations = h.kdf.iterations): Promise<FolderHeader> {
	const oldKek = await deriveKeyFromPassword(oldPassword, fromBase64(h.kdf.salt), h.kdf.iterations);
	let raw: Uint8Array;
	try {
		raw = await open(oldKek, fromBase64(h.byPassword.iv), fromBase64(h.byPassword.data), headerAad(h.id));
	} catch {
		throw new WrongPasswordError();
	}
	const salt = randomBytes(SALT_BYTES);
	const byPassword = await wrap(await deriveKeyFromPassword(newPassword, salt, iterations), raw, h.id);
	raw.fill(0);
	return { ...h, kdf: { name: "PBKDF2-SHA256", iterations, salt: toBase64(salt) }, byPassword };
}

export function encodeHeader(h: FolderHeader): string {
	return JSON.stringify(h, null, 2);
}

export function decodeHeader(text: string): FolderHeader {
	const h = JSON.parse(text) as FolderHeader;
	if (h.format !== FORMAT_VERSION) throw new Error(`Unsupported Vault Locker format ${h.format}`);
	// The header is plain JSON that anyone with access to the vault could edit.
	// A bad iteration count can't leak anything (the key just won't unwrap), but a
	// huge one would freeze Obsidian, so reject it along with missing fields.
	const it = h.kdf?.iterations;
	const ok =
		h.kdf?.name === "PBKDF2-SHA256" &&
		Number.isInteger(it) && it >= 1 && it <= MAX_ITERATIONS &&
		[h.id, h.kdf.salt, h.recoverySalt, h.byPassword?.iv, h.byPassword?.data, h.byRecovery?.iv, h.byRecovery?.data].every((v) => typeof v === "string" && v.length > 0);
	if (!ok) throw new Error("Vault Locker key file is damaged or was changed");
	return h;
}

export interface LockedFileMeta {
	path: string; // path relative to the locked folder
	mtime: number;
}

function fileAad(folderId: string, version: number): Uint8Array {
	const id = enc.encode(folderId);
	const out = new Uint8Array(MAGIC.length + 1 + id.length);
	out.set(MAGIC, 0);
	out[MAGIC.length] = version;
	out.set(id, MAGIC.length + 1);
	return out;
}

// Version 1 (first release): the whole file sealed in one piece. Still read,
// no longer written. Kept exported so tests can make old-format files.
export async function encryptFileV1(key: CryptoKey, folderId: string, meta: LockedFileMeta, content: Uint8Array): Promise<Uint8Array> {
	const metaBytes = enc.encode(JSON.stringify(meta));
	const plain = new Uint8Array(4 + metaBytes.length + content.length);
	new DataView(plain.buffer).setUint32(0, metaBytes.length);
	plain.set(metaBytes, 4);
	plain.set(content, 4 + metaBytes.length);
	const { iv, data } = await seal(key, plain, fileAad(folderId, 1));
	plain.fill(0);
	const out = new Uint8Array(PREFIX_BYTES + data.length);
	out.set(MAGIC, 0);
	out[MAGIC.length] = 1;
	out.set(iv, MAGIC.length + 1);
	out.set(data, PREFIX_BYTES);
	return out;
}

async function decryptFileV1(key: CryptoKey, folderId: string, bytes: Uint8Array): Promise<{ meta: LockedFileMeta; content: Uint8Array }> {
	const iv = bytes.subarray(MAGIC.length + 1, PREFIX_BYTES);
	const plain = await open(key, iv, bytes.subarray(PREFIX_BYTES), fileAad(folderId, 1));
	const metaLen = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
	const meta = JSON.parse(dec.decode(plain.subarray(4, 4 + metaLen))) as LockedFileMeta;
	return { meta, content: plain.slice(4 + metaLen) };
}

// Version 2: chunked, so a big file never needs more than one extra copy in memory.
//   MAGIC(4) | version=2 (1) | chunk size u32 | content length u64 | nonce prefix (8)
//   | meta length u32 | meta block | content chunks...
// Block i (meta is 0, chunks are 1..n) uses nonce = prefix + i, and its AAD holds the
// folder id, the whole fixed header and i. So chunks can't be swapped, reordered or
// moved between files, and the content length can't be edited. The file must be
// exactly as long as the header says, so a cut-off file is caught too.
export const CHUNK_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
const V2_FIXED = MAGIC.length + 1 + 4 + 8 + 8; // 25
const V2_HEAD = V2_FIXED + 4; // + meta length

export class DamagedFileError extends Error {
	constructor(why: string) {
		super(`Locked file is damaged or was changed (${why})`);
		this.name = "DamagedFileError";
	}
}

interface V2Header {
	fixed: Uint8Array;
	chunkBytes: number;
	contentLength: number;
	prefix: Uint8Array;
	metaLen: number;
	chunks: number;
}

function v2Nonce(prefix: Uint8Array, i: number): Uint8Array {
	const iv = new Uint8Array(12);
	iv.set(prefix, 0);
	new DataView(iv.buffer).setUint32(8, i);
	return iv;
}

function v2Aad(base: Uint8Array, fixed: Uint8Array, i: number): Uint8Array {
	const out = new Uint8Array(base.length + fixed.length + 4);
	out.set(base, 0);
	out.set(fixed, base.length);
	new DataView(out.buffer).setUint32(base.length + fixed.length, i);
	return out;
}

function chunkCount(contentLength: number, chunkBytes: number): number {
	return Math.ceil(contentLength / chunkBytes);
}

// Exact on-disk size of a version 2 file, for callers that want to check room first.
export function lockedSize(contentLength: number, metaCipherLength: number, chunkBytes = CHUNK_BYTES): number {
	return V2_HEAD + metaCipherLength + contentLength + TAG_BYTES * chunkCount(contentLength, chunkBytes);
}

export async function encryptFile(
	key: CryptoKey,
	folderId: string,
	meta: LockedFileMeta,
	content: Uint8Array,
	chunkBytes = CHUNK_BYTES,
): Promise<Uint8Array> {
	const fixed = new Uint8Array(V2_FIXED);
	const dv = new DataView(fixed.buffer);
	fixed.set(MAGIC, 0);
	fixed[MAGIC.length] = 2;
	dv.setUint32(5, chunkBytes);
	dv.setBigUint64(9, BigInt(content.length));
	const prefix = randomBytes(8);
	fixed.set(prefix, 17);
	const base = fileAad(folderId, 2);
	const n = chunkCount(content.length, chunkBytes);
	if (n >= 0xffffffff) throw new Error("File is too large");

	const enc0 = async (i: number, plain: Uint8Array) =>
		new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: v2Nonce(prefix, i), additionalData: v2Aad(base, fixed, i) }, key, plain));
	const metaCipher = await enc0(0, enc.encode(JSON.stringify(meta)));
	// One buffer of the final size; each chunk is written straight into it.
	const out = new Uint8Array(lockedSize(content.length, metaCipher.length, chunkBytes));
	out.set(fixed, 0);
	new DataView(out.buffer).setUint32(V2_FIXED, metaCipher.length);
	out.set(metaCipher, V2_HEAD);
	let at = V2_HEAD + metaCipher.length;
	for (let i = 0; i < n; i++) {
		const c = await enc0(i + 1, content.subarray(i * chunkBytes, Math.min(content.length, (i + 1) * chunkBytes)));
		out.set(c, at);
		at += c.length;
	}
	return out;
}

function parseV2(bytes: Uint8Array): V2Header {
	if (bytes.length < V2_HEAD) throw new DamagedFileError("too short");
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunkBytes = dv.getUint32(5);
	const big = dv.getBigUint64(9);
	if (chunkBytes === 0 || big > BigInt(Number.MAX_SAFE_INTEGER)) throw new DamagedFileError("bad header");
	const contentLength = Number(big);
	const metaLen = dv.getUint32(V2_FIXED);
	const chunks = chunkCount(contentLength, chunkBytes);
	if (metaLen < TAG_BYTES || bytes.length !== V2_HEAD + metaLen + contentLength + TAG_BYTES * chunks) throw new DamagedFileError("wrong length");
	return { fixed: bytes.subarray(0, V2_FIXED), chunkBytes, contentLength, prefix: bytes.subarray(17, 25), metaLen, chunks };
}

async function openV2Block(key: CryptoKey, h: V2Header, base: Uint8Array, i: number, data: Uint8Array): Promise<Uint8Array> {
	try {
		return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: v2Nonce(h.prefix, i), additionalData: v2Aad(base, h.fixed, i) }, key, data));
	} catch {
		throw new DamagedFileError(i === 0 ? "header check failed" : `piece ${i} of ${h.chunks} failed its check`);
	}
}

// Walks the content chunks of a version 2 file, decrypting one at a time.
async function eachV2Chunk(
	key: CryptoKey,
	folderId: string,
	bytes: Uint8Array,
	fn: (plain: Uint8Array, offset: number) => boolean | void,
): Promise<{ meta: LockedFileMeta; h: V2Header }> {
	const h = parseV2(bytes);
	const base = fileAad(folderId, 2);
	const meta = JSON.parse(dec.decode(await openV2Block(key, h, base, 0, bytes.subarray(V2_HEAD, V2_HEAD + h.metaLen)))) as LockedFileMeta;
	let at = V2_HEAD + h.metaLen;
	for (let i = 0; i < h.chunks; i++) {
		const len = Math.min(h.chunkBytes, h.contentLength - i * h.chunkBytes) + TAG_BYTES;
		const plain = await openV2Block(key, h, base, i + 1, bytes.subarray(at, at + len));
		at += len;
		if (fn(plain, i * h.chunkBytes) === false) break;
	}
	return { meta, h };
}

export function isLockedFile(bytes: Uint8Array): boolean {
	return bytes.length > PREFIX_BYTES && MAGIC.every((b, i) => bytes[i] === b);
}

export function lockedFileVersion(bytes: Uint8Array): number {
	return isLockedFile(bytes) ? bytes[MAGIC.length] : 0;
}

export async function decryptFile(key: CryptoKey, folderId: string, bytes: Uint8Array): Promise<{ meta: LockedFileMeta; content: Uint8Array }> {
	if (!isLockedFile(bytes)) throw new Error("Not a Vault Locker file");
	const v = bytes[MAGIC.length];
	if (v === 1) return decryptFileV1(key, folderId, bytes);
	if (v !== 2) throw new Error(`Unsupported file version ${v}`);
	const h = parseV2(bytes);
	const content = new Uint8Array(h.contentLength);
	const { meta } = await eachV2Chunk(key, folderId, bytes, (plain, offset) => {
		content.set(plain, offset);
	});
	return { meta, content };
}

// Only the name and date, without decrypting the content (version 2).
export async function readFileMeta(key: CryptoKey, folderId: string, bytes: Uint8Array): Promise<LockedFileMeta> {
	if (lockedFileVersion(bytes) !== 2) return (await decryptFile(key, folderId, bytes)).meta;
	const h = parseV2(bytes);
	return JSON.parse(dec.decode(await openV2Block(key, h, fileAad(folderId, 2), 0, bytes.subarray(V2_HEAD, V2_HEAD + h.metaLen)))) as LockedFileMeta;
}

// True if the locked bytes decrypt to exactly `content`. Checks a chunk at a
// time, so it needs no third copy of a big file in memory.
export async function lockedMatches(key: CryptoKey, folderId: string, bytes: Uint8Array, content: Uint8Array): Promise<boolean> {
	try {
		if (lockedFileVersion(bytes) !== 2) {
			const d = await decryptFile(key, folderId, bytes);
			return sameBytes(d.content, content);
		}
		if (parseV2(bytes).contentLength !== content.length) return false;
		let same = true;
		await eachV2Chunk(key, folderId, bytes, (plain, offset) => {
			same = sameBytes(plain, content.subarray(offset, offset + plain.length));
			return same;
		});
		return same;
	} catch {
		return false;
	}
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
