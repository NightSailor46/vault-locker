// Free vs Pro rules and the Polar license check (Lemon Squeezy shuts down March 31, 2027).
// The crypto is identical in both tiers; Pro only adds quantity and convenience.

export const FREE_FOLDER_LIMIT = 1;
export const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// Checkout page for Pro. Empty until the Polar product exists (the Buy button does nothing until then).
export const BUY_PRO_URL = "https://buy.polar.sh/polar_cl_Pbfr3GePXHqNSx2Mtuo1t7Y1ctbI2jJWeHHNv0hJBIL";
export const PRO_PRICE = "$5, lifetime use";

// Polar's customer-portal license endpoints need no secret, so they are safe in a public plugin.
// Testing against Polar's sandbox: use https://sandbox-api.polar.sh and the sandbox IDs.
export const POLAR_API = "https://api.polar.sh/v1/customer-portal/license-keys";

export interface Product {
	organizationId: string | null; // Polar organization (Senior Enterprises)
	benefitId: string | null; // the "License key" benefit on the Vault Locker Pro product
	api?: string; // defaults to POLAR_API; the sandbox uses POLAR_SANDBOX_API
}

export const POLAR_SANDBOX_API = "https://sandbox-api.polar.sh/v1/customer-portal/license-keys";

// Polar sandbox (test mode, no real money), created 2026-11-26. For local testing only.
export const SANDBOX_PRODUCT: Product = {
	organizationId: "31b81d65-aa92-444c-98fa-4f5b68103bbb",
	benefitId: "e96b5ba6-1112-4d31-b3ed-2ce1d33d27b7",
	api: POLAR_SANDBOX_API,
};

// Live Polar product: Senior Enterprises org, "Vault Locker Pro license key" benefit (2026-11-26).
// The benefit must have "Limit activations" turned on (e.g. 5 devices), or Polar refuses activation.
export const PRODUCT: Product = {
  organizationId: "72a97a83-0fe2-46e2-ae01-02b455bc1594",
  benefitId: "98c2dd5a-08ec-4e06-932c-4e63db43a3e2",
};

export interface LicenseState {
	key: string;
	instanceId: string;
	lastValidated: number; // ms since epoch of the last successful online check
	status: "none" | "active" | "invalid";
}

export const NO_LICENSE: LicenseState = { key: "", instanceId: "", lastValidated: 0, status: "none" };

export interface Features {
	maxFolders: number;
	wholeVault: boolean;
	autoLock: boolean;
	hideNames: boolean;
	perFolderPasswords: boolean;
}

export function isPro(s: LicenseState, now: number = Date.now()): boolean {
	return s.status === "active" && now - s.lastValidated < OFFLINE_GRACE_MS;
}

export function features(pro: boolean): Features {
	return pro
		? { maxFolders: Infinity, wholeVault: true, autoLock: true, hideNames: true, perFolderPasswords: true }
		: { maxFolders: FREE_FOLDER_LIMIT, wholeVault: false, autoLock: false, hideNames: false, perFolderPasswords: false };
}

export function canSetUpAnotherFolder(pro: boolean, foldersSetUp: number): boolean {
	return foldersSetUp < features(pro).maxFolders;
}

// True when the stored result is old enough that we should try the network again.
export function needsRevalidation(s: LicenseState, now: number = Date.now()): boolean {
	return s.status === "active" && now - s.lastValidated > 24 * 60 * 60 * 1000;
}

// Post a JSON body, get JSON back. Obsidian's requestUrl is wrapped into this
// shape in main.ts (it avoids CORS); tests pass a fake.
export type PostJson = (url: string, body: Record<string, unknown>) => Promise<{ status: number; json: any }>;

interface PolarKey {
	status?: string; // "granted" is the only good one; "revoked" and "disabled" are not
	organization_id?: string;
	benefit_id?: string;
	expires_at?: string | null;
}

function ourKey(k: PolarKey | undefined, p: Product, now: number): boolean {
	if (!k || p.organizationId === null || p.benefitId === null) return false;
	if (k.status !== "granted") return false;
	if (k.organization_id !== p.organizationId || k.benefit_id !== p.benefitId) return false;
	if (k.expires_at && Date.parse(k.expires_at) <= now) return false;
	return true;
}

function activationError(status: number, json: any): string {
	if (status === 404) return "That license key wasn't found. Check it against your Polar receipt email.";
	if (status === 403) return "This key can't be activated here: it has reached its device limit, or it was refunded or disabled.";
	return json?.detail && typeof json.detail === "string" ? json.detail : "Activation failed. Check your internet connection and try again.";
}

export async function activate(post: PostJson, key: string, deviceName: string, now: number = Date.now(), product: Product = PRODUCT): Promise<{ state: LicenseState; error?: string }> {
	key = key.trim();
	const invalid = { ...NO_LICENSE, key, status: "invalid" as const };
	if (product.organizationId === null || product.benefitId === null) return { state: invalid, error: "Pro sales aren't open yet." };
	let res;
	try {
		res = await post(`${product.api ?? POLAR_API}/activate`, { key, organization_id: product.organizationId, label: deviceName });
	} catch {
		return { state: invalid, error: "Couldn't reach Polar. Check your internet connection and try again." };
	}
	const r = res.json ?? {};
	if (res.status !== 200 || !r.id) return { state: invalid, error: activationError(res.status, r) };
	if (!ourKey(r.license_key, product, now)) return { state: invalid, error: "This key is for a different product" };
	return { state: { key, instanceId: r.id, lastValidated: now, status: "active" } };
}

// Network errors, rate limits and server errors keep the old state, so the offline grace period applies.
export async function revalidate(post: PostJson, s: LicenseState, now: number = Date.now(), product: Product = PRODUCT): Promise<LicenseState> {
	if (product.organizationId === null || product.benefitId === null) return s;
	let res;
	try {
		res = await post(`${product.api ?? POLAR_API}/validate`, {
			key: s.key,
			organization_id: product.organizationId,
			activation_id: s.instanceId,
			benefit_id: product.benefitId,
		});
	} catch {
		return s;
	}
	if (res.status >= 500 || res.status === 429) return s;
	if (res.status === 200 && ourKey(res.json, product, now)) return { ...s, lastValidated: now, status: "active" };
	return { ...s, status: "invalid" };
}
