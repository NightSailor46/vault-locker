// Memory/time bench for very large attachments. Not part of `npm test`.
// Usage: node scripts/bench-large.ts 50 250 1024   (sizes in MB)
// Each size runs in its own child process so peaks don't mix.
// Files go in test-vault/.bench-tmp and are deleted afterwards.

import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LockerFS } from "../src/locker.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "test-vault", ".bench-tmp");
const MB = 1024 * 1024;

function diskFS(root: string): LockerFS {
	const p = (x: string) => join(root, x);
	return {
		exists: async (x) => fsp.access(p(x)).then(() => true, () => false),
		list: async (x) => {
			const ents = await fsp.readdir(p(x), { withFileTypes: true });
			const full = (n: string) => (x ? `${x}/${n}` : n);
			return { files: ents.filter((e) => e.isFile()).map((e) => full(e.name)), folders: ents.filter((e) => e.isDirectory()).map((e) => full(e.name)) };
		},
		read: (x) => fsp.readFile(p(x), "utf8"),
		write: (x, d) => fsp.writeFile(p(x), d),
		// Fresh ArrayBuffer like Obsidian's adapter, not a pooled Buffer.
		readBinary: async (x) => {
			const fh = await fsp.open(p(x), "r");
			const u = new Uint8Array((await fh.stat()).size);
			for (let at = 0; at < u.length; ) at += (await fh.read(u, at, u.length - at, at)).bytesRead;
			await fh.close();
			return u;
		},
		// BENCH_GC=1 sweeps after each write, like a device under memory pressure would.
		writeBinary: async (x, d) => { await fsp.writeFile(p(x), d); if (process.env.BENCH_GC) setImmediate(() => (globalThis as any).gc?.()); },
		remove: (x) => fsp.rm(p(x)),
		mkdir: (x) => fsp.mkdir(p(x)),
		rmdir: (x) => fsp.rmdir(p(x)),
		size: async (x) => (await fsp.stat(p(x))).size,
	} as LockerFS;
}

async function child(sizeMB: number) {
	const { setupFolder, lockFolder, unlockFolder } = await import("../src/locker.ts");
	const dir = join(ROOT, `run-${sizeMB}`);
	await fsp.rm(dir, { recursive: true, force: true });
	await fsp.mkdir(join(dir, "Big"), { recursive: true });
	// Write the test file in 16 MB pieces so making it doesn't skew the peak.
	const fh = await fsp.open(join(dir, "Big", "video.bin"), "w");
	const piece = new Uint8Array(16 * MB);
	for (let i = 0; i < piece.length; i++) piece[i] = (i * 31) & 255;
	for (let left = sizeMB * MB; left > 0; left -= piece.length) await fh.write(piece, 0, Math.min(left, piece.length));
	await fh.close();
	const fs = diskFS(dir);
	(globalThis as any).gc?.();
	const base = process.memoryUsage();
	let peakRss = base.rss, peakAb = base.arrayBuffers;
	const sample = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakAb = Math.max(peakAb, m.arrayBuffers); };
	const timer = setInterval(sample, 2);
	const { folderKey } = await setupFolder(fs, "Big", "pw", { iterations: 1000 });
	const out: Record<string, unknown> = { sizeMB };
	for (const [name, fn] of [["lock", lockFolder], ["unlock", unlockFolder]] as const) {
		(globalThis as any).gc?.();
		const b = process.memoryUsage();
		peakRss = b.rss; peakAb = b.arrayBuffers;
		const t = performance.now();
		try {
			await fn(fs, "Big", folderKey);
			sample();
			out[name] = { ok: true, sec: +((performance.now() - t) / 1000).toFixed(1), peakRssMB: Math.round(peakRss / MB), peakBuffersMB: Math.round(peakAb / MB), buffersXFile: +(peakAb / (sizeMB * MB)).toFixed(2) };
		} catch (e) {
			out[name] = { ok: false, error: String(e) };
			break;
		}
	}
	clearInterval(timer);
	await fsp.rm(dir, { recursive: true, force: true });
	console.log(JSON.stringify(out));
}

if (process.argv[2] === "--child") {
	await child(Number(process.argv[3]));
} else {
	const sizes = process.argv.slice(2).map(Number);
	for (const s of sizes.length ? sizes : [50, 250, 1024]) {
		const r = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--child", String(s)], { encoding: "utf8" });
		console.log(r.stdout.trim() || `size ${s}MB failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
	}
	await fsp.rm(ROOT, { recursive: true, force: true });
}
