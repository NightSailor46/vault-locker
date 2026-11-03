// Tiny bundler with no npm packages: Node strips the TypeScript types, then
// each src module is wrapped in a function and imports become lookups.
// Only handles the import/export forms used in src/ (named imports, and
// `export` before function/class/const). Output: main.js (CommonJS) for Obsidian.

import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.removeAllListeners("warning");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");

function convert(code, file) {
	const exported = [];
	let out = stripTypeScriptTypes(code, { mode: "strip" });
	out = out.replace(/import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?/g, (_, names, from) => {
		const list = names.split(",").map((n) => n.trim()).filter(Boolean).join(", ");
		const target = from.startsWith("./") ? `__require(${JSON.stringify(from.slice(2))})` : `require(${JSON.stringify(from)})`;
		return list ? `const { ${list} } = ${target};` : "";
	});
	out = out.replace(/^export default class (\w+)/gm, (_, n) => {
		exported.push(["default", n]);
		return `class ${n}`;
	});
	out = out.replace(/^export (async function|function|class|const|let) (\w+)/gm, (_, kind, n) => {
		exported.push([n, n]);
		return `${kind} ${n}`;
	});
	if (/^\s*(import|export)\s/m.test(out)) throw new Error(`${file}: unsupported import/export left after conversion`);
	const assign = exported.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ");
	return `function (exports) {\n${out}\nObject.assign(exports, { ${assign} });\n}`;
}

const modules = readdirSync(src)
	.filter((f) => f.endsWith(".ts"))
	.map((f) => `${JSON.stringify(f)}: ${convert(readFileSync(join(src, f), "utf8"), f)}`);

const bundle = `"use strict";
// Vault Locker. Built by scripts/build.mjs from src/*.ts. Do not edit.
const __modules = {
${modules.join(",\n")}
};
const __cache = {};
function __require(name) {
	if (!__cache[name]) {
		__cache[name] = {};
		__modules[name](__cache[name]);
	}
	return __cache[name];
}
module.exports = __require("main.ts").default;
`;

writeFileSync(join(root, "main.js"), bundle);
console.log(`main.js written (${bundle.length} bytes, ${modules.length} modules)`);

// Install into the throwaway test vault only.
const dest = join(root, "test-vault", ".obsidian", "plugins", "vault-locker");
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(root, f), join(dest, f));
console.log(`installed into ${dest}`);
