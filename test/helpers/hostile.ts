// A model built from hostile old-site values, for the injection tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Inventory } from "../../src/contracts/inventory.ts";
import type { Model } from "../../src/contracts/model.ts";
import { propose } from "../../src/model/index.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const PAYLOAD = "*/ process.exit(1); /*";

export function hostileModel(): Model {
	const inv = JSON.parse(readFileSync(root + "test/samples/business.inventory.json", "utf8")) as Inventory;
	const service = inv.types.find((t) => t.slug === "service");
	if (!service) throw new Error("no service type");
	service.label = PAYLOAD;
	const tagline = service.fields.find((f) => f.key === "tagline");
	if (tagline) {
		tagline.key = 'tag"line\n*/ process.exit(1); //';
		tagline.label = `Tag ${PAYLOAD}\n\u2028line`;
	}
	const price = service.fields.find((f) => f.key === "price_band");
	if (price?.options) price.options = [...price.options, `"]); process.exit(1); //`, PAYLOAD];
	const award = service.fields.find((f) => f.key === "award");
	if (award) award.note = PAYLOAD;
	const tax = inv.taxonomies.find((t) => t.slug === "service_area");
	if (tax) tax.label = PAYLOAD;
	inv.menus[0]!.name = PAYLOAD;
	const m = propose(inv);
	m.site.url = "https://example.com/*/process.exit(1);/*/";
	// A taxonomy name that is not a safe identifier: EmDash keeps WordPress taxonomy names raw.
	m.taxonomies.push({ slug: 'bad-tax"', from: 'bad-tax"', label: PAYLOAD, hierarchical: false, collections: ["service"] });
	m.collections.find((c) => c.slug === "service")!.taxonomies.push('bad-tax"');
	m.collections.find((c) => c.slug === "team")!.check = PAYLOAD;
	return m;
}

/** The code left once comments and string literals are taken out. */
export function liveCode(ts: string): string {
	return ts.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}
