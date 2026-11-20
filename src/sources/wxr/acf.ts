// ACF (and Secure Custom Fields, which stores the same way) from the export.
//
// Storage, per post:
// - the value is under `name`; `_name` holds the field's reference key (`field_...`);
// - a repeater keeps its row count under `name` and each cell as `name_<n>_<sub>`,
//   each with its own `_name_<n>_<sub>` reference;
// - flexible content keeps a PHP array of layout names (one per row) under `name`,
//   cells as `name_<n>_<sub>`;
// - a group keeps "" under `name` and its parts as `name_<sub>`.
// Field settings live in `acf-field-group` and `acf-field` posts: the group's title and
// location rules, and for each field its label (title), name (excerpt), key (slug),
// parent (group or parent field) and order (menu_order), with the type and options as a
// PHP array in the content. When the export has no settings (fields defined in PHP or
// JSON), the reader rebuilds the tree from the meta names alone and says so.

import type { Confidence, Field, FieldShape, Layout } from "../../contracts/inventory.ts";
import type { WxrItem } from "./stream.ts";
import { addValue, inferShape, inferredConfidence, isSparse, newStats, sparseNote, type ValueStats } from "./meta.ts";

// --- PHP unserialize (the subset WordPress writes) ------------------------------------

type Php = null | boolean | number | string | Php[] | { [k: string]: Php };

/** Reads a PHP serialized value. Lengths are in bytes. Returns undefined when it is not one. */
export function unserialize(input: string): Php | undefined {
	const buf = Buffer.from(input, "utf8");
	let i = 0;
	const fail = (): never => {
		throw new Error("bad");
	};
	const readUntil = (ch: string): string => {
		const end = buf.indexOf(ch, i);
		if (end === -1) fail();
		const s = buf.toString("latin1", i, end);
		i = end + 1;
		return s;
	};
	const expect = (ch: string): void => {
		if (buf[i] !== ch.charCodeAt(0)) fail();
		i++;
	};
	const value = (depth: number): Php => {
		if (depth > 32) fail();
		const t = String.fromCharCode(buf[i] ?? 0);
		i++;
		if (t === "N") {
			expect(";");
			return null;
		}
		expect(":");
		switch (t) {
			case "b":
				return readUntil(";") === "1";
			case "i": {
				const n = Number(readUntil(";"));
				return Number.isFinite(n) ? n : fail();
			}
			case "d": {
				const n = Number(readUntil(";"));
				return Number.isNaN(n) ? fail() : n;
			}
			case "s": {
				const len = Number(readUntil(":"));
				if (!Number.isInteger(len) || len < 0) fail();
				expect('"');
				if (i + len > buf.length) fail();
				const s = buf.toString("utf8", i, i + len);
				i += len;
				expect('"');
				expect(";");
				return s;
			}
			case "a": {
				const n = Number(readUntil(":"));
				if (!Number.isInteger(n) || n < 0) fail();
				expect("{");
				const entries: [string | number, Php][] = [];
				for (let k = 0; k < n; k++) {
					const key = value(depth + 1);
					if (typeof key !== "string" && typeof key !== "number") fail();
					entries.push([key as string | number, value(depth + 1)]);
				}
				expect("}");
				const isList = entries.every(([k], idx) => k === idx);
				if (isList) return entries.map(([, v]) => v);
				const obj: { [k: string]: Php } = {};
				for (const [k, v] of entries) obj[String(k)] = v;
				return obj;
			}
			default:
				return fail();
		}
	};
	try {
		const out = value(0);
		return i === buf.length ? out : undefined;
	} catch {
		return undefined;
	}
}

const isObj = (v: Php | undefined): v is { [k: string]: Php } => v !== null && typeof v === "object" && !Array.isArray(v);
const asList = (v: Php | undefined): Php[] => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : []);

// --- Field settings -------------------------------------------------------------------

export interface AcfGroup { postId: number; key: string; title: string; order: number; types: string[] }
export interface AcfNode {
	key: string; // field_...
	name: string;
	label?: string;
	type?: string; // ACF type; unset when the export had no settings
	parentKey?: string; // the parent field's key
	groupPostId?: number;
	parentPostId?: number;
	order?: number;
	layoutKey?: string; // flexible content: the layout this subfield belongs to
	settings?: { [k: string]: Php };
}

/** The settings found in the export: groups and fields, by key. */
export class AcfSettings {
	readonly groups = new Map<number, AcfGroup>();
	readonly fields = new Map<string, AcfNode>();
	private readonly byPostId = new Map<number, AcfNode>();

	addItem(item: WxrItem): void {
		if (item.type === "acf-field-group") {
			const settings = unserialize(item.content);
			const types: string[] = [];
			for (const or of asList(isObj(settings) ? settings.location : undefined)) {
				for (const rule of asList(or)) {
					if (isObj(rule) && rule.param === "post_type" && rule.operator === "==" && typeof rule.value === "string") types.push(rule.value);
				}
			}
			this.groups.set(item.id, { postId: item.id, key: item.name, title: item.title, order: item.menuOrder, types });
		} else if (item.type === "acf-field") {
			const settings = unserialize(item.content);
			const node: AcfNode = { key: item.name, name: item.excerpt, label: item.title || undefined, parentPostId: item.parent, order: item.menuOrder };
			if (isObj(settings)) {
				node.settings = settings;
				if (typeof settings.type === "string") node.type = settings.type;
				if (typeof settings.parent_layout === "string" && settings.parent_layout) node.layoutKey = settings.parent_layout;
			}
			if (node.key && node.name) {
				this.fields.set(node.key, node);
				this.byPostId.set(item.id, node);
			}
		}
	}

	/** Ties each field to its group or parent field. Call once, after the stream. */
	link(): void {
		for (const node of this.fields.values()) {
			const parent = node.parentPostId === undefined ? undefined : this.byPostId.get(node.parentPostId);
			if (parent) node.parentKey = parent.key;
			else if (node.parentPostId !== undefined && this.groups.has(node.parentPostId)) node.groupPostId = node.parentPostId;
		}
	}

	get size(): number {
		return this.fields.size;
	}
}

// --- Values per type ------------------------------------------------------------------

/** ACF values on one post type, by field reference key. */
export class AcfValues {
	readonly stats = new Map<string, ValueStats & { zeros: number }>();

	add(fieldKey: string, metaName: string, value: string): void {
		let s = this.stats.get(fieldKey);
		if (!s) this.stats.set(fieldKey, (s = { ...newStats(), zeros: 0 }));
		addStat(s, value, metaName);
	}
}

function addStat(s: ValueStats & { zeros: number }, value: string, name: string): void {
	addValue(s, value, name);
	const v = value.trim();
	if (v === "0") s.zeros++;
	if (v.startsWith("a:")) {
		const parsed = unserialize(v);
		if (Array.isArray(parsed) && parsed.length && parsed.every((x) => typeof x === "string" && /^[a-z_][\w-]*$/i.test(x))) {
			for (const layout of parsed as string[]) s.layouts.set(layout, (s.layouts.get(layout) ?? 0) + 1);
		}
	}
}


// --- Building fields ------------------------------------------------------------------

const SHAPES: Record<string, FieldShape> = {
	text: "text", textarea: "text", password: "text", color_picker: "text", radio: "text", button_group: "text",
	wysiwyg: "html", number: "number", range: "number", true_false: "boolean",
	date_picker: "date", date_time_picker: "date", time_picker: "date",
	url: "url", oembed: "url", email: "email", image: "image", file: "file", gallery: "list", checkbox: "list",
	relationship: "relation", post_object: "relation", page_link: "relation", taxonomy: "relation", user: "relation",
	link: "object", google_map: "object", group: "object", clone: "object",
	repeater: "repeater", flexible_content: "flexible",
};
const NO_DATA = new Set(["tab", "message", "accordion"]);
const LOOSE: Set<FieldShape> = new Set(["relation", "repeater", "flexible", "serialized", "list", "mixed", "unknown", "object"]);
const NO_SETTINGS = "Field settings are not in the export; the type is guessed from the values.";

function shapeFor(node: AcfNode, stats: ValueStats, hasChildren: boolean): FieldShape {
	if (node.type) {
		if (node.type === "select") return node.settings?.multiple ? "list" : "text";
		return SHAPES[node.type] ?? inferShape(stats);
	}
	if (hasChildren) {
		if (stats.layouts.size) return "flexible";
		if ([...stats.shapes.keys()].every((s) => s === "number")) return "repeater";
		return "object";
	}
	return inferShape(stats);
}

function optionsOf(node: AcfNode): string[] | undefined {
	const choices = node.settings?.choices;
	if (!isObj(choices) && !Array.isArray(choices)) return undefined;
	const keys = Array.isArray(choices) ? choices.map(String) : Object.keys(choices);
	return keys.length ? keys : undefined;
}

function targetsOf(node: AcfNode): string[] | undefined {
	if (!node.type || !["relationship", "post_object", "page_link"].includes(node.type)) return undefined;
	const pt = node.settings?.post_type;
	const list = (Array.isArray(pt) ? pt : typeof pt === "string" && pt ? [pt] : []).filter((x): x is string => typeof x === "string" && x !== "");
	return list.length ? list : undefined;
}

interface Tree {
	nodes: Map<string, AcfNode>;
	children: Map<string, AcfNode[]>;
}

/** Nodes for one type: the settings plus a stand-in for each value key the settings lack. */
function treeFor(settings: AcfSettings, values: AcfValues): Tree {
	const nodes = new Map(settings.fields);
	const missing = [...values.stats.keys()].filter((k) => !nodes.has(k));
	// Without settings, find the parent from the meta names: `parent_<n>_sub`, `parent_sub`.
	const namesOf = (k: string): string[] => values.stats.get(k)?.names ?? [];
	for (const key of missing) {
		const name = namesOf(key)[0] ?? key;
		let best: { parent: string; rest: string; len: number } | undefined;
		for (const [other, s] of values.stats) {
			if (other === key) continue;
			for (const pn of s.names) {
				const m = name.startsWith(`${pn}_`) ? /^(\d+_)?(.+)$/.exec(name.slice(pn.length + 1)) : null;
				if (m && (!best || pn.length > best.len)) best = { parent: other, rest: m[2] as string, len: pn.length };
			}
		}
		nodes.set(key, best ? { key, name: best.rest, parentKey: best.parent } : { key, name });
	}
	const children = new Map<string, AcfNode[]>();
	for (const n of nodes.values()) {
		if (!n.parentKey) continue;
		const list = children.get(n.parentKey) ?? [];
		list.push(n);
		children.set(n.parentKey, list);
	}
	for (const list of children.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
	return { nodes, children };
}

function confidenceFor(shape: FieldShape, filled: number, total: number, fromSettings: boolean): Confidence {
	if (!fromSettings) return inferredConfidence(shape, filled, total) === "medium" ? "medium" : "low";
	if (LOOSE.has(shape) || isSparse(filled, total)) return "low";
	return filled < total ? "medium" : "high";
}

function buildField(node: AcfNode, tree: Tree, values: AcfValues, total: number, depth: number): Field {
	const stats = values.stats.get(node.key) ?? { ...newStats(), zeros: 0 };
	const kids = (tree.children.get(node.key) ?? []).filter((k) => !k.type || !NO_DATA.has(k.type));
	const shape = shapeFor(node, stats, kids.length > 0);
	const filled = shape === "repeater" || shape === "flexible" ? stats.filled - stats.zeros : shape === "object" && kids.length ? stats.occ : stats.filled;
	const field: Field = {
		key: node.name,
		owner: "acf",
		shape,
		source: "wxr",
		filled,
		total,
		samples: stats.samples,
		confidence: confidenceFor(shape, filled, total, node.type !== undefined),
	};
	if (node.label) field.label = node.label;
	if (node.order !== undefined && depth > 0) field.order = node.order;
	const notes: string[] = [];
	if (!node.type) notes.push(NO_SETTINGS);
	if (isSparse(filled, total)) notes.push(sparseNote(filled, total));
	if (shape === "relation" && node.type !== "taxonomy" && node.type !== "user") notes.push("Values are WordPress post IDs.");
	const targets = targetsOf(node);
	if (targets) field.targets = targets;
	const options = optionsOf(node);
	if (options) field.options = options;
	if (depth < 4 && kids.length) {
		if (shape === "flexible") {
			const declared = asList(node.settings?.layouts).filter(isObj);
			const layoutNames = new Map<string, { name: string; label?: string }>();
			for (const l of declared) if (typeof l.key === "string" && typeof l.name === "string") layoutNames.set(l.key, { name: l.name, label: typeof l.label === "string" ? l.label : undefined });
			const layouts: Layout[] = [];
			const seen = new Set<string>();
			for (const l of layoutNames.values()) seen.add(l.name);
			for (const [key, l] of layoutNames) {
				const subs = kids.filter((k) => k.layoutKey === key).map((k) => buildField(k, tree, values, stats.layouts.get(l.name) ?? 0, depth + 1));
				const layout: Layout = { name: l.name, subfields: subs };
				if (l.label) layout.label = l.label;
				layouts.push(layout);
			}
			for (const name of stats.layouts.keys()) if (!seen.has(name)) layouts.push({ name, subfields: [] });
			field.layouts = layouts;
			notes.push(`Flexible content with ${layouts.length} ${layouts.length === 1 ? "layout" : "layouts"}.`);
		} else {
			const childTotal = shape === "repeater" ? stats.rows : stats.occ;
			field.subfields = kids.map((k) => buildField(k, tree, values, childTotal, depth + 1));
		}
	}
	if (notes.length) field.note = notes.join(" ");
	return field;
}

/** The ACF fields of one post type, top level in source order. */
export function acfFields(type: string, settings: AcfSettings, values: AcfValues | undefined, total: number): Field[] {
	const vals = values ?? new AcfValues();
	const tree = treeFor(settings, vals);
	const top = [...tree.nodes.values()].filter((n) => {
		if (n.parentKey) return false;
		if (n.type && NO_DATA.has(n.type)) return false;
		if (vals.stats.has(n.key)) return true;
		const g = n.groupPostId === undefined ? undefined : settings.groups.get(n.groupPostId);
		return g !== undefined && g.types.includes(type);
	});
	const groupOf = (n: AcfNode): AcfGroup | undefined => (n.groupPostId === undefined ? undefined : settings.groups.get(n.groupPostId));
	top.sort((a, b) => {
		const ga = groupOf(a);
		const gb = groupOf(b);
		if (!ga || !gb) return ga ? -1 : gb ? 1 : a.name.localeCompare(b.name);
		return ga.order - gb.order || ga.postId - gb.postId || (a.order ?? 0) - (b.order ?? 0);
	});
	return top.map((n, i) => {
		const f = buildField(n, tree, vals, total, 0);
		const g = groupOf(n);
		if (g) {
			f.group = g.title;
			f.order = i;
		}
		return f;
	});
}
