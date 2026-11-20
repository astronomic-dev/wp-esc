// Stable JSON output for the three contracts, so the same facts give the same bytes.
//
// - Object keys are sorted, with `version` first.
// - Arrays of strings or numbers are sorted.
// - Arrays of objects are sorted by their identity keys (listed below per array name),
//   then by their full canonical JSON, so any input order gives one output order.
// - Arrays where order means something are kept as given (ORDERED below).
// - Inventory ledger URLs (`urls[].url`, `translationOf`) are put in canonical form (url.ts).
// - Tabs, and a newline at the end.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeUrl } from "./url.ts";

export type ContractKind = "inventory" | "model" | "assessment";

interface Rules {
	ordered: Set<string>;
	keys: Record<string, string[]>;
}

const RULES: Record<ContractKind, Rules> = {
	inventory: {
		ordered: new Set(["options"]),
		keys: {
			coverage: ["area", "source"],
			types: ["slug"],
			fields: ["key"],
			subfields: ["key"],
			layouts: ["name"],
			locales: ["code"],
			taxonomies: ["slug"],
			plugins: ["slug"],
			builders: ["name"],
			shortcodes: ["name"],
			blocks: ["name"],
			menus: ["id", "name", "location"],
			items: ["order", "id"],
			urls: ["url"],
			storedElsewhere: ["plugin", "what"],
		},
	},
	model: {
		ordered: new Set(["fields", "subfields", "items", "children", "options"]),
		keys: {
			locales: ["code"],
			collections: ["slug"],
			taxonomies: ["slug"],
			menus: ["name"],
			routes: ["kind", "pattern"],
		},
	},
	assessment: {
		ordered: new Set(["themes", "links"]),
		keys: {
			findings: ["area", "score"],
			storePaths: ["kind"],
		},
	},
};

function compareValues(a: unknown, b: unknown): number {
	if (a === b) return 0;
	if (a === undefined) return -1;
	if (b === undefined) return 1;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a !== typeof b) return typeof a < typeof b ? -1 : 1;
	const sa = typeof a === "string" ? a : JSON.stringify(a);
	const sb = typeof b === "string" ? b : JSON.stringify(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sortKeys(keys: string[]): string[] {
	return keys.sort((a, b) => {
		if (a === "version") return -1;
		if (b === "version") return 1;
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

function canonicalize(value: unknown, rules: Rules, prop: string): unknown {
	if (Array.isArray(value)) {
		const items = value.map((v) => canonicalize(v, rules, ""));
		if (rules.ordered.has(prop)) return items;
		const ids = rules.keys[prop] ?? [];
		const withJson = items.map((item) => ({ item, json: JSON.stringify(item) }));
		withJson.sort((x, y) => {
			const isObj = x.item !== null && typeof x.item === "object" && y.item !== null && typeof y.item === "object";
			if (isObj) {
				for (const id of ids) {
					const c = compareValues((x.item as Record<string, unknown>)[id], (y.item as Record<string, unknown>)[id]);
					if (c !== 0) return c;
				}
				return x.json < y.json ? -1 : x.json > y.json ? 1 : 0;
			}
			return compareValues(x.item, y.item);
		});
		return withJson.map((x) => x.item);
	}
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of sortKeys(Object.keys(obj))) {
			if (obj[key] === undefined) continue;
			out[key] = canonicalize(obj[key], rules, key);
		}
		return out;
	}
	return value;
}

function normalizeLedger(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	const inv = value as { urls?: unknown };
	if (!Array.isArray(inv.urls)) return value;
	const urls = inv.urls.map((entry: Record<string, unknown>) => {
		const out = { ...entry };
		if (typeof out.url === "string") out.url = normalizeUrl(out.url);
		if (typeof out.translationOf === "string") out.translationOf = normalizeUrl(out.translationOf);
		return out;
	});
	return { ...inv, urls };
}

/** The canonical form of a contract value: same facts, same structure, same order. */
export function canonical<T>(kind: ContractKind, value: T): T {
	return canonicalize(kind === "inventory" ? normalizeLedger(value) : value, RULES[kind], "") as T;
}

/** Byte-stable JSON text for a contract value. */
export function stringify(kind: ContractKind, value: unknown): string {
	return `${JSON.stringify(canonical(kind, value), null, "\t")}\n`;
}

/** Writes a contract value as byte-stable JSON, making the folder if needed. */
export async function writeContract(file: string, kind: ContractKind, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, stringify(kind, value), "utf8");
}
