// Runs the minimal EmDash site in test/emdash/site/ for the import proof.
//
// The site uses the starter's installed packages (astro, emdash, the Node adapter, React),
// linked into a temp copy, so wp-esc adds no dependency. It runs `astro dev`: EmDash's
// setup bypass, which stands in for the passkey a person makes on first run, is dev only.
// fetch-shim.mjs is preloaded so EmDash's importer can reach the local test WordPress
// (see that file). `--ignore-lock` keeps it in the foreground (Astro backgrounds it
// on its own when it detects an agent) so stop() can end it.

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const starterModules = join(here, "../../../../starters/starter/node_modules");
const LINKED = ["astro", "emdash", "@astrojs/node", "@astrojs/react", "react", "react-dom"];

/** The starter's installed copy of a package, or undefined. */
export function starterPackage(name: string): string | undefined {
	const p = join(starterModules, name);
	return existsSync(join(p, "package.json")) ? realpathSync(p) : undefined;
}

export interface SiteOptions {
	port: number;
	/** seed.json text for a fresh site; none for a site that starts from EmDash's default. */
	seed?: string;
	/** The made-up public host the importer is given, and where it really goes. */
	shimHost: string;
	shimTarget: string;
}

export interface Site {
	origin: string;
	dir: string;
	/** Logs from `astro dev`, for failure messages. */
	log(): string;
	stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startSite(opts: SiteOptions): Promise<Site> {
	const dir = mkdtempSync(join(tmpdir(), "wpm-emdash-"));
	cpSync(join(here, "site"), dir, { recursive: true });
	for (const name of LINKED) {
		const from = starterPackage(name);
		if (!from) throw new Error(`cannot resolve ${name} from starters/starter; run pnpm install`);
		mkdirSync(dirname(join(dir, "node_modules", name)), { recursive: true });
		symlinkSync(from, join(dir, "node_modules", name), "dir");
	}
	if (opts.seed !== undefined) {
		mkdirSync(join(dir, "seed"));
		writeFileSync(join(dir, "seed/seed.json"), opts.seed);
	}

	const astroBin = join(starterPackage("astro") as string, "bin/astro.mjs");
	let out = "";
	const child: ChildProcess = spawn(process.execPath, ["--import", join(here, "fetch-shim.mjs"), astroBin, "dev", "--ignore-lock", "--port", String(opts.port), "--host", "127.0.0.1"], {
		cwd: dir,
		env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", WPM_SHIM_HOST: opts.shimHost, WPM_SHIM_TARGET: opts.shimTarget, NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (d) => (out += d));
	child.stderr?.on("data", (d) => (out += d));
	let exited = false;
	child.on("exit", () => (exited = true));

	const origin = `http://127.0.0.1:${opts.port}`;
	const stop = async (): Promise<void> => {
		if (!exited) {
			child.kill("SIGTERM");
			for (let i = 0; i < 50 && !exited; i++) await sleep(100);
			if (!exited) child.kill("SIGKILL");
		}
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		for (let i = 0; ; i++) {
			if (exited) throw new Error(`astro dev exited:\n${out.slice(-3000)}`);
			try {
				const r = await fetch(`${origin}/_emdash/api/setup/status`, { signal: AbortSignal.timeout(30000) });
				if (r.status < 500) break;
			} catch {}
			if (i > 240) throw new Error(`astro dev did not come up:\n${out.slice(-3000)}`);
			await sleep(500);
		}
	} catch (e) {
		await stop();
		throw e;
	}
	return { origin, dir, log: () => out, stop };
}
