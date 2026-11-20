// Merges inventories read at different levels into one.
//
// - Higher-level facts win. An inventory's level is its highest entry in `levels`;
//   on a tie, the later argument wins.
// - A fact the higher level does not have is kept from the lower one (an unset field
//   never erases a set one).
// - Source lists, levels, locales and name lists add up.
// - Nothing is dropped: types, fields, URLs, plugins and menus are joined by their keys.
// - Coverage lines join by area and source. Then each area keeps only its best lines:
//   complete beats partial, and partial beats failed or not-visible. A line a better
//   source has answered (for example "needs level 3" next to a complete level 3 read)
//   is dropped. When no line for an area is complete, its failed lines stay, so a gap
//   still shows which source could not answer. At the end each area has one line: the
//   kept lines join, with the best kept status (a failed line next to a partial one adds
//   its reason, not its status) and that line's source, and the details ordered by source
//   (auth, wxr, rest, sitemap, html).
// - Once level 3 has run, "need level 3" clauses in the lower lines are dropped. Once level
//   2 or 3 has run, the drafts clause (DRAFTS_CLAUSE) is dropped too.
// - Once the export or the password supplied raw content, the html line's level 1
//   sentences on REST content are replaced by one that says where the counts came from.
// - A higher level never lowers a type's count. When it lists fewer items than a lower
//   level (for example a WXR filtered to one month next to the full REST list), each
//   status keeps the larger count, and the higher level's coverage line for that type
//   becomes partial. The `authors`, `media` and `comments` counts then keep the larger
//   one too, since that export is not the whole site.
// - A field's data comes whole from the best source that saw it (shape, owner,
//   counts, samples, subfields, confidence). Field sources rank wxr > auth > rest > html >
//   sitemap, whatever the level, so WXR field data replaces REST and HTML guesses.
// - `authors`, `media` and `comments` keep a defined count; an absent one never replaces it.
// - When the export was read whole for a type, a field that only REST or HTML saw for it
//   is empty on every item (the export holds all post meta): it gets filled 0, the
//   export's total and source "wxr".
// - Usage counts (builders, shortcodes, blocks) are distinct items: the larger count wins,
//   and never fewer than the distinct sample URLs.
// - storedElsewhere drops a plugin whose data the export holds as a post type
//   (DATA_IN_EXPORT, for example Flamingo messages as flamingo_inbound).
// - A block theme (core/navigation blocks, or wp_navigation or template items) adds a note
//   to the menus line: the menu shown may not be a classic menu. When a classic menu and a
//   Navigation block (kind "block") were both read, the note names both.
// - Menus join by kind, then by WordPress term ID; by name only when one side has no ID.
// - Comments: the count is picked like authors and media. When both sides counted the same,
//   byType and pending fill in from the other side.
// - URLs join by their canonical form (url.ts). Locales join by code. A URL keeps its
//   best kind: home or archive, then any other, then query. A slug or id stays once set.
// - Permalinks: a known structure is kept over an unknown one.
// - URL evidence keeps the strongest: resolved, then listed, then linked.
//
// The result is canonical (see write.ts). Inputs are not changed.

import { canonical } from "./write.ts";
import { normalizeUrl } from "./url.ts";

import type {
	ContentType,
	Coverage,
	Field,
	Inventory,
	Locale,
	Menu,
	MenuItem,
	Plugin,
	Source,
	StoredData,
	Taxonomy,
	UrlEntry,
	Usage,
} from "./inventory.ts";

/** A plugin's data that an export holds as one of its post types. */
export const DATA_IN_EXPORT: Record<string, string> = { flamingo: "flamingo_inbound" };

const level = (inv: Inventory): number => Math.max(0, ...inv.levels);

function union<T>(a: T[], b: T[]): T[] {
	return [...new Set([...a, ...b])];
}

/** Shallow overlay: defined values in `hi` win; values only in `lo` stay. */
function overlay<T extends object>(lo: T, hi: T): T {
	const out = { ...lo } as Record<string, unknown>;
	for (const [k, v] of Object.entries(hi)) if (v !== undefined) out[k] = v;
	return out as T;
}

function joinBy<T>(lo: T[], hi: T[], key: (x: T) => string, combine: (lo: T, hi: T) => T): T[] {
	const map = new Map<string, T>();
	for (const x of lo) map.set(key(x), x);
	for (const x of hi) {
		const k = key(x);
		const prev = map.get(k);
		map.set(k, prev === undefined ? x : combine(prev, x));
	}
	return [...map.values()];
}

const takeHi = <T>(_lo: T, hi: T): T => hi;

const FIELD_RANK: Record<Source, number> = { sitemap: 0, html: 1, rest: 2, auth: 3, wxr: 4 };
const bestField = (lo: Field, hi: Field): Field => (FIELD_RANK[hi.source] >= FIELD_RANK[lo.source] ? hi : lo);

/** True when `hi` lists fewer items than `lo` saw, in all or among published ones. */
function shortOf(lo: ContentType, hi: ContentType): boolean {
	if (lo.count !== undefined && hi.count !== undefined && lo.count > hi.count) return true;
	return Object.keys(hi.byStatus).length > 0 && (lo.byStatus.publish ?? 0) > (hi.byStatus.publish ?? 0);
}

function mergeType(lo: ContentType, hi: ContentType, short?: Map<string, number>): ContentType {
	if (shortOf(lo, hi)) {
		const byStatus: Record<string, number> = { ...lo.byStatus };
		for (const [k, v] of Object.entries(hi.byStatus)) byStatus[k] = Math.max(byStatus[k] ?? 0, v);
		const sum = Object.values(byStatus).reduce((a, b) => a + b, 0);
		const count = Math.max(lo.count ?? 0, hi.count ?? 0, sum);
		short?.set(hi.slug, count);
		return { ...joinType(lo, hi), count, byStatus };
	}
	return joinType(lo, hi);
}

function joinType(lo: ContentType, hi: ContentType): ContentType {
	return {
		...overlay(lo, hi),
		byStatus: { ...lo.byStatus, ...hi.byStatus },
		fields: joinBy<Field>(lo.fields, hi.fields, (f) => f.key, bestField),
		taxonomies: union(lo.taxonomies, hi.taxonomies),
		sources: union(lo.sources, hi.sources),
	};
}

function mergeTaxonomy(lo: Taxonomy, hi: Taxonomy): Taxonomy {
	return { ...overlay(lo, hi), types: union(lo.types, hi.types), sources: union(lo.sources, hi.sources) };
}

function mergeUsage(lo: Usage, hi: Usage): Usage {
	const samples = union(lo.samples, hi.samples);
	return { name: hi.name, count: Math.max(lo.count, hi.count, samples.length), samples };
}

function mergeMenu(lo: Menu, hi: Menu): Menu {
	return { ...overlay(lo, hi), items: joinBy<MenuItem>(lo.items, hi.items, (i) => String(i.id), overlay) };
}

function normalEntry(u: UrlEntry): UrlEntry {
	const out = { ...u, url: normalizeUrl(u.url) };
	if (u.translationOf !== undefined) out.translationOf = normalizeUrl(u.translationOf);
	return out;
}

const EVIDENCE = { linked: 0, listed: 1, resolved: 2 } as const;

const KIND_RANK = (k: UrlEntry["kind"]): number => (k === "home" || k === "archive" ? 2 : k === "query" ? 0 : 1);

function mergeUrl(lo: UrlEntry, hi: UrlEntry): UrlEntry {
	return {
		...overlay(lo, hi),
		kind: KIND_RANK(lo.kind) > KIND_RANK(hi.kind) ? lo.kind : hi.kind,
		source: union(lo.source, hi.source),
		evidence: EVIDENCE[lo.evidence] > EVIDENCE[hi.evidence] ? lo.evidence : hi.evidence,
	};
}

const menuKind = (m: Menu): string => m.kind ?? "classic";

function mergeMenus(lo: Menu[], hi: Menu[]): Menu[] {
	const out = [...lo];
	for (const m of hi) {
		const i = out.findIndex((o) =>
			menuKind(o) === menuKind(m) &&
			(o.id !== undefined && m.id !== undefined ? o.id === m.id : o.name === m.name && (o.location ?? "") === (m.location ?? "")),
		);
		if (i === -1) out.push(m);
		else out[i] = mergeMenu(out[i] as Menu, m);
	}
	return out;
}

function mergePermalinks(lo: Inventory["permalinks"], hi: Inventory["permalinks"]): Inventory["permalinks"] {
	if (hi.structure === undefined && lo.structure !== undefined) return lo;
	return hi;
}

const STATUS_RANK: Record<Coverage["status"], number> = { complete: 2, partial: 1, failed: 0, "not-visible": 0 };

/** Keeps, for each area, the lines at that area's best status, and its failed lines when none is complete. */
export function bestCoverage(lines: Coverage[]): Coverage[] {
	const best = new Map<string, number>();
	for (const c of lines) best.set(c.area, Math.max(best.get(c.area) ?? 0, STATUS_RANK[c.status]));
	return lines.filter((c) => STATUS_RANK[c.status] === best.get(c.area) || (c.status === "failed" && best.get(c.area) !== STATUS_RANK.complete));
}

/** The larger of two counts when the higher level is known to be short; else the usual pick. */
function countOf<T extends { count: number }>(lo: T | undefined, hi: T | undefined, short: boolean): T | undefined {
	if (short && lo && hi && lo.count > hi.count) return lo;
	return hi ?? lo;
}

/** The comments count as countOf picks it. When the other side counted the same, its split by type and pending count fill what the pick lacks. */
function commentsOf(lo: Inventory["comments"], hi: Inventory["comments"], short: boolean): Inventory["comments"] {
	const pick = countOf(lo, hi, short);
	if (!pick) return pick;
	const other = pick === hi ? lo : hi;
	if (other?.count !== pick.count) return pick;
	const out = { ...pick };
	if (out.byType === undefined && other?.byType !== undefined) out.byType = other.byType;
	if (out.pending === undefined && other?.pending !== undefined) out.pending = other.pending;
	return out;
}

function mergeTwo(lo: Inventory, hi: Inventory): Inventory {
	const short = new Map<string, number>();
	const types = joinBy(lo.types, hi.types, (t) => t.slug, (a, b) => mergeType(a, b, short));
	const hiCoverage = hi.coverage.map((c) => {
		const count = c.area.startsWith("type:") ? short.get(c.area.slice(5)) : undefined;
		if (count === undefined || c.status !== "complete") return c;
		return { ...c, status: "partial" as const, detail: `${c.detail} Another source lists more, so this one does not hold every item; the count is ${count}.` };
	});
	return {
		version: hi.version,
		site: { ...overlay(lo.site, hi.site), locales: joinBy<Locale>(lo.site.locales, hi.site.locales, (l) => l.code, overlay) },
		levels: union(lo.levels, hi.levels),
		coverage: joinBy<Coverage>(lo.coverage, hiCoverage, (c) => `${c.area}\u0000${c.source}`, takeHi),
		types,
		taxonomies: joinBy(lo.taxonomies, hi.taxonomies, (t) => t.slug, mergeTaxonomy),
		plugins: joinBy<Plugin>(dropFieldsGuess(lo.plugins, hi.plugins), hi.plugins, (p) => p.slug, overlay),
		builders: joinBy(lo.builders, hi.builders, (u) => u.name, mergeUsage),
		shortcodes: joinBy(lo.shortcodes, hi.shortcodes, (u) => u.name, mergeUsage),
		blocks: joinBy(lo.blocks, hi.blocks, (u) => u.name, mergeUsage),
		menus: mergeMenus(lo.menus, hi.menus),
		authors: countOf(lo.authors, hi.authors, short.size > 0),
		media: countOf(lo.media, hi.media, short.size > 0),
		comments: commentsOf(lo.comments, hi.comments, short.size > 0),
		permalinks: mergePermalinks(lo.permalinks, hi.permalinks),
		urls: joinBy(lo.urls.map(normalEntry), hi.urls.map(normalEntry), (u) => u.url, mergeUrl),
		storedElsewhere: joinBy<StoredData>(lo.storedElsewhere, hi.storedElsewhere, (s) => `${s.plugin}\u0000${s.what}`, takeHi),
	};
}

const FIELDS_PLUGINS = ["advanced-custom-fields", "advanced-custom-fields-pro", "secure-custom-fields"];
const isFieldsGuess = (p: Plugin): boolean => p.slug === "advanced-custom-fields" && p.confidence === "low";

/** The low-confidence "ACF or Secure Custom Fields" guess, dropped once a higher source names the real plugin. */
function dropFieldsGuess(lo: Plugin[], hi: Plugin[]): Plugin[] {
	if (!hi.some((p) => FIELDS_PLUGINS.includes(p.slug) && !isFieldsGuess(p))) return lo;
	return lo.filter((p) => !isFieldsGuess(p));
}

/** Fields only REST or HTML saw, on a type the export holds whole: empty on every item. */
function emptyInExport(inv: Inventory): void {
	const whole = new Set(inv.coverage.filter((c) => c.source === "wxr" && c.status === "complete" && c.area.startsWith("type:")).map((c) => c.area.slice(5)));
	for (const t of inv.types) {
		if (!whole.has(t.slug)) continue;
		const total = t.fields.find((f) => f.source === "wxr")?.total;
		if (total === undefined) continue;
		t.fields = t.fields.map((f) => {
			if (FIELD_RANK[f.source] >= FIELD_RANK.auth) return f;
			const out: Field = { ...f, source: "wxr", filled: 0, total, samples: [], confidence: "high", note: `The export has no value for it, so no item fills it. The ${f.source === "rest" ? "REST API" : "public page"} value was not stored data.` };
			return out;
		});
	}
}

/** The level 1 clause on drafts, which an export or the password answers. */
export const DRAFTS_CLAUSE = "drafts and private items need an export (level 2) or the password (level 3).";
const NEEDS_LEVEL_3 = /\bneeds? level 3\b/;
const DRAFTS = /\bdrafts and private items need (an export \(level 2\) or the password \(level 3\)|level 3)\b/;

/** Drops the clauses `levels` answers: "need level 3" once level 3 has run, the drafts clause once level 2 or 3 has. */
function dropLevelNotes(detail: string, levels: number[]): string {
	const answered = [...(levels.includes(3) ? [NEEDS_LEVEL_3] : []), ...(levels.some((l) => l >= 2) ? [DRAFTS] : [])];
	return detail
		.split(/(?<=\.)\s+/)
		.flatMap((sentence) => {
			const re = answered.find((r) => r.test(sentence));
			if (!re) return [sentence];
			const cut = sentence.lastIndexOf(";", sentence.search(re));
			return cut > 0 ? [`${sentence.slice(0, cut)}.`] : [];
		})
		.join(" ");
}

/** Level 1's sentences on where the html line's counts came from (two shared texts). */
const REST_COUNTED = /^Builders, shortcodes and blocks are counted from the REST content of /;
const REST_SHORTCODES = /^WordPress has already run the shortcodes in that content\b/;

/** Once the export or the password supplied raw content, the html line says the counts came from there. */
function rawContentNote(inv: Inventory, line: Coverage): Coverage {
	const ok = (c: Coverage): boolean => c.status === "complete" || c.status === "partial";
	const fromExport = inv.coverage.some((c) => c.source === "wxr" && c.area === "wxr" && ok(c));
	const fromAuth = inv.coverage.some((c) => c.source === "auth" && c.area.startsWith("type:") && ok(c));
	if (!fromExport && !fromAuth) return line;
	const sentences = line.detail.split(/(?<=\.)\s+/);
	if (!sentences.some((x) => REST_COUNTED.test(x) || REST_SHORTCODES.test(x))) return line;
	const where = fromExport ? "in the export" : "read with the password";
	const kept = sentences.filter((x) => !REST_COUNTED.test(x) && !REST_SHORTCODES.test(x));
	return { ...line, detail: [...kept, `Builders, shortcodes and blocks are counted from the raw content ${where}.`].join(" ") };
}

const SOURCE_RANK: Record<Source, number> = { html: 0, sitemap: 1, rest: 2, wxr: 3, auth: 4 };

/** One line per area: the kept lines' best status, highest source, and joined details. */
function oneLinePerArea(lines: Coverage[]): Coverage[] {
	const byArea = new Map<string, Coverage[]>();
	for (const c of lines) byArea.set(c.area, [...(byArea.get(c.area) ?? []), c]);
	return [...byArea.values()].map((group) => {
		const sorted = [...group].sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source]);
		const top = sorted.reduce((a, b) => (STATUS_RANK[b.status] > STATUS_RANK[a.status] || (b.status === "failed" && a.status === "not-visible") ? b : a));
		const details = [...new Set(sorted.flatMap((c) => c.detail.trim().split(/(?<=\.)\s+/)).filter(Boolean))];
		return { area: top.area, source: top.source, status: top.status, detail: details.join(" ") };
	});
}

const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * A block theme's menu may be a Navigation block or a page list: say so on the menus line.
 * When both a classic menu and a Navigation block were read, the line names both and says
 * which one the header shows.
 */
function blockThemeNote(inv: Inventory): void {
	const count = (slug: string): number => inv.types.find((t) => t.slug === slug)?.count ?? 0;
	const nav = inv.types.find((t) => t.slug === "wp_navigation");
	const blockMenus = inv.menus.filter((m) => m.kind === "block");
	const classic = inv.menus.filter((m) => m.kind !== "block");
	const block = blockMenus.length > 0 || inv.blocks.some((b) => b.name === "core/navigation") || count("wp_navigation") + count("wp_template") + count("wp_template_part") > 0;
	if (!block) return;
	const where = nav?.sources.includes("wxr") ? "in the export" : "on the site";
	const items = count("wp_navigation") ? ` (${n(count("wp_navigation"), "wp_navigation item")} ${where})` : "";
	const names = (ms: Menu[]): string => ms.map((m) => `"${m.name}"`).join(", ");
	const note = blockMenus.length && classic.length
		? `There are two kinds of menu: the classic ${classic.length === 1 ? "menu" : "menus"} ${names(classic)} and the Navigation ${blockMenus.length === 1 ? "block" : "blocks"} ${names(blockMenus)}. If the theme's header uses a Navigation block, the header shows that one, so check the live header.`
		: blockMenus.length
			? `This is a block theme. The menu is the Navigation ${blockMenus.length === 1 ? "block" : "blocks"} ${names(blockMenus)}; check the live header to be sure.`
			: `This is a block theme. The menu shown may be a Navigation block${items} or an automatic page list, not a classic menu.`;
	const line = inv.coverage.find((c) => c.area === "menus");
	if (!line) {
		inv.coverage.push({ area: "menus", source: nav?.sources.includes("wxr") ? "wxr" : "html", status: "partial", detail: note });
		return;
	}
	line.detail = `${line.detail} ${note}`;
	if (line.status === "complete") line.status = "partial";
}

/** Merges any number of inventories, lowest level first. */
export function merge(...inventories: Inventory[]): Inventory {
	if (inventories.length === 0) throw new Error("merge needs at least one inventory");
	const ordered = inventories.map((inv, i) => ({ inv, i })).sort((a, b) => level(a.inv) - level(b.inv) || a.i - b.i);
	let out = structuredClone(ordered[0]!.inv);
	for (const { inv } of ordered.slice(1)) out = mergeTwo(out, structuredClone(inv));
	emptyInExport(out);
	out.storedElsewhere = out.storedElsewhere.filter((s) => {
		const type = DATA_IN_EXPORT[s.plugin];
		return !(type && out.types.some((t) => t.slug === type && t.sources.includes("wxr")));
	});
	let coverage = bestCoverage(out.coverage);
	if (out.levels.some((l) => l >= 2)) {
		coverage = coverage.map((c) => (c.source === "auth" ? c : { ...c, detail: dropLevelNotes(c.detail, out.levels) })).filter((c) => c.detail !== "");
		coverage = coverage.map((c) => (c.area === "html" ? rawContentNote(out, c) : c));
	}
	out.coverage = oneLinePerArea(coverage);
	blockThemeNote(out);
	return canonical("inventory", out);
}
