import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { Inventory } from "../src/contracts/inventory.ts";
import type { Model } from "../src/contracts/model.ts";
import { propose } from "../src/model/index.ts";
import { createQueryRedirect, planRedirects, toQueryRedirects, writeRedirectPlan } from "../src/redirects/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = <T>(p: string): T => JSON.parse(readFileSync(root + p, "utf8")) as T;
const business = (): Inventory => json<Inventory>("test/samples/business.inventory.json");
const businessModel = (): Model => json<Model>("test/samples/business.model.json");
const realBusiness = (): Inventory => json<Inventory>("test/samples/business.real.inventory.json");
const temp = (fn: (dir: string) => Promise<void>) => async () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-query-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};
const mapOf = (text: string): Record<string, string> => (JSON.parse(text) as { redirects: Record<string, string> }).redirects;

test("query map: the business sample's resolved query URL, keyed by path and query", () => {
	const rows = planRedirects(business(), businessModel(), { target: "astro" });
	const q = toQueryRedirects(rows, "astro");
	assert.ok(q);
	assert.deepEqual(mapOf(q.map), { "/site/?page_id=11": "/plans/pricing/" });
	assert.equal(q.handlerFile, "query-redirects.worker.ts");
	assert.match(q.handler, /^\/\/ wp-redirect-plan for the astro target/);
	assert.match(q.handler, /Goes in worker\/query-redirects\.ts/);
	assert.match(q.handler, /"run_worker_first": \["\/site","\/site\/"\]/);
	// the emdash plan sends that URL to review, so there is nothing to map
	assert.equal(toQueryRedirects(planRedirects(business(), businessModel(), { target: "emdash" }), "emdash"), null);
});

test("query map: the real business site, review rows left out, path-only /site/ kept for emdash", () => {
	const inv = realBusiness();
	const model = propose(inv);
	const em = toQueryRedirects(planRedirects(inv, model, { target: "emdash" }), "emdash");
	assert.ok(em);
	const map = mapOf(em.map);
	assert.equal(em.queryCount, 30);
	assert.equal(map["/site/?author=2"], "/author/dana-whitlock");
	assert.equal(map["/site/?p=26"], "/spring-checklist-for-older-homes");
	assert.equal(map["/site/?page_id=16"], "/commercial");
	assert.equal(map["/site/?post_type=service"], "/services");
	assert.equal(map["/site/"], "/");
	assert.ok(!("/site/?page_id=17" in map), "review rows stay out");
	assert.equal(em.handlerFile, "query-redirects.middleware.ts");
	assert.match(em.handler, /Goes in src\/middleware\.ts/);
	const astro = toQueryRedirects(planRedirects(inv, model, { target: "astro" }), "astro");
	assert.ok(astro);
	assert.equal(astro.queryCount, 32);
	assert.ok(!("/site/" in mapOf(astro.map)), "astro leaves path-only lines to _redirects");
});

test("handler: known query → 301 to the path; extra params ignored; unknown and other params pass through", temp(async (dir) => {
	await writeRedirectPlan(realBusiness(), propose(realBusiness()), dir, { target: "astro" });
	const worker = (await import(pathToFileURL(join(dir, "query-redirects.worker.ts")).href)) as { default: { fetch(r: Request, env: unknown): Response | Promise<Response> } };
	const passed: string[] = [];
	const env = { ASSETS: { fetch: async (r: Request) => (passed.push(r.url), new Response("asset")) } };
	const get = (path: string, init?: RequestInit) => worker.default.fetch(new Request(`https://example.com${path}`, init), env);
	let res = await get("/site/?p=26");
	assert.equal(res.status, 301);
	assert.equal(res.headers.get("location"), "/spring-checklist-for-older-homes/");
	res = await get("/site/?utm_source=news&page_id=16&fbclid=x");
	assert.equal(res.status, 301);
	assert.equal(res.headers.get("location"), "/what-we-do/commercial/");
	res = await get("/site?p=26");
	assert.equal(res.headers.get("location"), "/spring-checklist-for-older-homes/", "with or without the trailing slash");
	for (const path of ["/site/?p=999", "/site/?utm_source=x", "/site/", "/services/", "/?p=26"]) {
		res = await get(path);
		assert.equal(await res.text(), "asset", path);
	}
	res = await get("/site/?p=26", { method: "POST" });
	assert.equal(await res.text(), "asset", "POST passes through");
	assert.equal(passed.length, 6);
}));

test("handler: the emdash middleware answers query URLs and the path-only /site/, else calls next", temp(async (dir) => {
	await writeRedirectPlan(realBusiness(), propose(realBusiness()), dir, { target: "emdash" });
	assert.ok(!existsSync(join(dir, "query-redirects.worker.ts")));
	const mw = (await import(pathToFileURL(join(dir, "query-redirects.middleware.ts")).href)) as { onRequest(c: { request: Request }, next: () => Promise<Response>): Response | Promise<Response> };
	const next = async () => new Response("page");
	const at = (path: string) => mw.onRequest({ request: new Request(`https://example.com${path}`) }, next);
	assert.equal((await at("/site/?page_id=21")).headers.get("location"), "/about-us");
	assert.equal((await at("/site/")).headers.get("location"), "/");
	assert.equal(await (await at("/site/?page_id=17")).text(), "page", "a review row is not in the map");
	assert.equal(await (await at("/about-us")).text(), "page");
}));

test("handler: a target that is not a path on this site is never sent", () => {
	const redirect = createQueryRedirect({
		"/?p=1": "https://evil.example.com/",
		"/?p=2": "//evil.example.com/",
		"/?p=3": "/\\evil.example.com/",
		"/?p=4": "/%5cevil.example.com/",
		"/?p=5": "/\tx",
		"/?p=6": "javascript:alert(1)",
		"/?p=7": "/ok/",
	});
	for (let i = 1; i <= 6; i++) assert.equal(redirect(new Request(`https://example.com/?p=${i}`)), null, `p=${i}`);
	assert.equal(redirect(new Request("https://example.com/?p=7"))?.headers.get("location"), "/ok/");
	const proto = createQueryRedirect({ "/?p=1": "/a/" });
	assert.equal(proto(new Request("https://example.com/?constructor=x")), null, "no prototype keys");
});

test("summary: over 10 query rules, the map and handler are the default and the rules optional", temp(async (dir) => {
	const { summary, files } = await writeRedirectPlan(realBusiness(), propose(realBusiness()), dir, { target: "astro" });
	const text = summary.join("\n");
	assert.match(text, /^query-redirects\.json: 32 old query URLs \(\?author=, \?cat=, \?p=, \?page_id=, \?post_type=\).*Goes in worker\/query-redirects\.json/m);
	assert.match(text, /^query-redirects\.worker\.ts: .*Goes in worker\/query-redirects\.ts/m);
	assert.match(text, /^cloudflare-rules\.json \(optional\): 32 Single Redirect rules/m);
	assert.match(text, /^Default: query-redirects\.json with query-redirects\.worker\.ts\. cloudflare-rules\.json has 32 rules, more than the 10/m);
	assert.match(text, /^Order: If you use the rules instead: /m);
	assert.ok(files.some((f) => f.endsWith("cloudflare-rules.json")), "the rules file is still written");
	const small = await writeRedirectPlan(business(), businessModel(), join(dir, "small"), { target: "astro" });
	const smallText = small.summary.join("\n");
	assert.match(smallText, /^cloudflare-rules\.json: 1 /m);
	assert.match(smallText, /^Choice: add the rules to the zone, or use query-redirects\.json with query-redirects\.worker\.ts/m);
	assert.doesNotMatch(smallText, /^Default:/m);
}));
