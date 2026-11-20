// The site-bound fetch door (contract: src/contracts/fetch.ts).
//
// One door per site origin (scheme, host and port). Every rule below is enforced here,
// before the transport opens a socket:
// - GET and HEAD only.
// - HTTPS only; http: only for the host `localhost` with WPM_ALLOW_HTTP_LOCALHOST=1.
// - No user or password in the start URL.
// - Paths stay on the origin. Redirects inside it are followed (up to 5); a redirect to
//   any other origin is not followed: it throws an "origin" error with the `target`.
// - Before every request and every redirect hop the host is resolved and every address
//   must be public (loopback only for `localhost` under the test flag). The transport is
//   then pinned to the checked address, so a second DNS answer cannot switch it.
// - The Basic auth header goes only to `wp/v2` paths under the API root set with
//   setApiRoot, and never on a redirect hop.
// - Credentials come only from WPM_WP_USER and WPM_WP_APP_PASSWORD. Every string that
//   leaves the door (bodies, headers, URLs, errors, log lines) is redacted.
// - A request cap (default 2,000), a rate cap (default 5 per second), and 2 retries
//   with backoff on 429 and 5xx.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import type { FetchOptions, SiteFetch, SiteResponse } from "../contracts/fetch.ts";
import { isLoopback, isPublicAddress } from "./address.ts";
import { makeRedactor } from "./redact.ts";

export type ErrorCode =
	| "method" | "scheme" | "credentials" | "path" | "origin" | "address" | "redirects" | "cap" | "size" | "transport";

export class SiteFetchError extends Error {
	readonly code: ErrorCode;
	/** For a redirect to another origin: where it pointed (redacted). No request goes there. */
	readonly target?: string;
	constructor(code: ErrorCode, message: string, target?: string) {
		super(message);
		this.name = "SiteFetchError";
		this.code = code;
		if (target !== undefined) this.target = target;
	}
}

export interface RawRequest {
	url: URL;
	method: "GET" | "HEAD";
	headers: Record<string, string>;
	/** The checked address the transport must connect to. */
	address: string;
	family: 4 | 6;
}
export interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: string }
export type Transport = (req: RawRequest) => Promise<RawResponse>;
export type Resolver = (host: string) => Promise<string[]>;

export interface SiteFetchOptions {
	/** The site's start URL. Only its origin binds the door. */
	url: string;
	/** Where the flags and credentials are read from. Default: process.env. */
	env?: Record<string, string | undefined>;
	transport?: Transport;
	resolve?: Resolver;
	maxRequests?: number;
	/** Requests per second. */
	rate?: number;
	retries?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Receives one redacted line per request. */
	log?: (line: string) => void;
}

export type BoundSiteFetch = SiteFetch & {
	readonly origin: string;
	/** Sets the discovered API root (absolute, same origin). Auth is scoped under it. */
	setApiRoot(root: string): void;
	/** Transport calls made so far. */
	requests(): number;
};

const MAX_REDIRECTS = 5;
const MAX_BODY = 25 * 1024 * 1024;
const IDLE_TIMEOUT = 30_000;
const DEADLINE = 120_000;
const MAX_RETRY_WAIT = 30_000;
const UA = "wp-esc (WordPress inventory)";

const defaultResolve: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * A node:http(s) transport that connects only to the address it is given. `idleMs` ends a
 * request whose socket goes quiet; `deadlineMs` ends any request that runs too long in all,
 * however slowly bytes keep arriving.
 */
export function createNodeTransport(limits: { idleMs?: number; deadlineMs?: number } = {}): Transport {
	const idleMs = limits.idleMs ?? IDLE_TIMEOUT;
	const deadlineMs = limits.deadlineMs ?? DEADLINE;
	return (req) => new Promise((resolve, reject) => {
		const send = req.url.protocol === "https:" ? httpsRequest : httpRequest;
		const signal = AbortSignal.timeout(deadlineMs);
		let settled = false;
		const failOnce = (e: SiteFetchError): void => {
			if (settled) return;
			settled = true;
			reject(e);
		};
		const r = send(
			req.url,
			{
				method: req.method,
				headers: { ...req.headers, "accept-encoding": "gzip, deflate, br" },
				agent: false,
				timeout: idleMs,
				signal,
				lookup: (_host, opts, cb) => {
					const all = (opts as { all?: boolean }).all;
					if (all) (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: req.address, family: req.family }]);
					else (cb as (e: null, a: string, f: number) => void)(null, req.address, req.family);
				},
			},
			(res) => {
				const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
				let stream: Readable = res;
				if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(createGunzip());
				else if (enc === "deflate") stream = res.pipe(createInflate());
				else if (enc === "br") stream = res.pipe(createBrotliDecompress());
				const chunks: Buffer[] = [];
				let size = 0;
				stream.on("data", (c: Buffer) => {
					size += c.length;
					if (size > MAX_BODY) {
						r.destroy();
						failOnce(new SiteFetchError("size", `response larger than ${MAX_BODY} bytes`));
						return;
					}
					chunks.push(c);
				});
				stream.on("end", () => {
					if (settled) return;
					settled = true;
					const headers = { ...res.headers };
					delete headers["content-encoding"];
					resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
				});
				stream.on("error", (e) => failOnce(new SiteFetchError("transport", signal.aborted ? `no answer within ${deadlineMs} ms` : e.message)));
				res.on("error", (e) => failOnce(new SiteFetchError("transport", signal.aborted ? `no answer within ${deadlineMs} ms` : e.message)));
			},
		);
		r.on("timeout", () => r.destroy(new Error(`idle for ${idleMs} ms`)));
		r.on("error", (e) => failOnce(new SiteFetchError("transport", signal.aborted ? `no answer within ${deadlineMs} ms` : e.message)));
		r.end();
	});
}

/** The default transport. */
export const nodeTransport: Transport = createNodeTransport();

const hostOf = (u: URL): string => u.hostname.replace(/^\[|\]$/g, "");

function wait(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/** Creates a door bound to the origin of `opts.url`. */
export function createSiteFetch(opts: SiteFetchOptions): BoundSiteFetch {
	const env = opts.env ?? process.env;
	const allowLocal = env.WPM_ALLOW_HTTP_LOCALHOST === "1";
	const user = env.WPM_WP_USER || undefined;
	const password = env.WPM_WP_APP_PASSWORD || undefined;
	const redact = makeRedactor(user, password);

	let start: URL;
	try {
		start = new URL(opts.url);
	} catch {
		throw new SiteFetchError("path", "the site address is not a valid URL");
	}
	if (start.username !== "" || start.password !== "") {
		throw new SiteFetchError("credentials", "the site address may not carry a user name or password");
	}
	const localhost = start.hostname === "localhost";
	if (start.protocol !== "https:" && !(start.protocol === "http:" && localhost && allowLocal)) {
		throw new SiteFetchError("scheme", `only https:// sites can be read (got ${start.protocol})`);
	}
	const origin = start.origin;
	const transport = opts.transport ?? nodeTransport;
	const resolve = opts.resolve ?? defaultResolve;
	const maxRequests = opts.maxRequests ?? 2000;
	const interval = 1000 / (opts.rate ?? 5);
	const retries = opts.retries ?? 2;
	const sleep = opts.sleep ?? wait;
	const now = opts.now ?? Date.now;
	const log = opts.log;

	let apiRoot: URL | undefined;
	let count = 0;
	let nextAt = -Infinity;

	const fail = (code: ErrorCode, message: string, target?: string): never => {
		throw new SiteFetchError(code, redact(message), target === undefined ? undefined : redact(target));
	};

	async function checkedAddress(u: URL): Promise<{ address: string; family: 4 | 6 }> {
		const host = hostOf(u);
		const literal = isIP(host) !== 0;
		let addresses: string[];
		try {
			addresses = literal ? [host] : await resolve(host);
		} catch (e) {
			return fail("address", `${host} does not resolve (${(e as Error).message})`);
		}
		if (addresses.length === 0) fail("address", `${host} does not resolve`);
		for (const a of addresses) {
			const ok = isPublicAddress(a) || (localhost && allowLocal && !literal && isLoopback(a));
			if (!ok) fail("address", `${host} resolves to a non-public address (${a}); only public sites can be read`);
		}
		const address = addresses[0] as string;
		return { address, family: isIP(address) === 6 ? 6 : 4 };
	}

	function authScoped(u: URL): boolean {
		if (!apiRoot) return false;
		if (/%2[ef]/i.test(u.pathname + u.search)) return false;
		if (apiRoot.searchParams.has("rest_route")) {
			const routes = u.searchParams.getAll("rest_route");
			if (u.pathname !== apiRoot.pathname || routes.length !== 1) return false;
			const route = routes[0] as string;
			if (route.split("/").some((s) => s === "." || s === "..")) return false;
			return route === "/wp/v2" || route.startsWith("/wp/v2/");
		}
		const base = `${apiRoot.pathname.replace(/\/$/, "")}/wp/v2`;
		return u.pathname === base || u.pathname.startsWith(`${base}/`);
	}

	async function schedule(): Promise<void> {
		if (count >= maxRequests) fail("cap", `request cap reached (${maxRequests} requests)`);
		count++;
		const t = now();
		const at = Math.max(t, nextAt + interval);
		nextAt = at;
		if (at > t) await sleep(at - t);
	}

	async function send(u: URL, method: "GET" | "HEAD", auth: boolean): Promise<RawResponse> {
		const headers: Record<string, string> = { "user-agent": UA, accept: "*/*" };
		if (auth) headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
		for (let attempt = 0; ; attempt++) {
			const { address, family } = await checkedAddress(u);
			await schedule();
			let res: RawResponse;
			try {
				res = await transport({ url: u, method, headers, address, family });
			} catch (e) {
				if (e instanceof SiteFetchError) fail(e.code, e.message);
				fail("transport", `${method} ${u.pathname}${u.search} failed: ${(e as Error).message}`);
				throw e;
			}
			log?.(redact(`${method} ${u.pathname}${u.search} ${res.status}`));
			const retryable = res.status === 429 || res.status >= 500;
			if (!retryable || attempt >= retries) return res;
			const after = Number(first(res.headers["retry-after"]));
			const ms = Number.isFinite(after) && after >= 0 ? Math.min(after * 1000, MAX_RETRY_WAIT) : 1000 * 2 ** attempt;
			await sleep(ms);
		}
	}

	const door = async (path: string, o: FetchOptions = {}): Promise<SiteResponse> => {
		const method = o.method ?? "GET";
		if (method !== "GET" && method !== "HEAD") fail("method", `only GET and HEAD are allowed (got ${String(method)})`);
		if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
			fail("path", `a path on the site is required, starting with one "/" (got ${String(path)})`);
		}
		let target = path;
		if (o.query && Object.keys(o.query).length > 0) {
			target += (target.includes("?") ? "&" : "?") + new URLSearchParams(o.query).toString();
		}
		let u = new URL(target, origin);
		if (u.origin !== origin) fail("path", `path leaves the site: ${path}`);
		let wantAuth = o.auth === true;
		if (wantAuth && (!user || !password)) fail("credentials", "auth needs WPM_WP_USER and WPM_WP_APP_PASSWORD in the environment");

		for (let hop = 0; ; hop++) {
			const res = await send(u, method, wantAuth && authScoped(u));
			const location = first(res.headers.location);
			if (res.status >= 300 && res.status < 400 && location) {
				let next: URL;
				try {
					next = new URL(location, u);
				} catch {
					return fail("origin", `bad redirect from ${u.pathname}`);
				}
				if (next.origin !== origin) fail("origin", `${u.pathname} redirects to another site (${next.href}); the redirect was not followed`, next.href);
				if (next.username !== "" || next.password !== "") fail("origin", `redirect with credentials stopped the run: ${u.pathname}`);
				if (hop >= MAX_REDIRECTS) fail("redirects", `more than ${MAX_REDIRECTS} redirects from ${path}`);
				u = next;
				wantAuth = false;
				continue;
			}
			return respond(res, u.href, redact);
		}
	};

	const bound = door as BoundSiteFetch;
	Object.defineProperty(bound, "origin", { value: origin, enumerable: true });
	bound.setApiRoot = (root: string): void => {
		const r = new URL(root);
		if (r.origin !== origin) fail("origin", `the API root is on another origin: ${r.origin}`);
		apiRoot = r;
	};
	bound.requests = () => count;
	return bound;
}

function first(v: string | string[] | undefined): string | undefined {
	return Array.isArray(v) ? v[0] : v;
}

function respond(res: RawResponse, url: string, redact: (s: string) => string): SiteResponse {
	const headers = new Headers();
	for (const [k, v] of Object.entries(res.headers)) {
		if (v === undefined || k.toLowerCase() === "set-cookie") continue;
		for (const one of Array.isArray(v) ? v : [v]) headers.append(k, redact(one));
	}
	const body = redact(res.body);
	return { status: res.status, headers, url: redact(url), text: async () => body };
}
