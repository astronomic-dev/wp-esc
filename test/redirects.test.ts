import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Inventory, UrlEntry } from "../src/contracts/inventory.ts";
import type { Model } from "../src/contracts/model.ts";
import { propose } from "../src/model/index.ts";
import { planRedirects, settleGraph, toCsv, toCloudflare, writeRedirectPlan, type Row } from "../src/redirects/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = <T>(p: string): T => JSON.parse(readFileSync(root + p, "utf8")) as T;
const inventory = (name: string): Inventory => json<Inventory>(`test/samples/${name}.inventory.json`);
const businessModel = (): Model => json<Model>("test/samples/business.model.json");

const rowFor = (rows: Row[], old: string): Row => {
	const r = rows.find((x) => x.old === old);
	assert.ok(r, `no row for ${old}`);
	return r;
};
const plan = (name: string, target: "astro" | "emdash" = "astro", model?: Model) => {
	const inv = inventory(name);
	return planRedirects(inv, model ?? propose(inv), { target });
};

test("blog: date-style post URLs map to /blog/<slug>/", () => {
	const rows = plan("blog");
	assert.deepEqual(rowFor(rows, "/2026/03/up-the-north-ridge/"), { old: "/2026/03/up-the-north-ridge/", new: "/blog/up-the-north-ridge/", status: "301", kind: "post", note: "Post by slug." });
	assert.equal(rowFor(rows, "/2026/02/ten-days-on-the-coast/").new, "/blog/ten-days-on-the-coast/");
});

test("blog: dates, feeds, authors, attachments, paged and terms", () => {
	const rows = plan("blog");
	assert.equal(rowFor(rows, "/2026/03/").new, "/blog/");
	assert.equal(rowFor(rows, "/feed/").new, "/rss.xml");
	assert.equal(rowFor(rows, "/author/ruth/").new, "/author/ruth/");
	assert.equal(rowFor(rows, "/author/ruth/").status, "same");
	assert.equal(rowFor(rows, "/2026/03/up-the-north-ridge/ridge-view/").new, "/blog/up-the-north-ridge/");
	assert.equal(rowFor(rows, "/page/2/").new, "/blog/", "the old home listed posts, so its later pages go to the blog index");
	assert.equal(rowFor(rows, "/category/trips/coast/").new, "/category/trips/coast/");
	assert.equal(rowFor(rows, "/tag/gear/").status, "same");
	assert.equal(rowFor(rows, "/").status, "same");
});

test("?p= maps by ID", () => {
	const rows = plan("blog");
	const r = rowFor(rows, "/?p=118");
	assert.equal(r.new, "/blog/up-the-north-ridge/");
	assert.equal(r.status, "301");
	assert.equal(r.kind, "query");
});

test("?page_id= maps by ID, and query rows go to Cloudflare rules, not _redirects", () => {
	const rows = plan("business", "astro", businessModel());
	const r = rowFor(rows, "/site/?page_id=11");
	assert.equal(r.new, "/plans/pricing/");
	const cf = toCloudflare(rows, { origin: "https://example.com", host: "example.com" });
	assert.ok(!cf.redirects.includes("page_id"));
	const rules = JSON.parse(cf.rules) as { rules: { expression: string; action: string; action_parameters: { from_value: { status_code: number; target_url: { value: string }; preserve_query_string: boolean } } }[] };
	assert.equal(rules.rules.length, 1);
	const rule = rules.rules[0]!;
	assert.equal(rule.action, "redirect");
	assert.equal(rule.expression, 'http.host eq "example.com" and http.request.uri.path eq "/site/" and any(http.request.uri.args["page_id"][*] eq "11")');
	assert.deepEqual(rule.action_parameters.from_value, { status_code: 301, target_url: { value: "https://example.com/plans/pricing/" }, preserve_query_string: false });
});

test("model routes are matched through `from`, not the collection slug", () => {
	const rows = plan("business", "astro", businessModel());
	assert.equal(rowFor(rows, "/site/service/bookkeeping/").new, "/services/bookkeeping/");
	assert.equal(rowFor(rows, "/site/service/").new, "/services/");
	assert.equal(rowFor(rows, "/site/service-area/coastal/").new, "/services/area/coastal/");
	const team = rowFor(rows, "/site/team/dana-whitfield/");
	assert.equal(team.status, "review");
	assert.match(team.note, /no page/);
});

test("astro: the duplicate page slug maps to two different paths", () => {
	const rows = plan("business", "astro", businessModel());
	assert.equal(rowFor(rows, "/site/plans/pricing/").new, "/plans/pricing/");
	assert.equal(rowFor(rows, "/site/support/pricing/").new, "/support/pricing/");
	assert.equal(rowFor(rows, "/site/support/pricing/faq/").new, "/support/pricing/faq/");
});

test("emdash: child pages move to /<slug>, and duplicate slugs become review", () => {
	const rows = plan("business", "emdash", businessModel());
	assert.equal(rowFor(rows, "/site/support/pricing/faq/").new, "/faq");
	assert.equal(rowFor(rows, "/site/contact/").new, "/contact");
	assert.equal(rowFor(rows, "/site/service/payroll/").new, "/services/payroll");
	for (const old of ["/site/plans/pricing/", "/site/support/pricing/", "/site/?page_id=11"]) {
		const r = rowFor(rows, old);
		assert.equal(r.status, "review", old);
		assert.equal(r.new, "");
		assert.match(r.note, /\/pricing/);
	}
});

test("the multilingual sample keeps locale prefixes", () => {
	const rows = plan("multilingual");
	assert.equal(rowFor(rows, "/fr/pain-du-printemps/").new, "/fr/pain-du-printemps/");
	assert.equal(rowFor(rows, "/fr/a-propos/").new, "/fr/a-propos/");
	assert.equal(rowFor(rows, "/fr/category/pains/").new, "/fr/category/pains/");
	assert.equal(rowFor(rows, "/fr/").new, "/fr/");
	const em = plan("multilingual", "emdash");
	assert.equal(rowFor(em, "/fr/a-propos/").new, "/fr/a-propos");
	assert.equal(rowFor(em, "/about/").new, "/about");
});

test("plain-link sites: page_id with a known slug and custom-type queries map", () => {
	const rows = plan("builder");
	assert.equal(rowFor(rows, "/?page_id=5").new, "/services/");
	assert.equal(rowFor(rows, "/?portfolio=harbor-rebrand").new, "/portfolio/harbor-rebrand/");
});

test("unknown URLs become review with a plain reason", () => {
	const inv = inventory("blog");
	const extra: UrlEntry[] = [
		{ url: "https://blog.example.com/odd/thing/", kind: "other", source: ["html"], evidence: "linked" },
		{ url: "https://blog.example.com/?p=999", kind: "query", source: ["html"], evidence: "linked" },
		{ url: "https://blog.example.com/?s=boots", kind: "query", source: ["html"], evidence: "linked" },
		{ url: "https://blog.example.com/recipes/x/", kind: "custom", type: "recipe", id: 5, slug: "x", source: ["html"], evidence: "linked" },
		{ url: "https://blog.example.com/media/lost/", kind: "attachment", type: "attachment", id: 6, slug: "lost", source: ["html"], evidence: "linked" },
		{ url: "https://blog.example.com/nowhere/page/3/", kind: "paged", source: ["html"], evidence: "linked" },
	];
	inv.urls.push(...extra);
	const rows = planRedirects(inv, propose(inventory("blog")), { target: "astro" });
	for (const e of extra) {
		const old = e.url.replace("https://blog.example.com", "");
		const r = rowFor(rows, old);
		assert.equal(r.status, "review", old);
		assert.equal(r.new, "");
		assert.ok(r.note.length > 10, old);
	}
	assert.match(rowFor(rows, "/?p=999").note, /999/);
	assert.match(rowFor(rows, "/recipes/x/").note, /recipe/);
});

test("byte-stable: shuffled input gives the same bytes", () => {
	for (const name of ["blog", "business", "builder", "store", "multilingual"]) {
		for (const target of ["astro", "emdash"] as const) {
			const inv = inventory(name);
			const model = propose(inv);
			const a = planRedirects(inv, model, { target });
			const shuffled = structuredClone(inv);
			shuffled.urls.reverse();
			const m2 = structuredClone(model);
			m2.collections.reverse();
			m2.routes.reverse();
			m2.taxonomies.reverse();
			const b = planRedirects(shuffled, m2, { target });
			assert.equal(toCsv(b), toCsv(a));
			const ca = toCloudflare(a, { origin: "https://new.example.com", host: "old.example.com" });
			const cb = toCloudflare(b, { origin: "https://new.example.com", host: "old.example.com" });
			assert.deepEqual(cb, ca);
		}
	}
});

test("CSV escapes per RFC 4180", () => {
	const rows: Row[] = [{ old: '/a,"b"/', new: "/c/", status: "301", kind: "page", note: "line one\nline two" }];
	assert.equal(toCsv(rows), 'old,new,status,kind,note\r\n"/a,""b""/",/c/,301,page,"line one\nline two"\r\n');
});

test("hostile old-site text cannot break _redirects or the rules file", () => {
	const inv = inventory("blog");
	inv.urls.push(
		{ url: "https://blog.example.com/2026/01/bad slug\n/x 302/", kind: "post", type: "post", id: 300, slug: "bad slug\n/x 302", source: ["html"], evidence: "linked" },
		{ url: "https://blog.example.com/2026/01/star*/", kind: "post", type: "post", id: 301, slug: 'st"ar*', source: ["html"], evidence: "linked" },
		{ url: 'https://blog.example.com/?p=" or true or "', kind: "query", source: ["html"], evidence: "linked" },
		{ url: "https://blog.example.com/?p=300", kind: "query", type: "post", id: 300, source: ["html"], evidence: "linked" },
	);
	const rows = planRedirects(inv, propose(inventory("blog")), { target: "astro" });
	const cf = toCloudflare(rows, { origin: "https://blog.example.com", host: "blog.example.com" });
	for (const line of cf.redirects.split("\n").filter((l) => l && !l.startsWith("#"))) {
		assert.match(line, /^\/[^\s*:]* \/[^\s*:]* 301$/, line);
	}
	assert.ok(cf.redirects.includes("/2026/01/bad%20slug%0A/x%20302/ /blog/bad%20slug%0A%2Fx%20302/ 301"));
	const rules = JSON.parse(cf.rules) as { rules: { expression: string; action_parameters: { from_value: { target_url: { value: string } } } }[] };
	const star = rules.rules.find((r) => r.expression.includes("star"));
	assert.ok(star, "a path with * goes to the rules file");
	assert.equal(star.expression, 'http.host eq "blog.example.com" and http.request.uri.path eq "/2026/01/star*/"');
	assert.equal(star.action_parameters.from_value.target_url.value, "https://blog.example.com/blog/st%22ar%2A/");
	const bad = rowFor(rows, '/?p=" or true or "');
	assert.equal(bad.status, "review");
	assert.ok(!cf.rules.includes("or true"));
	assert.ok(rules.rules.some((r) => r.expression === 'http.host eq "blog.example.com" and http.request.uri.path eq "/" and any(http.request.uri.args["p"][*] eq "300")'));
	assert.ok(toCsv(rows).includes('"/2026/01/bad slug\n/x 302/"'));
});

test("_redirects splits and warns past 2,000 static rules; many query rules warn", () => {
	const rows: Row[] = [];
	for (let i = 0; i < 2005; i++) rows.push({ old: `/old/${String(i).padStart(4, "0")}/`, new: `/new/${i}/`, status: "301", kind: "post", note: "Post by slug." });
	for (let i = 0; i < 12; i++) rows.push({ old: `/?p=${i}`, new: `/new/${i}/`, status: "301", kind: "query", note: "Query by ID." });
	const cf = toCloudflare(rows, { origin: "https://x.example.com", host: "x.example.com" });
	assert.equal(cf.redirects.split("\n").filter((l) => l && !l.startsWith("#")).length, 2000);
	assert.equal(cf.overflow?.split("\n").filter(Boolean).length, 5);
	assert.ok(cf.warnings.some((w) => /2,000/.test(w) && /5/.test(w)));
	assert.ok(cf.warnings.some((w) => /12 Single Redirect rules/.test(w)));
	const small = toCloudflare(rows.slice(0, 3), { origin: "https://x.example.com", host: "x.example.com" });
	assert.equal(small.overflow, undefined);
	assert.deepEqual(small.warnings, []);
});

test("the CLI writes the files and a summary", () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-redirects-"));
	try {
		const bin = join(root, "bin/wp-redirect-plan.mjs");
		const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
		const args = ["--inventory", join(root, "test/samples/business.inventory.json"), "--model", join(root, "test/samples/business.model.json"), "--out", dir];
		const first = run(...args, "--target", "astro");
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stdout, /review/);
		assert.match(first.stdout, /cloudflare-rules\.json: 1 /);
		for (const f of ["redirects.csv", "_redirects", "cloudflare-rules.json"]) assert.ok(existsSync(join(dir, f)), f);
		const csv = readFileSync(join(dir, "redirects.csv"), "utf8");
		assert.equal(run(...args, "--target", "astro").status, 0);
		assert.equal(readFileSync(join(dir, "redirects.csv"), "utf8"), csv);
		const em = run(...args, "--target", "emdash");
		assert.equal(em.status, 0, em.stderr);
		assert.match(readFileSync(join(dir, "_redirects"), "utf8"), /\/site\/contact\/ \/contact 301/);
		const bad = run(...args, "--target", "wix");
		assert.equal(bad.status, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hostile paths and slugs cannot leave the site", () => {
	for (const target of ["astro", "emdash"] as const) {
		const inv = inventory("business");
		const bad: [string, string][] = [
			["/evil.example.com", "evil.example.com"],
			["//evil.example.com", "evil.example.com"],
			["a/../b", "b"],
			["a/./b", "b"],
			["%2e%2e/x", "x"],
			["a%2Fb", "a%2Fb"],
			["\\evil.example.com", "evil.example.com"],
			["ok", ".."],
			["ok", "%2E%2e"],
			["ok", "a\\b"],
		];
		bad.forEach(([path, slug], i) => {
			inv.urls.push({ url: `https://example.com/site/bad${i}/`, kind: "page", type: "page", id: 900 + i, slug, path, source: ["html"], evidence: "linked" });
		});
		const rows = planRedirects(inv, businessModel(), { target });
		bad.forEach((_, i) => {
			const r = rowFor(rows, `/site/bad${i}/`);
			assert.equal(r.status, "review", `${target} bad${i}: ${r.new}`);
			assert.equal(r.new, "");
		});
		for (const r of rows) if (r.new) assert.match(r.new, /^\/(?![\/\\])/, r.new);
	}
	const inv = inventory("business");
	const model = businessModel();
	model.collections.find((c) => c.from === "service")!.route = "//evil.example.com/{slug}/";
	const rows = planRedirects(inv, model, { target: "astro" });
	assert.equal(rowFor(rows, "/site/service/payroll/").status, "review");
	const cf = toCloudflare(rows, { origin: "https://example.com", host: "example.com" });
	assert.ok(!cf.redirects.includes("//evil"));
});

test("$& and $1 in slugs stay literal", () => {
	const inv = inventory("blog");
	inv.urls.push({ url: "https://blog.example.com/2026/01/a$&b$1/", kind: "post", type: "post", id: 500, slug: "a$&b$1", source: ["html"], evidence: "linked" });
	inv.urls.push({ url: "https://blog.example.com/x$&/", kind: "page", type: "page", id: 501, slug: "x$&", path: "y/x$&", source: ["html"], evidence: "linked" });
	const rows = planRedirects(inv, propose(inventory("blog")), { target: "astro" });
	assert.equal(rowFor(rows, "/2026/01/a$&b$1/").new, "/blog/a$&b$1/");
	assert.equal(rowFor(rows, "/x$&/").new, "/y/x$&/");
	const em = planRedirects(inv, propose(inventory("blog")), { target: "emdash" });
	assert.equal(rowFor(em, "/x$&/").new, "/x$&");
});

test("redirect graph: chains collapse to the final target; cycles and chains into review are review", () => {
	const r = (old: string, to: string, status: Row["status"] = "301"): Row => ({ old, new: to, status, kind: "page", note: "Page by path." });
	const rows = settleGraph([r("/a/", "/b/"), r("/b/", "/c/"), r("/c/", "/d/"), r("/x/", "/y/"), r("/y/", "/x/"), r("/p/", "/q/"), r("/q/", "", "review"), r("/s/", "/s/", "same"), r("/t/", "/s/")]);
	const by = (old: string) => rows.find((x) => x.old === old)!;
	assert.equal(by("/a/").new, "/d/");
	assert.match(by("/a/").note, /\/b\/.*\/c\//);
	assert.equal(by("/b/").new, "/d/");
	assert.equal(by("/c/").new, "/d/");
	for (const old of ["/x/", "/y/"]) {
		assert.equal(by(old).status, "review");
		assert.match(by(old).note, /loop/);
	}
	assert.equal(by("/p/").status, "review");
	assert.match(by("/p/").note, /\/q\//);
	assert.equal(by("/t/").new, "/s/");
	assert.equal(by("/t/").status, "301");
});

test("query rules match parsed args, so extra params still match", () => {
	const rows: Row[] = [{ old: "/?p=1&utm=x%22", new: "/n/", status: "301", kind: "query", note: "" }, { old: "/?amp", new: "/m/", status: "301", kind: "query", note: "" }];
	const cf = toCloudflare(rows, { origin: "https://x.example.com", host: "x.example.com" });
	const rules = JSON.parse(cf.rules).rules as { expression: string }[];
	assert.equal(rules[0]!.expression, 'http.host eq "x.example.com" and http.request.uri.path eq "/" and any(http.request.uri.args["p"][*] eq "1") and any(http.request.uri.args["utm"][*] eq "x%22")');
	assert.equal(rules[1]!.expression, 'http.host eq "x.example.com" and http.request.uri.path eq "/" and any(http.request.uri.args["amp"][*] eq "")');
});

test("post types EmDash names alike share one collection, and both redirect to its pattern", () => {
	const inv = inventory("business");
	const team = inv.types.find((t) => t.slug === "team")!;
	inv.types.push({ ...structuredClone(team), slug: "Team" });
	inv.urls.push({ url: "https://example.com/site/Team/sam-reyes/", kind: "custom", source: ["sitemap"], type: "Team", id: 99, slug: "sam-reyes", evidence: "listed" } as UrlEntry);
	const rows = planRedirects(inv, propose(inv), { target: "emdash" });
	assert.equal(rowFor(rows, "/site/Team/sam-reyes/").new, rowFor(rows, "/site/team/dana-whitfield/").new.replace("dana-whitfield", "sam-reyes"));
});

// --- Checkpoint K review fixes --------------------------------------------------------

const realBusiness = (): Inventory => json<Inventory>("test/samples/business.real.inventory.json");

test("?page_id= finds the front page and the posts page, listed as home and archive", () => {
	const inv = realBusiness();
	inv.urls.push(
		{ url: "http://localhost:4602/site/news/", kind: "archive", type: "post", id: 25, slug: "news", path: "news", source: ["html"], evidence: "resolved" },
		{ url: "http://localhost:4602/site/?page_id=25", kind: "query", type: "page", id: 25, source: ["rest"], evidence: "listed" },
	);
	for (const target of ["astro", "emdash"] as const) {
		const rows = planRedirects(inv, propose(inv), { target });
		assert.equal(rowFor(rows, "/site/?page_id=13").new, "/", target);
		assert.equal(rowFor(rows, "/site/?page_id=25").new, target === "emdash" ? "/news" : "/news/");
		assert.equal(rowFor(rows, "/site/?page_id=25").status, "301");
	}
});

test("the service archive linked from the menu gets a redirect", () => {
	const inv = realBusiness();
	const m = propose(inv);
	assert.equal(rowFor(planRedirects(inv, m, { target: "emdash" }), "/site/?post_type=service").new, "/services");
	// Listed in the ledger as a plain query URL, it maps the same way.
	inv.urls.push({ url: "http://localhost:4602/site/?post_type=service", kind: "query", source: ["html"], evidence: "linked" });
	assert.equal(rowFor(planRedirects(inv, m, { target: "emdash" }), "/site/?post_type=service").new, "/services");
	inv.menus[0]!.items.find((i) => i.target?.kind === "archive")!.url = "http://localhost:4602/site/services/";
	const m2 = propose(inv);
	assert.deepEqual(rowFor(planRedirects(inv, m2, { target: "emdash" }), "/site/services/"), { old: "/site/services/", new: "/services", status: "301", kind: "archive", note: "Post type archive. Not in the inventory: a menu links to this archive, so it gets a row too." });
	assert.equal(rowFor(planRedirects(inv, m2, { target: "astro" }), "/site/services/").new, "/services/");
});

test("one trailing-slash rule per target: none on emdash, the model's on astro", () => {
	const inv = realBusiness();
	const m = propose(inv);
	const emdash = planRedirects(inv, m, { target: "emdash" }).filter((r) => r.new);
	assert.deepEqual(emdash.filter((r) => r.new !== "/" && r.new.endsWith("/")).map((r) => r.new), []);
	assert.equal(rowFor(emdash, "/site/category/uncategorized/").new, "/category/uncategorized");
	const astro = planRedirects(inv, m, { target: "astro" }).filter((r) => r.new && r.new !== "/rss.xml");
	assert.deepEqual(astro.filter((r) => !r.new.endsWith("/")).map((r) => r.new), []);
});

test("--target astro keeps nested pages, and every file names its target", () => {
	const inv = realBusiness();
	const m = propose(inv);
	const astro = planRedirects(inv, m, { target: "astro" });
	assert.equal(rowFor(astro, "/site/company/about-us/history/").new, "/company/about-us/history/");
	assert.equal(rowFor(planRedirects(inv, m, { target: "emdash" }), "/site/company/about-us/history/").new, "/history");
	const cf = toCloudflare(astro, { origin: "https://example.com", host: "localhost:4602", target: "astro" });
	assert.match(cf.redirects, /^# wp-redirect-plan for the astro target/);
	assert.match(JSON.parse(cf.rules).rules[0].description, /\(astro target\)$/);
	const csv = toCsv(astro, "astro");
	assert.match(csv, /^old,new,status,kind,note,target\r\n/);
	assert.match(csv.split("\r\n")[1] ?? "", /,astro$/);
});

test("with no --target the CLI writes both plans, astro/ and emdash/", () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-redirects-both-"));
	try {
		const bin = join(root, "bin/wp-redirect-plan.mjs");
		const args = ["--inventory", join(root, "test/samples/business.inventory.json"), "--model", join(root, "test/samples/business.model.json"), "--out", dir];
		const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		for (const t of ["astro", "emdash"]) {
			for (const f of ["redirects.csv", "_redirects", "cloudflare-rules.json"]) assert.ok(existsSync(join(dir, t, f)), `${t}/${f}`);
			assert.match(readFileSync(join(dir, t, "_redirects"), "utf8"), new RegExp(`^# wp-redirect-plan for the ${t} target`));
			assert.match(r.stdout, new RegExp(`Wrote the ${t} plan to `));
		}
		assert.ok(!existsSync(join(dir, "redirects.csv")));
		const both = spawnSync(process.execPath, [bin, ...args, "--target", "both"], { encoding: "utf8" });
		assert.equal(both.status, 0, both.stderr);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the files and the summary say the query rules must run before _redirects", async () => {
	const rows: Row[] = [
		{ old: "/site/", new: "/", status: "301", kind: "home", note: "Home page." },
		{ old: "/site/?p=26", new: "/spring", status: "301", kind: "query", note: "Post by slug." },
	];
	const cf = toCloudflare(rows, { origin: "https://x.example.com", host: "x.example.com", target: "emdash" });
	assert.match(cf.redirects, /^# wp-redirect-plan for the emdash target[^\n]*\n# Cloudflare runs the Single Redirect rules in cloudflare-rules\.json before this file/);
	assert.ok(cf.redirects.includes("\n/site/ / 301\n"));
	const none = toCloudflare(rows.slice(0, 1), { origin: "https://x.example.com", host: "x.example.com" });
	assert.ok(!none.redirects.includes("Single Redirect"), "no rules, no order note");
	const dir = mkdtempSync(join(tmpdir(), "wpm-redirects-order-"));
	try {
		const inv = inventory("business");
		inv.urls.push({ url: "https://example.com/site/?page_id=916", kind: "query", type: "page", id: 916, slug: "pricing-plans", source: ["wxr"], evidence: "listed" });
		const { summary } = await writeRedirectPlan(inv, businessModel(), dir, { target: "emdash" });
		assert.ok(summary.some((l) => /^Order: Cloudflare runs the Single Redirect rules in cloudflare-rules\.json before _redirects/.test(l)), summary.join("\n"));
		assert.ok(summary.some((l) => /targeting \S+, the old site's address, since no --origin was given/.test(l)));
		const given = await writeRedirectPlan(inv, businessModel(), dir, { target: "emdash", origin: "https://new.example.com" });
		assert.ok(given.summary.some((l) => /targeting https:\/\/new\.example\.com\.$/.test(l)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a plain-permalink entry known only by its query URL: placed when it has a slug, else a clear review", () => {
	const inv = inventory("business");
	const model = businessModel();
	inv.urls.push({ url: "https://example.com/site/?page_id=916", kind: "query", type: "page", id: 916, slug: "pricing-plans", source: ["wxr"], evidence: "listed" });
	inv.urls.push({ url: "https://example.com/site/?page_id=917", kind: "query", type: "page", id: 917, source: ["wxr"], evidence: "listed" });
	const astro = planRedirects(inv, model, { target: "astro" });
	assert.equal(rowFor(astro, "/site/?page_id=916").new, "/pricing-plans/");
	const bare = rowFor(astro, "/site/?page_id=917");
	assert.equal(bare.status, "review");
	assert.match(bare.note, /only by its query URL, with no slug/);
});

test("end to end: a plain-permalink site's ?page_id= pages map by slug, from the WXR reader to both plans", async () => {
	const { readWxr } = await import("../src/sources/wxr/index.ts");
	const inv = await readWxr(join(root, "test/fixtures/builder/export.xml"));
	assert.equal(inv.permalinks.structure, "");
	const m = propose(inv);
	assert.equal(rowFor(planRedirects(inv, m, { target: "astro" }), "/?page_id=16").new, "/pricing/");
	const emdash = planRedirects(inv, m, { target: "emdash" });
	assert.equal(rowFor(emdash, "/?page_id=16").new, "/pricing");
	assert.equal(rowFor(emdash, "/?p=20").status, "301");
	// ?attachment_id= now carries a slug too; it is still an attachment page, not content.
	const att = emdash.find((r) => r.old.startsWith("/?attachment_id="));
	assert.ok(att);
	assert.match(att.note, /attachment page/i);
});

test("an empty term: review when it has no child terms; with children it redirects with a check note", () => {
	const inv = realBusiness();
	const m = propose(inv);
	const rows = planRedirects(inv, m, { target: "emdash" });
	const parent = rowFor(rows, "/site/service-area/emergency/");
	assert.equal(parent.status, "301", "emergency (0 own entries) has the child term same-day");
	assert.match(parent.note, /holds no entries of its own, only its child terms'/);
	inv.urls = inv.urls.filter((u) => u.slug !== "same-day");
	const alone = rowFor(planRedirects(inv, m, { target: "emdash" }), "/site/service-area/emergency/");
	assert.equal(alone.status, "review");
	assert.match(alone.note, /holds no entries of its own and has no child terms; check the page \/service-area\/emergency exists/);
	assert.equal(rowFor(planRedirects(inv, m, { target: "emdash" }), "/site/service-area/commercial/").status, "301", "a term with entries is unchanged");
});

test("?author=N: mapped like the author's /author/<slug>/ page", () => {
	const inv = inventory("blog");
	const site = inv.site.url.replace(/\/$/, "");
	inv.urls.push({ url: `${site}/?author=7`, kind: "query", source: ["rest"], slug: "ruth", evidence: "listed" } as UrlEntry);
	const model = propose(inv);
	const row = rowFor(planRedirects(inv, model, { target: "astro" }), "/?author=7");
	assert.equal(row.new, "/author/ruth/");
	assert.equal(row.status, "301");
	assert.match(row.note, /^Author page by slug\./);
	const noAuthor = { ...model, routes: model.routes.filter((r) => r.kind !== "author") };
	const home = rowFor(planRedirects(inv, noAuthor, { target: "astro" }), "/?author=7");
	assert.equal(home.new, "/");
	assert.match(home.note, /^No author pages on the new site; sent to the home page\./);
});
