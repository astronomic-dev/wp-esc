// The authenticated reader (level 3) on the recorded fixtures, through the replay door.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createReplayFetch, type Manifest } from "../src/http/replay.ts";
import { readAuth } from "../src/sources/auth/index.ts";
import { stringify } from "../src/contracts/write.ts";
import { merge } from "../src/contracts/merge.ts";
import { readWxr } from "../src/sources/wxr/index.ts";
import { readPublic } from "../src/sources/public/index.ts";
import { checkSchema } from "./helpers/check-schema.ts";
import type { SiteFetch } from "../src/contracts/fetch.ts";
import type { Inventory } from "../src/contracts/inventory.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/inventory.schema.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const SITES = {
	blog: { root: "/wp-json/", base: "/" },
	business: { root: "/site/wp-json/", base: "/site/" },
	builder: { root: "/index.php?rest_route=/", base: "/" },
} as const;

interface Run { inv: Inventory; paths: string[]; misses: string[] }

async function run(site: keyof typeof SITES, dir = `${fixtures}${site}`): Promise<Run> {
	const door = createReplayFetch(dir);
	const { root, base } = SITES[site];
	door.setApiRoot(door.origin + root);
	const paths: string[] = [];
	const logged: SiteFetch = (path, opts) => {
		paths.push(path + (opts?.query ? `?${new URLSearchParams(opts.query)}` : ""));
		return door(path, opts);
	};
	const inv = await readAuth(logged, { siteUrl: door.origin + base, apiRoot: door.origin + root });
	return { inv, paths, misses: door.misses };
}

const cache = new Map<string, Promise<Run>>();
const cached = (site: keyof typeof SITES): Promise<Run> => {
	if (!cache.has(site)) cache.set(site, run(site));
	return cache.get(site)!;
};

test("each site: fits the schema, level 3, every request was recorded, byte-stable", async () => {
	for (const site of Object.keys(SITES) as (keyof typeof SITES)[]) {
		const { inv, misses } = await cached(site);
		assert.deepEqual(checkSchema(schema, inv), [], site);
		assert.deepEqual(misses, [], site);
		assert.deepEqual(inv.levels, [3]);
		assert.equal(stringify("inventory", (await run(site)).inv), stringify("inventory", inv), site);
	}
});

test("business: the plugin list shows Secure Custom Fields, Contact Form 7 and Flamingo active", async () => {
	const { inv } = await cached("business");
	for (const slug of ["secure-custom-fields", "contact-form-7", "flamingo"]) {
		const p = inv.plugins.find((x) => x.slug === slug)!;
		assert.ok(p, slug);
		assert.deepEqual([p.active, p.source, p.confidence], [true, "auth", "high"], slug);
		assert.ok(p.version, slug);
	}
	assert.equal(inv.plugins.find((p) => p.slug === "flamingo")?.category, "form-storage");
	assert.ok(inv.storedElsewhere.some((s) => s.plugin === "flamingo"));
	assert.equal(inv.coverage.find((c) => c.area === "plugins")?.status, "complete");
});

test("business: settings, edit lists, menus, user count", async () => {
	const { inv } = await cached("business");
	assert.equal(inv.site.name, "Harbor Light Home Services");
	assert.equal(inv.site.tagline, "Repairs and upkeep for homes and shops");
	const service = inv.types.find((t) => t.slug === "service");
	assert.deepEqual([service?.count, service?.byStatus, service?.sources], [8, { publish: 8 }, ["auth"]]);
	assert.equal(inv.types.find((t) => t.slug === "page")?.count, 13);
	assert.ok(!inv.types.some((t) => t.slug === "attachment" || t.slug === "nav_menu_item" || t.slug === "wp_block"));
	assert.equal(inv.menus.length, 1);
	assert.deepEqual([inv.menus[0]?.id, inv.menus[0]?.name, inv.menus[0]?.source, inv.menus[0]?.items.length], [6, "Primary", "auth", 4]);
	const archive = inv.menus[0]?.items.find((i) => i.target?.kind === "archive");
	assert.deepEqual(archive?.target, { kind: "archive", type: "service" });
	assert.match(inv.coverage.find((c) => c.area === "users")?.detail ?? "", /2 user accounts/);
	assert.match(inv.coverage.find((c) => c.area === "users")?.detail ?? "", /authors count holds only people who wrote content/);
	const home = inv.urls.find((u) => u.kind === "home");
	assert.deepEqual([home?.url, home?.id], ["http://localhost:4602/site/", 13]);
	assert.ok(inv.blocks.some((b) => b.name === "core/paragraph"));
	assert.ok(inv.shortcodes.some((s) => s.name === "contact-form-7"));
});

test("blog: drafts and private posts come from the edit lists", async () => {
	const { inv } = await cached("blog");
	const post = inv.types.find((t) => t.slug === "post");
	assert.deepEqual([post?.count, post?.byStatus], [124, { publish: 120, draft: 3, private: 1 }]);
	assert.equal(inv.coverage.find((c) => c.area === "type:post")?.status, "complete");
});

test("builder: works with a ?rest_route= root", async () => {
	const { inv } = await cached("builder");
	assert.ok(inv.plugins.some((p) => p.slug === "elementor" && p.active));
	assert.ok(inv.shortcodes.some((s) => s.name === "pricing_table"));
	// Level 1 got a 401 on elementor_library; the password reads it, for a count only.
	const lib = inv.types.find((t) => t.slug === "elementor_library");
	assert.deepEqual([lib?.count, lib?.byStatus, lib?.fields], [1, { publish: 1 }, []]);
	assert.equal(inv.coverage.find((c) => c.area === "type:elementor_library")?.status, "complete");
	assert.equal(inv.types.find((t) => t.slug === "e-floating-buttons")?.count, 0);
	assert.ok(!inv.shortcodes.some((s) => s.samples.some((u) => /elementor_library/.test(u))));
});

test("settings are partial; the front page and posts page become URL entries", async () => {
	const business = (await cached("business")).inv;
	const line = business.coverage.find((c) => c.area === "settings");
	assert.equal(line?.status, "partial");
	assert.match(line?.detail ?? "", /front page and posts page only/);
	const archive = business.urls.find((u) => u.kind === "archive");
	assert.deepEqual([archive?.url, archive?.type, archive?.id], ["http://localhost:4602/site/news/", "post", 25]);
	// The blog's home page lists the latest posts: a home entry with no type.
	const blog = (await cached("blog")).inv;
	const home = blog.urls.find((u) => u.kind === "home");
	assert.deepEqual([home?.url, home?.type, home?.id], ["http://localhost:4601/", undefined, undefined]);
	assert.match(blog.coverage.find((c) => c.area === "settings")?.detail ?? "", /lists the latest posts/);
});

test("only the listed endpoints: never themes (an authenticated read writes to the site)", async () => {
	for (const site of Object.keys(SITES) as (keyof typeof SITES)[]) {
		const { paths } = await cached(site);
		assert.ok(paths.length > 5, site);
		for (const p of paths) {
			assert.doesNotMatch(p, /themes|menu-locations|wp\/v2\/users\/|global-styles/, `${site}: ${p}`);
			if (p.includes("comments")) assert.match(p, /comments.*status=(approve|hold)&per_page=1$/, `${site}: ${p}`);
			assert.match(p, /wp\/v2\/(types|plugins|settings|users\?|users$|menus|menu-items|[a-z_-]+)/, `${site}: ${p}`);
		}
		assert.ok(paths.some((p) => p.includes("users") && p.includes("per_page=1")), site);
		assert.ok(!paths.some((p) => p.includes("users") && !p.includes("per_page=1")), site);
	}
});

test("no user names, logins or emails in any output", async () => {
	for (const site of Object.keys(SITES) as (keyof typeof SITES)[]) {
		const text = stringify("inventory", (await cached(site)).inv);
		assert.doesNotMatch(text, /@example\.com|dana-whitlock|Dana Whitlock|theo-marsh|Theo Marsh|wpm-recorder|gravatar/i, site);
	}
});

test("a user who is not an administrator: clean coverage lines, the run goes on", async () => {
	const src = `${fixtures}business`;
	const dir = mkdtempSync(join(tmpdir(), "wpm-auth-"));
	try {
		const m = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as Manifest;
		mkdirSync(join(dir, "bodies"));
		const deny = (code: string, message: string): string => {
			const file = `bodies/${code}.txt`;
			writeFileSync(join(dir, file), JSON.stringify({ code, message, data: { status: 403 } }));
			return file;
		};
		const plugins = deny("rest_cannot_view_plugins", "Sorry, you are not allowed to manage plugins for this site.");
		const settings = deny("rest_forbidden", "Sorry, you are not allowed to do that.");
		m.entries = m.entries.map((e) => {
			const body = e.body === undefined ? undefined : pathToFileURL(join(src, e.body)).href;
			if (e.auth && e.path === "/site/wp-json/wp/v2/plugins") return { ...e, status: 403, body: plugins };
			if (e.auth && (e.path === "/site/wp-json/wp/v2/settings" || e.path.startsWith("/site/wp-json/wp/v2/users"))) return { ...e, status: 403, body: settings };
			return { ...e, body };
		});
		writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
		const { inv } = await run("business", dir);
		const line = (area: string) => inv.coverage.find((c) => c.area === area && c.source === "auth");
		assert.deepEqual([line("plugins")?.status, line("plugins")?.detail], ["failed", "This user cannot list plugins; an administrator can."]);
		assert.equal(line("settings")?.status, "failed");
		assert.match(line("settings")?.detail ?? "", /cannot read site settings; an administrator can/);
		assert.equal(line("users")?.status, "failed");
		assert.deepEqual(inv.plugins, []);
		assert.equal(inv.types.find((t) => t.slug === "service")?.count, 8, "the lists still ran");
		assert.equal(inv.site.name, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rejected password (401) says so", async () => {
	const unauthorized: SiteFetch = async (path) => ({ status: 401, headers: new Headers(), url: `http://localhost:4602${path}`, text: async () => '{"code":"incorrect_password"}' });
	const inv = await readAuth(unauthorized, { siteUrl: "http://localhost:4602/site/", apiRoot: "http://localhost:4602/site/wp-json/" });
	const plugins = inv.coverage.find((c) => c.area === "plugins");
	assert.equal(plugins?.status, "failed");
	assert.match(plugins?.detail ?? "", /did not accept the application password/);
	assert.deepEqual(checkSchema(schema, inv), []);
});

test("levels 2 and 3 merge: auth counts and plugins, WXR fields", async () => {
	const wxr = await readWxr(`${fixtures}business/export.xml`);
	const { inv } = await cached("business");
	const all = merge(wxr, inv);
	assert.deepEqual(all.levels, [2, 3]);
	const service = all.types.find((t) => t.slug === "service");
	assert.deepEqual(service?.sources, ["auth", "wxr"]);
	assert.ok(service?.fields.some((f) => f.key === "faq" && f.subfields?.length === 2));
	assert.equal(all.storedElsewhere.filter((s) => s.plugin === "flamingo").length, 0, "the messages are in the export");
	assert.deepEqual(inv.storedElsewhere.map((s) => s.plugin), ["flamingo"], "without the export they stay in WordPress");
	assert.deepEqual(all.menus.map((m) => [m.name, m.kind, m.items.length]).sort(), [["Primary", "block", 4], ["Primary", "classic", 4]]);
	assert.equal(all.types.find((t) => t.slug === "team")?.count, 5);
});

test("levels 1, 2 and 3 merge: each area keeps only its best coverage lines", async () => {
	const pubDoor = createReplayFetch(`${fixtures}business`);
	const pub = await readPublic(pubDoor, `${pubDoor.origin}/site/`);
	const wxr = await readWxr(`${fixtures}business/export.xml`);
	const { inv } = await cached("business");
	const all = merge(pub, wxr, inv);
	const lines = (area: string) => all.coverage.filter((c) => c.area === area);
	assert.deepEqual(lines("type:team").map((c) => [c.source, c.status]), [["wxr", "complete"]], "the export answered team");
	assert.ok(!all.coverage.some((c) => /no count or field data|need level 3|needs level 3|not read at level 1/.test(c.detail)), "no stale level notes");
	for (const area of ["plugins", "users", "type:page", "type:post", "type:service", "type:flamingo_inbound"]) {
		assert.ok(lines(area).length > 0 && lines(area).every((c) => c.status === "complete"), area);
	}
	assert.equal(lines("settings")[0]?.status, "partial");
	const areas = all.coverage.map((c) => c.area);
	assert.deepEqual(areas, [...new Set(areas)], "one line per area");
	assert.deepEqual(lines("type:page").map((c) => c.source), ["auth"]);
	assert.match(lines("type:page")[0]?.detail ?? "", /with the password.* in the export/);
	// A block theme with both kinds of menu: the line names both.
	assert.equal(lines("menus")[0]?.status, "partial");
	assert.match(lines("menus")[0]?.detail ?? "", /There are two kinds of menu: the classic menu "Primary" and the Navigation block "Primary"\. If the theme's header uses a Navigation block, the header shows that one, so check the live header\./);
	assert.deepEqual(checkSchema(schema, all), []);
});

async function threeLevels(site: keyof typeof SITES): Promise<Inventory> {
	const pubDoor = createReplayFetch(`${fixtures}${site}`);
	const pub = await readPublic(pubDoor, `${pubDoor.origin}${SITES[site].base}`);
	const wxr = await readWxr(`${fixtures}${site}/export.xml`);
	return merge(pub, wxr, (await cached(site)).inv);
}

test("builder, levels 1, 2 and 3: types level 1 could not read are read; no stale notes; kinds stay", async () => {
	const all = await threeLevels("builder");
	const lines = (area: string) => all.coverage.filter((c) => c.area === area);
	assert.deepEqual(lines("type:elementor_library").map((c) => c.status), ["complete"], "the 401 line is cleared");
	assert.equal(all.types.find((t) => t.slug === "elementor_library")?.count, 1);
	assert.deepEqual(lines("type:e-floating-buttons").map((c) => [c.source, c.status]), [["auth", "complete"]]);
	assert.ok(!all.coverage.some((c) => /level 3/.test(c.detail)), "no level 3 notes in a level 3 run");
	assert.equal(all.types.find((t) => t.slug === "wpcf7_contact_form")?.count, 1);
	// URL kinds do not change between levels: plain links stay page, post, attachment.
	const at = (url: string) => all.urls.find((u) => u.url === `http://localhost:4603/${url}`);
	assert.deepEqual([at("?page_id=13")?.kind, at("?p=20")?.kind, at("?attachment_id=6")?.kind], ["page", "post", "attachment"]);
	assert.deepEqual([at("")?.kind, at("")?.id], ["home", 12]);
	assert.deepEqual([at("?page_id=12")?.kind, at("?page_id=12")?.id], ["query", 12], "the query form stays its own entry, on the same id");
	assert.equal(at("?attachment_id=6")?.file, "http://localhost:4603/wp-content/uploads/2026/11/studio-work-1.png");
	// Usage counts are distinct items: the export saw pricing_table on 4 pages.
	const pricing = all.shortcodes.find((s) => s.name === "pricing_table");
	assert.equal(pricing?.count, 4);
	assert.ok((pricing?.count ?? 0) >= (pricing?.samples.length ?? 0));
	assert.deepEqual(checkSchema(schema, all), []);
});

test("blog, levels 1, 2 and 3: fields the export does not hold are empty, with the export's total", async () => {
	const all = await threeLevels("blog");
	const field = (type: string, key: string) => all.types.find((t) => t.slug === type)?.fields.find((f) => f.key === key);
	const footnotes = field("post", "footnotes");
	assert.deepEqual([footnotes?.filled, footnotes?.total, footnotes?.source], [0, 124, "wxr"]);
	assert.ok(all.types.find((t) => t.slug === "post")?.fields.every((f) => f.total === 124), "every post field has one total");
	const desc = field("page", "_yoast_wpseo_metadesc");
	assert.deepEqual([desc?.filled, desc?.total, desc?.source], [0, 3, "wxr"]);
	assert.match(desc?.note ?? "", /export has no value/);
	assert.deepEqual([field("page", "post_excerpt")?.filled, field("page", "post_excerpt")?.source], [0, "wxr"]);
	assert.deepEqual([field("post", "_yoast_wpseo_focuskw")?.filled, field("post", "_yoast_wpseo_focuskw")?.total], [31, 124]);
	const photo = all.urls.find((u) => u.url === "http://localhost:4601/kitchen-photo-2/");
	assert.deepEqual([photo?.kind, photo?.parentId], ["attachment", 19]);
	assert.equal(all.urls.find((u) => u.url === "http://localhost:4601/")?.kind, "home");
});

test("the level 3 revoke reminder also says to unset the variables", () => {
	const bin = readFileSync(fileURLToPath(new URL("../bin/wp-inventory.mjs", import.meta.url)), "utf8");
	assert.match(bin, /Revoke it now: Users > Profile > Application Passwords > Revoke\. Then run: unset WPM_WP_USER WPM_WP_APP_PASSWORD/);
});
