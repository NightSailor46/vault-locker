// Lock and unlock a folder. Works over a small file-system interface shaped
// like Obsidian's DataAdapter, so tests can run without Obsidian.

import { randomBytes, formatRecoveryKey, toBase64 } from "./crypto.ts";
import {
	HEADER_NAME,
	LOCKED_EXT,
	createFolderHeader,
	decodeHeader,
	decryptFile,
	encodeHeader,
	encryptFile,
	lockedMatches,
	readFileMeta,
	sameBytes,
	type FolderHeader,
} from "./format.ts";

export interface LockerFS {
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	readBinary(path: string): Promise<Uint8Array>;
	writeBinary(path: string, data: Uint8Array): Promise<void>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	rmdir(path: string): Promise<void>;
	// File size in bytes without reading it. Optional; used for the size limit.
	size?(path: string): Promise<number>;
}

// Biggest single file we lock. Each file is read and encrypted in memory, which
// needs about twice its size free. Phones and tablets have far less room than a
// computer, so they get a lower limit. Measured numbers: Build Log 2026-10-31.
export const MAX_FILE_BYTES_DESKTOP = 1024 * 1024 * 1024; // 1 GB
export const MAX_FILE_BYTES_MOBILE = 200 * 1024 * 1024; // 200 MB

export interface LockOptions {
	onProgress?: Progress;
	maxFileBytes?: number;
}

export interface LockResult {
	files: number;
	// Files over the size limit, left as they were (relative to the folder).
	tooBig?: string[];
}

// Called after each file, so the UI can show progress on big folders.
export type Progress = (done: number, total: number) => void;

function headerPath(folder: string): string {
	return `${folder}/${HEADER_NAME}`;
}

function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export async function readHeader(fs: LockerFS, folder: string): Promise<FolderHeader | null> {
	const p = headerPath(folder);
	if (!(await fs.exists(p))) return null;
	return decodeHeader(await fs.read(p));
}

async function saveHeader(fs: LockerFS, folder: string, h: FolderHeader): Promise<void> {
	await fs.write(headerPath(folder), encodeHeader(h));
}

// All files under a folder (recursive), skipping the header file.
async function walk(fs: LockerFS, folder: string): Promise<{ files: string[]; folders: string[] }> {
	const files: string[] = [];
	const folders: string[] = [];
	const queue = [folder];
	while (queue.length) {
		const dir = queue.shift()!;
		const entry = await fs.list(dir);
		for (const f of entry.files) if (f !== headerPath(folder)) files.push(f);
		for (const d of entry.folders) {
			folders.push(d);
			queue.push(d);
		}
	}
	return { files, folders };
}

async function ensureDir(fs: LockerFS, dir: string): Promise<void> {
	if (!dir || (await fs.exists(dir))) return;
	await ensureDir(fs, parentOf(dir));
	await fs.mkdir(dir);
}

// Deepest first, and only the ones left empty.
async function removeEmptyFolders(fs: LockerFS, folders: string[]): Promise<void> {
	const sorted = [...folders].sort((a, b) => b.split("/").length - a.split("/").length);
	for (const d of sorted) {
		if (!(await fs.exists(d))) continue;
		const e = await fs.list(d);
		if (e.files.length === 0 && e.folders.length === 0) await fs.rmdir(d);
	}
}

// First-time setup. Returns the recovery key to show the user once.
export async function setupFolder(
	fs: LockerFS,
	folder: string,
	password: string,
	opts: { hideNames?: boolean; iterations?: number } = {},
): Promise<{ header: FolderHeader; folderKey: CryptoKey; recoveryKey: string }> {
	if (await fs.exists(headerPath(folder))) throw new Error(`${folder} is already set up`);
	const { header, folderKey, recoveryKey } = await createFolderHeader(password, opts.hideNames ?? false, opts.iterations);
	await saveHeader(fs, folder, header);
	return { header, folderKey, recoveryKey: formatRecoveryKey(recoveryKey) };
}

// Puts back a missing header from a saved copy (e.g. a sync service that skips
// dot-files). The keys inside are still wrapped, so the copy reveals nothing.
// Returns true if the header had to be restored.
export async function restoreHeader(fs: LockerFS, folder: string, saved: string): Promise<boolean> {
	if (!(await fs.exists(folder)) || (await fs.exists(headerPath(folder)))) return false;
	const h = decodeHeader(saved);
	const { files } = await walk(fs, folder);
	h.state = files.some((f) => !f.endsWith(LOCKED_EXT)) ? "unlocked" : "locked";
	await saveHeader(fs, folder, h);
	return true;
}

// Files in the folder that are not encrypted, e.g. notes added or moved in
// after it was locked. Empty means the folder is fully locked.
export async function plainFiles(fs: LockerFS, folder: string): Promise<string[]> {
	if (!(await fs.exists(folder))) return [];
	const { files } = await walk(fs, folder);
	return files.filter((f) => !f.endsWith(LOCKED_EXT));
}

export async function lockFolder(fs: LockerFS, folder: string, key: CryptoKey, opts: LockOptions | Progress = {}): Promise<LockResult> {
	const { onProgress, maxFileBytes } = typeof opts === "function" ? { onProgress: opts, maxFileBytes: undefined } : opts;
	const h = await readHeader(fs, folder);
	if (!h) throw new Error(`${folder} is not set up for Vault Locker`);

	const { files, folders } = await walk(fs, folder);
	const locked = files.filter((f) => f.endsWith(LOCKED_EXT));
	const plain = files.filter((f) => !f.endsWith(LOCKED_EXT));

	// Files over the limit would run the device out of memory, so they are left as
	// they are and named to the user. Everything else still gets locked: one big
	// video shouldn't leave the notes beside it readable.
	const tooBig: string[] = [];
	if (maxFileBytes && fs.size) {
		for (const f of [...plain]) {
			if ((await fs.size(f)) > maxFileBytes) {
				tooBig.push(f.slice(folder.length + 1));
				plain.splice(plain.indexOf(f), 1);
			}
		}
	}

	const resuming = h.state === "locking";
	h.state = "locking";
	await saveHeader(fs, folder, h);

	// After a crash, some originals may already have a .vlock. Only the names are
	// kept here; contents are compared one file at a time below.
	const done = new Map<string, string>();
	if (resuming) {
		for (const f of locked) {
			try {
				done.set((await readFileMeta(key, h.id, await fs.readBinary(f))).path, f);
			} catch {
				// Likely half-written by the crash. Drop it only if its original is still
				// here; otherwise leave it alone rather than risk deleting anything.
				if (plain.includes(f.slice(0, -LOCKED_EXT.length))) await fs.remove(f);
			}
		}
	}

	let count = 0;
	for (const file of plain) {
		const rel = file.slice(folder.length + 1);
		const content = await fs.readBinary(file);
		const prior = done.get(rel);
		if (!(prior && (await lockedMatches(key, h.id, await fs.readBinary(prior), content)))) {
			const target = h.hideNames ? `${folder}/${hiddenName()}${LOCKED_EXT}` : `${file}${LOCKED_EXT}`;
			await fs.writeBinary(target, await encryptFile(key, h.id, { path: rel, mtime: Date.now() }, content));
			// Never delete the original until the locked copy reads back from disk and
			// decrypts to the same bytes. The encrypted buffer is already let go, and the
			// check runs a piece at a time, so a big file needs about 2x its size in memory.
			if (!(await lockedMatches(key, h.id, await fs.readBinary(target), content))) throw new Error(`Verify failed for ${rel}; original kept`);
			// A stale copy from an interrupted run would otherwise come back on unlock.
			if (prior && prior !== target) await fs.remove(prior);
		}
		await fs.remove(file);
		count++;
		onProgress?.(count, plain.length);
	}
	if (h.hideNames) await removeEmptyFolders(fs, folders);

	h.state = "locked";
	await saveHeader(fs, folder, h);
	return tooBig.length ? { files: count, tooBig } : { files: count };
}

export async function unlockFolder(fs: LockerFS, folder: string, key: CryptoKey, onProgress?: Progress): Promise<LockResult> {
	const h = await readHeader(fs, folder);
	if (!h) throw new Error(`${folder} is not set up for Vault Locker`);
	h.state = "unlocking";
	await saveHeader(fs, folder, h);

	const { files } = await walk(fs, folder);
	const locked = files.filter((f) => f.endsWith(LOCKED_EXT));
	let count = 0;
	for (const file of locked) {
		const { meta, content } = await decryptFile(key, h.id, await fs.readBinary(file));
		if (meta.path.startsWith("/") || meta.path.split(/[\\/]/).includes("..")) throw new Error(`Unsafe path in ${file}`);
		let target = `${folder}/${meta.path}`;
		await ensureDir(fs, parentOf(target));
		if (await fs.exists(target)) {
			// Same content: an interrupted unlock already wrote it. Different: a file made
			// while the folder was locked; keep both rather than overwrite it.
			if (!sameBytes(await fs.readBinary(target), content)) {
				target = await freeName(fs, target);
				await fs.writeBinary(target, content);
			}
		} else {
			await fs.writeBinary(target, content);
		}
		// Cheap check that the whole file landed before the locked copy goes.
		if (fs.size && (await fs.size(target)) !== content.length) throw new Error(`Write check failed for ${meta.path}; locked copy kept`);
		await fs.remove(file);
		count++;
		onProgress?.(count, locked.length);
	}

	h.state = "unlocked";
	await saveHeader(fs, folder, h);
	return { files: count };
}

function hiddenName(): string {
	return toBase64(randomBytes(12)).replace(/\+/g, "-").replace(/\//g, "_");
}

// "Note.md" -> "Note (locked copy).md", then "Note (locked copy 2).md", ...
async function freeName(fs: LockerFS, path: string): Promise<string> {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
	for (let n = 1; ; n++) {
		const candidate = `${stem} (locked copy${n === 1 ? "" : ` ${n}`})${ext}`;
		if (!(await fs.exists(candidate))) return candidate;
	}
}
