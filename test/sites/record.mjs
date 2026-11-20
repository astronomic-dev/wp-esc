#!/usr/bin/env node
// Record the wp-esc test fixtures from three throwaway WordPress sites.
//
// Run from the repo root (needs Docker and network for images and plugins):
//
//   node packages/wp-esc/test/sites/record.mjs
//
// What it does, in order:
//   1. `docker compose -p wpm-record` brings up MariaDB and the three sites
//      (blog 4601, business 4602 under /site/, builder 4603). Ports move with
//      WPM_BLOG_PORT, WPM_BUSINESS_PORT, WPM_BUILDER_PORT.
//   2. Runs seed-<site>.sh in each site's WP-CLI container.
//   3. Creates one application password per site for `wpm-recorder`.
//   4. Records every response the readers may ask for (see recordSite) into
//      test/fixtures/<site>/manifest.json + bodies/, then the WXR export
//      (WP-CLI `wp export`) into test/fixtures/<site>/export.xml.
//   5. Adds mu-plugins/rest-off.php to `blog` and records it again as
//      `blog-rest-off` (anonymous REST gets 401).
//   6. Revokes the passwords, checks no secret reached a fixture, swaps the
//      new fixtures into place, and always runs `down -v` (finally block).
//
// Fixture format (replayed by src/http/replay.ts):
//   manifest.json: { origin, entries: [{ method, path, auth, status, headers, body }] }
//   - `path` is the path plus query exactly as requested, starting with "/".
//   - `headers` are lowercase. Dropped: set-cookie, authorization, x-wp-nonce,
//     and the transport headers content-encoding, content-length,
//     transfer-encoding, connection, keep-alive (bodies are stored decoded).
//   - `body` is "bodies/<sha1 of `${method} ${path} ${auth}`>.txt".
//   - Redirects are stored as they came (3xx + location); the target is a
//     separate entry. Bodies are never rewritten, except that nonce values are
//     replaced with the same number of "x" characters, and plain.mjs drops a
//     few chat-tool routes from the REST index (no reader uses them).
//
// Paths recorded per REST root (the discovered root; for `builder` also the
// short "/?rest_route=" form), where Q is the list query:
//   anon  ?per_page=100  and  ?per_page=100&page=N for every page
//   auth  ?context=edit&status=any&per_page=100 (+&page=N) for post types (media: also without status)
//   auth  ?context=edit&per_page=100 (+&page=N) for taxonomies, comments, menus, menu-items
//   plus the API index, /wp/v2, types and taxonomies (anon, auth, auth context=edit),
//   users (anon per_page=100, auth per_page=1), comments (auth status=approve|hold&per_page=1),
//   plugins, settings, themes,
//   menu-locations, the `wp-json/` and `?rest_route=/` fallbacks, robots.txt,
//   every sitemap reachable from the usual entry points, and up to 30 HTML
//   pages (the home page by HEAD and GET, then up to 3 per type round-robin).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plainBody } from "./plain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../fixtures");
const stagingDir = join(fixturesDir, ".staging");
const RECORDER = "wpm-recorder";

const compose = [
	"compose", "-p", process.env.WPM_RECORD_PROJECT ?? "wpm-record",
	"--env-file", join(here, "versions.env"), "-f", join(here, "compose.yaml"),
];

const SITES = [
	{ name: "blog", port: Number(process.env.WPM_BLOG_PORT ?? 4601), base: "/", seed: "seed-blog.sh", cli: "cli-blog" },
	{ name: "business", port: Number(process.env.WPM_BUSINESS_PORT ?? 4602), base: "/site/", seed: "seed-business.sh", cli: "cli-business" },
	{ name: "builder", port: Number(process.env.WPM_BUILDER_PORT ?? 4603), base: "/", seed: "seed-builder.sh", cli: "cli-builder" },
];
for (const s of SITES) s.origin = `http://localhost:${s.port}`;

const SKIP_TYPES = new Set(["wp_template", "wp_template_part", "wp_global_styles", "wp_font_family", "wp_font_face"]);
const DROP_HEADERS = new Set(["set-cookie", "authorization", "x-wp-nonce", "content-encoding", "content-length",
	"transfer-encoding", "connection", "keep-alive"]);
const NONCE_RE = /((?:_wp)?nonce[A-Za-z_-]*(?:\\?["'])?\s*(?:=>|[:=])\s*(?:\\?["'])?)([0-9a-f]{10})(?![0-9a-f])/gi;
const HTML_CAP = 30;
const PAGE_CAP = 50;

function dc(args, { capture = false } = {}) {
	const r = spawnSync("docker", [...compose, ...args], {
		encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
	});
	if (r.status !== 0) throw new Error(`docker ${args.slice(0, 6).join(" ")} failed:\n${(r.stderr ?? "").slice(-2000)}`);
	return r.stdout ?? "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url) {
	for (let i = 0; i < 90; i++) {
		try {
			const r = await fetch(url, { redirect: "manual" });
			if (r.status < 500) return;
		} catch {}
		await sleep(2000);
	}
	throw new Error(`${url} did not come up`);
}

class Recorder {
	constructor(origin, password) {
		this.origin = origin;
		this.authHeader = "Basic " + Buffer.from(`${RECORDER}:${password}`).toString("base64");
		this.entries = new Map();
		this.bodies = new Map();
	}

	// Record one request (and same-origin redirect targets). Returns the entry plus its text.
	async get(path, { method = "GET", auth = false } = {}) {
		const key = `${method} ${path} ${auth}`;
		if (this.entries.has(key)) return { ...this.entries.get(key), text: this.bodies.get(key) };
		let res;
		for (let attempt = 0; ; attempt++) {
			try {
				res = await fetch(this.origin + path, {
					method, redirect: "manual", headers: auth ? { authorization: this.authHeader } : {},
				});
				break;
			} catch (e) {
				if (attempt >= 2) throw new Error(`${method} ${path}: ${e.cause?.code ?? e.message}`);
				await sleep(1000);
			}
		}
		const raw = method === "HEAD" ? "" : await res.text();
		const text = plainBody(raw.replace(NONCE_RE, (_m, pre, v) => pre + "x".repeat(v.length)));
		const headers = {};
		for (const [k, v] of res.headers) if (!DROP_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
		const body = `bodies/${createHash("sha1").update(key).digest("hex")}.txt`;
		const entry = { method, path, auth, status: res.status, headers, body };
		this.entries.set(key, entry);
		this.bodies.set(key, text);
		if (res.status >= 300 && res.status < 400 && headers.location) {
			const to = new URL(headers.location, this.origin + path);
			if (to.origin === this.origin) {
				await this.get(to.pathname + to.search, { method });
				if (auth) await this.get(to.pathname + to.search, { method, auth });
			}
		}
		return { ...entry, text };
	}

	async json(path, opts) {
		const r = await this.get(path, opts);
		if (r.status !== 200) return null;
		try { return JSON.parse(r.text); } catch { return null; }
	}

	write(dir, extra = {}) {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(dir, "bodies"), { recursive: true });
		const entries = [...this.entries.values()].sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : a.method.localeCompare(b.method) || Number(a.auth) - Number(b.auth));
		for (const [key, text] of this.bodies) writeFileSync(join(dir, this.entries.get(key).body), text);
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ origin: this.origin, ...extra, entries }, null, "\t") + "\n");
		return entries.length;
	}
}

// Build REST paths for a root that is either "/x/wp-json/" or "/x/index.php?rest_route=/".
function restPaths(rootPath) {
	const q = rootPath.indexOf("?rest_route=");
	if (q >= 0) {
		const prefix = rootPath.slice(0, q) + "?rest_route=";
		return (route, query = "") => prefix + route + (query ? "&" + query : "");
	}
	const prefix = rootPath.replace(/\/$/, "");
	return (route, query = "") => prefix + route + (query ? "?" + query : "");
}

async function pageAll(rec, route, query, auth) {
	const first = await rec.get(route(query), { auth });
	const total = Math.min(Number(first.headers["x-wp-totalpages"] ?? 1) || 1, PAGE_CAP);
	const pages = [first];
	for (let n = 1; n <= total; n++) pages.push(await rec.get(route(`${query}&page=${n}`), { auth }));
	return pages;
}

async function crawlRest(rec, root, links) {
	const r = restPaths(root);
	await rec.get(r("/"));
	await rec.get(r("/"), { auth: true });
	await rec.get(r("/wp/v2"));
	for (const what of ["types", "taxonomies"]) {
		await rec.get(r(`/wp/v2/${what}`));
		await rec.get(r(`/wp/v2/${what}`), { auth: true });
		await rec.get(r(`/wp/v2/${what}`, "context=edit"), { auth: true });
	}
	const types = (await rec.json(r("/wp/v2/types"), { auth: true })) ?? (await rec.json(r("/wp/v2/types"))) ?? {};
	const taxes = (await rec.json(r("/wp/v2/taxonomies"), { auth: true })) ?? (await rec.json(r("/wp/v2/taxonomies"))) ?? {};

	const addLinks = (group, pages) => {
		const first = pages[0];
		if (first.status !== 200) return;
		let list;
		try { list = JSON.parse(first.text); } catch { return; }
		if (!Array.isArray(list)) return;
		const urls = list.map((x) => x.link).filter((l) => typeof l === "string").slice(0, 3);
		if (urls.length) links.set(`rest:${group}`, [...(links.get(`rest:${group}`) ?? []), ...urls]);
	};

	for (const [slug, t] of Object.entries(types)) {
		if (SKIP_TYPES.has(slug) || !t.rest_base || (t.rest_namespace ?? "wp/v2") !== "wp/v2") continue;
		const route = (q) => r(`/wp/v2/${t.rest_base}`, q);
		const anon = await pageAll(rec, route, "per_page=100", false);
		if (slug !== "attachment" && slug !== "nav_menu_item") addLinks(slug, anon);
		await pageAll(rec, route, "context=edit&status=any&per_page=100", true);
		// Media rejects status=any (400); record the edit list without it as well.
		if (slug === "attachment") await pageAll(rec, route, "context=edit&per_page=100", true);
	}
	for (const [slug, t] of Object.entries(taxes)) {
		if (!t.rest_base || (t.rest_namespace ?? "wp/v2") !== "wp/v2") continue;
		const route = (q) => r(`/wp/v2/${t.rest_base}`, q);
		const anon = await pageAll(rec, route, "per_page=100", false);
		if (slug !== "nav_menu") addLinks(slug, anon);
		await pageAll(rec, route, "context=edit&per_page=100", true);
	}
	for (const base of ["comments", "menus", "menu-items"]) {
		const route = (q) => r(`/wp/v2/${base}`, q);
		await pageAll(rec, route, "per_page=100", false);
		await pageAll(rec, route, "per_page=100", true);
		await pageAll(rec, route, "context=edit&per_page=100", true);
	}
	await pageAll(rec, (q) => r("/wp/v2/users", q), "per_page=100", false);
	await rec.get(r("/wp/v2/users", "per_page=1"));
	await rec.get(r("/wp/v2/users", "per_page=1"), { auth: true });
	// Level 3 comment totals: approved and waiting (the X-WP-Total header only).
	await rec.get(r("/wp/v2/comments", "status=approve&per_page=1"), { auth: true });
	await rec.get(r("/wp/v2/comments", "status=hold&per_page=1"), { auth: true });
	for (const route of ["/wp/v2/plugins", "/wp/v2/settings", "/wp/v2/themes", "/wp/v2/menu-locations"]) {
		await rec.get(r(route));
		await rec.get(r(route), { auth: true });
	}
	await rec.get(r("/wp/v2/themes", "status=active"));
	await rec.get(r("/wp/v2/themes", "status=active"), { auth: true });
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#0?38;/g, "&").trim();

async function crawlSitemaps(rec, site, links) {
	const b = site.base;
	const robots = [await rec.get("/robots.txt")];
	if (b !== "/") robots.push(await rec.get(`${b}robots.txt`));
	const queue = [`${b}wp-sitemap.xml`, `${b}sitemap_index.xml`, `${b}sitemap.xml`, `${b}?sitemap=index`];
	for (const r of robots) {
		if (r.status !== 200) continue;
		for (const m of r.text.matchAll(/^sitemap:\s*(\S+)/gim)) queue.push(m[1]);
	}
	const seen = new Set();
	while (queue.length) {
		const next = queue.shift();
		const u = new URL(decode(next), site.origin);
		if (u.origin !== site.origin) continue;
		const path = u.pathname + u.search;
		if (seen.has(path)) continue;
		seen.add(path);
		let res = await rec.get(path);
		for (let hops = 0; res.status >= 300 && res.status < 400 && res.headers.location && hops < 5; hops++) {
			const to = new URL(res.headers.location, site.origin + path);
			if (to.origin !== site.origin) break;
			res = await rec.get(to.pathname + to.search);
		}
		if (res.status !== 200) continue;
		const locs = [...res.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/g)].map((m) => decode(m[1]));
		if (/<sitemapindex/i.test(res.text)) queue.push(...locs);
		else if (/<urlset/i.test(res.text) && locs.length) links.set(`sitemap:${path}`, locs.slice(0, 3));
	}
}

async function crawlHtml(rec, site, links) {
	const home = site.base;
	await rec.get(home, { method: "HEAD" });
	await rec.get(home);
	if (home !== "/") {
		await rec.get(home.replace(/\/$/, ""));
		await rec.get("/");
	}
	const picked = new Set([site.origin + home]);
	const groups = [...links.values()].map((l) => [...l]);
	while (picked.size < HTML_CAP && groups.some((g) => g.length)) {
		for (const g of groups) {
			if (picked.size >= HTML_CAP) break;
			const next = g.shift();
			if (!next) continue;
			const u = new URL(next, site.origin);
			if (u.origin !== site.origin || picked.has(u.href)) continue;
			picked.add(u.href);
			await rec.get(u.pathname + u.search);
		}
	}
	return picked.size;
}

async function recordSite(site, password) {
	const rec = new Recorder(site.origin, password);
	const links = new Map();
	// Discovery: the Link header (HEAD and GET of the home page), then fallbacks.
	const head = await rec.get(site.base, { method: "HEAD" });
	const m = /<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/.exec(head.headers.link ?? "");
	const roots = new Set();
	if (m) {
		const u = new URL(m[1]);
		roots.add(u.pathname + u.search);
	}
	await rec.get(`${site.base}wp-json/`);
	await rec.get(`${site.base}?rest_route=/`);
	await rec.get(`${site.base}wp-json/`, { auth: true });
	await rec.get(`${site.base}?rest_route=/`, { auth: true });
	// With plain permalinks the advertised root is index.php?rest_route=/; record the short form too.
	for (const root of [...roots]) if (root.includes("?rest_route=")) roots.add(`${site.base}?rest_route=/`);
	if (!roots.size) roots.add(`${site.base}wp-json/`);
	for (const root of roots) await crawlRest(rec, root, links);
	await crawlSitemaps(rec, site, links);
	const html = await crawlHtml(rec, site, links);
	return { rec, html };
}

function scanForSecrets(dir, secrets) {
	const needles = [];
	for (const s of secrets) needles.push(s, encodeURIComponent(s), Buffer.from(s).toString("base64").replace(/=+$/, ""));
	for (const pw of secrets.slice(1)) needles.push(Buffer.from(`${RECORDER}:${pw}`).toString("base64").replace(/=+$/, ""));
	const hits = [];
	const walk = (d) => {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) { walk(p); continue; }
			const text = readFileSync(p, "utf8");
			for (const n of needles) if (n && text.includes(n)) hits.push(`${p.slice(fixturesDir.length + 1)}: ${n === secrets[0] ? "recorder login" : "secret"}`);
		}
	};
	walk(dir);
	if (hits.length) throw new Error("secrets reached the fixtures:\n" + [...new Set(hits)].slice(0, 20).join("\n"));
}

function exportWxr(site) {
	const out = dc(["run", "--rm", "-T", site.cli, "wp", "export", "--stdout", "--quiet"], { capture: true });
	const start = out.indexOf("<?xml");
	if (start < 0) throw new Error(`${site.name}: wp export gave no XML`);
	return out.slice(start);
}

async function main() {
	const passwords = new Map();
	let revoked = false;
	const revoke = () => {
		for (const site of SITES) {
			if (!passwords.has(site.name)) continue;
			dc(["run", "--rm", "-T", site.cli, "wp", "user", "application-password", "delete", RECORDER, "--all", "--quiet"]);
		}
		revoked = true;
	};
	try {
		dc(["down", "-v", "--remove-orphans"]);
		dc(["up", "-d", "--quiet-pull", "db", "blog", "business", "builder"]);
		for (const site of SITES) await waitFor(site.origin + site.base);
		for (const site of SITES) {
			dc(["run", "--rm", "-T", "-e", `WPM_URL=${site.origin}${site.base.replace(/\/$/, "")}`, site.cli, "sh", `/seed/${site.seed}`]);
			const pw = dc(["run", "--rm", "-T", site.cli, "wp", "user", "application-password", "create", RECORDER,
				"wpm-move-record", "--porcelain"], { capture: true }).trim().split(/\s+/).pop();
			if (!pw || pw.length < 20) throw new Error(`${site.name}: no application password`);
			passwords.set(site.name, pw);
		}

		rmSync(stagingDir, { recursive: true, force: true });
		const summary = [];
		for (const site of SITES) {
			const { rec, html } = await recordSite(site, passwords.get(site.name));
			const n = rec.write(join(stagingDir, site.name));
			writeFileSync(join(stagingDir, site.name, "export.xml"), exportWxr(site));
			summary.push(`${site.name}: ${n} entries, ${html} HTML pages`);
		}
		const blog = SITES[0];
		dc(["run", "--rm", "-T", blog.cli, "sh", "-c",
			"mkdir -p wp-content/mu-plugins && cp /seed/mu-plugins/rest-off.php wp-content/mu-plugins/"]);
		{
			const { rec, html } = await recordSite(blog, passwords.get(blog.name));
			const n = rec.write(join(stagingDir, "blog-rest-off"));
			summary.push(`blog-rest-off: ${n} entries, ${html} HTML pages`);
		}

		revoke();
		scanForSecrets(stagingDir, [RECORDER, ...passwords.values()]);
		for (const name of ["blog", "business", "builder", "blog-rest-off"]) {
			rmSync(join(fixturesDir, name), { recursive: true, force: true });
			renameSync(join(stagingDir, name), join(fixturesDir, name));
		}
		console.log(summary.join("\n"));
	} finally {
		try { if (!revoked) revoke(); } catch {}
		// WPM_KEEP_STAGING=1 keeps a failed run's files in test/fixtures/.staging to look at (never commit them).
		if (!process.env.WPM_KEEP_STAGING) rmSync(stagingDir, { recursive: true, force: true });
		try { dc(["down", "-v", "--remove-orphans"]); }
		catch (e) { console.error(String(e)); process.exitCode = 1; }
	}
}

// Ctrl-C or a kill still tears the stack down.
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		try { dc(["down", "-v", "--remove-orphans"]); } catch {}
		rmSync(stagingDir, { recursive: true, force: true });
		process.exit(130);
	});
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exitCode = 1;
});
