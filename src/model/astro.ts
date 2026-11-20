// model.json -> src/content.config.ts: Astro content collections with glob loaders and Zod.
//
// Each collection reads Markdown from content/<slug>/. The Markdown body holds the
// WordPress content, so the `content` field (post_content) is not in the frontmatter.
// Every field with `check` gets a "Check:" comment, so the reviewer sees it in the code.
// Taxonomy and menu data follow the starter's shape (content/taxonomies.json, content/menus.json).
//
// Image fields are optional here even when model.json requires them: Astro's image()
// fails the build for a missing file, and the media files are copied in only after the
// content, so a required image() would break every build until then. The field's
// "Check:" comment says to make it required once the media is in place.

import type { Collection, Model, ModelField } from "../contracts/model.ts";
import { canonical } from "../contracts/write.ts";

// Every value here can come from the old site, so each is escaped for its spot:
// comments go through safeText (one line, no "*/"), strings through JSON.stringify,
// and object keys are bare only when they are safe identifiers.
export function safeText(text: string): string {
	let s = text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
	while (s.includes("*/")) s = s.replaceAll("*/", "* /");
	return s;
}
const comment = (text: string): string => `/** ${safeText(text)} */`;
const str = (s: string): string => JSON.stringify(s);
const SAFE_KEY = /^[a-z_][a-z0-9_]*$/;
/** An object key: bare when safe, else quoted. `__proto__` is computed so it stays a plain key. */
export function key(name: string): string {
	if (name === "__proto__") return `[${str(name)}]`;
	return SAFE_KEY.test(name) ? name : str(name);
}

function zodFor(f: ModelField): string {
	let z: string;
	switch (f.type) {
		case "string":
		case "text":
		case "slug":
		case "portableText":
		case "file":
			z = "z.string()";
			break;
		case "url":
			z = "z.url()";
			break;
		case "number":
			z = "z.number()";
			break;
		case "integer":
			z = "z.number().int()";
			break;
		case "boolean":
			z = "z.boolean()";
			break;
		case "datetime":
			z = "z.coerce.date()";
			break;
		case "select":
			z = f.options?.length ? `z.enum([${f.options.map(str).join(", ")}])` : "z.string()";
			break;
		case "multiSelect":
			z = `z.array(${f.options?.length ? `z.enum([${f.options.map(str).join(", ")}])` : "z.string()"})`;
			break;
		case "image":
			// Optional until the media files are copied in (see the header).
			return "image().optional()";
		case "reference":
			z = f.target ? `reference(${str(f.target)})` : "z.string()";
			break;
		case "repeater":
			z = `z.array(z.object({ ${(f.subfields ?? []).map((s) => `${key(s.name)}: ${zodFor(s)}`).join(", ")} }))`;
			break;
		default:
			z = "z.unknown()";
	}
	return f.required ? z : `${z}.optional()`;
}

const usesIn = (c: Collection, type: string): boolean => {
	const walk = (fields: ModelField[]): boolean => fields.some((f) => f.type === type || walk(f.subfields ?? []));
	return walk(c.fields);
};

const IMAGE_LATER = "Required in model.json; optional here so the site builds before the media files are copied into the project. Remove .optional() once every entry has its image file.";

function fieldCheck(f: ModelField): string | undefined {
	const parts = [f.check, f.type === "image" && f.required ? IMAGE_LATER : undefined, ...(f.subfields ?? []).filter((s) => s.check).map((s) => `${s.name}: ${s.check}`)].filter(Boolean);
	return parts.length ? parts.join(" ") : undefined;
}

function collectionBlock(c: Collection, model: Model): string[] {
	const fn = usesIn(c, "image");
	const pad = fn ? "\t\t\t\t" : "\t\t\t";
	const lines: string[] = [];
	const head = [`${c.label}. From WordPress post type ${c.from}.`];
	if (c.route) head.push(`URL: ${c.route}.`);
	if (c.fields.some((f) => f.name === "content" && f.type === "portableText")) head.push("The Markdown body is the content.");
	if (c.check) head.push(`Check: ${c.check}`);
	// "Left out" notes are not "Check:" notes: they name what the model does not keep.
	if (c.leftOut?.length) head.push(...c.leftOut);
	lines.push(`\t${comment(head.join(" "))}`);
	lines.push(`\t${key(c.slug)}: defineCollection({`);
	lines.push(`\t\tloader: glob({ pattern: "**/*.{md,mdx}", base: ${str(`./content/${c.slug}`)} }),`);
	lines.push(fn ? "\t\tschema: ({ image }) =>" : "\t\tschema: z.object({");
	if (fn) lines.push("\t\t\tz.object({");
	const used = new Set<string>();
	for (const f of c.fields) {
		if (f.name === "content" && f.type === "portableText") continue;
		const check = fieldCheck(f);
		if (check) lines.push(`${pad}${comment(`Check: ${check}`)}`);
		lines.push(`${pad}${key(f.name)}: ${zodFor(f)},`);
		used.add(f.name);
	}
	for (const t of c.taxonomies) {
		if (used.has(t)) continue;
		const tx = model.taxonomies.find((x) => x.slug === t);
		lines.push(`${pad}${comment(`Terms of the ${tx?.label ?? t} taxonomy, by slug.${tx?.check ? ` Check: ${tx.check}` : ""}`)}`);
		lines.push(`${pad}${key(t)}: z.array(z.string()).default([]),`);
		used.add(t);
	}
	if (c.supports.includes("drafts") && !used.has("draft")) lines.push(`${pad}draft: z.boolean().default(false),`);
	lines.push(fn ? "\t\t\t})," : "\t\t}),");
	lines.push("\t}),");
	return lines;
}

/** The text of src/content.config.ts for a model. */
export function toAstroConfig(input: Model): string {
	const model = canonical("model", input);
	const names = new Set(model.collections.map((c) => c.slug));
	const withTaxonomies = model.taxonomies.length > 0 && !names.has("taxonomies");
	const withMenus = model.menus.length > 0 && !names.has("menus");
	const imports = model.collections.some((c) => c.fields.some((f) => f.type === "reference" && f.target)) ? "defineCollection, reference" : "defineCollection";
	const loaders = withTaxonomies || withMenus ? "file, glob" : "glob";

	const out: string[] = [
				comment(`Content collections, proposed from ${model.site.url} by wp-content-model. Entries live in content/<collection>/ as Markdown. Review every "Check" comment.${model.collections.some((c) => usesIn(c, "image")) ? " Image fields are optional until the media files are copied into the project; image() fails the build for a missing file." : ""}`),
		`import { ${imports} } from "astro:content";`,
		`import { ${loaders} } from "astro/loaders";`,
		'import { z } from "astro/zod";',
		"",
	];
	if (withMenus) {
		out.push(
			"const menuItem: z.ZodType<{ label: string; href: string; children?: unknown[] }> = z.lazy(() =>",
			"\tz.object({ label: z.string(), href: z.string(), children: z.array(menuItem).optional() }),",
			");",
			"",
		);
	}
	out.push("export const collections = {");
	for (const c of model.collections) out.push(...collectionBlock(c, model));
	if (withTaxonomies) {
		out.push(
			`\t${comment(`One entry per taxonomy (${model.taxonomies.map((t) => t.slug).join(", ")}): { id, terms }.`)}`,
			"\ttaxonomies: defineCollection({",
			'\t\tloader: file("content/taxonomies.json", {',
			"\t\t\tparser: (text) => Object.entries(JSON.parse(text)).map(([id, terms]) => ({ id, terms })),",
			"\t\t}),",
			"\t\tschema: z.object({ terms: z.array(z.object({ slug: z.string(), label: z.string(), parent: z.string().optional() })) }),",
			"\t}),",
		);
	}
	if (withMenus) {
		out.push(
			`\t${comment(`One entry per menu (${model.menus.map((m) => m.name).join(", ")}): { id, items }.`)}`,
			"\tmenus: defineCollection({",
			'\t\tloader: file("content/menus.json", {',
			"\t\t\tparser: (text) => Object.entries(JSON.parse(text)).map(([id, items]) => ({ id, items })),",
			"\t\t}),",
			"\t\tschema: z.object({ items: z.array(menuItem) }),",
			"\t}),",
		);
	}
	out.push("};", "");
	return out.join("\n");
}
