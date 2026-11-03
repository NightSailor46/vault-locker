import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DamagedFileError,
	createFolderHeader,
	decryptFile,
	encryptFile,
	encryptFileV1,
	lockedFileVersion,
	lockedMatches,
	unlockWithPassword,
} from "../src/format.ts";
import { lockFolder, readHeader, setupFolder, unlockFolder } from "../src/locker.ts";
import { MemFS } from "./memfs.ts";

const FAST = { iterations: 1000 };
const CHUNK = 64; // tiny chunks so a small test file has many pieces
const TAG = 16;

function data(n: number): Uint8Array {
	const d = new Uint8Array(n);
	for (let i = 0; i < n; i++) d[i] = (i * 7 + 3) & 255;
	return d;
}

async function folder() {
	const { header, folderKey } = await createFolderHeader("pw", false, 1000);
	return { id: header.id, key: folderKey };
}

// Offset of content chunk i (0-based) in a v2 file made with chunk size CHUNK.
function chunkAt(bytes: Uint8Array, i: number): number {
	const metaLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(25);
	return 29 + metaLen + i * (CHUNK + TAG);
}

test("chunked format: round trip at many sizes, including empty and exact multiples", async () => {
	const { id, key } = await folder();
	for (const n of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 5, CHUNK * 5 + 17]) {
		const bytes = await encryptFile(key, id, { path: "v.mp4", mtime: 1 }, data(n), CHUNK);
		assert.equal(lockedFileVersion(bytes), 2);
		const out = await decryptFile(key, id, bytes);
		assert.deepEqual(out.content, data(n), `size ${n}`);
		assert.deepEqual(out.meta, { path: "v.mp4", mtime: 1 });
	}
});

test("default chunk size handles a multi-chunk file (3.5 MB)", async () => {
	const { id, key } = await folder();
	const d = data(3.5 * 1024 * 1024);
	const bytes = await encryptFile(key, id, { path: "big.bin", mtime: 1 }, d);
	assert.deepEqual((await decryptFile(key, id, bytes)).content, d);
	assert.ok(await lockedMatches(key, id, bytes, d));
	const other = d.slice();
	other[other.length - 1] ^= 1;
	assert.equal(await lockedMatches(key, id, bytes, other), false);
});

test("old format (version 1) files still unlock", async () => {
	const fs = new MemFS();
	fs.addText("P/a.md", "x");
	const { folderKey, header } = await setupFolder(fs, "P", "pw", FAST);
	// Lock the way the first release did, by hand.
	const old = await encryptFileV1(folderKey, header.id, { path: "note.md", mtime: 2 }, new TextEncoder().encode("old secret"));
	assert.equal(lockedFileVersion(old), 1);
	assert.deepEqual((await decryptFile(folderKey, header.id, old)).content, new TextEncoder().encode("old secret"));
	await lockFolder(fs, "P", folderKey);
	fs.addBinary("P/note.md.vlock", old);
	const key = await unlockWithPassword((await readHeader(fs, "P"))!, "pw");
	await unlockFolder(fs, "P", key);
	assert.equal(fs.text("P/note.md"), "old secret");
	assert.equal(fs.text("P/a.md"), "x");
});

test("truncated file is refused (cut at a chunk edge and mid-chunk)", async () => {
	const { id, key } = await folder();
	const bytes = await encryptFile(key, id, { path: "v", mtime: 0 }, data(CHUNK * 4), CHUNK);
	await assert.rejects(decryptFile(key, id, bytes.slice(0, chunkAt(bytes, 3))), DamagedFileError);
	await assert.rejects(decryptFile(key, id, bytes.slice(0, bytes.length - 5)), DamagedFileError);
	await assert.rejects(decryptFile(key, id, bytes.slice(0, 10)));
});

test("truncation with an edited length in the header is refused", async () => {
	const { id, key } = await folder();
	const bytes = await encryptFile(key, id, { path: "v", mtime: 0 }, data(CHUNK * 4), CHUNK);
	const cut = bytes.slice(0, chunkAt(bytes, 3));
	new DataView(cut.buffer).setBigUint64(9, BigInt(CHUNK * 3)); // claim 3 chunks
	await assert.rejects(decryptFile(key, id, cut), DamagedFileError);
});

test("reordered or swapped chunks are refused", async () => {
	const { id, key } = await folder();
	const bytes = await encryptFile(key, id, { path: "v", mtime: 0 }, data(CHUNK * 4), CHUNK);
	const swapped = bytes.slice();
	const a = chunkAt(bytes, 1), b = chunkAt(bytes, 2), len = CHUNK + TAG;
	swapped.set(bytes.subarray(b, b + len), a);
	swapped.set(bytes.subarray(a, a + len), b);
	await assert.rejects(decryptFile(key, id, swapped), DamagedFileError);
});

test("a chunk from another locked file can't be spliced in", async () => {
	const { id, key } = await folder();
	const one = await encryptFile(key, id, { path: "a", mtime: 0 }, data(CHUNK * 3), CHUNK);
	const two = await encryptFile(key, id, { path: "a", mtime: 0 }, data(CHUNK * 3), CHUNK);
	const mixed = one.slice();
	mixed.set(two.subarray(chunkAt(two, 1), chunkAt(two, 2)), chunkAt(one, 1));
	await assert.rejects(decryptFile(key, id, mixed), DamagedFileError);
});

test("a changed byte in any chunk or the header is caught", async () => {
	const { id, key } = await folder();
	const bytes = await encryptFile(key, id, { path: "v", mtime: 0 }, data(CHUNK * 3), CHUNK);
	for (const at of [6, 20, 30, chunkAt(bytes, 0) + 3, chunkAt(bytes, 2) + 70]) {
		const bad = bytes.slice();
		bad[at] ^= 1;
		await assert.rejects(decryptFile(key, id, bad), undefined, `byte ${at}`);
	}
});

test("files over the size limit are left alone and named; the rest still lock", async () => {
	const fs = new MemFS();
	fs.addText("P/small.md", "ok");
	const movie = data(5000);
	fs.addBinary("P/movie.mov", movie);
	const { folderKey } = await setupFolder(fs, "P", "pw", FAST);
	const r = await lockFolder(fs, "P", folderKey, { maxFileBytes: 4000 });
	assert.equal(r.files, 1);
	assert.deepEqual(r.tooBig, ["movie.mov"]);
	assert.ok(!fs.files.has("P/small.md"), "the note is locked");
	assert.ok(fs.files.has("P/small.md.vlock"));
	assert.deepEqual(fs.files.get("P/movie.mov"), movie, "the big file is untouched");
	assert.equal((await readHeader(fs, "P"))!.state, "locked");
	await unlockFolder(fs, "P", folderKey);
	assert.equal(fs.text("P/small.md"), "ok");
	assert.deepEqual(fs.files.get("P/movie.mov"), movie);
	const again = await lockFolder(fs, "P", folderKey, { maxFileBytes: 10_000 });
	assert.equal(again.files, 2);
	assert.equal(again.tooBig, undefined);
});

test("resume after a crash drops a half-written locked copy and keeps the original", async () => {
	const fs = new MemFS();
	fs.addBinary("P/clip.mov", data(3000));
	const { folderKey } = await setupFolder(fs, "P", "pw", FAST);
	const h = (await readHeader(fs, "P"))!;
	h.state = "locking";
	await fs.write("P/.vaultlocker", JSON.stringify(h));
	const full = await encryptFile(folderKey, h.id, { path: "clip.mov", mtime: 0 }, data(3000));
	fs.addBinary("P/clip.mov.vlock", full.slice(0, 1000)); // the crash cut it short
	await lockFolder(fs, "P", folderKey);
	assert.deepEqual([...fs.files.keys()].filter((f) => f.startsWith("P/") && !f.endsWith(".vaultlocker")), ["P/clip.mov.vlock"]);
	await unlockFolder(fs, "P", folderKey);
	assert.deepEqual(fs.files.get("P/clip.mov"), data(3000));
});
