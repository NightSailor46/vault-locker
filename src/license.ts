// Free vs Pro rules and the Lemon Squeezy license check.
// The crypto is identical in both tiers; Pro only adds quantity and convenience.

export const FREE_FOLDER_LIMIT = 1;
export const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// Checkout page for Pro. Empty until the Lemon Squeezy store exists.
export const BUY_PRO_URL = "";
export const PRO_PRICE = "$5, lifetime use";

const LS_API = "https://api.lemonsqueezy.com/v1/licenses";

export interface Product {
	storeId: number | null;
	productId: number | null;
}

// Filled in once the Lemon Squeezy product exists. Until then no key can validate.
export const PRODUCT: Product = { storeId: null, productId: null };

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

// Post form fields, get JSON back. Obsidian's requestUrl is wrapped into this
// shape in main.ts (it avoids CORS); tests pass a fake.
export type PostForm = (url: string, form: Record<string, string>) => Promise<{ status: number; json: any }>;

interface LsResponse {
	valid?: boolean;
	activated?: boolean;
	error: string | null;
	license_key?: { status: string };
	instance?: { id: string } | null;
	meta?: { store_id: number; product_id: number };
}

function ourProduct(r: LsResponse, p: Product): boolean {
	if (p.storeId === null || p.productId === null) return false;
	return r.meta?.store_id === p.storeId && r.meta?.product_id === p.productId;
}

export async function activate(post: PostForm, key: string, deviceName: string, now: number = Date.now(), product: Product = PRODUCT): Promise<{ state: LicenseState; error?: string }> {
	key = key.trim();
	const res = await post(`${LS_API}/activate`, { license_key: key, instance_name: deviceName });
	const r = res.json as LsResponse;
	if (!r.activated || !r.instance?.id) return { state: { ...NO_LICENSE, key, status: "invalid" }, error: r.error ?? "Activation failed" };
	if (!ourProduct(r, product)) return { state: { ...NO_LICENSE, key, status: "invalid" }, error: "This key is for a different product" };
	return { state: { key, instanceId: r.instance.id, lastValidated: now, status: "active" } };
}

// Network errors keep the old state, so the offline grace period applies.
export async function revalidate(post: PostForm, s: LicenseState, now: number = Date.now(), product: Product = PRODUCT): Promise<LicenseState> {
	let res;
	try {
		res = await post(`${LS_API}/validate`, { license_key: s.key, instance_id: s.instanceId });
	} catch {
		return s;
	}
	if (res.status >= 500) return s;
	const r = res.json as LsResponse;
	if (r.valid && r.license_key?.status === "active" && ourProduct(r, product)) return { ...s, lastValidated: now, status: "active" };
	return { ...s, status: "invalid" };
}
