// Post meta from the export: what is plumbing, who owns a key, and the shape of values.
//
// - PLUMBING is an exact denylist. Every other key is read as a field.
// - `_wp_page_template` is kept as a fact (owner "core").
// - `_thumbnail_id` is the featured image (owner "core", shape "image").
// - Yoast and Rank Math keys are owner "seo".
// - Elementor keys are builder usage, never fields (index.ts counts them).

import type { Confidence, Field, FieldShape } from "../../contracts/inventory.ts";

export const PLUMBING = new Set([
	"_edit_lock", "_edit_last", "_wp_old_slug", "_wp_old_date", "_encloseme", "_pingme", "_trackbackme",
	"_wp_trash_meta_status", "_wp_trash_meta_time", "_wp_trash_meta_comments_status", "_wp_desired_post_slug",
	"_wp_attached_file", "_wp_attachment_metadata", "_wp_attachment_backup_sizes", "_wp_attachment_context",
	"_wp_suggested_privacy_policy_content", "_customize_changeset_uuid", "_customize_draft_post_name", "_customize_restore_dismissed",
	"_menu_item_type", "_menu_item_menu_item_parent", "_menu_item_object_id", "_menu_item_object", "_menu_item_target",
	"_menu_item_classes", "_menu_item_xfn", "_menu_item_url", "_wp_old_date", "_acf_changed", "_pingme", "_oembed_time",
]);
const PLUMBING_PREFIXES = ["_oembed_", "_elementor_"];

export const CORE_LABELS: Record<string, string> = {
	post_title: "Title", post_content: "Content", post_excerpt: "Excerpt", _thumbnail_id: "Featured image", _wp_page_template: "Page template",
};
const SEO_LABELS: Record<string, string> = {
	_yoast_wpseo_title: "SEO title", _yoast_wpseo_metadesc: "SEO description", _yoast_wpseo_focuskw: "Focus keyphrase",
	rank_math_title: "SEO title", rank_math_description: "SEO description", rank_math_focus_keyword: "Focus keyphrase",
	_rank_math_title: "SEO title", _rank_math_description: "SEO description",
};

export const isPlumbing = (key: string): boolean => PLUMBING.has(key) || PLUMBING_PREFIXES.some((p) => key.startsWith(p));

export function ownerOf(key: string): Field["owner"] {
	if (key === "_thumbnail_id" || key === "_wp_page_template") return "core";
	if (key.startsWith("_yoast_wpseo_") || key.startsWith("rank_math_") || key.startsWith("_rank_math_")) return "seo";
	return "meta";
}

export const labelOf = (key: string): string | undefined => CORE_LABELS[key] ?? SEO_LABELS[key];

// --- Values ---------------------------------------------------------------------------

const SAMPLE_CAP = 3;
const SAMPLE_LENGTH = 120;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;

/** Running facts about one field's values. */
export interface ValueStats {
	occ: number; // rows seen (filled or not)
	filled: number;
	samples: string[];
	shapes: Map<FieldShape, number>;
	rows: number; // sum of integer values (repeater row counts)
	layouts: Map<string, number>; // flexible content: rows per layout
	names: string[]; // a few raw meta names, to find repeater parents without field settings
}

export const newStats = (): ValueStats => ({ occ: 0, filled: 0, samples: [], shapes: new Map(), rows: 0, layouts: new Map(), names: [] });

/** The shape one non-empty value looks like. */
export function shapeOfValue(v: string): FieldShape {
	const s = v.trim();
	if (/^(a|O|C):\d+:/.test(s) || /^(s:\d+:"|i:-?\d+;|b:[01];|d:)/.test(s)) return "serialized";
	if (/^-?\d+(\.\d+)?$/.test(s)) return "number";
	if (/^(true|false)$/i.test(s)) return "boolean";
	if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return "date";
	if (/^https?:\/\/\S+$/i.test(s)) return "url";
	if (EMAIL.test(s)) return "email";
	if (/^[[{]/.test(s) && /[\]}]$/.test(s)) {
		try {
			const parsed: unknown = JSON.parse(s);
			return Array.isArray(parsed) ? "list" : "object";
		} catch {}
	}
	if (/<[a-z][^>]*>/i.test(s)) return "html";
	return "text";
}

/** A sample safe to keep: trimmed, cut short, emails masked. */
export function sampleOf(v: string): string {
	let s = v.trim().replace(/\s+/g, " ");
	if (s.length > SAMPLE_LENGTH) s = `${s.slice(0, SAMPLE_LENGTH)}…`;
	return s.replace(/([^\s@<>"':;,]{1})[^\s@<>"':;,]*@([^\s@<>"':;,]+\.[a-z]{2,})/gi, "$1***@$2");
}

export function addValue(stats: ValueStats, value: string, name?: string): void {
	stats.occ++;
	if (name !== undefined && stats.names.length < 3 && !stats.names.includes(name)) stats.names.push(name);
	if (value.trim() === "") return;
	stats.filled++;
	const shape = shapeOfValue(value);
	stats.shapes.set(shape, (stats.shapes.get(shape) ?? 0) + 1);
	if (shape === "number" && /^\d+$/.test(value.trim())) stats.rows += Number(value.trim());
	if (stats.samples.length < SAMPLE_CAP) {
		const sample = sampleOf(value);
		if (!stats.samples.includes(sample)) stats.samples.push(sample);
	}
}

/** The one shape the values share, "mixed" when they differ, "unknown" with no values. */
export function inferShape(stats: ValueStats): FieldShape {
	const shapes = [...stats.shapes.keys()];
	if (shapes.length === 0) return "unknown";
	if (shapes.length === 1) return shapes[0] as FieldShape;
	if (shapes.every((s) => s === "text" || s === "html")) return "html";
	return "mixed";
}

export const isSparse = (filled: number, total: number): boolean => total > 0 && filled * 2 < total;

export function sparseNote(filled: number, total: number): string {
	return filled === 0 ? `Never filled (0 of ${total}).` : `Filled on ${filled} of ${total}.`;
}

/** Confidence for a shape guessed from values alone. */
export function inferredConfidence(shape: FieldShape, filled: number, total: number): Confidence {
	if (shape === "unknown" || shape === "mixed" || shape === "serialized" || isSparse(filled, total)) return "low";
	return "medium";
}
