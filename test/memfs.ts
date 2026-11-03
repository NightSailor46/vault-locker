// In-memory LockerFS for tests. Mirrors Obsidian's DataAdapter: list() is
// one level deep and returns full paths.

import type { LockerFS } from "../src/locker.ts";

export class MemFS implements LockerFS {
	files = new Map<string, Uint8Array>();
	dirs = new Set<string>([""]);
	failWritesAfter = Infinity;

	private parent(p: string): string {
		const i = p.lastIndexOf("/");
		return i < 0 ? "" : p.slice(0, i);
	}

	addText(path: string, text: string): void {
		this.addBinary(path, new TextEncoder().encode(text));
	}

	addBinary(path: string, data: Uint8Array): void {
		let d = this.parent(path);
		while (d && !this.dirs.has(d)) {
			this.dirs.add(d);
			d = this.parent(d);
		}
		this.files.set(path, data);
	}

	text(path: string): string {
		return new TextDecoder().decode(this.files.get(path));
	}

	async exists(p: string): Promise<boolean> {
		return this.files.has(p) || this.dirs.has(p);
	}
	async list(p: string): Promise<{ files: string[]; folders: string[] }> {
		return {
			files: [...this.files.keys()].filter((f) => this.parent(f) === p).sort(),
			folders: [...this.dirs].filter((d) => d && this.parent(d) === p).sort(),
		};
	}
	async read(p: string): Promise<string> {
		return this.text(p);
	}
	async write(p: string, data: string): Promise<void> {
		await this.writeBinary(p, new TextEncoder().encode(data));
	}
	async readBinary(p: string): Promise<Uint8Array> {
		const v = this.files.get(p);
		if (!v) throw new Error(`ENOENT ${p}`);
		return v.slice();
	}
	async writeBinary(p: string, data: Uint8Array): Promise<void> {
		if (this.failWritesAfter-- <= 0) throw new Error("simulated crash");
		if (!this.dirs.has(this.parent(p))) throw new Error(`no parent dir for ${p}`);
		this.files.set(p, data.slice());
	}
	async remove(p: string): Promise<void> {
		this.files.delete(p);
	}
	async mkdir(p: string): Promise<void> {
		this.dirs.add(p);
	}
	async size(p: string): Promise<number> {
		return this.files.get(p)?.length ?? 0;
	}
	async rmdir(p: string): Promise<void> {
		this.dirs.delete(p);
	}
}
