import { test } from "node:test";
import assert from "node:assert/strict";
import {
	NO_LICENSE,
	OFFLINE_GRACE_MS,
	PRODUCT,
	activate,
	canSetUpAnotherFolder,
	features,
	isPro,
	needsRevalidation,
	revalidate,
	type PostJson,
} from "../src/license.ts";

const P = { organizationId: "org-1", benefitId: "ben-1" };
const key = { id: "lk-1", key: "KEY-1", status: "granted", organization_id: "org-1", benefit_id: "ben-1", expires_at: null };
const activated = { id: "act-1", license_key_id: "lk-1", label: "Pisces", license_key: key };

function fake(json: object, status = 200): PostJson & { calls: Array<{ url: string; body: Record<string, unknown> }> } {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fn = (async (url: string, body: Record<string, unknown>) => {
		calls.push({ url, body });
		return { status, json };
	}) as PostJson & { calls: typeof calls };
	fn.calls = calls;
	return fn;
}

const active = { ...NO_LICENSE, key: "KEY-1", instanceId: "act-1", lastValidated: 0, status: "active" as const };

test("Free allows one folder, Pro unlimited; security is the same", () => {
	assert.equal(canSetUpAnotherFolder(false, 0), true);
	assert.equal(canSetUpAnotherFolder(false, 1), false);
	assert.equal(canSetUpAnotherFolder(true, 500), true);
	assert.equal(features(false).hideNames, false);
	assert.equal(features(true).autoLock, true);
});

test("activation calls Polar, stores the activation ID and marks Pro", async () => {
	const post = fake(activated);
	const { state, error } = await activate(post, " KEY-1 ", "Pisces", 1000, P);
	assert.equal(error, undefined);
	assert.equal(state.instanceId, "act-1");
	assert.ok(isPro(state, 2000));
	assert.equal(post.calls[0].url, "https://api.polar.sh/v1/customer-portal/license-keys/activate");
	assert.deepEqual(post.calls[0].body, { key: "KEY-1", organization_id: "org-1", label: "Pisces" });
});

test("keys for another product (benefit) or organization are refused", async () => {
	for (const k of [{ ...key, benefit_id: "other" }, { ...key, organization_id: "other" }]) {
		const { state, error } = await activate(fake({ ...activated, license_key: k }), "k", "d", 0, P);
		assert.equal(state.status, "invalid");
		assert.match(error!, /different product/);
	}
});

test("unknown key, device limit and network failure give plain messages", async () => {
	const nf = await activate(fake({ detail: "License key not found." }, 404), "k", "d", 0, P);
	assert.equal(nf.state.status, "invalid");
	assert.match(nf.error!, /wasn't found/);
	const lim = await activate(fake({ error: "NotPermitted", detail: "limit" }, 403), "k", "d", 0, P);
	assert.match(lim.error!, /device limit/);
	const off = await activate(async () => {
		throw new Error("offline");
	}, "k", "d", 0, P);
	assert.match(off.error!, /Couldn't reach Polar/);
});

test("no key validates and nothing is sent when the Polar IDs are empty", async () => {
	const post = fake(activated);
	const { state } = await activate(post, "k", "d", 0, { organizationId: null, benefitId: null });
	assert.equal(state.status, "invalid");
	assert.equal(post.calls.length, 0);
});

test("the live product points at the real Polar API with both IDs set", () => {
	assert.equal(PRODUCT.api, undefined);
	assert.match(PRODUCT.organizationId!, /^[0-9a-f-]{36}$/);
	assert.match(PRODUCT.benefitId!, /^[0-9a-f-]{36}$/);
});

test("revalidate sends the activation and benefit to Polar", async () => {
	const post = fake(key);
	const r = await revalidate(post, active, 10, P);
	assert.equal(r.lastValidated, 10);
	assert.equal(r.status, "active");
	assert.equal(post.calls[0].url, "https://api.polar.sh/v1/customer-portal/license-keys/validate");
	assert.deepEqual(post.calls[0].body, { key: "KEY-1", organization_id: "org-1", activation_id: "act-1", benefit_id: "ben-1" });
});

test("offline grace: Pro lasts 30 days without a successful check", async () => {
	assert.ok(isPro(active, OFFLINE_GRACE_MS - 1));
	assert.ok(!isPro(active, OFFLINE_GRACE_MS + 1));
	const failing: PostJson = async () => {
		throw new Error("offline");
	};
	assert.deepEqual(await revalidate(failing, active, 5, P), active);
	assert.deepEqual(await revalidate(fake({}, 503), active, 5, P), active);
	assert.deepEqual(await revalidate(fake({}, 429), active, 5, P), active);
	assert.ok(needsRevalidation(active, 2 * 24 * 3600 * 1000));
});

test("a refunded, revoked or expired key turns Pro off at the next check", async () => {
	const gone = await revalidate(fake({ detail: "License key not found." }, 404), active, 10, P);
	assert.equal(gone.status, "invalid");
	assert.ok(!isPro(gone, 10));
	const revoked = await revalidate(fake({ ...key, status: "revoked" }), active, 10, P);
	assert.equal(revoked.status, "invalid");
	const expired = await revalidate(fake({ ...key, expires_at: "2020-01-01T00:00:00Z" }), active, Date.parse("2026-11-26"), P);
	assert.equal(expired.status, "invalid");
});
