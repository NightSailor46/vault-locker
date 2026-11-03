import { test } from "node:test";
import assert from "node:assert/strict";
import {
	NO_LICENSE,
	OFFLINE_GRACE_MS,
	activate,
	canSetUpAnotherFolder,
	features,
	isPro,
	needsRevalidation,
	revalidate,
	type PostForm,
} from "../src/license.ts";

const P = { storeId: 7, productId: 42 };
const ok = { valid: true, activated: true, error: null, license_key: { status: "active" }, instance: { id: "inst-1" }, meta: { store_id: 7, product_id: 42 } };

function fake(json: object, status = 200): PostForm & { calls: Array<{ url: string; form: Record<string, string> }> } {
	const calls: Array<{ url: string; form: Record<string, string> }> = [];
	const fn = (async (url: string, form: Record<string, string>) => {
		calls.push({ url, form });
		return { status, json };
	}) as PostForm & { calls: typeof calls };
	fn.calls = calls;
	return fn;
}

test("Free allows one folder, Pro unlimited; security is the same", () => {
	assert.equal(canSetUpAnotherFolder(false, 0), true);
	assert.equal(canSetUpAnotherFolder(false, 1), false);
	assert.equal(canSetUpAnotherFolder(true, 500), true);
	assert.equal(features(false).hideNames, false);
	assert.equal(features(true).autoLock, true);
});

test("activation stores the instance and marks Pro", async () => {
	const post = fake(ok);
	const { state, error } = await activate(post, " KEY-1 ", "Pisces", 1000, P);
	assert.equal(error, undefined);
	assert.equal(state.instanceId, "inst-1");
	assert.ok(isPro(state, 2000));
	assert.equal(post.calls[0].url, "https://api.lemonsqueezy.com/v1/licenses/activate");
	assert.deepEqual(post.calls[0].form, { license_key: "KEY-1", instance_name: "Pisces" });
});

test("keys for another store or product are refused", async () => {
	const { state, error } = await activate(fake({ ...ok, meta: { store_id: 7, product_id: 1 } }), "k", "d", 0, P);
	assert.equal(state.status, "invalid");
	assert.match(error!, /different product/);
});

test("no key validates until the real product IDs are filled in", async () => {
	const { state } = await activate(fake(ok), "k", "d", 0);
	assert.equal(state.status, "invalid");
});

test("offline grace: Pro lasts 30 days without a successful check", async () => {
	const s = { ...NO_LICENSE, key: "k", instanceId: "i", lastValidated: 0, status: "active" as const };
	assert.ok(isPro(s, OFFLINE_GRACE_MS - 1));
	assert.ok(!isPro(s, OFFLINE_GRACE_MS + 1));
	const failing: PostForm = async () => {
		throw new Error("offline");
	};
	assert.deepEqual(await revalidate(failing, s, 5, P), s);
	assert.deepEqual(await revalidate(fake({}, 503), s, 5, P), s);
	assert.ok(needsRevalidation(s, 2 * 24 * 3600 * 1000));
});

test("a refunded or disabled key turns Pro off at the next check", async () => {
	const s = { ...NO_LICENSE, key: "k", instanceId: "i", lastValidated: 0, status: "active" as const };
	const r = await revalidate(fake({ ...ok, valid: false, license_key: { status: "disabled" } }), s, 10, P);
	assert.equal(r.status, "invalid");
	assert.ok(!isPro(r, 10));
	const good = await revalidate(fake(ok), s, 10, P);
	assert.equal(good.lastValidated, 10);
});
