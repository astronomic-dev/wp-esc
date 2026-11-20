// Checks the recorded fixtures (test/sites/record.mjs): the manifest shape the
// replay relies on, a few facts about each site, and a secret scan. Every
// fixture file is scanned raw, URL-decoded and base64-decoded for the recorder
// login, application passwords, Basic auth headers, login cookies and nonces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SITES = ["blog", "business", "builder", "blog-rest-off"];
const WITH_WXR = ["blog", "business", "builder"];

interface Entry { method: string; path: string; auth: boolean; status: number; headers: Record<string, string>; body: string }
interface Manifest { origin: string; entries: Entry[] }

const manifest = (site: string): Manifest => JSON.parse(readFileSync(join(dir, site, "manifest.json"), "utf8")) as Manifest;
const find = (m: Manifest, path: string, auth = false, method = "GET"): Entry | undefined =>
	m.entries.find((e) => e.path === path && e.auth === auth && e.method === method);
const body = (site: string, e: Entry): string => readFileSync(join(dir, site, e.body), "utf8");

test("each recording has a well-formed manifest", () => {
	for (const site of SITES) {
		const m = manifest(site);
		assert.match(m.origin, /^http:\/\/localhost:\d+$/, site);
		assert.ok(m.entries.length > 50, `${site}: ${m.entries.length} entries`);
		const keys = new Set<string>();
		for (const e of m.entries) {
			assert.ok(e.method === "GET" || e.method === "HEAD", `${site} ${e.method}`);
			assert.ok(e.path.startsWith("/"), `${site} ${e.path}`);
			assert.equal(typeof e.auth, "boolean");
			assert.equal(typeof e.status, "number");
			assert.match(e.body, /^bodies\/[0-9a-f]{40}\.txt$/);
			assert.ok(existsSync(join(dir, site, e.body)), `${site}: missing ${e.body}`);
			for (const h of Object.keys(e.headers)) {
				assert.equal(h, h.toLowerCase(), `${site} ${e.path}: header ${h}`);
				assert.ok(!["set-cookie", "authorization", "x-wp-nonce"].includes(h), `${site} ${e.path}: kept ${h}`);
			}
			const key = `${e.method} ${e.path} ${e.auth}`;
			assert.ok(!keys.has(key), `${site}: duplicate ${key}`);
			keys.add(key);
		}
	}
});

test("WXR exports exist for the three sites", () => {
	for (const site of WITH_WXR) {
		const xml = readFileSync(join(dir, site, "export.xml"), "utf8");
		assert.ok(xml.startsWith("<?xml"), site);
		assert.match(xml, /<rss[^>]*xmlns:wp=/, site);
	}
});

test("blog: discovery, two pages of posts, auth lists", () => {
	const m = manifest("blog");
	assert.match(find(m, "/", false, "HEAD")?.headers.link ?? "", /<http:\/\/localhost:\d+\/wp-json\/>; rel="https:\/\/api\.w\.org\/"/);
	const p1 = find(m, "/wp-json/wp/v2/posts?per_page=100&page=1");
	assert.equal(p1?.headers["x-wp-total"], "120");
	assert.equal(p1?.headers["x-wp-totalpages"], "2");
	assert.ok(find(m, "/wp-json/wp/v2/posts?per_page=100&page=2"));
	const edit = find(m, "/wp-json/wp/v2/posts?context=edit&status=any&per_page=100", true);
	assert.equal(edit?.headers["x-wp-total"], "124");
	assert.equal(find(m, "/wp-json/wp/v2/plugins", true)?.status, 200);
	assert.equal(find(m, "/wp-json/wp/v2/plugins")?.status, 401);
});

test("blog-rest-off: anonymous REST is 401, sitemaps still work", () => {
	const m = manifest("blog-rest-off");
	assert.equal(find(m, "/wp-json/")?.status, 401);
	assert.equal(find(m, "/wp-json/wp/v2/posts?per_page=100")?.status, 401);
	assert.equal(find(m, "/sitemap_index.xml")?.status, 200);
});

test("business: API under /site/, team only outside REST", () => {
	const m = manifest("business");
	assert.match(find(m, "/site/", false, "HEAD")?.headers.link ?? "", /\/site\/wp-json\/>; rel="https:\/\/api\.w\.org\/"/);
	const types = JSON.parse(body("business", find(m, "/site/wp-json/wp/v2/types")!)) as Record<string, unknown>;
	assert.ok("service" in types && !("team" in types));
	assert.ok(m.entries.some((e) => /\/site\/wp-sitemap-posts-team-1\.xml$/.test(e.path) && e.status === 200));
});

test("builder: API at ?rest_route=/", () => {
	const m = manifest("builder");
	assert.match(find(m, "/", false, "HEAD")?.headers.link ?? "", /\?rest_route=\/>; rel="https:\/\/api\.w\.org\/"/);
	assert.equal(find(m, "/?rest_route=/wp/v2/pages&per_page=100")?.status, 200);
	assert.equal(find(m, "/index.php?rest_route=/wp/v2/pages&per_page=100")?.status, 200);
});

// ---- secret scan ----

const files: string[] = [];
const walk = (d: string): void => {
	for (const f of readdirSync(d)) {
		const p = join(d, f);
		if (statSync(p).isDirectory()) walk(p);
		else files.push(p);
	}
};
walk(dir);

const urlDecode = (s: string): string =>
	s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
const base64Runs = (s: string): string[] =>
	[...s.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)].map((m) => Buffer.from(m[0], "base64").toString("latin1"));

const RULES: [string, RegExp][] = [
	["recorder login", /wpm[-_]recorder/i],
	["Basic auth header", /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/],
	["grouped application password", /(?<![A-Za-z0-9])[A-Za-z0-9]{4}(?: [A-Za-z0-9]{4}){5}(?![A-Za-z0-9])/],
	["login cookie", /wordpress_(?:logged_in|sec)_[0-9a-f]{32}|wp-settings-(?:time-)?\d+=/],
	["nonce", /(?:_wp)?nonce[A-Za-z_-]*(?:\\?["'])?\s*(?:=>|[:=])\s*(?:\\?["'])?[0-9a-f]{10}(?![0-9a-f])/i],
];
// A WordPress application password is 24 characters of [A-Za-z0-9].
const appPassword = (s: string): string | undefined =>
	[...s.matchAll(/(?<![A-Za-z0-9_-])[A-Za-z0-9]{24}(?![A-Za-z0-9_-])/g)]
		.map((m) => m[0]).find((t) => /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t));

test("no fixture holds a credential, cookie or nonce (raw, URL- or base64-decoded)", () => {
	assert.ok(files.length > 100);
	const hits: string[] = [];
	for (const file of files) {
		const raw = readFileSync(file, "utf8");
		const forms = [raw, urlDecode(raw), ...base64Runs(raw)];
		const name = file.slice(dir.length);
		for (const text of forms) {
			for (const [label, re] of RULES) if (re.test(text)) hits.push(`${name}: ${label}`);
		}
		const pw = appPassword(raw) ?? appPassword(urlDecode(raw));
		if (pw) hits.push(`${name}: application password shape (${pw.slice(0, 4)}...)`);
	}
	assert.deepEqual([...new Set(hits)], []);
});
