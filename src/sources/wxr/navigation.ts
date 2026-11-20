// Block theme navigation: the links in a wp_navigation post's raw content, as a Menu with
// kind "block". Shared by the export reader and the password reader.
//
// Read: core/navigation-link and core/navigation-submenu (label, url, id, kind, type) and
// core/home-link. A core/page-list block stands for every published page, so it adds one
// link per page (nested by parent, in menu order, then by title), as WordPress shows it.
// Block links have no WordPress IDs: items get ids 1…N in document order.

import type { Menu, MenuItem, Source, UrlKind } from "../../contracts/inventory.ts";

/** A published page, for a page-list block. */
export interface NavPage { id: number; title: string; link: string; parent: number; order: number }

type Attrs = Record<string, unknown>;

const BLOCK = /<!--\s+(\/)?wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)\s+(\{[\s\S]*?\})?\s*(\/)?-->/g;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function idOf(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function targetOf(a: Attrs): MenuItem["target"] {
	const kind = str(a.kind);
	const type = str(a.type) ?? "";
	const id = idOf(a.id);
	if (kind === "post-type") {
		const k: UrlKind = type === "post" ? "post" : type === "page" ? "page" : "custom";
		return id === undefined ? { kind: k, type } : { kind: k, type, id };
	}
	if (kind === "taxonomy") {
		const k: UrlKind = type === "category" ? "category" : type === "post_tag" || type === "tag" ? "tag" : "term";
		const t = type === "tag" ? "post_tag" : type;
		return id === undefined ? { kind: k, type: t } : { kind: k, type: t, id };
	}
	if (kind === "post-type-archive") return { kind: "archive", type };
	return undefined;
}

function pageItems(pages: NavPage[], add: (title: string, url: string, parent: number, target: MenuItem["target"]) => number, parent: number): void {
	const ids = new Set(pages.map((p) => p.id));
	const children = new Map<number, NavPage[]>();
	for (const p of pages) {
		const up = ids.has(p.parent) ? p.parent : 0;
		children.set(up, [...(children.get(up) ?? []), p]);
	}
	const walk = (up: number, under: number, seen: Set<number>): void => {
		const list = [...(children.get(up) ?? [])].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title) || a.id - b.id);
		for (const p of list) {
			if (seen.has(p.id)) continue;
			seen.add(p.id);
			const id = add(p.title, p.link, under, { kind: "page", type: "page", id: p.id });
			walk(p.id, id, seen);
		}
	};
	walk(0, parent, new Set());
}

/** The links of one wp_navigation post. */
export function blockMenu(name: string, content: string, siteUrl: string, pages: NavPage[], source: Source): Menu {
	const items: MenuItem[] = [];
	const open: number[] = []; // ids of the submenus we are inside
	const add = (title: string, url: string, parent: number, target: MenuItem["target"]): number => {
		const id = items.length + 1;
		const item: MenuItem = { id, title, url: url || siteUrl, order: id };
		if (parent) item.parent = parent;
		if (target) item.target = target;
		items.push(item);
		return id;
	};
	for (const m of content.matchAll(BLOCK)) {
		const [, close, rawName, json, selfClose] = m;
		const block = (rawName ?? "").replace(/^core\//, "");
		if (close) {
			if (block === "navigation-submenu") open.pop();
			continue;
		}
		let a: Attrs = {};
		if (json) {
			try {
				a = JSON.parse(json) as Attrs;
			} catch {
				a = {};
			}
		}
		const parent = open.at(-1) ?? 0;
		if (block === "navigation-link" || block === "navigation-submenu") {
			const id = add(str(a.label) ?? "", str(a.url) ?? "", parent, targetOf(a));
			if (block === "navigation-submenu" && !selfClose) open.push(id);
		} else if (block === "home-link") {
			add(str(a.label) ?? "Home", siteUrl, parent, { kind: "home" });
		} else if (block === "page-list") {
			pageItems(pages, add, parent);
		}
	}
	return { name, kind: "block", items, source };
}
