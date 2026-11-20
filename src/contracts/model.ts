// The content model contract: the proposed new site, mapped from WordPress.
// Frozen after Chunk 0a. schema/model.schema.json mirrors it; a test keeps them in step.
//
// Every collection, field, taxonomy and menu names its WordPress source in `from`.
// The EmDash import steps and the redirect plan read that mapping; no code guesses names twice.
//
// Route patterns are site paths with tokens:
//   {slug}  the entry or term slug
//   {path}  the full hierarchical path, for pages (for example `about/team`)
// Locale prefixes are not in patterns; each locale's `prefix` says where its URLs live.
//
// Field types are EmDash's seed field types, so the seed writer maps one to one.
// Order matters in `fields`, `subfields`, menu `items` and `children`, and `options`.
// Fields keep the inventory's source order (Field.order where the inventory has it).

import type { Locale } from "./inventory.ts";

export const MODEL_VERSION = 1;

export type ModelFieldType = "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select" | "multiSelect" | "image" | "file" | "reference" | "slug" | "repeater" | "portableText" | "json";
export type CollectionSupport = "drafts" | "revisions" | "preview" | "scheduling" | "search" | "seo";
export type RouteKind = "home" | "blog" | "archive" | "feed" | "author" | "search"; // archive: a collection index, with `collection`

export interface Model {
	version: typeof MODEL_VERSION;
	site: { url: string; name?: string; tagline?: string };
	locales: Locale[];
	collections: Collection[];
	taxonomies: ModelTaxonomy[];
	menus: ModelMenu[];
	routes: Route[]; // pages that are not one entry or term: home, blog index, collection archives, feed, author archive, search
	leftOut?: string[]; // "Left out" notes about the site as a whole (post types the model does not keep); never in `check`
}

export interface Collection {
	slug: string; // new name; EmDash slug rules: /^[a-z][a-z0-9_]*$/
	from: string; // WordPress post type slug
	label: string;
	labelSingular?: string;
	hierarchical?: boolean;
	route: string | null; // for example `/blog/{slug}/` or `/{path}/`; null when entries have no page
	supports: CollectionSupport[];
	taxonomies: string[]; // ModelTaxonomy slugs
	fields: ModelField[];
	check?: string; // a note for the reviewer
	leftOut?: string[]; // "Left out" notes: inventory keys the collection does not keep; never in `check`
}

export interface ModelField {
	name: string; // new field slug
	from: string; // inventory Field key (for subfields, the subfield key)
	label: string;
	type: ModelFieldType;
	required: boolean;
	searchable?: boolean;
	target?: string; // reference fields: the target collection slug
	options?: string[]; // select and multiSelect
	subfields?: ModelField[]; // repeater rows
	check?: string; // set on every low-confidence field: why to check it
}

export interface ModelTaxonomy { slug: string; from: string; label: string; labelSingular?: string; hierarchical: boolean; collections: string[]; route?: string; check?: string }
export interface ModelMenu { name: string; from: string; label: string; items: ModelMenuItem[]; check?: string }
export interface ModelMenuItem { label: string; url: string; children?: ModelMenuItem[] }
export interface Route { kind: RouteKind; pattern: string; collection?: string }
