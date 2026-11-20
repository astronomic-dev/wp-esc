// Theme match: which listed Astronomic themes fit a WordPress site, from data/themes.json.
// Up to two, best first, each with a plain reason, or "none-fit".

import { readFileSync } from "node:fs";
import type { ContentType, Inventory } from "../contracts/inventory.ts";
import type { ThemeMatch } from "../contracts/assessment.ts";
import { canonical } from "../contracts/write.ts";

export interface ThemeEntry {
	slug: string;
	name: string;
	listed: boolean;
	url: string;
	fits: string; // one plain sentence: what the theme is for
	types: string[]; // WordPress post type slugs it has pages for
	keywords: string[]; // words in the site name or tagline
	plugins: string[]; // parts of plugin slugs
	pluginCategories: string[];
	blog: number; // weight when the site is mostly a blog
	authors: number; // extra weight when the blog has two or more writers
}

const THEMES_FILE = new URL("../../data/themes.json", import.meta.url);

// Points for each kind of evidence, and the least a theme needs to be named.
const TYPE_POINTS = 3;
const KEYWORD_POINTS = 2;
const PLUGIN_POINTS = 3;
const MIN_SCORE = 3;
const BLOG_POSTS = 20; // a site with this many posts, and more posts than pages, is a blog
const MAX_MATCHES = 2;

/** The listed themes, in data file order. Themes with `listed: false` are left out. */
export function loadThemes(file: URL | string = THEMES_FILE): ThemeEntry[] {
	const data = JSON.parse(readFileSync(file, "utf8")) as { themes: ThemeEntry[] };
	return data.themes.filter((t) => t.listed);
}

const norm = (s: string): string => s.toLowerCase().replace(/-/g, "_");

/** The word in `text` that the keyword matches, or undefined. */
function keywordHit(text: string, keyword: string): string | undefined {
	const kw = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Short words must match whole (with an optional plural s), so "law" does not match "lawn".
	const re = keyword.length <= 4 ? new RegExp(`\\b${kw}s?\\b`) : new RegExp(`\\b${kw}[\\p{L}-]*`, "u");
	return re.exec(text)?.[0];
}

function listWords(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Published items when the source gave statuses, else the total; drafts and private items do not show on the site. */
function published(t: ContentType | undefined): number | undefined {
	if (!t) return undefined;
	return t.byStatus.publish ?? (Object.keys(t.byStatus).length > 0 ? 0 : t.count);
}

function typeLabel(inv: Inventory, slug: string): string {
	const t = inv.types.find((x) => x.slug === slug);
	const label = (t?.label ?? slug.replace(/[_-]/g, " ")).toLowerCase();
	const n = published(t);
	return n === undefined ? `a ${label} section` : `${label} (${n})`;
}

interface Scored { entry: ThemeEntry; score: number; reason: string; order: number }

function score(inv: Inventory, entry: ThemeEntry, order: number): Scored {
	let points = 0;
	const has: string[] = [];
	const notes: string[] = [];

	const posts = published(inv.types.find((t) => t.slug === "post")) ?? 0;
	const pages = published(inv.types.find((t) => t.slug === "page")) ?? 0;
	if (entry.blog > 0 && posts >= BLOG_POSTS && posts >= pages) {
		points += entry.blog;
		has.push(`${posts} posts`);
		if (entry.authors > 0 && (inv.authors?.count ?? 0) >= 2) {
			points += entry.authors;
			has.push(`${inv.authors?.count} writers`);
		}
	}

	const wanted = new Set(entry.types.map(norm));
	for (const t of inv.types) {
		if (t.slug === "post" || t.slug === "page") continue;
		if (published(t) === 0) continue;
		if (!wanted.has(norm(t.slug))) continue;
		points += TYPE_POINTS;
		has.push(typeLabel(inv, t.slug));
	}

	const text = `${inv.site.name ?? ""} ${inv.site.tagline ?? ""}`.toLowerCase();
	const words = [...new Set(entry.keywords.map((k) => keywordHit(text, k)).filter((w): w is string => w !== undefined))];
	points += Math.min(words.length, 2) * KEYWORD_POINTS;
	const named = words.length > 0 ? `Your site's name or tagline says "${words[0]}".` : "";

	const plugin = inv.plugins.find((p) => p.active !== false && (entry.plugins.some((part) => p.slug.toLowerCase().includes(part)) || entry.pluginCategories.includes(p.category)));
	if (plugin) {
		points += PLUGIN_POINTS;
		notes.push(`uses ${plugin.name ?? plugin.slug}`);
	}

	const facts = [...(has.length > 0 ? [`has ${listWords(has)}`] : []), ...notes];
	const lead = facts.length > 0 ? `Your site ${listWords(facts)}.` : "";
	const reason = [lead, named, entry.fits].filter(Boolean).join(" ");
	return { entry, score: points, reason, order };
}

/** Up to two listed themes that fit the site, best first, or "none-fit". */
export function matchThemes(input: Inventory, themes: ThemeEntry[] = loadThemes()): ThemeMatch[] | "none-fit" {
	const inv = canonical("inventory", input); // equal facts in any order give the same evidence
	const ranked = themes
		.filter((t) => t.listed)
		.map((t, i) => score(inv, t, i))
		.filter((s) => s.score >= MIN_SCORE)
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, MAX_MATCHES);
	if (ranked.length === 0) return "none-fit";
	return ranked.map((s) => ({ slug: s.entry.slug, name: s.entry.name, reason: s.reason, url: s.entry.url }));
}
