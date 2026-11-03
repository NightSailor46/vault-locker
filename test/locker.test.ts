import { test } from "node:test";
import assert from "node:assert/strict";
import { MemFS } from "./memfs.ts";
import { lockFolder, readHeader, setupFolder, unlockFolder } from "../src/locker.ts";
import { unlockWithPassword, unlockWithRecovery } from "../src/format.ts";
import { parseRecoveryKey } from "../src/crypto.ts";

const FAST = { iterations: 1000 };

function sampleVault(): MemFS {
	const fs = new MemFS();
	fs.addText("Notes/open.md", "not locked");
	fs.addText("Private/Taxes.md", "EIN goes here");
	fs.addText("Private/Sub/Deep note.md", "deep secret");
	fs.addBinary("Private/scan.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 255, 7]));
	return fs;
}

function plainOf(fs: MemFS, prefix: string): Map<string, string> {
	const m = new Map<string, string>();
	for (const [k, v] of fs.files) if (k.startsWith(prefix) && !k.endsWith(".vaultlocker")) m.set(k, Buffer.from(v).toString("hex"));
	return m;
}

test("lock then unlock restores every file exactly (notes + attachments)", async () => {
	const fs = sampleVault();
	const before = plainOf(fs, "Private/");
	const { folderKey } = await setupFolder(fs, "Private", "pw", FAST);
	const r = await lockFolder(fs, "Private", folderKey);
	assert.equal(r.files, 3);
	assert.equal((await readHeader(fs, "Private"))!.state, "locked");
	for (const [k, v] of fs.files) {
		if (!k.startsWith("Private/") || k.endsWith(".vaultlocker")) continue;
		assert.ok(k.endsWith(".vlock"), `left plain: ${k}`);
		const s = Buffer.from(v).toString("latin1");
		assert.ok(!s.includes("secret") && !s.includes("EIN"));
	}
	assert.equal(fs.text("Notes/open.md"), "not locked");

	const key = await unlockWithPassword((await readHeader(fs, "Private"))!, "pw");
	await unlockFolder(fs, "Private", key);
	assert.deepEqual(plainOf(fs, "Private/"), before);
	assert.equal((await readHeader(fs, "Private"))!.state, "unlocked");
});

test("hidden names: no file or subfolder names are left visible", async () => {
	const fs = sampleVault();
	const before = plainOf(fs, "Private/");
	const { folderKey } = await setupFolder(fs, "Private", "pw", { ...FAST, hideNames: true });
	await lockFolder(fs, "Private", folderKey);
	const names = [...fs.files.keys(), ...fs.dirs].filter((k) => k.startsWith("Private/"));
	assert.ok(names.every((n) => !/Taxes|Deep|scan|Sub/.test(n)), names.join(", "));
	await unlockFolder(fs, "Private", folderKey);
	assert.deepEqual(plainOf(fs, "Private/"), before);
	assert.ok(fs.dirs.has("Private/Sub"));
});

test("recovery key from setup unlocks the folder", async () => {
	const fs = sampleVault();
	const { folderKey, recoveryKey } = await setupFolder(fs, "Private", "pw", FAST);
	await lockFolder(fs, "Private", folderKey);
	const key = await unlockWithRecovery((await readHeader(fs, "Private"))!, parseRecoveryKey(recoveryKey));
	await unlockFolder(fs, "Private", key);
	assert.equal(fs.text("Private/Taxes.md"), "EIN goes here");
});

test("setting up the same folder twice is refused", async () => {
	const fs = sampleVault();
	await setupFolder(fs, "Private", "pw", FAST);
	await assert.rejects(setupFolder(fs, "Private", "pw", FAST));
});

test("a crash mid-lock loses nothing, and re-running finishes the job", async () => {
	for (const hideNames of [false, true]) {
		const fs = sampleVault();
		const before = plainOf(fs, "Private/");
		const { folderKey } = await setupFolder(fs, "Private", "pw", { ...FAST, hideNames });
		fs.failWritesAfter = 2; // header write + one file, then crash
		await assert.rejects(lockFolder(fs, "Private", folderKey));
		assert.equal((await readHeader(fs, "Private"))!.state, "locking");
		fs.failWritesAfter = Infinity;
		await lockFolder(fs, "Private", folderKey);
		await unlockFolder(fs, "Private", folderKey);
		assert.deepEqual(plainOf(fs, "Private/"), before, `hideNames=${hideNames}`);
	}
});

test("resume after a crash where the original was edited keeps only the new version", async () => {
	const fs = new MemFS();
	fs.addText("P/a.md", "v1");
	const { folderKey } = await setupFolder(fs, "P", "pw", { ...FAST, hideNames: true });
	fs.failWritesAfter = 2; // header + a.md locked copy, then crash before the final header save
	await lockFolder(fs, "P", folderKey).catch(() => {});
	// Interrupted after the .vlock was written; put the original back as if never removed, edited.
	fs.addText("P/a.md", "v2");
	fs.failWritesAfter = Infinity;
	const h = (await readHeader(fs, "P"))!;
	h.state = "locking";
	await fs.write("P/.vaultlocker", JSON.stringify(h));
	await lockFolder(fs, "P", folderKey);
	assert.equal([...fs.files.keys()].filter((k) => k.endsWith(".vlock")).length, 1);
	await unlockFolder(fs, "P", folderKey);
	assert.equal(fs.text("P/a.md"), "v2");
});

test("locking an already locked folder is a no-op", async () => {
	const fs = sampleVault();
	const { folderKey } = await setupFolder(fs, "Private", "pw", FAST);
	await lockFolder(fs, "Private", folderKey);
	const snapshot = plainOf(fs, "Private/");
	const r = await lockFolder(fs, "Private", folderKey);
	assert.equal(r.files, 0);
	assert.deepEqual(plainOf(fs, "Private/"), snapshot);
});

test("progress is reported once per file", async () => {
	const fs = sampleVault();
	const { folderKey } = await setupFolder(fs, "Private", "pw", FAST);
	const seen: string[] = [];
	await lockFolder(fs, "Private", folderKey, (d, t) => seen.push(`${d}/${t}`));
	assert.deepEqual(seen, ["1/3", "2/3", "3/3"]);
	seen.length = 0;
	await unlockFolder(fs, "Private", folderKey, (d, t) => seen.push(`${d}/${t}`));
	assert.deepEqual(seen, ["1/3", "2/3", "3/3"]);
});

test("a note made with the same name while locked is kept, not overwritten", async () => {
	const fs = sampleVault();
	const { folderKey } = await setupFolder(fs, "Private", "pw", FAST);
	await lockFolder(fs, "Private", folderKey);
	fs.addText("Private/Taxes.md", "written while locked");
	await unlockFolder(fs, "Private", folderKey);
	assert.equal(fs.text("Private/Taxes.md"), "written while locked");
	assert.equal(fs.text("Private/Taxes (locked copy).md"), "EIN goes here");
});

test("a crash mid-unlock is finished by unlocking again, with no duplicate copies", async () => {
	const fs = sampleVault();
	const before = plainOf(fs, "Private/");
	const { folderKey } = await setupFolder(fs, "Private", "pw", FAST);
	await lockFolder(fs, "Private", folderKey);
	// Simulate: a file was written back but its .vlock was not yet removed.
	const vlock = [...fs.files.keys()].find((k) => k.endsWith("Taxes.md.vlock"))!;
	fs.addText("Private/Taxes.md", "EIN goes here");
	assert.ok(fs.files.has(vlock));
	await unlockFolder(fs, "Private", folderKey);
	assert.deepEqual(plainOf(fs, "Private/"), before);
});

test("plainFiles finds notes added to a folder after it was locked", async () => {
	const { plainFiles } = await import("../src/locker.ts");
	const fs = sampleVault();
	const { folderKey } = await setupFolder(fs, "Private", "pw", FAST);
	await lockFolder(fs, "Private", folderKey);
	assert.deepEqual(await plainFiles(fs, "Private"), []);
	fs.addText("Private/added later.md", "new secret");
	assert.deepEqual(await plainFiles(fs, "Private"), ["Private/added later.md"]);
	const r = await lockFolder(fs, "Private", folderKey);
	assert.equal(r.files, 1);
	assert.deepEqual(await plainFiles(fs, "Private"), []);
	assert.deepEqual(await plainFiles(fs, "Missing"), []);
});
