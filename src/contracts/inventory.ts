// The inventory contract: what one run learned about a WordPress site.
// Frozen after Chunk 0a. schema/inventory.schema.json mirrors it; a test keeps them in step.
//
// Rules the types encode:
// - A type seen only by name (for example `show_in_rest: false` with no other evidence)
//   is never invented: `count` stays unset and its coverage line says `not-visible`.
// - Duplicate slugs across types and parents are allowed in `urls`. The key is the URL.
// - Coverage areas are short names: "rest", "sitemaps", "html", "wxr", "plugins",
//   "settings", "menus", "users", and "type:<slug>" or "taxonomy:<slug>" for one list.
// - URLs in `urls`, `menus` and `samples` are absolute, on the site's own origin.
// - Ledger URLs (`urls[].url`, `translationOf`) are in canonical form; see url.ts.
//   The origin is the site's origin (lowercase, no default port), the path is kept as
//   served (trailing slash too), query keys are sorted, and there is no fragment.
// - `authors`, `media` and `comments` are left out when no source gave a count. Never guess one.
//   `authors` counts people who wrote content (WXR authors, REST users with posts); the
//   "users" coverage line counts every account, so the two can differ.
// - Coverage areas also include "comments".

export const INVENTORY_VERSION = 1;
export type Level = 1 | 2 | 3;
export type Confidence = "high" | "medium" | "low";
export type Source = "rest" | "sitemap" | "html" | "wxr" | "auth";

export interface Inventory {
	version: typeof INVENTORY_VERSION;
	site: { url: string; apiRoot?: string; name?: string; tagline?: string; wpVersion?: string; locales: Locale[]; theme?: string };
	levels: Level[];
	coverage: Coverage[];
	types: ContentType[];
	taxonomies: Taxonomy[];
	plugins: Plugin[];
	builders: Usage[]; // page builders, with page counts
	shortcodes: Usage[]; // from raw content (WXR or auth) and unrendered tags in HTML
	blocks: Usage[]; // from block comments in raw content and block classes in HTML
	menus: Menu[];
	authors?: { count: number; source: Source };
	media?: { count: number; source: Source };
	comments?: { count: number; source: Source; byType?: Record<string, number>; pending?: number }; // byType: post type slug to its comment count, when the source splits them. pending: comments not approved (WXR comment_approved 0, REST status hold), counted in `count`
	permalinks: { structure?: string; source: Source; confidence: Confidence };
	urls: UrlEntry[]; // the URL ledger
	storedElsewhere: StoredData[]; // plugin data the export does not carry, only when a storing plugin is found
}

export interface Coverage { area: string; source: Source; status: "complete" | "partial" | "failed" | "not-visible"; detail: string }
// count: all statuses together; byStatus splits it. unpublished: drafts, private and pending
// items, at most MAX_UNPUBLISHED_PER_TYPE (limits.ts), from the export or the password.
export interface ContentType { slug: string; label?: string; count?: number; byStatus: Record<string, number>; unpublished?: { title: string; status: string }[]; hierarchical?: boolean; restBase?: string; inRest?: boolean; fields: Field[]; taxonomies: string[]; sources: Source[] }
// A field. `source` says which reader saw it; merge ranks field data by it (wxr > auth > rest > html).
// subfields: repeater rows. layouts: flexible content (shape "flexible"), one per layout.
// targets: related post types (relation fields). options: choices in source order (select, radio).
// order: source order, for example ACF menu_order; the model keeps fields in this order.
export interface Field { key: string; label?: string; group?: string; owner: "core" | "acf" | "meta" | "seo" | "builder"; shape: FieldShape; source: Source; order?: number; subfields?: Field[]; layouts?: Layout[]; targets?: string[]; options?: string[]; filled: number; total: number; samples: string[]; confidence: Confidence; note?: string }
export interface Layout { name: string; label?: string; subfields: Field[] }
export type FieldShape = "text" | "html" | "number" | "boolean" | "date" | "url" | "email" | "image" | "file" | "relation" | "list" | "object" | "repeater" | "flexible" | "serialized" | "mixed" | "unknown";
export interface Taxonomy { slug: string; label?: string; hierarchical?: boolean; count?: number; types: string[]; sources: Source[] }
// slug: the plugin's folder name under wp-content/plugins.
export interface Plugin { slug: string; name?: string; version?: string; active?: boolean; category: PluginCategory; source: Source; confidence: Confidence }
export type PluginCategory = "seo" | "forms" | "form-storage" | "store" | "members" | "courses" | "builder" | "fields" | "cache" | "security" | "analytics" | "comments" | "search" | "media" | "multilingual" | "redirects" | "other";
export interface Usage { name: string; count: number; samples: string[] }
// id: the WordPress menu term ID, when a source gave it. kind: "block" = links read from a
// wp_navigation post (a Navigation block), named by its title; its items get ids 1…N in order.
// Unset or "classic" = a classic menu.
export interface Menu { id?: number; name: string; kind?: "classic" | "block"; location?: string; items: MenuItem[]; source: Source }
export interface MenuItem { title: string; url: string; target?: { kind: UrlKind; type?: string; id?: number }; parent?: number; order: number; id: number }
export interface UrlEntry {
	url: string; kind: UrlKind; source: Source[];
	type?: string; id?: number; slug?: string; parentId?: number; path?: string; // parentId, path: the parent and full hierarchical path, for pages and nested terms
	taxonomy?: string; termId?: number; count?: number; locale?: string; translationOf?: string;
	// file: attachments only, the absolute upload file URL. An attachment's parentId is its
	// WXR post_parent, or else the first published post that uses it as _thumbnail_id.
	file?: string;
	// count: terms only, the entries WordPress counts in the term (published, child terms not
	// included), when REST gave it. 0 means the term's own list is empty; its page may still
	// show child terms' entries on WordPress. path on a term is its place in the term tree,
	// not its URL path: a taxonomy can serve nested terms at /<base>/<slug>/.
	evidence: "listed" | "linked" | "resolved"; // listed by API/sitemap, linked in HTML, or fetched and returned 200
}
export type UrlKind = "post" | "page" | "custom" | "category" | "tag" | "term" | "author" | "date" | "feed" | "attachment" | "paged" | "query" | "home" | "archive" | "other"; // archive: a post type archive, with `type`
export interface StoredData { plugin: string; what: string }
// A site language. prefix: the URL prefix without slashes (for example "fr"); unset when the locale has none.
export interface Locale { code: string; prefix?: string; default?: boolean }
