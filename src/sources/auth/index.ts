// Level 3: what an application password adds. Every request is a GET with `auth: true`
// under the API root's wp/v2 namespace; the door sends the header nowhere else.
//
// Requests made, relative to the API root <r> (recorders must match), and nothing else:
//   GET <r>wp/v2/types                                    rest bases of the post types
//   GET <r>wp/v2/<rest_base>?context=edit&status=any&per_page=100&page=N   drafts, private posts, raw content
//   GET <r>wp/v2/plugins                                  needs activate_plugins
//   GET <r>wp/v2/settings                                 needs manage_options
//   GET <r>wp/v2/users?per_page=1                         the X-WP-Total header only
//   GET <r>wp/v2/comments?status=approve&per_page=1       the X-WP-Total header only
//   GET <r>wp/v2/comments?status=hold&per_page=1          the X-WP-Total header only (comments that wait for approval)
//   GET <r>wp/v2/menus?context=edit&per_page=100&page=N   WordPress 5.9+, needs edit_theme_options
//   GET <r>wp/v2/menu-items?context=edit&per_page=100&page=N
// Never /wp/v2/themes: an authenticated read of it writes a wp_global_styles post.
//
// Kept: plugin slugs, names, versions and status; the site title and tagline; the front
// page and posts page (as home and archive URL entries); counts by status; shortcodes and
// blocks from raw content; menus, and Navigation blocks from wp_navigation posts (see
// ../wxr/navigation.ts); the titles of drafts, private and pending items (at most
// MAX_UNPUBLISHED_PER_TYPE per type); comment counts. Plugin and site data types (INTERNAL_TYPES, for example
// elementor_library, which level 1 cannot read) are counted by status, never scanned.
// Never kept: user names, logins or emails (the users and comments bodies are not read), and other settings.
// On 401 or 403 an area gets coverage `failed` with a plain reason, and the run goes on.

import type { SiteFetch } from "../../contracts/fetch.ts";
import type { ContentType, Coverage, Inventory, Menu, MenuItem, Plugin, UrlEntry, UrlKind } from "../../contracts/inventory.ts";
import { canonical } from "../../contracts/write.ts";
import { PLUGINS } from "../public/plugins-map.ts";
import { SKIP_TYPES, routePath, soft } from "../public/rest.ts";
import { UsageCounter, scanContent } from "../wxr/content.ts";
import { UNPUBLISHED_STATUSES, navNote, pendingNote } from "../wxr/index.ts";
import { blockMenu, type NavPage } from "../wxr/navigation.ts";
import { MAX_UNPUBLISHED_PER_TYPE, newBudget, spendBytes, spendItems, type ListBudget } from "../limits.ts";

export interface AuthOptions {
	/** The site's address, with its base path. */
	siteUrl: string;
	/** The discovered API root, absolute (for example https://example.com/wp-json/ or https://example.com/?rest_route=/). */
	apiRoot: string;
	/** The most items all edit lists read together (default 200,000). */
	maxListItems?: number;
	/** The most bytes all edit list pages read together (default 512 MB). */
	maxListBytes?: number;
}

/** Types a plugin or the site owns: not content. Their lists are read for a count only. */
const INTERNAL_TYPES = new Set(["elementor_library", "e-floating-buttons", "e-landing-page", "wpcf7_contact_form", "flamingo_contact", "flamingo_inbound", "flamingo_outbound", "wp_navigation"]);
const PER_PAGE = "100";
const MAX_PAGES = 1000;

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const raw = (v: unknown): string => (v && typeof v === "object" ? (str((v as Json).raw) ?? str((v as Json).rendered) ?? "") : (str(v) ?? ""));
const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

interface Got { status: number; json?: unknown; headers?: Headers; error?: string; capped?: string }

async function get(fetch: SiteFetch, path: string, query?: Record<string, string>, budget?: ListBudget): Promise<Got> {
	try {
		const res = await fetch(path, query ? { auth: true, query } : { auth: true });
		if (res.status !== 200) return { status: res.status, headers: res.headers };
		const text = await res.text();
		const capped = budget ? spendBytes(budget, Buffer.byteLength(text)) : undefined;
		if (capped) return { status: 200, headers: res.headers, capped };
		try {
			return { status: 200, json: JSON.parse(text), headers: res.headers };
		} catch {
			return { status: 200, headers: res.headers, error: "the answer was not JSON" };
		}
	} catch (e) {
		if (soft(e)) return { status: 0, error: e.message };
		throw e;
	}
}

/** The plain reason a request failed. `need` names who has the right, `what` the action. */
function reason(r: Got, what: string, need: string): string {
	if (r.status === 401) return `The site did not accept the application password when asked to ${what}. Check the user name and password.`;
	if (r.status === 403) return `This user cannot ${what}; ${need} can.`;
	if (r.status === 404) return `The site has no endpoint to ${what} (it may be older than WordPress 5.9, or the REST API is limited).`;
	if (r.error) return `Could not ${what}: ${r.error}.`;
	return `Could not ${what}: the site answered ${r.status}.`;
}

/** count: items handed to `onPage`; each page is dropped after it, so only what the caller keeps stays. */
interface Listed { count: number; ok: boolean; first: Got; detail?: string }

async function pageAll(fetch: SiteFetch, path: string, query: Record<string, string>, budget: ListBudget, onPage: (items: Json[]) => void): Promise<Listed> {
	let count = 0;
	let pages = 1;
	let first: Got | undefined;
	for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
		const r = await get(fetch, path, { ...query, per_page: PER_PAGE, page: String(page) }, budget);
		if (!first) first = r;
		if (r.capped) return { count, ok: false, first, detail: `stopped at page ${page} of ${pages}: ${r.capped}` };
		if (r.status !== 200 || !Array.isArray(r.json)) {
			return { count, ok: false, first, detail: page > 1 ? `stopped at page ${page} of ${pages}` : undefined };
		}
		if (page === 1) {
			const tp = Number(r.headers?.get("x-wp-totalpages"));
			pages = Number.isFinite(tp) && tp >= 1 ? tp : 1;
		}
		const got = r.json as Json[];
		const { take, reason } = spendItems(budget, got.length);
		onPage(take < got.length ? got.slice(0, take) : got);
		count += take;
		if (reason) return { count, ok: false, first, detail: `stopped at page ${page} of ${pages}: ${reason}` };
	}
	if (pages > MAX_PAGES) return { count, ok: false, first: first as Got, detail: `more than ${MAX_PAGES} pages` };
	return { count, ok: true, first: first as Got };
}

/** The X-WP-Total header of a one-item list; the body is never read. */
async function totalOf(fetch: SiteFetch, path: string, query: Record<string, string>): Promise<Got & { total?: number }> {
	try {
		const res = await fetch(path, { auth: true, query: { ...query, per_page: "1" } });
		const header = res.headers.get("x-wp-total");
		const total = Number(header);
		if (res.status === 200 && header !== null && Number.isInteger(total) && total >= 0) return { status: 200, headers: res.headers, total };
		return { status: res.status, headers: res.headers };
	} catch (e) {
		if (soft(e)) return { status: 0, error: e.message };
		throw e;
	}
}

const pluginSlug = (file: string): string => {
	const slash = file.indexOf("/");
	return slash === -1 ? file.replace(/\.php$/, "") : file.slice(0, slash);
};

function kindOf(type: string): UrlKind {
	return type === "post" ? "post" : type === "page" ? "page" : "custom";
}

export async function readAuth(fetch: SiteFetch, opts: AuthOptions): Promise<Inventory> {
	const root = new URL(opts.apiRoot);
	const route = (r: string): string => routePath(root, r);
	const coverage: Coverage[] = [];
	const cover = (area: string, status: Coverage["status"], detail: string): void => {
		coverage.push({ area, source: "auth", status, detail });
	};
	const types: ContentType[] = [];
	const shortcodes = new UsageCounter();
	const blocks = new UsageCounter();
	const pageLinks = new Map<number, string>();
	const pages: NavPage[] = [];
	const navPosts: { title: string; content: string }[] = [];
	const site: Inventory["site"] = { url: opts.siteUrl, apiRoot: opts.apiRoot, locales: [] };
	const urls: UrlEntry[] = [];
	const budget = newBudget(opts);

	// Post types, then each list in edit context.
	const t = await get(fetch, route("/wp/v2/types"));
	if (t.status === 200 && t.json && typeof t.json === "object") {
		for (const [slug, info] of Object.entries(t.json as Record<string, Json>)) {
			const base = str(info.rest_base);
			const internal = INTERNAL_TYPES.has(slug);
			if (!base || (SKIP_TYPES.has(slug) && !internal) || (str(info.rest_namespace) ?? "wp/v2") !== "wp/v2") continue;
			const byStatus: Record<string, number> = {};
			const unpublished: { title: string; status: string }[] = [];
			const list = await pageAll(fetch, route(`/wp/v2/${base}`), { context: "edit", status: "any" }, budget, (page) => {
				for (const item of page) {
					const status = str(item.status) ?? "unknown";
					byStatus[status] = (byStatus[status] ?? 0) + 1;
					if (slug === "wp_navigation" && status === "publish") navPosts.push({ title: raw(item.title), content: raw(item.content) });
					if (internal) continue;
					const published = status === "publish";
					if (UNPUBLISHED_STATUSES.has(status) && unpublished.length < MAX_UNPUBLISHED_PER_TYPE) unpublished.push({ title: raw(item.title).trim() || "(no title)", status });
					const link = published ? str(item.link) : undefined;
					const id = num(item.id);
					if (slug === "page" && id !== undefined && link) {
						pageLinks.set(id, link);
						pages.push({ id, title: raw(item.title), link, parent: num(item.parent) ?? 0, order: num(item.menu_order) ?? 0 });
					}
					const scan = scanContent(raw(item.content));
					shortcodes.add(scan.shortcodes, link);
					blocks.add(scan.blocks, link);
				}
			});
			if (!list.ok) {
				const why = list.detail ? `The ${slug} list ${list.detail}.` : reason(list.first, `read drafts and private ${slug} entries`, "an editor or administrator");
				cover(`type:${slug}`, list.count ? "partial" : "failed", list.count ? `${why} Read ${n(list.count, "entry", "entries")} before that; no count is given.` : why);
				if (!list.count) continue;
			}
			// A count and its split by status only when the list was read to the end; a partial
			// count would replace a complete one from the export when inventories merge.
			const type: ContentType = { slug, byStatus: list.ok ? byStatus : {}, restBase: base, inRest: true, fields: [], taxonomies: Array.isArray(info.taxonomies) ? (info.taxonomies as unknown[]).filter((x): x is string => typeof x === "string") : [], sources: ["auth"] };
			if (list.ok) type.count = list.count;
			if (list.ok && unpublished.length) type.unpublished = unpublished;
			const label = str(info.name);
			if (label) type.label = label;
			if (typeof info.hierarchical === "boolean") type.hierarchical = info.hierarchical;
			types.push(type);
			if (list.ok) cover(`type:${slug}`, "complete", `Read ${n(list.count, "entry", "entries")} with the password, drafts and private ones too.${internal ? " This is plugin or site data, not content; only the count is kept." : ""}`);
		}
		cover("rest", "complete", `Read ${n(types.length, "post type")} with the application password.`);
	} else {
		cover("rest", "failed", reason(t, "list the post types", "any logged-in user"));
	}

	// Plugins.
	const plugins: Plugin[] = [];
	const p = await get(fetch, route("/wp/v2/plugins"));
	if (p.status === 200 && Array.isArray(p.json)) {
		for (const item of p.json as Json[]) {
			const file = str(item.plugin);
			if (!file) continue;
			const slug = pluginSlug(file);
			const info = PLUGINS[slug];
			const plugin: Plugin = { slug, category: info?.category ?? "other", source: "auth", confidence: "high" };
			const name = info?.name ?? str(item.name);
			if (name) plugin.name = name;
			const version = str(item.version);
			if (version) plugin.version = version;
			const status = str(item.status);
			plugin.active = status === "active" || status === "network-active";
			plugins.push(plugin);
		}
		const active = plugins.filter((x) => x.active).length;
		cover("plugins", "complete", `Read the full plugin list: ${n(plugins.length, "plugin")}, ${active} active.`);
	} else {
		cover("plugins", "failed", reason(p, "list plugins", "an administrator"));
	}

	// Settings: the title, tagline, front page and posts page only.
	const s = await get(fetch, route("/wp/v2/settings"));
	if (s.status === 200 && s.json && typeof s.json === "object") {
		const set = s.json as Json;
		const title = str(set.title);
		const tagline = str(set.description);
		if (title) site.name = title;
		if (tagline) site.tagline = tagline;
		const front = num(set.page_on_front);
		const posts = num(set.page_for_posts);
		const shows = str(set.show_on_front);
		let homeIs = "";
		const postsPage = shows === "page" && posts && pageLinks.has(posts) ? posts : undefined;
		if (shows === "page" && front && pageLinks.has(front)) {
			urls.push({ url: pageLinks.get(front) as string, kind: "home", source: ["auth"], type: "page", id: front, evidence: "listed" });
			homeIs = postsPage ? ` The home page is page ${front}.` : ` No posts page is set; the home page is page ${front}.`;
		}
		if (postsPage) {
			urls.push({ url: pageLinks.get(postsPage) as string, kind: "archive", source: ["auth"], type: "post", id: postsPage, evidence: "listed" });
			homeIs += ` The posts page is page ${postsPage}.`;
		}
		if (shows === "posts") {
			// The home page lists the latest posts: it is the posts page.
			urls.push({ url: opts.siteUrl, kind: "home", source: ["auth"], evidence: "listed" });
			homeIs = " The home page lists the latest posts.";
		}
		cover("settings", "partial", `Read the site title, tagline, front page and posts page only.${homeIs} Other settings are not read. The REST API does not show the permalink structure.`);
	} else {
		cover("settings", "failed", reason(s, "read site settings", "an administrator"));
	}

	// Users: the total header only; the body (names) is never read.
	const u = await totalOf(fetch, route("/wp/v2/users"), {});
	const total = u.total ?? NaN;
	if (u.total !== undefined) {
		cover("users", "complete", `The site has ${n(total, "user account")}. Names and emails are not read. The authors count holds only people who wrote content, so it can be lower.`);
	} else {
		cover("users", "failed", u.status === 200 ? "The site did not give a user count." : reason(u, "list users", "an administrator"));
	}

	// Comments: two totals, approved and waiting; the bodies (names, emails) are never read.
	// Spam and trash are left out: they are not real comments for a move. The WXR reader
	// counts the same two, so the counts agree and merge can fill in the split by type.
	let comments: Inventory["comments"];
	const approved = await totalOf(fetch, route("/wp/v2/comments"), { status: "approve" });
	const held = await totalOf(fetch, route("/wp/v2/comments"), { status: "hold" });
	if (approved.total !== undefined && held.total !== undefined) {
		const count = approved.total + held.total;
		comments = { count, source: "auth", pending: held.total };
		cover("comments", "complete", count ? `The site has ${n(count, "comment")}. ${pendingNote(held.total)}`.trim() : "The site has no comments.");
	} else {
		const bad = approved.total === undefined ? approved : held;
		cover("comments", "failed", bad.status === 200 ? "The site did not give a comment count." : reason(bad, "count comments waiting for approval", "an editor or administrator"));
	}

	// Menus (WordPress 5.9+).
	const menus: Menu[] = [];
	const menuList: { id: number; name?: string; location?: string }[] = [];
	const ml = await pageAll(fetch, route("/wp/v2/menus"), { context: "edit" }, budget, (page) => {
		for (const m of page) {
			const id = num(m.id);
			if (id === undefined) continue;
			const loc = Array.isArray(m.locations) ? m.locations.find((x): x is string => typeof x === "string") : undefined;
			menuList.push({ id, ...(str(m.name) ? { name: str(m.name) } : {}), ...(loc ? { location: loc } : {}) });
		}
	});
	if (ml.ok) {
		const byMenu = new Map<number, MenuItem[]>();
		const il = await pageAll(fetch, route("/wp/v2/menu-items"), { context: "edit" }, budget, (page) => {
			for (const item of page) {
				const id = num(item.id);
				const menuId = num(item.menus);
				if (id === undefined || menuId === undefined) continue;
				const mi: MenuItem = { id, title: raw(item.title), url: str(item.url) ?? opts.siteUrl, order: num(item.menu_order) ?? 0 };
				const parent = num(item.parent);
				if (parent) mi.parent = parent;
				const kind = str(item.type);
				const object = str(item.object) ?? "";
				const objectId = num(item.object_id);
				if (kind === "post_type") mi.target = objectId === undefined ? { kind: kindOf(object), type: object } : { kind: kindOf(object), type: object, id: objectId };
				else if (kind === "post_type_archive") mi.target = { kind: "archive", type: object };
				else if (kind === "taxonomy") {
					const tk: UrlKind = object === "category" ? "category" : object === "post_tag" ? "tag" : "term";
					mi.target = objectId === undefined ? { kind: tk, type: object } : { kind: tk, type: object, id: objectId };
				}
				const list = byMenu.get(menuId) ?? [];
				list.push(mi);
				byMenu.set(menuId, list);
			}
		});
		for (const m of menuList) {
			const { id } = m;
			// menu_order can skip numbers (0, 2, 3, 4); every item is kept and numbered 1…N.
			const items = [...(byMenu.get(id) ?? [])].sort((a, b) => a.order - b.order || a.id - b.id).map((x, k) => ({ ...x, order: k + 1 }));
			const menu: Menu = { id, name: m.name ?? `Menu ${id}`, kind: "classic", items, source: "auth" };
			if (m.location) menu.location = m.location;
			menus.push(menu);
		}
		if (il.ok) cover("menus", "complete", `Read ${n(menus.length, "menu")} with ${n(il.count, "item")}.`);
		else cover("menus", "partial", `Read ${n(menus.length, "menu")}, but not all their items. ${il.detail ? `The menu item list ${il.detail}.` : reason(il.first, "read menu items", "a user who can edit theme options")}`);
	} else {
		cover("menus", "failed", ml.detail ? `The menu list ${ml.detail}.` : reason(ml.first, "read menus", "a user who can edit theme options (an administrator)"));
	}
	const blockMenus = navPosts.map((b) => blockMenu(b.title || "Navigation", b.content, opts.siteUrl, pages, "auth"));
	if (blockMenus.length) {
		menus.push(...blockMenus);
		const line = coverage.find((c) => c.area === "menus");
		const note = navNote(blockMenus);
		if (line && line.status !== "failed") line.detail = `${line.detail} ${note}`;
		else cover("menus", "partial", line ? `${note} ${line.detail}` : note);
	}

	const inv: Inventory = {
		version: 1,
		site,
		levels: [3],
		coverage,
		types,
		taxonomies: [],
		plugins,
		builders: [],
		shortcodes: shortcodes.list(),
		blocks: blocks.list(),
		menus,
		...(comments ? { comments } : {}),
		permalinks: { source: "auth", confidence: "low" },
		urls,
		storedElsewhere: plugins.flatMap((x) => (x.active && PLUGINS[x.slug]?.stores ? [{ plugin: x.slug, what: PLUGINS[x.slug]?.stores as string }] : [])),
	};
	return canonical("inventory", inv);
}
