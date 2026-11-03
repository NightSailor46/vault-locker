import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PBKDF2_ITERATIONS,
	formatRecoveryKey,
	fromBase64,
	parseRecoveryKey,
	randomBytes,
	toBase64,
} from "../src/crypto.ts";
import {
	WrongPasswordError,
	changePassword,
	createFolderHeader,
	decodeHeader,
	decryptFile,
	encodeHeader,
	encryptFile,
	isLockedFile,
	unlockWithPassword,
	unlockWithRecovery,
} from "../src/format.ts";

const FAST = 1000; // iterations for speed in tests; real default checked below

test("default PBKDF2 iterations meet OWASP 2023 (600k)", () => {
	assert.ok(PBKDF2_ITERATIONS >= 600_000);
});

test("recovery key round-trips through its text form", () => {
	for (let i = 0; i < 20; i++) {
		const bytes = randomBytes(20);
		const text = formatRecoveryKey(bytes);
		assert.match(text, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
		assert.deepEqual(parseRecoveryKey(text.toLowerCase().replace(/-/g, " ")), bytes);
	}
});

test("base64 helpers round-trip", () => {
	const b = randomBytes(33);
	assert.deepEqual(fromBase64(toBase64(b)), b);
});

test("password unlocks, wrong password fails", async () => {
	const { header } = await createFolderHeader("correct horse", false, FAST);
	await unlockWithPassword(header, "correct horse");
	await assert.rejects(unlockWithPassword(header, "wrong"), WrongPasswordError);
});

test("recovery key unlocks the same folder key", async () => {
	const { header, folderKey, recoveryKey } = await createFolderHeader("pw", false, FAST);
	const bytes = await encryptFile(folderKey, header.id, { path: "a.md", mtime: 1 }, new TextEncoder().encode("hi"));
	const k2 = await unlockWithRecovery(header, recoveryKey);
	const { content } = await decryptFile(k2, header.id, bytes);
	assert.equal(new TextDecoder().decode(content), "hi");
	await assert.rejects(unlockWithRecovery(header, randomBytes(20)), WrongPasswordError);
});

test("changing the password keeps files readable", async () => {
	const { header, folderKey } = await createFolderHeader("old", false, FAST);
	const bytes = await encryptFile(folderKey, header.id, { path: "n.md", mtime: 1 }, new Uint8Array([1, 2, 3]));
	const h2 = await changePassword(header, "old", "new");
	await assert.rejects(unlockWithPassword(h2, "old"), WrongPasswordError);
	const k = await unlockWithPassword(h2, "new");
	assert.deepEqual((await decryptFile(k, h2.id, bytes)).content, new Uint8Array([1, 2, 3]));
	await assert.rejects(changePassword(header, "nope", "x"), WrongPasswordError);
});

test("header survives JSON encode/decode and has no plain key", async () => {
	const { header } = await createFolderHeader("pw", true, FAST);
	const text = encodeHeader(header);
	assert.deepEqual(decodeHeader(text), header);
	assert.ok(!text.includes("pw\""));
	assert.throws(() => decodeHeader(JSON.stringify({ ...header, format: 99 })));
});

test("file encryption: same input gives different bytes, tamper is caught", async () => {
	const { header, folderKey } = await createFolderHeader("pw", false, FAST);
	const data = new TextEncoder().encode("secret note");
	const a = await encryptFile(folderKey, header.id, { path: "x.md", mtime: 5 }, data);
	const b = await encryptFile(folderKey, header.id, { path: "x.md", mtime: 5 }, data);
	assert.ok(isLockedFile(a));
	assert.notDeepEqual(a, b);
	assert.ok(!Buffer.from(a).toString("latin1").includes("secret"));
	assert.ok(!Buffer.from(a).toString("latin1").includes("x.md"));
	const out = await decryptFile(folderKey, header.id, a);
	assert.deepEqual(out.meta, { path: "x.md", mtime: 5 });
	assert.deepEqual(out.content, data);
	const bad = a.slice();
	bad[bad.length - 1] ^= 1;
	await assert.rejects(decryptFile(folderKey, header.id, bad));
});

test("a file can't be moved into a different locked folder", async () => {
	const one = await createFolderHeader("pw", false, FAST);
	const bytes = await encryptFile(one.folderKey, one.header.id, { path: "a", mtime: 0 }, new Uint8Array([9]));
	await assert.rejects(decryptFile(one.folderKey, "other-folder-id", bytes));
});

test("empty password is refused", async () => {
	await assert.rejects(createFolderHeader("", false, FAST));
});

test("recovery key forgives 0/1/8 typed for O/I/B", async () => {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	const text = formatRecoveryKey(bytes);
	const sloppy = text.replace(/O/g, "0").replace(/I/g, "1").replace(/B/g, "8");
	assert.deepEqual(parseRecoveryKey(sloppy), bytes);
	assert.throws(() => parseRecoveryKey(text.slice(0, -4)), /should have/);
});

test("header with a tampered iteration count or missing fields is refused", async () => {
	const { header } = await createFolderHeader("pw", false, FAST);
	const huge = { ...header, kdf: { ...header.kdf, iterations: 2_000_000_000 } };
	assert.throws(() => decodeHeader(encodeHeader(huge)), /damaged or was changed/);
	const missing: Record<string, unknown> = { ...header };
	delete missing.byRecovery;
	assert.throws(() => decodeHeader(JSON.stringify(missing)), /damaged or was changed/);
	assert.deepEqual(decodeHeader(encodeHeader(header)), header);
});
