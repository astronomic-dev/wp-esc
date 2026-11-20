// What EmDash's Exporter plugin reports for each custom field, so the seed asks for the
// same fields with the same types and the import screen shows Ready.
//
// The Exporter's own rules, from the pinned release (emdash-exporter 1.2.0, the zip in
// test/sites/versions.env), includes/class-content-exporter.php:
//   analyze_custom_fields (lines 308-344): every meta key that does not start with "_",
//     on more than one meta row (HAVING count > 1), most used first, at most 50. The type
//     comes from ONE sample: the first non-empty stored value (LIMIT 1, no ORDER BY).
//   infer_field_type (lines 349-383): key-name rules first, then that one sample.
// ACF repeaters store a row count under the field name and each row as flat keys
// (`faq_0_question`), so the Exporter reports every flat key too. It also sends the ACF
// field groups (analyze `acf`: each group's location rules and its top-level fields).
// EmDash 1.4.0 then requires, per post type (src/import/sources/wordpress-plugin.ts
// analyze, ~408-460), in this order:
//   1. each field of the ACF groups whose location has `post_type == <type>`, except
//      tab, message and accordion (acfFieldsForPostType ~717), with slug
//      sanitizeFieldSlug(name) and type ACF_FIELD_TYPES[acf type] ?? "json"
//      (acfImportFieldType ~696; an existing field keeps its type when the ACF type
//      does not fit it and the reported meta type does);
//   2. each reported key that is not plugin bookkeeping and not a row of a json
//      repeater or flexible field from step 1 (isAcfRowMeta ~743), with slug
//      sanitizeFieldSlug(key) and type mapInferredFieldType(guess).
// A slug already taken is skipped. An existing field passes only by isTypeCompatible
// (src/import/utils.ts). Execute fills ACF fields from get_fields() first, so a json
// repeater gets its rows whole.

import type { ContentType, Field, FieldShape } from "../contracts/inventory.ts";
import type { ModelFieldType } from "../contracts/model.ts";

export type ExporterType = "string" | "text" | "number" | "integer" | "boolean" | "datetime" | "json" | "reference";

/** The Exporter's analyze response (GET /wp-json/emdash/v1/analyze), the parts the seed reads. */
export interface ExporterField { key: string; count: number; inferred_type: string; sample: string | null }
export interface ExporterPostType { name: string; total: number; supports?: Record<string, unknown>; custom_fields?: ExporterField[] }
export interface AcfFieldInfo { key?: string; name: string; label?: string; type: string; required?: boolean }
export interface AcfGroup { key?: string; title?: string; location?: { param: string; operator: string; value: string }[][]; fields: AcfFieldInfo[] }
export interface ExporterAnalyze { post_types: ExporterPostType[]; acf?: AcfGroup[] }

// wordpress-plugin.ts VALID_INFERRED_TYPES and mapInferredFieldType.
const VALID: ExporterType[] = ["string", "text", "number", "integer", "boolean", "datetime", "json", "reference"];
export const mapInferredType = (t: string): ExporterType => ((VALID as string[]).includes(t) ? (t as ExporterType) : "string");

// wordpress-plugin.ts ACF_FIELD_TYPES: ACF types that hold one scalar; every other ACF
// type (image, select, relationship, repeater, ...) is stored as json.
export const ACF_FIELD_TYPES: Record<string, ExporterType> = {
	text: "string",
	email: "string",
	url: "string",
	password: "string",
	radio: "string",
	button_group: "string",
	color_picker: "string",
	oembed: "string",
	date_picker: "string",
	date_time_picker: "string",
	time_picker: "string",
	textarea: "text",
	wysiwyg: "text",
	number: "number",
	range: "number",
	true_false: "boolean",
};
export const acfEmDashType = (acfType: string): ExporterType => ACF_FIELD_TYPES[acfType] ?? "json";
const ACF_LAYOUT_TYPES = new Set(["tab", "message", "accordion"]);

/** wordpress-plugin.ts acfFieldsForPostType: the fields of the groups located on a post type. */
export function acfFieldsForPostType(groups: AcfGroup[] | undefined, postType: string): AcfFieldInfo[] {
	const out: AcfFieldInfo[] = [];
	for (const g of groups ?? []) {
		const assigned = g.location?.some((rules) => rules.some((r) => r.param === "post_type" && r.operator === "==" && r.value === postType));
		if (!assigned) continue;
		for (const f of g.fields) if (f.name && !ACF_LAYOUT_TYPES.has(f.type)) out.push(f);
	}
	return out;
}

/** wordpress-plugin.ts isAcfRowMeta: a `<name>_<row>_<sub>` key of a repeater or flexible field. */
export function isAcfRowMeta(key: string, fields: AcfFieldInfo[]): boolean {
	return fields.some((f) => (f.type === "repeater" || f.type === "flexible_content") && key.startsWith(f.name) && /^_\d+_/.test(key.slice(f.name.length)));
}

/** PHP 8 is_numeric: optional whitespace, sign, digits with an optional point, exponent. */
function isNumeric(s: string): boolean {
	return /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(s);
}

/** WordPress is_serialized (wp-includes/functions.php), strict mode. */
function isSerialized(value: string): boolean {
	const d = value.trim();
	if (d === "N;") return true;
	if (d.length < 4 || d[1] !== ":") return false;
	const last = d.at(-1);
	if (last !== ";" && last !== "}") return false;
	const t = d[0];
	if (t === "s") return d.at(-2) === '"' && /^s:[0-9]+:/.test(d);
	if (t === "a" || t === "O" || t === "E") return new RegExp(`^${t}:[0-9]+:`).test(d);
	if (t === "b" || t === "i" || t === "d") return new RegExp(`^${t}:[0-9.E+-]+;$`).test(d);
	return false;
}

/** The key-name rules (infer_field_type, lines 351-362), or undefined when none applies. */
export function keyRuleType(key: string): ExporterType | undefined {
	if (/_(id|image|thumbnail|media|photo|attachment)$/.test(key)) return "reference";
	if (/_(date|time)$/.test(key)) return "datetime";
	if (/_(count|number|price|amount)$/.test(key)) return "number";
	if (/_(enabled|active|featured)$/.test(key)) return "boolean";
	return undefined;
}

/** infer_field_type (class-content-exporter.php lines 349-383) for one stored value. */
export function exporterGuess(key: string, sample: string | null | undefined): ExporterType {
	const byKey = keyRuleType(key);
	if (byKey) return byKey;
	// PHP `!$sample`: null, "" and "0" all give string.
	if (!sample || sample === "0") return "string";
	if (isSerialized(sample)) return "json";
	if (isNumeric(sample)) return sample.includes(".") ? "number" : "integer";
	// "0" and "1" are numeric above, so only these words reach the boolean rule.
	if (["true", "false", "yes", "no"].includes(sample)) return "boolean";
	if (/^\d{4}-\d{2}-\d{2}/.test(sample)) return "datetime";
	if (Buffer.byteLength(sample, "utf8") > 500) return "text";
	return "string";
}

// --- From the inventory ---------------------------------------------------------------

/** Samples are stored values only from the export file; level 1 sees formatted REST values. */
const rawSamples = (f: Field): boolean => f.source === "wxr";

/** The stored type for a field whose samples are not stored values (ACF storage). */
function storedTypeForShape(f: Field): ExporterType {
	switch (f.shape) {
		case "html":
			return "text";
		case "number":
			return f.samples.length && f.samples.every((s) => /^-?\d+$/.test(s.trim())) ? "integer" : f.samples.length ? "number" : "integer";
		case "boolean":
		case "image":
		case "file":
		case "repeater":
			return "integer"; // ACF true_false "1", an attachment ID, a row count
		case "relation":
			return f.samples.some((s) => /^\s*(\[|a:)/.test(s)) ? "json" : "integer";
		case "list":
		case "object":
		case "serialized":
		case "flexible":
			return "json";
		default:
			return "string";
	}
}

/**
 * The stored values behind REST samples of a choice field with return format "array"
 * (radio, button_group, select): ACF formats each as {"value", "label"} but stores the value.
 */
function choiceValues(f: Field): string[] | undefined {
	if (f.shape !== "object" || !f.samples.length) return undefined;
	const out: string[] = [];
	for (const s of f.samples) {
		let v: unknown;
		try {
			v = JSON.parse(s);
		} catch {
			return undefined;
		}
		if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
		const keys = Object.keys(v).sort().join(",");
		const value = (v as Record<string, unknown>).value;
		if (keys !== "label,value" || (typeof value !== "string" && typeof value !== "number")) return undefined;
		out.push(String(value));
	}
	return out;
}

export interface Guess {
	type: ExporterType;
	/** Why the guess may not match: set when it depends on which stored value the Exporter samples. */
	risk?: string;
}

const describeCounts = (counts: Map<ExporterType, number>): string => [...counts].map(([t, n]) => `${t} (${n})`).join(", ");

/** The type the Exporter will most likely report for an inventory field, under `key`. */
export function guessField(key: string, f: Field): Guess {
	const byKey = keyRuleType(key);
	if (byKey) return { type: byKey };
	const samples = rawSamples(f) ? f.samples : choiceValues(f);
	if (!samples?.length) {
		const type = storedTypeForShape(f);
		return { type, risk: `The samples are not stored values, so ${type} is a best guess; for an exact match, write the seed with --emdash-analyze.` };
	}
	// The type most samples give; a tie goes to the earliest sample, the export's order,
	// which is close to the stored order the Exporter's LIMIT 1 reads.
	const counts = new Map<ExporterType, number>();
	for (const s of samples) {
		const t = exporterGuess(key, s);
		counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	let type = exporterGuess(key, samples[0]);
	for (const [t, n] of counts) if (n > (counts.get(type) ?? 0)) type = t;
	const risks: string[] = [];
	if (counts.size > 1) risks.push(`The Exporter guesses from one stored value, and the samples give ${describeCounts(counts)}; the seed uses ${type}.`);
	if (f.shape === "repeater" && f.filled < f.total) risks.push("Some entries have no rows; if the Exporter samples a row count of 0 it reports string.");
	return risks.length ? { type, risk: risks.join(" ") } : { type };
}

// The EmDash type of the ACF field type behind each inventory shape (ACF_FIELD_TYPES), for
// shapes the export's field settings give (wxr/acf.ts SHAPES). `text` is text, textarea,
// password and color_picker, and also radio, button_group and a single select, which carry
// options; mixed and unknown say nothing.
const ACF_TYPE_FOR_SHAPE: Partial<Record<FieldShape, ExporterType>> = {
	html: "text",
	number: "number",
	boolean: "boolean",
	date: "string",
	url: "string",
	email: "string",
	image: "json",
	file: "json",
	relation: "json",
	list: "json",
	object: "json",
	repeater: "json",
	flexible: "json",
};
// The ACF readers' notes: the REST API's own type (public/rest.ts), or settings not seen.
const REST_ACF_TYPE = /^Field type "([a-z_]+)" as the REST API reports it\./;
const ACF_TYPE_GUESSED = /guessed from the values|check the field group/;

/** The ACF type's EmDash type, when the inventory knows the ACF type; else undefined. */
function knownAcfType(f: Field): ExporterType | undefined {
	const rest = f.note ? REST_ACF_TYPE.exec(f.note) : null;
	if (rest) return acfEmDashType(rest[1] as string);
	if (f.source !== "wxr" || (f.note && ACF_TYPE_GUESSED.test(f.note))) return undefined;
	if (f.shape === "text") return f.options?.length ? undefined : "string";
	return ACF_TYPE_FOR_SHAPE[f.shape];
}

/**
 * The type the seed gives an inventory field, so EmDash 1.4.0's import shows Ready whether
 * or not the field's ACF group is located on the post type (`post_type ==`), which the
 * inventory does not record:
 * - Located: EmDash requires the ACF type, but keeps an existing field's type when the ACF
 *   type does not fit it and the reported meta type does (acfImportFieldType). Not located:
 *   EmDash requires the reported meta type, if the key is reported at all.
 * - So a key the Exporter reports (on two or more entries) takes the Exporter's guess,
 *   which both accept, and a repeater's rows stay flat (a kept row count is not json, so
 *   the rows are still asked for).
 * - A key on one entry or none is not reported: only a located group asks for it, with
 *   its ACF type, so it takes that type when the inventory knows it.
 * --emdash-analyze has the groups, so that seed takes ACF's types exactly (seed.ts).
 */
export function seedGuess(key: string, f: Field): Guess {
	const meta = guessField(key, f);
	if (f.owner !== "acf" || f.filled >= 2) return meta;
	const acf = knownAcfType(f);
	// ACF text and textarea both hold plain text, and EmDash takes string and text for each
	// other (isTypeCompatible), so the seed names them as the model does (propose.ts
	// scalarType): one name for the field whatever the evidence.
	if (acf === "text" || acf === "string") return f.shape === "text" ? { type: f.samples.some((s) => s.includes("\n") || s.length > 200) ? "text" : "string" } : { type: acf };
	if (acf) return { type: acf };
	return { type: meta.type, risk: `${meta.risk ? `${meta.risk} ` : ""}The field is on one entry or none, so EmDash asks for it only by its ACF type, which is not known here; for an exact match, write the seed with --emdash-analyze.` };
}

/** Do the rows arrive whole? Only for an ACF repeater or flexible field the seed makes json. */
export const rowsArriveWhole = (key: string, f: Field): boolean => f.owner === "acf" && (f.shape === "repeater" || f.shape === "flexible") && seedGuess(key, f).type === "json";

/** How many rows a repeater or flexible field has at most, from its samples. */
export function rowsOf(f: Field): number {
	let rows = 0;
	for (const s of f.samples) {
		const t = s.trim();
		let n = 0;
		if (/^\d+$/.test(t)) n = Number(t);
		else if (/^a:\d+:/.test(t)) n = Number(t.slice(2, t.indexOf(":", 2)));
		else if (t.startsWith("[")) {
			try {
				const v: unknown = JSON.parse(t);
				if (Array.isArray(v)) n = v.length;
			} catch {
				n = rowsBegun(t); // a sample cut short: count the rows it starts
			}
		}
		rows = Math.max(rows, n);
	}
	// Every row has each subfield at most once, so the most filled subfield over the filled
	// entries is a floor for the longest entry's row count.
	const most = Math.max(0, ...(f.subfields ?? []).map((s) => s.filled));
	if (f.filled > 0 && most > 0) rows = Math.max(rows, Math.ceil(most / f.filled));
	return Math.min(rows, 50);
}

/** The rows a JSON array of objects cut short begins: the objects opened at depth 1. */
function rowsBegun(text: string): number {
	let depth = 0;
	let inString = false;
	let rows = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "[" || ch === "{") {
			depth++;
			if (depth === 2 && ch === "{") rows++;
		} else if (ch === "]" || ch === "}") depth--;
	}
	return rows;
}

/** Are a repeater's samples cut short, so more rows may exist than the seed lists? */
export const rowsCutShort = (f: Field): boolean => f.source !== "wxr" && f.samples.some((s) => /^\s*\[/.test(s) && !/\]\s*$/.test(s));

export interface FlatKey { key: string; field: Field }

/**
 * The flat keys ACF stores a repeater's (or flexible field's) rows under: `<key>_<n>_<sub>`
 * for each row seen, nested rows too. Flexible rows take every layout's subfields, since a
 * row's layout is not known here; extra fields cost nothing on import.
 */
export function flatKeys(key: string, f: Field): FlatKey[] {
	const subs = f.shape === "repeater" ? (f.subfields ?? []) : f.shape === "flexible" ? (f.layouts ?? []).flatMap((l) => l.subfields) : [];
	if (!subs.length) return [];
	const out: FlatKey[] = [];
	const seen = new Set<string>();
	for (let n = 0; n < rowsOf(f); n++) {
		for (const s of subs) {
			const k = `${key}_${n}_${s.key}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push({ key: k, field: s });
			for (const deeper of flatKeys(k, s)) {
				if (seen.has(deeper.key)) continue;
				seen.add(deeper.key);
				out.push(deeper);
			}
		}
	}
	return out;
}

/** Does the analyze response say this post type has featured images? (analyze, ~391) */
export const supportsThumbnail = (pt: ExporterPostType): boolean => !!pt.supports && "thumbnail" in pt.supports;

/** The inventory type's field for a key, or undefined. */
export const inventoryField = (t: ContentType | undefined, key: string): Field | undefined => t?.fields.find((f) => f.key === key);

/** The Exporter type a model type is stored as, for a field with no inventory evidence. */
export function exporterTypeForModel(key: string, storage: ModelFieldType): ExporterType {
	return keyRuleType(key) ?? mapInferredType(storage);
}
