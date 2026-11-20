// The smallest EmDash site, for the wp-esc import proof (test/emdash-import.test.ts).
// test/emdash/site.ts copies this folder to a temp folder, links the starter's installed
// packages into node_modules, and runs `astro dev` (EmDash's setup bypass is dev only).
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
		}),
	],
});
