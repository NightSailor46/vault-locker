// Obsidian glue: commands, folder menu, password prompts, settings.
// All the real work is in locker.ts / format.ts / license.ts.

import { Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFolder, requestUrl } from "obsidian";
import { MAX_FILE_BYTES_DESKTOP, MAX_FILE_BYTES_MOBILE, lockFolder, plainFiles, readHeader, restoreHeader, setupFolder, unlockFolder, type LockerFS } from "./locker.ts";
import { WrongPasswordError, changePassword, encodeHeader, HEADER_NAME, unlockWithPassword, unlockWithRecovery } from "./format.ts";
import { parseRecoveryKey } from "./crypto.ts";
import {
	BUY_PRO_URL,
	PRO_PRICE,
	NO_LICENSE,
	activate,
	canSetUpAnotherFolder,
	features,
	isPro,
	needsRevalidation,
	revalidate,
	type LicenseState,
	type PostForm,
} from "./license.ts";

interface Settings {
	folders: string[];
	// Copy of each folder's header, so a device whose sync skipped the
	// `.vaultlocker` dot-file can still unlock it.
	headers: Record<string, string>;
	license: LicenseState;
	autoLockMinutes: number;
	hideNamesForNewFolders: boolean;
}

const DEFAULTS: Settings = { folders: [], headers: {}, license: NO_LICENSE, autoLockMinutes: 0, hideNamesForNewFolders: false };

function adapterFS(adapter: any): LockerFS {
	return {
		exists: (p) => adapter.exists(p),
		list: (p) => adapter.list(p),
		read: (p) => adapter.read(p),
		write: (p, d) => adapter.write(p, d),
		readBinary: async (p) => new Uint8Array(await adapter.readBinary(p)),
		// Pass the buffer as is when it's the whole thing; copying a big file costs memory.
		writeBinary: (p, d) =>
			adapter.writeBinary(p, d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d.buffer : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)),
		remove: (p) => adapter.remove(p),
		mkdir: (p) => adapter.mkdir(p),
		rmdir: (p) => adapter.rmdir(p, false),
		size: async (p) => (await adapter.stat(p))?.size ?? 0,
	};
}

const postForm: PostForm = async (url, form) => {
	const res = await requestUrl({
		url,
		method: "POST",
		headers: { Accept: "application/json" },
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams(form).toString(),
		throw: false,
	});
	return { status: res.status, json: res.json };
};

// On-screen messages close by themselves, but stay long enough to read twice over.
// Warnings (something isn't protected, or went wrong) get extra time.
function readTime(text: string, warning = false): number {
	const words = text.split(/\s+/).length;
	return warning ? Math.max(20_000, 5000 + words * 600) : Math.max(8000, 3000 + words * 350);
}

function say(text: string, warning = false): Notice {
	return new Notice(text, readTime(text, warning));
}

export default class VaultLockerPlugin extends Plugin {
	settings: Settings = { ...DEFAULTS };
	fs!: LockerFS;
	// Folder keys for folders unlocked in this session, so locking needs no password.
	keys = new Map<string, CryptoKey>();
	idleTimer: number | null = null;
	statusEl: any = null;
	// Folders being locked or unlocked right now; a second request waits its turn.
	busy = new Set<string>();
	// Folders warned about recently, so one drag of many notes gives one notice.
	warned = new Set<string>();
	// Notes that were open when a folder was locked, reopened on unlock. Memory only.
	reopen = new Map<string, string[]>();
	// Files over the size limit found in protected folders, waiting for one combined warning.
	tooBig = new Map<string, any[]>();
	warnDelay = 1500;

	async onload() {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());
		this.settings.headers = { ...this.settings.headers };
		this.fs = adapterFS(this.app.vault.adapter);
		this.addSettingTab(new VaultLockerSettingTab(this));
		this.statusEl = this.addStatusBarItem();
		this.updateStatus();

		// Ribbon "front door": lock everything open, or pick a folder to unlock.
		this.addRibbonIcon("lock", "Vault Locker", () => {
			if (this.keys.size) return this.lockAll();
			new FolderPickModal(this, { multi: true, action: "unlock", onPick: (f) => this.unlockMany(f) }).open();
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: any, file: any) => {
				if (!(file instanceof TFolder) || file.isRoot()) return;
				const path = file.path;
				if (!this.settings.folders.includes(path)) {
					menu.addItem((i: any) => i.setTitle("Vault Locker: protect this folder").setIcon("lock").onClick(() => this.protect(path)));
					return;
				}
				menu.addItem((i: any) => i.setTitle("Vault Locker: lock").setIcon("lock").onClick(() => this.lock(path)));
				menu.addItem((i: any) => i.setTitle("Vault Locker: unlock").setIcon("unlock").onClick(() => this.unlock(path)));
				menu.addItem((i: any) => i.setTitle("Vault Locker: change password").setIcon("key").onClick(() => this.changePassword(path)));
			}),
		);

		this.addCommand({ id: "lock-all", name: "Lock all protected folders", callback: () => this.lockAll() });
		this.addCommand({
			id: "lock-folder",
			name: "Lock a protected folder",
			callback: () => new FolderPickModal(this, { multi: true, action: "lock", onPick: (f) => this.lockMany(f) }).open(),
		});
		this.addCommand({
			id: "unlock-folder",
			name: "Unlock a protected folder",
			callback: () => new FolderPickModal(this, { multi: true, action: "unlock", onPick: (f) => this.unlockMany(f) }).open(),
		});
		this.addCommand({
			id: "unlock-with-recovery",
			name: "Unlock a folder with its recovery key",
			callback: () => new FolderPickModal(this, { multi: false, action: "unlock", onPick: (f) => this.unlockMany(f, true) }).open(),
		});

		this.addCommand({
			id: "change-password",
			name: "Change a folder's password",
			callback: () => new FolderPickModal(this, { multi: false, action: "change the password of", onPick: (f) => this.changePassword(f[0]) }).open(),
		});
		this.addCommand({
			id: "protect-whole-vault",
			name: "Protect every top-level folder (Pro)",
			callback: () => this.protectWholeVault(),
		});

		// Keep the protected-folder list right when a folder (or a parent) is renamed or moved.
		this.registerEvent(
			this.app.vault.on("rename", async (file: any, oldPath: string) => {
				// A big file moved into a protected folder gets the same warning as one dropped in.
				if (!(file instanceof TFolder)) void this.checkTooBig(file);
				if (!(file instanceof TFolder)) return this.warnIfInLockedFolder(file.path);
				let changed = false;
				this.settings.folders = this.settings.folders.map((f) => {
					if (f !== oldPath && !f.startsWith(oldPath + "/")) return f;
					changed = true;
					const moved = file.path + f.slice(oldPath.length);
					if (this.settings.headers[f]) {
						this.settings.headers[moved] = this.settings.headers[f];
						delete this.settings.headers[f];
					}
					const key = this.keys.get(f);
					if (key) {
						this.keys.delete(f);
						this.keys.set(moved, key);
					}
					return moved;
				});
				if (changed) await this.save();
			}),
		);

		// Notes created in, or moved into, a locked folder are not encrypted until locked again.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("create", (file: any) => {
				if (file instanceof TFolder) return;
				this.warnIfInLockedFolder(file.path);
				void this.checkTooBig(file);
			}));
		});

		// Pro: lock everything when Obsidian quits. Obsidian waits for these tasks.
		this.registerEvent(
			this.app.workspace.on("quit", (tasks: any) => {
				if (this.pro && this.keys.size) tasks.add(() => this.lockAll());
			}),
		);

		this.app.workspace.onLayoutReady(() => this.startupChecks());
		this.registerDomEvent(document, "keydown", () => this.bumpIdle());
		this.registerDomEvent(document, "mousedown", () => this.bumpIdle());
	}

	onunload() {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.keys.clear();
	}

	// Status bar: a visible reminder whenever a protected folder is open.
	updateStatus() {
		if (!this.statusEl) return;
		const open = this.keys.size;
		this.statusEl.setText(open ? `🔓 ${open} folder${open === 1 ? "" : "s"} unlocked` : this.settings.folders.length ? "🔒 Locked" : "");
	}

	get pro(): boolean {
		return isPro(this.settings.license);
	}

	async save() {
		await this.saveData(this.settings);
	}

	// Folders left open (e.g. Obsidian closed or crashed while unlocked).
	async startupChecks() {
		const restored: string[] = [];
		for (const f of this.settings.folders) {
			const saved = this.settings.headers[f];
			if (saved && (await restoreHeader(this.fs, f, saved).catch(() => false))) restored.push(f);
		}
		if (restored.length) {
			say(`Vault Locker: restored the key file for ${restored.join(", ")}. If locked files are missing on this device, turn on "Sync all other types" in Obsidian Sync.`, true);
		}
		const open: string[] = [];
		for (const f of this.settings.folders) {
			const h = await readHeader(this.fs, f).catch(() => null);
			if (h && (h.state !== "locked" || (await plainFiles(this.fs, f).catch(() => [])).length)) open.push(f);
		}
		if (open.length) {
			const names = open.map((f) => `"${f}"`).join(", ");
			say(`Vault Locker: ${names} ${open.length === 1 ? "is" : "are"} unlocked, so ${open.length === 1 ? "its" : "their"} files can be read. Right-click and choose "Vault Locker: lock", or run "Lock all protected folders".`, true);
		}
		if (needsRevalidation(this.settings.license)) {
			this.settings.license = await revalidate(postForm, this.settings.license);
			await this.save();
		}
	}

	// The folder's header, restored from the saved copy if sync left it behind.
	async headerFor(folder: string) {
		const saved = this.settings.headers[folder];
		if (saved) await restoreHeader(this.fs, folder, saved).catch(() => false);
		const h = await readHeader(this.fs, folder).catch(() => null);
		if (!h) say(`Vault Locker can't find the key file for "${folder}" on this device. Open this vault on the device where the folder was protected first.`, true);
		return h;
	}

	bumpIdle() {
		if (!this.pro || this.settings.autoLockMinutes <= 0 || this.keys.size === 0) return;
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => this.lockAll(), this.settings.autoLockMinutes * 60_000);
	}

	// Save and close any open tabs showing files inside the folder, so the
	// editor can't write plain text back after the folder is locked.
	// Saves and closes every tab showing a note in the folder. Returns those notes' paths.
	async closeLeavesIn(folder: string): Promise<string[]> {
		const prefix = folder + "/";
		const leaves: any[] = [];
		this.app.workspace.iterateAllLeaves((leaf: any) => {
			const file = leaf.view?.file;
			if (file && file.path.startsWith(prefix)) leaves.push(leaf);
		});
		const paths: string[] = [];
		for (const l of leaves) {
			if (!paths.includes(l.view.file.path)) paths.push(l.view.file.path);
			if (typeof l.view?.save === "function") await l.view.save();
			l.detach();
		}
		return paths;
	}

	// After an unlock, show the notes: reopen the ones that were open at lock time,
	// or else reveal the folder in the file list. Never fails the unlock itself.
	async showUnlocked(folder: string) {
		try {
			const vault: any = this.app.vault;
			const want = this.reopen.get(folder) ?? [];
			this.reopen.delete(folder);
			// The file list catches up with the disk a moment after the files are written.
			const find = async (p: string) => {
				if (typeof vault.getAbstractFileByPath !== "function") return null;
				for (let i = 0; i < 20; i++) {
					const f = vault.getAbstractFileByPath(p);
					if (f) return f;
					await new Promise((r) => window.setTimeout(r, 100));
				}
				return null;
			};
			let opened = 0;
			for (const p of want) {
				const f = await find(p);
				if (!f) continue;
				await this.app.workspace.getLeaf("tab").openFile(f);
				opened++;
			}
			if (opened) return;
			const dir: any = await find(folder);
			const first = dir?.children?.find((c: any) => c.extension === "md") ?? dir?.children?.[0];
			const explorer = (this.app as any).internalPlugins?.getPluginById?.("file-explorer")?.instance;
			if (first && typeof explorer?.revealInFolder === "function") explorer.revealInFolder(first);
		} catch {
			// Showing the notes is a convenience; the files are already unlocked.
		}
	}

	// One lock/unlock per folder at a time, and failures shown instead of lost.
	async exclusive(folder: string, label: string, job: () => Promise<void>) {
		if (this.busy.has(folder)) {
			say(`Vault Locker is still working on "${folder}".`);
			return;
		}
		this.busy.add(folder);
		try {
			await job();
		} catch (e) {
			say(`Vault Locker could not ${label} "${folder}": ${e instanceof Error ? e.message : String(e)}. Your files were not deleted; try again.`, true);
		} finally {
			this.busy.delete(folder);
		}
	}

	async protect(folder: string) {
		if (!canSetUpAnotherFolder(this.pro, this.settings.folders.length)) {
			say("Vault Locker Free protects one folder. Get Pro to protect more folders or the whole vault.");
			return;
		}
		const pw = await PasswordModal.ask(this, `Choose a password for "${folder}"`, true);
		if (!pw) return;
		const hideNames = this.pro && this.settings.hideNamesForNewFolders;
		const { header, folderKey, recoveryKey } = await setupFolder(this.fs, folder, pw, { hideNames });
		this.settings.folders.push(folder);
		this.settings.headers[folder] = encodeHeader(header);
		await this.save();
		await new Promise<void>((done) => new RecoveryKeyModal(this, folder, recoveryKey, done).open());
		await this.runLock(folder, folderKey);
	}

	// Tries a password (or recovery key) on a folder. Null means wrong.
	async tryKey(h: any, secret: string, useRecovery = false): Promise<CryptoKey | null> {
		try {
			return useRecovery ? await unlockWithRecovery(h, parseRecoveryKey(secret)) : await unlockWithPassword(h, secret);
		} catch (e) {
			if (e instanceof WrongPasswordError) return null;
			throw e;
		}
	}

	// Gets each folder's key, asking for a password only when the last one entered doesn't fit,
	// so folders sharing a password need it typed once. Calls job(folder, key) for each.
	async withKeys(folders: string[], useRecovery: boolean, job: (folder: string, key: CryptoKey) => Promise<void>, preferOpen = false) {
		let last: string | null = null;
		for (const folder of folders) {
			let key: CryptoKey | null = preferOpen ? this.keys.get(folder) ?? null : null;
			if (!key) {
				const h = await this.headerFor(folder);
				if (!h) continue;
				try {
					if (last) key = await this.tryKey(h, last, useRecovery);
					if (!key) {
						const prompt = useRecovery ? `Recovery key for "${folder}"` : `Password for "${folder}"`;
						const secret = await PasswordModal.ask(this, prompt, false, useRecovery);
						if (!secret) return;
						// Checking takes a second or two on a phone (the slow hashing that protects the
						// password), so say so instead of looking frozen.
						const wait: any = new Notice(useRecovery ? "Checking the recovery key…" : "Checking the password…", 0);
						try {
							key = await this.tryKey(h, secret, useRecovery);
						} finally {
							wait.hide?.();
						}
						if (!key) {
							say(useRecovery ? "Wrong recovery key." : "Wrong password.");
							continue;
						}
						last = secret;
					}
				} catch (e) {
					say(e instanceof Error ? e.message : String(e), true);
					continue;
				}
			}
			await job(folder, key);
		}
	}

	async lock(folder: string) {
		await this.lockMany([folder]);
	}

	async lockMany(folders: string[]) {
		await this.withKeys(folders, false, (f, k) => this.runLock(f, k), true);
	}

	async runLock(folder: string, key: CryptoKey) {
		await this.exclusive(folder, "lock", async () => {
			const open = await this.closeLeavesIn(folder);
			const r = await lockFolder(this.fs, folder, key, {
				onProgress: this.progressNotice(`Locking "${folder}"`),
				maxFileBytes: this.maxFileBytes,
			});
			this.keys.delete(folder);
			if (open.length) this.reopen.set(folder, open);
			this.updateStatus();
			if (r.tooBig?.length) {
				const mb = Math.round(this.maxFileBytes / (1024 * 1024));
						say(
					`Locked "${folder}" (${r.files} files), but ${r.tooBig.length === 1 ? "this file is" : "these files are"} over the ${mb} MB limit and NOT locked: ` +
						`${r.tooBig.join(", ")}. Move ${r.tooBig.length === 1 ? "it" : "them"} out of the folder.`,
					true,
				);
			} else say(`Locked "${folder}" (${r.files} files).`);
		});
	}

	async unlock(folder: string, useRecovery = false) {
		await this.unlockMany([folder], useRecovery);
	}

	async unlockMany(folders: string[], useRecovery = false) {
		await this.withKeys(folders, useRecovery, (folder, key) =>
			this.exclusive(folder, "unlock", async () => {
				const r = await unlockFolder(this.fs, folder, key, this.progressNotice(`Unlocking "${folder}"`));
				this.keys.set(folder, key);
				this.updateStatus();
				this.bumpIdle();
				say(`Unlocked "${folder}" (${r.files} files).`);
				await this.showUnlocked(folder);
			}),
		);
	}

	async changePassword(folder: string) {
		const h = await this.headerFor(folder);
		if (!h) return;
		const oldPw = await PasswordModal.ask(this, `Current password for "${folder}"`, false);
		if (!oldPw) return;
		const newPw = await PasswordModal.ask(this, `New password for "${folder}"`, true);
		if (!newPw) return;
		try {
			const h2 = await changePassword(h, oldPw, newPw);
			await this.fs.write(`${folder}/${HEADER_NAME}`, encodeHeader(h2));
			this.settings.headers[folder] = encodeHeader(h2);
			await this.save();
			say(`Password changed for "${folder}". The recovery key still works.`);
		} catch (e) {
			say(e instanceof WrongPasswordError ? "Wrong password." : String(e));
		}
	}

	// Pro: one password for every top-level folder not yet protected.
	async protectWholeVault() {
		if (!features(this.pro).wholeVault) {
			say("Protecting the whole vault is a Pro feature.");
			new UpsellModal(this).open();
			return;
		}
		const top = this.app.vault.getRoot().children.filter((c: any) => c instanceof TFolder && !this.settings.folders.includes(c.path));
		if (!top.length) {
			say("Every top-level folder is already protected.");
			return;
		}
		const pw = await PasswordModal.ask(this, `One password for ${top.length} folders`, true);
		if (!pw) return;
		const done: Array<{ path: string; key: CryptoKey; recovery: string }> = [];
		for (const folder of top) {
			const { header, folderKey, recoveryKey } = await setupFolder(this.fs, folder.path, pw, { hideNames: this.settings.hideNamesForNewFolders });
			this.settings.folders.push(folder.path);
			this.settings.headers[folder.path] = encodeHeader(header);
			await this.save();
			done.push({ path: folder.path, key: folderKey, recovery: recoveryKey });
		}
		// Show the recovery keys before anything is encrypted.
		const text = done.map((d) => `${d.path}: ${d.recovery}`).join("\n");
		await new Promise<void>((ok) => new RecoveryKeyModal(this, "each folder", text, ok).open());
		for (const d of done) await this.runLock(d.path, d.key);
		say("Notes in the vault's top level (outside folders) are not encrypted. Move them into a folder to protect them.", true);
	}

	// A notice that appears only for bigger folders and counts up.
	progressNotice(label: string) {
		let notice: any = null;
		return (done: number, total: number) => {
			if (total < 20) return;
			if (!notice) notice = new Notice(label, 0);
			notice.setMessage(`${label}: ${done} of ${total} files`);
			if (done === total) notice.hide();
		};
	}

	// Locks folders unlocked this session, then any locked folder that has
	// unencrypted notes in it (added or moved in after locking), asking for
	// that folder's password. Always says what happened.
	async lockAll() {
		let acted = 0;
		for (const [folder, key] of [...this.keys]) {
			await this.runLock(folder, key);
			acted++;
		}
		const needPassword: string[] = [];
		for (const folder of this.settings.folders) {
			if (this.keys.has(folder)) continue;
			if ((await plainFiles(this.fs, folder).catch(() => [])).length) needPassword.push(folder);
		}
		if (needPassword.length) {
			acted += needPassword.length;
			await this.lockMany(needPassword);
		}
		if (!acted) say("All protected folders are already locked.");
		this.updateStatus();
	}

	get maxFileBytes() {
		return Platform.isMobile ? MAX_FILE_BYTES_MOBILE : MAX_FILE_BYTES_DESKTOP;
	}

	// A file over the size limit can never be locked, so say so the moment it lands in a
	// protected folder (Obsidian can't stop the drop itself), and offer to move it out.
	// Many files from one drag get one warning.
	async checkTooBig(file: any) {
		const folder = this.settings.folders.find((f) => file.path.startsWith(f + "/"));
		if (!folder || file.path.endsWith(".vlock") || this.busy.has(folder)) return;
		const size = file.stat?.size ?? (await this.fs.size?.(file.path).catch(() => 0)) ?? 0;
		if (size <= this.maxFileBytes) return;
		const list = this.tooBig.get(folder) ?? [];
		list.push(file);
		this.tooBig.set(folder, list);
		if (list.length === 1) window.setTimeout(() => this.warnTooBig(folder), this.warnDelay);
	}

	warnTooBig(folder: string) {
		const files = this.tooBig.get(folder) ?? [];
		this.tooBig.delete(folder);
		if (!files.length) return;
		const mb = Math.round(this.maxFileBytes / (1024 * 1024));
		const names = files.map((f) => f.name ?? f.path.split("/").pop()).join(", ");
		const one = files.length === 1;
		const text =
			`${one ? "This file is" : "These files are"} over Vault Locker's ${mb} MB limit and can't be locked: ${names}. ` +
			`While ${one ? "it stays" : "they stay"} in "${folder}", ${one ? "it is" : "they are"} not protected.`;
		// A long-lasting warning with a button that moves the files to "Too big to lock".
		const n: any = new Notice(text, readTime(text, true) + 10_000);
		const el = n.messageEl ?? n.noticeEl;
		if (!el?.createEl) return;
		const b = el.createEl("button", { text: `Move ${one ? "it" : "them"} out of "${folder}"` });
		b.style && (b.style.marginTop = "8px");
		b.addEventListener("click", async (e: Event) => {
			e.stopPropagation();
			n.hide?.();
			await this.moveOut(files);
		});
	}

	async moveOut(files: any[]) {
		const dest = "Too big to lock";
		try {
			if (!(await this.fs.exists(dest))) await this.app.vault.createFolder(dest);
			for (const f of files) {
				const name: string = f.name ?? f.path.split("/").pop();
				const dot = name.lastIndexOf(".");
				const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
				let target = `${dest}/${name}`;
				for (let n = 2; await this.fs.exists(target); n++) target = `${dest}/${stem} ${n}${ext}`;
				await this.app.fileManager.renameFile(f, target);
			}
			say(`Moved to the "${dest}" folder.`);
		} catch (e) {
			say(`Vault Locker couldn't move the file: ${e instanceof Error ? e.message : String(e)}`, true);
		}
	}

	// Warn when a note lands in a locked folder: it stays readable until locked again.
	// Checked after a short wait, so files written back by an unlock aren't mistaken for new notes.
	warnIfInLockedFolder(path: string) {
		const folder = this.settings.folders.find((f) => path.startsWith(f + "/"));
		if (!folder || path.endsWith(".vlock") || path.endsWith("/.vaultlocker")) return;
		window.setTimeout(() => void this.checkNewNotes(folder), this.warnDelay);
	}

	async checkNewNotes(folder: string) {
		if (this.keys.has(folder) || this.busy.has(folder) || this.warned.has(folder)) return;
		const h = await readHeader(this.fs, folder).catch(() => null);
		if (!h || h.state !== "locked") return;
		if (!(await plainFiles(this.fs, folder).catch(() => [])).length) return;
		this.warned.add(folder);
		window.setTimeout(() => this.warned.delete(folder), 10_000);
		say(`"${folder}" is locked, but new notes in it are not encrypted yet. Run "Lock all protected folders" to encrypt them.`, true);
	}
}

class PasswordModal extends Modal {
	private value = "";
	private confirm = "";
	private title: string;
	private isNew: boolean;
	private resolve: (v: string | null) => void;
	private done = false;

	private visible: boolean;

	// visible: show what is typed (recovery keys are long, and mistakes must be seen).
	static ask(plugin: Plugin, title: string, isNew: boolean, visible = false): Promise<string | null> {
		return new Promise((resolve) => new PasswordModal(plugin, title, isNew, resolve, visible).open());
	}

	constructor(plugin: Plugin, title: string, isNew: boolean, resolve: (v: string | null) => void, visible = false) {
		super(plugin.app);
		this.title = title;
		this.isNew = isNew;
		this.resolve = resolve;
		this.visible = visible;
	}

	onOpen() {
		this.titleEl.setText(this.title);
		this.modalEl?.addClass?.("vault-locker-prompt");
		// Layout: the boxes stacked on the left, equal width, each with an eye that shows
		// or hides every box at once; one tall OK down the right side, clear of the keyboard.
		const box: any = this.contentEl.createEl("div", { cls: "vl-pw" });
		const column: any = box.createEl("div", { cls: "vl-pw-fields" });
		const inputs: HTMLInputElement[] = [];
		const eyes: any[] = [];
		let shown = false;
		const showAll = (on: boolean) => {
			shown = on;
			for (const i of inputs) i.type = on ? "text" : "password";
			for (const e of eyes) {
				e.setText?.(on ? "🙈" : "👁");
				e.setAttribute?.("aria-label", on ? "Hide password" : "Show password");
			}
		};
		const field = (name: string, set: (v: string) => void) => {
			const s: any = new Setting(this.contentEl).addText((t: any) => {
				t.inputEl.type = this.visible ? "text" : "password";
				t.setPlaceholder?.(name);
				t.inputEl.setAttribute?.("aria-label", name);
				if (this.visible) {
					t.inputEl.setAttribute?.("autocapitalize", "characters");
					t.inputEl.setAttribute?.("autocorrect", "off");
					t.inputEl.setAttribute?.("spellcheck", "false");
					t.inputEl.style && (t.inputEl.style.fontFamily = "var(--font-monospace)");
				}
				t.onChange(set);
				const i = inputs.push(t.inputEl);
				// Enter moves to the confirm box when there is one, and submits from the last box.
				t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					if (inputs[i]) inputs[i].focus();
					else this.submit();
				});
				const row: any = column.createEl("div", { cls: "vl-pw-row" });
				row.appendChild?.(t.inputEl);
				if (!this.visible) {
					const eye: any = row.createEl("button", { cls: "vl-pw-eye", text: "👁" });
					eye.setAttribute?.("type", "button");
					eye.setAttribute?.("aria-label", "Show password");
					eye.addEventListener("click", (e: Event) => {
						e.preventDefault();
						showAll(!shown);
						t.inputEl.focus?.();
					});
					eyes.push(eye);
				}
			});
			s.settingEl?.remove?.();
		};
		field(this.visible ? "Recovery key" : this.isNew ? "New password" : "Password", (v) => (this.value = v));
		if (this.isNew) field("Confirm password", (v) => (this.confirm = v));
		let ok: any = null;
		const okRow: any = new Setting(this.contentEl).addButton((b: any) => {
			ok = b.buttonEl;
			b.setButtonText("OK").setCta().onClick(() => this.submit());
		});
		if (ok) {
			ok.addClass?.("vl-pw-ok");
			box.appendChild?.(ok);
		}
		okRow.settingEl?.remove?.();
		if (this.isNew) this.contentEl.createEl("p", { text: "Type it twice. There is no way to read a locked folder without this password or the recovery key." });
		// When the keyboard opens, scroll so OK stays in view.
		for (const i of inputs) i.addEventListener?.("focus", () => window.setTimeout(() => ok?.scrollIntoView?.({ block: "nearest" }), 300));
		// Cursor in the first box, so the password can be typed right away. Obsidian moves
		// focus to the dialog itself after onOpen, so focus again on the next tick.
		inputs[0]?.focus?.();
		window.setTimeout(() => inputs[0]?.focus?.(), 0);
	}

	submit() {
		if (!this.value) return;
		if (this.isNew && this.value !== this.confirm) {
			say("Passwords don't match.");
			return;
		}
		this.done = true;
		this.resolve(this.value);
		this.close();
	}

	onClose() {
		if (!this.done) this.resolve(null);
		this.contentEl.empty();
	}
}

class RecoveryKeyModal extends Modal {
	private folder: string;
	private key: string;
	private done: () => void;

	constructor(plugin: Plugin, folder: string, key: string, done: () => void) {
		super(plugin.app);
		this.folder = folder;
		this.key = key;
		this.done = done;
	}
	onOpen() {
		this.titleEl.setText(`Recovery key for "${this.folder}"`);
		this.contentEl.createEl("p", { text: "Write this down and keep it somewhere safe. It is shown only once. It opens the folder if you forget the password." });
		this.contentEl.createEl("pre", {
			text: this.key,
			attr: { style: "user-select: text; -webkit-user-select: text; white-space: pre-wrap; word-break: break-all;" },
		});
		new Setting(this.contentEl)
			.addButton((b: any) =>
				b.setButtonText("Copy").onClick(async () => {
					try {
						await navigator.clipboard.writeText(this.key);
						b.setButtonText("Copied");
						say("Recovery key copied. Paste it somewhere safe, like a password manager.");
					} catch {
						say("Couldn't copy. Select the key and press Command-C instead.");
					}
				}),
			)
			.addButton((b: any) => b.setButtonText("I saved it").setCta().onClick(() => this.close()));
	}
	onClose() {
		this.contentEl.empty();
		this.done();
	}
}

// Pick protected folders: click a folder to highlight it (click again to clear),
// then press Select. Pro can pick several, or "Entire vault" for all of them.
// Free shows "Entire vault" too; clicking it explains Pro and how to buy it.
class FolderPickModal extends Modal {
	private plugin: VaultLockerPlugin;
	private opts: { multi: boolean; action: string; onPick: (folders: string[]) => void };
	private selected = new Set<string>();
	private rows = new Map<string, any>();
	private entireRow: any = null;

	constructor(plugin: VaultLockerPlugin, opts: { multi: boolean; action: string; onPick: (folders: string[]) => void }) {
		super(plugin.app);
		this.plugin = plugin;
		this.opts = opts;
	}

	get multi(): boolean {
		return this.opts.multi && this.plugin.pro;
	}

	onOpen() {
		const folders = this.plugin.settings.folders;
		this.titleEl.setText(this.multi ? `Choose folders to ${this.opts.action}` : `Choose a folder to ${this.opts.action}`);
		this.contentEl.addClass?.("vault-locker-picker");
		if (!this.plugin.pro) {
			this.contentEl.createEl("p", { cls: "vl-note", text: "You have the free version, which protects one folder." });
		} else if (this.multi && folders.length > 1) {
			this.contentEl.createEl("p", { cls: "vl-note", text: "Click each folder you want, then press Select." });
		}
		if (!folders.length) {
			this.contentEl.createEl("p", { text: "No folders are protected yet. Right-click a folder to protect it." });
			return;
		}
		const list = this.contentEl.createEl("div", { cls: "vl-list" });
		for (const f of folders) {
			const row = list.createEl("div", { cls: "vl-folder", text: f });
			row.setAttribute?.("role", "button");
			row.setAttribute?.("tabindex", "0");
			row.addEventListener("click", () => this.toggle(f));
			row.addEventListener("dblclick", () => {
				this.selected = new Set([f]);
				this.submit();
			});
			this.rows.set(f, row);
		}
		if (this.opts.multi) {
			this.entireRow = list.createEl("div", { cls: "vl-folder vl-entire", text: this.plugin.pro ? "Entire vault (all protected folders)" : "Entire vault (Pro)" });
			this.entireRow.setAttribute?.("role", "button");
			this.entireRow.addEventListener("click", () => {
				if (!this.plugin.pro) return new UpsellModal(this.plugin).open();
				const all = folders.every((f) => this.selected.has(f));
				this.selected = all ? new Set() : new Set(folders);
				this.paint();
			});
		}
		if (folders.length === 1) this.selected.add(folders[0]);
		this.paint();
		new Setting(this.contentEl).addButton((b: any) => b.setButtonText("Select").setCta().onClick(() => this.submit()));
	}

	toggle(f: string) {
		if (this.selected.has(f)) this.selected.delete(f);
		else {
			if (!this.multi) this.selected.clear();
			this.selected.add(f);
		}
		this.paint();
	}

	paint() {
		for (const [f, row] of this.rows) row.toggleClass?.("is-selected", this.selected.has(f));
		const all = this.plugin.settings.folders.length > 0 && this.plugin.settings.folders.every((f) => this.selected.has(f));
		this.entireRow?.toggleClass?.("is-selected", this.plugin.pro && all);
	}

	submit() {
		if (!this.selected.size) {
			say("Click a folder first.");
			return;
		}
		const picked = this.plugin.settings.folders.filter((f) => this.selected.has(f));
		this.close();
		this.opts.onPick(picked);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Shown when a free user reaches for a Pro feature.
class UpsellModal extends Modal {
	constructor(plugin: VaultLockerPlugin) {
		super(plugin.app);
	}
	onOpen() {
		this.titleEl.setText("Vault Locker Pro");
		this.contentEl.createEl("p", { text: "You have the free version, which protects one folder." });
		this.contentEl.createEl("p", {
			text: `Would you like to buy Vault Locker Pro? It's ${PRO_PRICE}, and adds unlimited folders, the entire vault, auto-lock, lock on quit and hidden file names.`,
		});
		new Setting(this.contentEl)
			.addButton((b: any) => b.setButtonText("Not now").onClick(() => this.close()))
			.addButton((b: any) =>
				b.setButtonText(`Buy Pro (${PRO_PRICE})`).setCta().onClick(() => {
					if (BUY_PRO_URL) window.open(BUY_PRO_URL);
					else say("Vault Locker Pro goes on sale soon.");
					this.close();
				}),
			);
	}
	onClose() {
		this.contentEl.empty();
	}
}

class VaultLockerSettingTab extends PluginSettingTab {
	private plugin: VaultLockerPlugin;

	constructor(plugin: VaultLockerPlugin) {
		super(plugin.app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		const p = this.plugin;
		const f = features(p.pro);
		containerEl.empty();

		// Shown first, so it's easy to tell which build a device is running.
		new Setting(containerEl).setName("Version").setDesc(`Vault Locker ${p.manifest?.version ?? ""}`.trim());

		new Setting(containerEl).setName("Protected folders").setDesc(p.settings.folders.join(", ") || "None yet. Right-click a folder to protect it.");

		if (!p.pro) {
			containerEl.createEl("p", { text: `Vault Locker Free protects one folder. Pro (${PRO_PRICE}) adds unlimited folders, the whole vault, auto-lock and hidden file names.` });
		}

		containerEl.createEl("p", {
			text: 'Using Obsidian Sync? Turn on "Sync all other types" in its settings, or locked (.vlock) files will not reach your other devices.',
		});

		new Setting(containerEl)
			.setName("License key")
			.setDesc(p.pro ? "Pro is active." : "Paste your Pro license key. Checking a key contacts Lemon Squeezy (api.lemonsqueezy.com).")
			.addText((t: any) => t.setValue(p.settings.license.key).onChange((v: string) => (p.settings.license = { ...p.settings.license, key: v })))
			.addButton((b: any) =>
				b.setButtonText("Activate").onClick(async () => {
					const { state, error } = await activate(postForm, p.settings.license.key, "Obsidian");
					p.settings.license = state;
					await p.save();
					say(error ?? "Vault Locker Pro activated.");
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName("Auto-lock after idle (minutes)")
			.setDesc(f.autoLock ? "0 = off." : "Pro feature.")
			.addText((t: any) => {
				t.setValue(String(p.settings.autoLockMinutes)).onChange(async (v: string) => {
					p.settings.autoLockMinutes = Math.max(0, Number(v) || 0);
					await p.save();
				});
				t.setDisabled(!f.autoLock);
			});

		new Setting(containerEl)
			.setName("Hide file names in newly protected folders")
			.setDesc(f.hideNames ? "Locked files get random names." : "Pro feature.")
			.addToggle((t: any) => {
				t.setValue(p.settings.hideNamesForNewFolders).onChange(async (v: boolean) => {
					p.settings.hideNamesForNewFolders = v;
					await p.save();
				});
				t.setDisabled(!f.hideNames);
			});
	}
}
