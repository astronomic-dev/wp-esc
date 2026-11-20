// Pattern lines for _redirects: URL families the ledger cannot list in full.
//
// WordPress answers many URLs no sitemap lists: every post's own feed (/<post-path>/feed/),
// every later page of the post list (/page/N/) and every date archive (/2024/12/). The
// plan lists the ones the inventory saw; these lines catch the rest.
//
// Cloudflare's _redirects has two kinds of line. A static line matches one exact path. A
// dynamic line uses placeholders (`:name` matches one path segment) or a splat (`*`
// matches the rest, also nothing). Cloudflare checks the static lines first, then the
// dynamic lines from the top down, and the first match wins. It reads at most 100
// dynamic lines.
//
// A pattern is only made when the old permalink structure makes it safe, and then only
// when it catches no path that stays the same and no new path of the plan. Each family:
//   feeds   /<year>/:month/:slug/feed/* to the post's new path, one line per year, when
//           the structure is dates (or a fixed word) then %postname% and posts route by
//           {slug}. A bare /:year/ would also catch /category/<slug>/feed/.
//   paged   /page/* to the blog index, when the old home page listed the posts.
//   dates   /<year>/* to the blog index, for each year the posts were made in, when the
//           structure starts with %year%. It comes after the feeds line.
//   lists   for each term and author page the plan places: <path>page/* to that page's new
//           path (page 1), and <path>feed/* to the new feed (or, with no feed route, the
//           page). The ledger lists only the later pages and feeds it saw; these catch the rest.
//           A path with a placeholder character (`:` or `*`) gets no line.
//
// `skipped` says, in plain words, why a family got no line, for the summary.

import type { Inventory } from "../contracts/inventory.ts";
import type { Model } from "../contracts/model.ts";
import { urlPatternFor } from "../model/seed.ts";
import { DYNAMIC_LIMIT } from "./cloudflare.ts";
import { encodeSegment, isSiteRelative, noTrailingSlash, siteBase, type Row, type Target } from "./plan.ts";

export interface Pattern {
	from: string;
	to: string;
	kind: "feed" | "paged" | "date";
	note: string;
}

export interface Patterns {
	patterns: Pattern[];
	warnings: string[];
	skipped: string[]; // "none for post feeds, since /%postname%/ makes a feed pattern unsafe"
}

// An old path that is safe to put in front of `page/*` or `feed/*`: plain characters only,
// so no `:` placeholder and no second `*`.
const PLAIN_PATH = /^\/[A-Za-z0-9\-._~!$&'()+,;=@%/]*\/$/;
const LIST_KINDS = new Set(["category", "tag", "term", "author"]);

const TOKENS: Record<string, string> = { "%year%": ":year", "%monthnum%": ":month", "%day%": ":day" };

/** The same regular expression Cloudflare builds for a dynamic line. */
export function patternRegExp(from: string): RegExp {
	const esc = (s: string): string => s.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
	const body = from
		.split("*")
		.map((part) => esc(part).replace(/:([A-Za-z]\w*)/g, "[^/]+"))
		.join(".*");
	return new RegExp(`^${body}$`);
}

/** A pattern line is written only when both fields are plain site paths: no whitespace or control characters, nothing off the site. */
export function safeLine(p: { from: string; to: string }): boolean {
	const plain = (s: string): boolean => !/[\s\x00-\x1f\x7f]/.test(s);
	return plain(p.from) && plain(p.to) && isSiteRelative(p.from) && isSiteRelative(p.to);
}

/** The pattern lines for one plan. `rows` is the plan itself, used to check each pattern is safe. */
export function patternLines(inv: Inventory, model: Model, target: Target, rows: Row[], skip: string[] = []): Patterns {
	if (model.locales.some((l) => l.prefix) || inv.site.locales.some((l) => l.prefix)) return { patterns: [], warnings: [], skipped: ["none, since the site has language prefixes, so no pattern is safe"] };
	const base = siteBase(new URL(inv.site.url));
	const fit = (p: string): string => (target === "emdash" ? noTrailingSlash(p) : p);
	const blogRoute = model.routes.filter((r) => r.kind === "blog").map((r) => r.pattern).sort()[0];
	const blog = blogRoute ? fit(blogRoute) : undefined;
	const structure = inv.permalinks.structure ?? "";
	const segs = structure.split("/").filter(Boolean);
	const out: Pattern[] = [];
	const skipped: string[] = [];
	if (!structure) skipped.push("none, since with plain permalinks old feeds, date archives and later pages are query URLs; the query map holds the ones the inventory lists");

	// The years the posts were made in, from their old URLs.
	const years = new Set<string>();
	for (const u of inv.urls) {
		if (u.kind !== "post" && u.kind !== "date") continue;
		const y = /^(\d{4})\//.exec(new URL(u.url).pathname.slice(base.length))?.[1];
		if (y) years.add(y);
	}
	const byYear = segs[0] === "%year%";

	// Per-post feeds. A placeholder matches any segment, so a date structure gets one line
	// per year (a fixed first segment), never a bare /:year/ that would catch /category/.
	const posts = model.collections.find((c) => c.from === "post");
	const lead = segs.slice(0, -1);
	const leadOk = lead.length > 0 && lead.every((s) => TOKENS[s] !== undefined || !s.includes("%")) && (byYear || !lead[0]?.includes("%"));
	if (posts?.route && posts.route.includes("{slug}") && !posts.route.includes("{path}") && segs.at(-1) === "%postname%" && leadOk) {
		const route = target === "emdash" ? urlPatternFor(posts.route) : posts.route;
		const to = route.replace("{slug}", ":slug");
		const tail = (first: string): string => `${base}${[first, ...lead.slice(1).map((s) => TOKENS[s] ?? encodeSegment(s))].join("/")}/:slug/feed/*`;
		if (byYear) for (const y of [...years].sort()) out.push({ from: tail(y), to, kind: "feed", note: `Pattern: the feed of every post from ${y}; sent to the post.` });
		else out.push({ from: tail(encodeSegment(lead[0] as string)), to, kind: "feed", note: "Pattern: the feed of every post; sent to the post." });
	} else if (structure) {
		skipped.push(!posts?.route ? "none for post feeds, since the new site has no post pages" : `none for post feeds, since ${structure} makes a feed pattern unsafe`);
	}

	// Later pages of the post list on the old home page.
	const rootEntry = inv.urls.find((u) => {
		const x = new URL(u.url);
		return x.pathname === base && !x.search;
	});
	if (blog && rootEntry?.kind === "home" && rootEntry.id === undefined && !rootEntry.type) {
		out.push({ from: `${base}page/*`, to: blog, kind: "paged", note: "Pattern: every later page of the post list on the old home page; sent to the blog index." });
	}

	// Date archives, one line per year. Post URLs are exact lines, which Cloudflare checks first.
	if (blog && byYear) for (const y of [...years].sort()) out.push({ from: `${base}${y}/*`, to: blog, kind: "date", note: `Pattern: every date archive in ${y}; sent to the blog index.` });
	else if (structure && years.size) skipped.push(!blog ? "none for date archives, since the new site has no blog index" : "none for date archives, since post addresses do not start with the year");

	// Later pages and feeds of each term and author page the plan places.
	const feedRoute = model.routes.filter((r) => r.kind === "feed").map((r) => r.pattern).sort()[0];
	const feed = feedRoute ? fit(feedRoute) : undefined;
	for (const r of rows) {
		if (!LIST_KINDS.has(r.kind) || r.status === "review" || !PLAIN_PATH.test(r.old) || !r.old.startsWith(base)) continue;
		const what = r.kind === "author" ? "author page" : "term";
		out.push({ from: `${r.old}page/*`, to: r.new, kind: "paged", note: `Pattern: every later page of this ${what}; sent to page 1.` });
		out.push({ from: `${r.old}feed/*`, to: feed ?? r.new, kind: "feed", note: feed ? `Pattern: the feeds of this ${what}; sent to the new feed.` : `Pattern: the feeds of this ${what}; sent to its page.` });
	}

	// Safe only when a pattern catches no old path that is not an exact redirect line (a path
	// that stays the same, a row to review, anything else) and no new path. Exact lines are
	// safe: Cloudflare checks them first. `skip` names exact rows that will not be in _redirects.
	const leftOut = new Set(skip);
	const exact = new Set(rows.filter((r) => r.status === "301" && !r.old.includes("?") && isSiteRelative(r.new) && !leftOut.has(r.old)).map((r) => r.old));
	const kept: string[] = [...rows.map((r) => r.old.split("?")[0] as string).filter((p) => p.startsWith("/") && !exact.has(p)), ...rows.filter((r) => r.status === "301").map((r) => r.new)];
	const warnings: string[] = [];
	const safe = out.filter((p) => {
		if (!safeLine(p)) {
			warnings.push(`Left out the pattern line ${JSON.stringify(p.from)}: its new path ${JSON.stringify(p.to)} is not a plain path on the site.`);
			return false;
		}
		const re = patternRegExp(p.from);
		const hit = kept.find((k) => re.test(k));
		if (hit) warnings.push(`Left out the pattern line ${p.from}: it would also catch ${hit}, which must not move there.`);
		return !hit;
	});
	if (safe.length > DYNAMIC_LIMIT) warnings.push(`Cloudflare reads only ${DYNAMIC_LIMIT} pattern lines; left out ${safe.length - DYNAMIC_LIMIT}.`);
	return { patterns: safe.slice(0, DYNAMIC_LIMIT), warnings, skipped };
}
