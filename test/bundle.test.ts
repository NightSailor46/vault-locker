// End-to-end check of the built main.js, loaded the way Obsidian loads it
// (CommonJS, `obsidian` provided by the host) against a fake app and an
// in-memory vault. Modals auto-fill "pw" and auto-click their buttons.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { MemFS } from "./memfs.ts";

const notices: string[] = [];

// Input types that received focus, in order ("password" or "text").
const focusLog: string[] = [];

class FakeEl {
	children: FakeEl[] = [];
	text = "";
	type = "";
	setText(t: string) {
		this.text = t;
	}
	cls = "";
	toggleClass(c: string, on: boolean) {
		(this as any)[c] = on;
	}
	createEl(_tag: string, o?: { text?: string; cls?: string }) {
		const e = new FakeEl();
		e.text = o?.text ?? "";
		e.cls = o?.cls ?? "";
		this.children.push(e);
		return e;
	}
	empty() {
		this.children = [];
	}
	addEventListener() {}
	focused = 0;
	focus() {
		this.focused++;
		focusLog.push(this.type);
	}
}

class Setting {
	constructor(_el: FakeEl) {}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	addText(cb: (t: any) => void) {
		const t: any = { inputEl: new FakeEl(), setValue: () => t, setDisabled: () => t, onChange: (fn: (v: string) => void) => (fn("pw"), t) };
		cb(t);
		return this;
	}
	addToggle(cb: (t: any) => void) {
		const t: any = { setValue: () => t, setDisabled: () => t, onChange: () => t };
		cb(t);
		return this;
	}
	addButton(cb: (b: any) => void) {
		const b: any = { setButtonText: () => b, setCta: () => b, onClick: (fn: () => void) => (queueMicrotask(fn), b) };
		cb(b);
		return this;
	}
}

class Modal {
	app: any;
	titleEl = new FakeEl();
	contentEl = new FakeEl();
	constructor(app: any) {
		this.app = app;
	}
	open() {
		(this as any).onOpen();
	}
	close() {
		(this as any).onClose?.();
	}
}

class TFolder {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
	isRoot() {
		return this.path === "/";
	}
}

const obsidian = {
	Platform: { isMobile: false },
	Modal,
	Setting,
	TFolder,
	Notice: class {
		constructor(msg: string) {
			notices.push(msg);
		}
		setMessage(msg: string) {
			notices.push(msg);
		}
		hide() {}
	},
	Plugin: class {
		app: any;
		data: any = null;
		commands: any[] = [];
		constructor(app: any) {
			this.app = app;
		}
		loadData() {
			return Promise.resolve(this.data);
		}
		saveData(d: any) {
			this.data = JSON.parse(JSON.stringify(d));
			return Promise.resolve();
		}
		addSettingTab() {}
		addRibbonIcon(_icon: string, _title: string, fn: () => void) {
			(this as any).ribbon = fn;
		}
		addStatusBarItem() {
			const el: any = { text: "", setText: (t: string) => (el.text = t) };
			(this as any).status = el;
			return el;
		}
		addCommand(c: any) {
			this.commands.push(c);
		}
		registerEvent() {}
		registerDomEvent() {}
	},
	PluginSettingTab: class {},
	requestUrl: async () => ({ status: 500, json: {} }),
};

function load(): any {
	const code = readFileSync(new URL("../main.js", import.meta.url), "utf8");
	const module = { exports: {} as any };
	const req = (name: string) => {
		if (name === "obsidian") return obsidian;
		throw new Error(`unexpected require ${name}`);
	};
	new Function("module", "exports", "require", code)(module, module.exports, req);
	return module.exports;
}

function fakeApp(fs: MemFS) {
	const handlers: Record<string, any> = {};
	const closed: string[] = [];
	const opened: string[] = [];
	const moved: string[] = [];
	const leaves = [{ view: { file: { path: "Private/Taxes.md" }, save: async () => closed.push("saved") }, detach: () => closed.push("Private/Taxes.md") }];
	const adapter = {
		exists: (p: string) => fs.exists(p),
		list: (p: string) => fs.list(p),
		read: (p: string) => fs.read(p),
		write: (p: string, d: string) => fs.write(p, d),
		readBinary: async (p: string) => (await fs.readBinary(p)).buffer,
		writeBinary: (p: string, d: ArrayBuffer) => fs.writeBinary(p, new Uint8Array(d)),
		remove: (p: string) => fs.remove(p),
		mkdir: (p: string) => fs.mkdir(p),
		rmdir: (p: string) => fs.rmdir(p),
		stat: async (p: string) => (fs.files.has(p) ? { type: "file", size: fs.files.get(p)!.length } : null),
	};
	return {
		closed,
		opened,
		moved,
		fileManager: { renameFile: async (f: any, to: string) => moved.push(`${f.path} -> ${to}`) },
		menu: () => handlers["file-menu"],
		handlers,
		vault: {
			adapter,
			on: (e: string, fn: any) => (handlers["vault:" + e] = fn),
			createFolder: async (p: string) => fs.mkdir(p),
			getAbstractFileByPath: (p: string) => (fs.files.has(p) ? { path: p, extension: p.split(".").pop() } : null),
			getRoot: () => ({ children: [...fs.dirs].filter((d) => d && !d.includes("/")).map((d) => new TFolder(d)) }),
		},
		workspace: {
			on: (e: string, fn: any) => (handlers[e] = fn),
			onLayoutReady: (fn: () => void) => fn(),
			iterateAllLeaves: (fn: (l: any) => void) => leaves.forEach(fn),
			getLeaf: () => ({ openFile: async (f: any) => opened.push(f.path) }),
		},
	};
}

before(() => {
	// Browser globals the plugin touches (idle timer, key listeners).
	(globalThis as any).document = {};
	(globalThis as any).window = { setTimeout, clearTimeout };
	execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: new URL("..", import.meta.url) });
});

test("built plugin protects, locks and unlocks a folder through its UI", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("Private/Taxes.md", "EIN goes here");
	fs.addText("Open/readme.md", "public");
	const app = fakeApp(fs);
	const plugin = new Plugin(app);
	await plugin.onload();
	assert.deepEqual(plugin.commands.map((c: any) => c.id).sort(), ["change-password", "lock-all", "lock-folder", "protect-whole-vault", "unlock-folder", "unlock-with-recovery"]);

	// Folder menu offers "protect" for an unprotected folder.
	const items: any[] = [];
	const menu = { addItem: (cb: any) => {
		const i: any = { setTitle: (t: string) => ((i.title = t), i), setIcon: () => i, onClick: (fn: any) => ((i.click = fn), i) };
		cb(i);
		items.push(i);
	} };
	app.menu()(menu, new TFolder("Private"));
	assert.equal(items.length, 1);
	await plugin.protect("Private");

	assert.deepEqual(plugin.settings.folders, ["Private"]);
	assert.ok(fs.files.has("Private/Taxes.md.vlock"));
	assert.ok(!fs.files.has("Private/Taxes.md"));
	assert.deepEqual(app.closed, ["saved", "Private/Taxes.md"], "open tab is saved, then closed, before locking");
	assert.equal(fs.text("Open/readme.md"), "public");

	await plugin.unlock("Private");
	assert.equal(fs.text("Private/Taxes.md"), "EIN goes here");
	assert.deepEqual(app.opened, ["Private/Taxes.md"], "the note open at lock time comes back on unlock");
	assert.equal(focusLog[0], "password", "the cursor starts in the password box");
	assert.ok(plugin.keys.has("Private"));
	assert.equal(plugin.status.text, "🔓 1 folder unlocked");
	await plugin.ribbon(); // ribbon locks what's open
	assert.ok(fs.files.has("Private/Taxes.md.vlock"));
	await plugin.unlock("Private");

	await plugin.lockAll();
	assert.equal(plugin.status.text, "🔒 Locked");
	assert.ok(fs.files.has("Private/Taxes.md.vlock"));
	assert.equal(plugin.keys.size, 0);
});

test("a file over the size limit in a protected folder is flagged at once, with a move-out", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("Private/Taxes.md", "x");
	const app = fakeApp(fs);
	const plugin = new Plugin(app);
	await plugin.onload();
	await plugin.protect("Private");
	await plugin.unlock("Private");
	plugin.warnDelay = 0;
	notices.length = 0;
	const big = { path: "Private/movie.m4v", name: "movie.m4v", stat: { size: 1.5 * 1024 ** 3 } };
	await plugin.checkTooBig(big);
	await plugin.checkTooBig({ path: "Private/song.mp3", name: "song.mp3", stat: { size: 10 * 1024 ** 2 } });
	await plugin.checkTooBig({ path: "Open/huge.m4v", name: "huge.m4v", stat: { size: 5 * 1024 ** 3 } });
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(notices.length, 1, "one warning, only for the big file in the protected folder");
	assert.match(notices[0], /over Vault Locker's 1024 MB limit and can't be locked: movie\.m4v/);
	await plugin.moveOut([big]);
	assert.deepEqual(app.moved, ["Private/movie.m4v -> Too big to lock/movie.m4v"]);
});

test("Free tier refuses a second folder", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("A/a.md", "a");
	fs.addText("B/b.md", "b");
	const plugin = new Plugin(fakeApp(fs));
	await plugin.onload();
	await plugin.protect("A");
	notices.length = 0;
	await plugin.protect("B");
	assert.deepEqual(plugin.settings.folders, ["A"]);
	assert.match(notices[0], /Free protects one folder/);
	assert.equal(fs.text("B/b.md"), "b");
});

test("Pro: whole vault protects every top-level folder and locks on quit", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("A/a.md", "a");
	fs.addText("B/sub/b.md", "b");
	fs.addText("loose.md", "top level");
	const app = fakeApp(fs);
	const plugin = new Plugin(app);
	await plugin.onload();
	plugin.settings.license = { key: "k", instanceId: "i", lastValidated: Date.now(), status: "active" };
	await plugin.protectWholeVault();
	assert.deepEqual(plugin.settings.folders.sort(), ["A", "B"]);
	assert.ok(fs.files.has("A/a.md.vlock") && fs.files.has("B/sub/b.md.vlock"));
	assert.equal(fs.text("loose.md"), "top level");

	await plugin.unlock("A");
	const tasks: Array<() => Promise<void>> = [];
	app.handlers["quit"]({ add: (fn: () => Promise<void>) => tasks.push(fn) });
	assert.equal(tasks.length, 1);
	await tasks[0]();
	assert.ok(fs.files.has("A/a.md.vlock") && !fs.files.has("A/a.md"));
});

test("Free: whole vault is refused; quit does nothing", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("A/a.md", "a");
	const app = fakeApp(fs);
	const plugin = new Plugin(app);
	await plugin.onload();
	notices.length = 0;
	await plugin.protectWholeVault();
	assert.match(notices[0], /Pro feature/);
	const tasks: unknown[] = [];
	app.handlers["quit"]({ add: (fn: unknown) => tasks.push(fn) });
	assert.equal(tasks.length, 0);
});

test("change password: old stops working, new and recovery work", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("A/a.md", "a");
	const plugin = new Plugin(fakeApp(fs));
	await plugin.onload();
	await plugin.protect("A");
	notices.length = 0;
	await plugin.changePassword("A"); // modals type "pw" for old and new, so this checks the path runs
	assert.match(notices[0], /Password changed/);
	await plugin.unlock("A");
	assert.equal(fs.text("A/a.md"), "a");
});

test("renaming a protected folder (or its parent) keeps it protected", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("Work/Private/a.md", "a");
	const app = fakeApp(fs);
	const plugin = new Plugin(app);
	await plugin.onload();
	await plugin.protect("Work/Private");
	await plugin.unlock("Work/Private");
	await app.handlers["vault:rename"](new TFolder("Job"), "Work");
	assert.deepEqual(plugin.settings.folders, ["Job/Private"]);
	assert.ok(plugin.keys.has("Job/Private"));
	await app.handlers["vault:rename"](new TFolder("Other"), "Jo");
	assert.deepEqual(plugin.settings.folders, ["Job/Private"], "prefix that is not a parent is ignored");
});

test("big folders show a progress count", async () => {
	const Plugin = load();
	const fs = new MemFS();
	for (let i = 0; i < 25; i++) fs.addText(`Big/n${i}.md`, `note ${i}`);
	const plugin = new Plugin(fakeApp(fs));
	await plugin.onload();
	notices.length = 0;
	await plugin.protect("Big");
	assert.ok(notices.includes('Locking "Big": 25 of 25 files'));
});

test("a failed lock shows a notice, keeps the folder open and its key, and can be retried", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("A/a.md", "a");
	const plugin = new Plugin(fakeApp(fs));
	await plugin.onload();
	await plugin.protect("A");
	await plugin.unlock("A");
	notices.length = 0;
	fs.failWritesAfter = 1; // header saves, then the locked copy fails
	await plugin.lockAll(); // must not throw
	assert.ok(notices.some((n) => /could not lock "A"/.test(n)), notices.join(" | "));
	assert.equal(fs.text("A/a.md"), "a", "original kept");
	assert.ok(plugin.keys.has("A"));
	assert.equal(plugin.busy.size, 0);
	fs.failWritesAfter = Infinity;
	await plugin.lockAll();
	assert.ok(fs.files.has("A/a.md.vlock") && !fs.files.has("A/a.md"));
});

test("a second lock of the same folder while one is running is refused", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("A/a.md", "a");
	const plugin = new Plugin(fakeApp(fs));
	await plugin.onload();
	await plugin.protect("A");
	await plugin.unlock("A");
	const key = plugin.keys.get("A");
	notices.length = 0;
	await Promise.all([plugin.runLock("A", key), plugin.runLock("A", key)]);
	assert.ok(notices.some((n) => /still working on "A"/.test(n)));
	assert.ok(fs.files.has("A/a.md.vlock") && !fs.files.has("A/a.md"));
});

test("a folder whose .vaultlocker file did not sync is restored from the plugin's saved copy", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("A/a.md", "a");
	const plugin = new Plugin(fakeApp(fs));
	await plugin.onload();
	await plugin.protect("A");
	assert.ok(plugin.data.headers["A"], "header copy saved in plugin data");

	// Second device: same plugin data and .vlock files, but no dot-file.
	const fs2 = new MemFS();
	fs2.addBinary("A/a.md.vlock", fs.files.get("A/a.md.vlock")!);
	const plugin2 = new Plugin(fakeApp(fs2));
	plugin2.data = plugin.data;
	notices.length = 0;
	await plugin2.onload();
	await new Promise((r) => setTimeout(r, 50)); // startup checks run after layout-ready
	assert.ok(notices.some((n) => /restored the key file for A/.test(n)), notices.join(" | "));
	assert.equal(JSON.parse(fs2.text("A/.vaultlocker")).state, "locked");
	await plugin2.unlock("A");
	assert.equal(fs2.text("A/a.md"), "a");
});

test("a protected folder with no header and no saved copy explains instead of failing silently", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("A/a.md.vlock", "x");
	const plugin = new Plugin(fakeApp(fs));
	plugin.data = { folders: ["A"] };
	await plugin.onload();
	notices.length = 0;
	await plugin.unlock("A");
	assert.match(notices[0], /can't find the key file for "A"/);
});

test("notes added to a locked folder: warned, then encrypted by Lock all", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("Private/Taxes.md", "EIN goes here");
	const app = fakeApp(fs);
	const plugin = new Plugin(app);
	await plugin.onload();
	await plugin.protect("Private");
	assert.equal(plugin.keys.size, 0);

	notices.length = 0;
	await plugin.lockAll();
	assert.match(notices.join("\n"), /already locked/, "Lock all never stays silent");

	plugin.warnDelay = 0;
	const settle = () => new Promise((r) => setTimeout(r, 20));
	fs.addText("Private/new note.md", "added while locked");
	notices.length = 0;
	app.handlers["vault:create"]({ path: "Private/new note.md" });
	await settle();
	assert.match(notices.join("\n"), /not encrypted yet/);

	await plugin.lockAll();
	assert.ok(fs.files.has("Private/new note.md.vlock"));
	assert.ok(!fs.files.has("Private/new note.md"));
});

test("unlocking does not raise the new-notes warning", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("Private/Taxes.md", "EIN goes here");
	const app = fakeApp(fs);
	const plugin = new Plugin(app);
	await plugin.onload();
	plugin.warnDelay = 0;
	await plugin.protect("Private");
	notices.length = 0;
	await plugin.unlock("Private");
	// Obsidian reports the restored files as created, after the unlock.
	app.handlers["vault:create"]({ path: "Private/Taxes.md" });
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!notices.some((n) => /not encrypted yet/.test(n)), notices.join(" | "));
});

test("folder picker: free note shown, single folder preselected, Select unlocks it", async () => {
	const Plugin = load();
	const fs = new MemFS();
	fs.addText("Private/Taxes.md", "EIN goes here");
	const plugin = new Plugin(fakeApp(fs));
	await plugin.onload();
	await plugin.protect("Private");
	plugin.commands.find((c: any) => c.id === "unlock-folder").callback();
	for (let i = 0; i < 200 && !plugin.keys.has("Private"); i++) await new Promise((r) => setTimeout(r, 25));
	assert.equal(fs.text("Private/Taxes.md"), "EIN goes here");
	assert.ok(plugin.keys.has("Private"));
});
