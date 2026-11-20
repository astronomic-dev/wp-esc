// A small JSON Schema checker for the subset our schemas use:
// type, const, enum, properties, required, additionalProperties (false or a schema),
// items, $ref to "#/$defs/...", anyOf, oneOf, minimum, minItems, pattern, uniqueItems.
// It throws on any keyword it does not know, so a schema cannot quietly use more.

type Schema = Record<string, unknown> | boolean;

const KNOWN = new Set([
	"$schema",
	"$id",
	"$defs",
	"$ref",
	"title",
	"description",
	"type",
	"const",
	"enum",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"anyOf",
	"oneOf",
	"minimum",
	"minItems",
	"pattern",
	"uniqueItems",
]);

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}

function typeMatches(want: string, value: unknown): boolean {
	const got = typeOf(value);
	if (want === "number") return got === "number" || got === "integer";
	return want === got;
}

export function checkSchema(root: Record<string, unknown>, value: unknown): string[] {
	const errors: string[] = [];
	const defs = (root.$defs ?? {}) as Record<string, Schema>;

	function resolve(ref: string): Schema {
		const prefix = "#/$defs/";
		if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref ${ref}`);
		const def = defs[ref.slice(prefix.length)];
		if (def === undefined) throw new Error(`missing $def ${ref}`);
		return def;
	}

	function walk(schema: Schema, v: unknown, path: string, out: string[]): void {
		if (schema === true) return;
		if (schema === false) {
			out.push(`${path}: not allowed`);
			return;
		}
		for (const key of Object.keys(schema)) {
			if (!KNOWN.has(key)) throw new Error(`schema keyword not supported by the checker: ${key} at ${path}`);
		}
		if (typeof schema.$ref === "string") walk(resolve(schema.$ref), v, path, out);
		if (schema.type !== undefined) {
			const types = Array.isArray(schema.type) ? schema.type : [schema.type];
			if (!types.some((t) => typeMatches(t as string, v))) {
				out.push(`${path}: expected ${types.join("|")}, got ${typeOf(v)}`);
				return;
			}
		}
		if ("const" in schema && v !== schema.const) out.push(`${path}: expected ${JSON.stringify(schema.const)}`);
		if (Array.isArray(schema.enum) && !schema.enum.includes(v)) out.push(`${path}: ${JSON.stringify(v)} not in enum`);
		if (typeof schema.minimum === "number" && typeof v === "number" && v < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
		if (typeof schema.pattern === "string" && typeof v === "string" && !new RegExp(schema.pattern, "u").test(v)) {
			out.push(`${path}: ${JSON.stringify(v)} does not match ${schema.pattern}`);
		}
		if (Array.isArray(v)) {
			if (typeof schema.minItems === "number" && v.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
			if (schema.uniqueItems === true) {
				const seen = new Set(v.map((x) => JSON.stringify(x)));
				if (seen.size !== v.length) out.push(`${path}: items not unique`);
			}
			if (schema.items !== undefined) v.forEach((item, i) => walk(schema.items as Schema, item, `${path}[${i}]`, out));
		}
		if (typeOf(v) === "object") {
			const obj = v as Record<string, unknown>;
			const props = (schema.properties ?? {}) as Record<string, Schema>;
			for (const req of (schema.required ?? []) as string[]) {
				if (!(req in obj)) out.push(`${path}: missing ${req}`);
			}
			for (const [k, child] of Object.entries(obj)) {
				if (k in props) walk(props[k] as Schema, child, `${path}.${k}`, out);
				else if (schema.additionalProperties !== undefined) {
					walk(schema.additionalProperties as Schema, child, `${path}.${k}`, out);
				}
			}
		}
		for (const word of ["anyOf", "oneOf"] as const) {
			const list = schema[word];
			if (!Array.isArray(list)) continue;
			const passing = list.filter((s) => {
				const sub: string[] = [];
				walk(s as Schema, v, path, sub);
				return sub.length === 0;
			}).length;
			if (word === "anyOf" ? passing === 0 : passing !== 1) out.push(`${path}: ${word} matched ${passing}`);
		}
	}

	walk(root, value, "$", errors);
	return errors;
}

// Reads `export interface X { ... }` and `export type X = "a" | "b";` from a contract source,
// so a test can compare the TypeScript shapes with the JSON Schema.

export interface Member {
	name: string;
	optional: boolean;
	type: string;
	inline?: Member[];
}

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function splitTop(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of body) {
		if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth++;
		if (ch === "}" || ch === ")" || ch === "]" || ch === ">") depth--;
		if (depth === 0 && (ch === ";" || ch === "\n")) {
			if (cur.trim()) parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts;
}

function parseMembers(body: string): Member[] {
	return splitTop(body).map((part) => {
		const m = /^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(part);
		if (!m) throw new Error(`cannot parse member: ${part}`);
		const type = (m[3] as string).trim();
		const member: Member = { name: m[1] as string, optional: m[2] === "?", type };
		if (type.startsWith("{") && type.endsWith("}")) member.inline = parseMembers(type.slice(1, -1));
		return member;
	});
}

function matchBrace(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		if (src[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	throw new Error("unbalanced braces");
}

export function readContract(source: string): { interfaces: Map<string, Member[]>; unions: Map<string, (string | number)[]> } {
	const src = stripComments(source);
	const interfaces = new Map<string, Member[]>();
	const unions = new Map<string, (string | number)[]>();
	const ifaceRe = /export interface (\w+)\s*\{/g;
	for (let m = ifaceRe.exec(src); m; m = ifaceRe.exec(src)) {
		const open = m.index + m[0].length - 1;
		const close = matchBrace(src, open);
		interfaces.set(m[1] as string, parseMembers(src.slice(open + 1, close)));
	}
	const unionRe = /export type (\w+)\s*=\s*([^;]+);/g;
	for (let m = unionRe.exec(src); m; m = unionRe.exec(src)) {
		const parts = (m[2] as string).split("|").map((p) => p.trim());
		if (parts.every((p) => /^"[^"]*"$/.test(p) || /^\d+$/.test(p))) {
			unions.set(m[1] as string, parts.map((p) => (p.startsWith('"') ? p.slice(1, -1) : Number(p))));
		}
	}
	return { interfaces, unions };
}

// Shape strings, so a test can compare a member's TypeScript type with its schema node.
// "string", "number" (integer or number), "boolean", "null", "const", "ref:Name",
// "array<...>", "record<...>", "object", "enum:a,b" and unions "a|b" (sorted).

function splitUnion(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of text) {
		if ("{(<[".includes(ch)) depth++;
		if ("})>]".includes(ch)) depth--;
		if (depth === 0 && ch === "|") {
			parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	parts.push(cur.trim());
	return parts.filter(Boolean);
}

const isLiteral = (p: string): boolean => /^"[^"]*"$/.test(p) || /^\d+$/.test(p);

function enumShape(values: unknown[]): string {
	return `enum:${values.map(String).sort().join(",")}`;
}

export function tsShape(text: string): string {
	const parts = splitUnion(text.trim());
	const literals = parts.filter(isLiteral);
	const others = parts.filter((p) => !isLiteral(p));
	const shapes = others.map((p) => {
		if (p.endsWith("[]")) return `array<${tsShape(p.slice(0, -2))}>`;
		const rec = /^Record<\s*string\s*,\s*([\s\S]+)>$/.exec(p);
		if (rec) return `record<${tsShape(rec[1] as string)}>`;
		if (p.startsWith("{")) return "object";
		if (p.startsWith("typeof ")) return "const";
		if (p === "string" || p === "number" || p === "boolean" || p === "null") return p;
		if (/^[A-Z]\w*$/.test(p)) return `ref:${p}`;
		throw new Error(`tsShape cannot read ${p}`);
	});
	if (literals.length === 1 && others.length > 0) shapes.push("const");
	else if (literals.length > 0) shapes.push(enumShape(literals.map((l) => (l.startsWith('"') ? l.slice(1, -1) : l))));
	return shapes.sort().join("|");
}

export function schemaShape(node: Record<string, unknown>): string {
	if (typeof node.$ref === "string") return `ref:${node.$ref.replace("#/$defs/", "")}`;
	if ("const" in node) return "const";
	if (Array.isArray(node.enum)) return enumShape(node.enum);
	if (Array.isArray(node.anyOf)) return node.anyOf.map((n) => schemaShape(n as Record<string, unknown>)).sort().join("|");
	const types = (Array.isArray(node.type) ? node.type : [node.type]) as string[];
	return types
		.map((t) => {
			if (t === "integer") return "number";
			if (t === "array") return `array<${schemaShape(node.items as Record<string, unknown>)}>`;
			if (t === "object") {
				const extra = node.additionalProperties;
				if (extra && typeof extra === "object") return `record<${schemaShape(extra as Record<string, unknown>)}>`;
				return "object";
			}
			return t;
		})
		.sort()
		.join("|");
}
