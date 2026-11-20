// The plain-language steps the wp-content-model skill prints for moving a WordPress site
// into EmDash with EmDash's own importer (the EmDash Exporter plugin path), for a fresh
// EmDash site and for one that is already set up. test/emdash-import.test.ts follows
// them against a real EmDash site and a real WordPress site.
//
// Facts these steps rest on (EmDash 1.4.0, node_modules/emdash/src):
//   - A seed is applied once, by the setup wizard on first run (astro/routes/api/setup/
//     index.ts). It is read from .emdash/seed.json, then package.json "emdash.seed", then
//     seed/seed.json (astro/integration/virtual-modules.ts). A configured site never
//     applies it again.
//   - The importer's analysis shows each post type as Ready, Add fields, New collection or
//     Incompatible (the admin's import screen, from import/utils.ts
//     checkSchemaCompatibility). "Add fields" and "New collection" are fixed by the
//     wizard's prepare step (astro/routes/api/import/wordpress/prepare.ts), which adds the
//     missing ones with the types the Exporter reported. "Incompatible" blocks the import
//     of that post type until the field's type is changed.
//   - The Exporter guesses each field's type from one stored value (src/model/exporter.ts),
//     so a seed built from its analyze response (--emdash-analyze) is the exact match,
//     for the fields that response lists. The steps say which evidence built this seed.

/** The parts of seed.json (src/model/seed.ts) the steps read. */
export interface SeedField {
	slug: string;
	label: string;
	type: string;
	required?: boolean;
	searchable?: boolean;
}
export interface SeedCollection {
	slug: string;
	label: string;
	labelSingular?: string;
	description?: string;
	urlPattern?: string;
	supports?: string[];
	fields: SeedField[];
}
export interface SeedFile {
	collections: SeedCollection[];
	taxonomies?: { name: string; label: string; collections?: string[] }[];
}

export type SiteKind = "fresh" | "existing";

/** What the steps know about how the seed was made and what the old site has. */
export interface StepsContext {
	/** The seed was built from the Exporter's analyze response (--emdash-analyze). */
	analyze?: boolean;
	/** With `analyze`: the fields (collection.field) it does not list, so their types are guesses. */
	guessed?: string[];
	/** SEO plugins on the old site, by name (from the inventory). Without it, the seed's seo_ fields decide. */
	seo?: string[];
	/** The old site's Exporter analyze URL (its REST root + emdash/v1/analyze). */
	analyzeUrl?: string;
	/** The heading of a section above that already holds the analyze steps: refer to its step 2 instead of printing them again. */
	analyzeAbove?: string;
}

/** The Exporter analyze URL for a site: from its REST root (which may be ?rest_route=/), else its address + wp-json/. */
export function analyzeUrlFor(siteUrl: string, apiRoot?: string): string {
	const fallback = new URL("wp-json/", siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`).href;
	// apiRoot comes from the site (its Link header), so only an http(s) URL is used.
	const rootUrl = apiRoot && /^https?:\/\//i.test(apiRoot) ? apiRoot : fallback;
	return `${rootUrl}${rootUrl.endsWith("/") ? "" : "/"}emdash/v1/analyze`;
}

/** One shell word in single quotes. The URL comes from the site, so it must never run as code when pasted. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The command that writes the seed again from the saved analysis. */
export const RESEED = "node ~/wp-esc/bin/wp-content-model.mjs --model model.json --seed --emdash-analyze emdash-analyze.json";
const UNSET = "unset WPM_WP_USER WPM_WP_APP_PASSWORD";

// The SEO plugins whose titles and descriptions EmDash's Exporter import brings across
// (execute.ts IMPORT_FIELDS, from the post's yoast and rank_math blocks).
const IMPORTED_SEO = ["Yoast SEO", "Yoast SEO Premium", "Rank Math SEO"];

/**
 * The collections and fields to add by hand on an existing site, in seed order. A
 * collection made in Content Types starts with no fields, so title, content and excerpt
 * are listed too. Every field is optional: EmDash checks Required on each imported entry
 * and rejects an entry that lacks the value (execute.ts, "price_band: Invalid input"),
 * so Required is turned on after the import, if at all.
 */
export function schemaToAdd(seed: SeedFile): SeedCollection[] {
	return seed.collections.map((c) => ({ ...c, fields: c.fields.map(({ required: _required, ...f }) => f) }));
}

// The password never goes on a command line: the user sets the two variables in their own
// terminal (as for wp-inventory level 3). printf is a shell builtin, so it starts no process
// whose arguments others could see in ps; it hands curl the user and password as a config
// on stdin (-K -). `curl -u "$USER:$PASSWORD"` would put the password in curl's arguments.
function analyzeHow(about: StepsContext): string {
	const url = about.analyzeUrl ?? "https://your-site.example.com/wp-json/emdash/v1/analyze";
	return [
		"Make a new application password for an Administrator under Users > Profile > Application Passwords. It carries that user's full rights.",
		"In your own terminal, set WPM_WP_USER to the user name and WPM_WP_APP_PASSWORD to the password. Do not paste the password into a command.",
		`Save the analysis with \`printf 'user = "%s:%s"\\n' "$WPM_WP_USER" "$WPM_WP_APP_PASSWORD" | curl -K - ${shellQuote(url)} -o emdash-analyze.json\`, then run \`${RESEED}\`. This passes the password to curl on its input, not in the command, so other users cannot see it in the process list.`,
		`Then revoke the password under Users > Profile > Application Passwords, and run \`${UNSET}\`.`,
		"The file lists the site's authors and their email addresses, so keep it private and delete it after the move.",
	].join(" ");
}

function exporterSteps(about: StepsContext): string[] {
	const install = "On the WordPress site, install and activate the EmDash Exporter plugin, version 1.2.0 or later (from github.com/emdash-cms/wp-emdash). It needs an Administrator account.";
	if (!about.analyze && about.analyzeAbove) return [install, `This seed's custom field types follow the Exporter's rules on the inventory's samples, which can differ on a few fields. For an exact match with the import screen, save the Exporter's analysis and build the seed again, as step 2 under "${about.analyzeAbove}" says.`];
	if (!about.analyze) return [install, `This seed's custom field types follow the Exporter's rules on the inventory's samples, which can differ on a few fields. Most reliable for an existing WordPress site: build the seed again from the Exporter's own analysis, so its fields match what the import screen asks for exactly. ${analyzeHow(about)}`];
	const guessed = about.guessed ?? [];
	const except = guessed.length ? ` The analysis does not list ${guessed.join(", ")}, so ${guessed.length > 1 ? "their types are guesses" : "its type is a guess"}; watch for ${guessed.length > 1 ? "them" : "it"} on the import screen.` : "";
	if (about.analyzeAbove) return [install, `This seed was built from the Exporter's own analysis (--emdash-analyze).${except} If the WordPress fields change before the import, save the analysis again and rebuild the seed, as step 2 under "${about.analyzeAbove}" says.`];
	return [install, `This seed was built from the Exporter's own analysis (--emdash-analyze), the most reliable path, so its fields match what the import screen asks for.${except} If the WordPress fields change before the import, save the analysis again and rebuild the seed. ${analyzeHow(about)}`];
}

/** The SEO lines for the import screen; none when the old site has no SEO data. */
function seoStep(seed: SeedFile, about: StepsContext): string[] {
	const seedHasSeo = seed.collections.some((c) => c.fields.some((f) => f.slug === "seo_title" || f.slug === "seo_description"));
	const names = about.seo ?? [];
	const read = [...new Set(names.filter((n) => IMPORTED_SEO.includes(n)).map((n) => n.replace(" Premium", "")))];
	const other = names.filter((n) => !IMPORTED_SEO.includes(n));
	const out: string[] = [];
	if (read.length || seedHasSeo) out.push(`Leave SEO on. ${read.length ? read.join(" and ") : "Yoast SEO and Rank Math SEO"} titles and descriptions arrive as the seo_title and seo_description fields.`);
	if (other.length) out.push(`EmDash's import reads SEO titles and descriptions only from Yoast SEO and Rank Math SEO, so those from ${other.join(" and ")} do not come across; copy the important ones by hand in each entry's SEO panel.`);
	return out;
}

function connectSteps(): string[] {
	return [
		"In WordPress, open Tools > EmDash Migration and copy the migration key.",
		"In the EmDash admin, open Import > WordPress, enter the site's address, and paste the key.",
	];
}

function statusSteps(seed: SeedFile, about: StepsContext): string[] {
	return [
		"Check each post type on the import screen. Ready: go on. Add fields or New collection: leave it on, and the import adds what is missing with the types WordPress reports. Incompatible: a field has the wrong type; open Content Types, change that field to the type the screen names (or delete it and let the import add it), then run the check again.",
		...seoStep(seed, about),
		"Start the import. Media comes in its own step after the content.",
	];
}

/**
 * Fields to leave to the import screen on an existing site: Content Types makes a reference
 * field only with a target collection (api/handlers/schema.ts handleSchemaFieldCreate), which
 * turns it into a relation with no stored value. The import's prepare step makes the plain
 * reference field the Exporter's value fits.
 */
export const leaveToImport = (f: SeedField): boolean => f.type === "reference";

function fieldLine(f: SeedField): string {
	const base = `${f.slug} ("${f.label}"), type ${f.type}`;
	return leaveToImport(f) ? `${base} (skip it here: the import screen adds it, since Content Types would ask for a target collection)` : base;
}

/** The numbered steps, as lines of text. */
export function emdashSteps(seed: SeedFile, kind: SiteKind, about: StepsContext = {}): string[] {
	const steps: string[] = [...exporterSteps(about)];
	if (kind === "fresh") {
		steps.push(
			"Copy seed/seed.json into your EmDash project, at seed/seed.json (or point package.json \"emdash\": { \"seed\": ... } at it). Do this before the site runs for the first time.",
			"Start the site and open the admin. The setup wizard applies the seed: it makes the collections, fields, taxonomies and menus, with no content. Then create your admin account.",
		);
	} else {
		steps.push("Your EmDash site is already set up, so it will not apply seed.json. Add the collections and fields below in the admin under Content Types (skip any that exist with the same type). Leave every field optional until the import is done. Or skip this step and let the import add them for you (see the import screen check below).");
		for (const c of schemaToAdd(seed)) {
			const where = c.urlPattern ? `, URL pattern ${c.urlPattern}` : "";
			const fields = `: ${c.fields.map(fieldLine).join("; ")}`;
			steps.push(`  - Collection ${c.slug} ("${c.label}"${where})${fields}.`);
		}
		for (const t of seed.taxonomies ?? []) steps.push(`  - Taxonomy ${t.name} ("${t.label}") for ${(t.collections ?? []).join(", ") || "all collections"}.`);
	}
	steps.push(...connectSteps(), ...statusSteps(seed, about));
	let n = 0;
	return steps.map((s) => (s.startsWith("  - ") ? s : `${++n}. ${s}`));
}

/** The steps as one block of text, the way the skill prints them. */
export function emdashStepsText(seed: SeedFile, kind: SiteKind, about: StepsContext = {}): string {
	return `${emdashSteps(seed, kind, about).join("\n")}\n`;
}
