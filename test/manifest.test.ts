// Checks manifest.json against Obsidian's manifest and submission rules,
// and that the directory entry draft matches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const m = read("manifest.json");

test("manifest has the required fields", () => {
	for (const k of ["id", "name", "version", "minAppVersion", "description", "author"]) assert.equal(typeof m[k], "string", k);
	assert.equal(typeof m.isDesktopOnly, "boolean");
});

test("manifest id, name and version follow the rules", () => {
	assert.match(m.id, /^[a-z-]+$/);
	assert.ok(!m.id.includes("obsidian") && !m.id.endsWith("plugin"));
	assert.ok(!/obsidian/i.test(m.name) && !/plugin/i.test(m.name));
	assert.match(m.name, /^[A-Za-z0-9 +()-]+$/);
	assert.match(m.version, /^\d+\.\d+\.\d+$/);
	assert.match(m.minAppVersion, /^\d+\.\d+\.\d+$/);
});

test("description follows the submission rules", () => {
	assert.ok(m.description.length <= 250);
	assert.ok(m.description.endsWith("."));
	assert.ok(!/^this is a plugin/i.test(m.description));
	assert.match(m.description, /^[\x20-\x7E]+$/, "no emoji or special characters");
});

test("no fundingUrl unless it points to a donation service", () => {
	assert.equal(m.fundingUrl, undefined);
});

test("versions.json and the directory entry agree with the manifest", () => {
	assert.equal(read("versions.json")[m.version], m.minAppVersion);
	const e = read("submission/community-plugins-entry.json");
	for (const k of ["id", "name", "author", "description"]) assert.equal(e[k], m[k], k);
});
