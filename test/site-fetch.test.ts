import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createServer } from "node:http";
import { createNodeTransport, createSiteFetch, nodeTransport, SiteFetchError, type RawRequest, type RawResponse, type Transport } from "../src/http/site-fetch.ts";
import { isPublicAddress } from "../src/http/address.ts";
import { makeRedactor, REDACTED } from "../src/http/redact.ts";
import { createReplayFetch } from "../src/http/replay.ts";

const PUBLIC = "93.184.215.14";
const USER = "editor@example.com";
const PASSWORD = "abcd EFGH 1234 ijkl MNOP 5678";

interface Fake {
	transport: Transport;
	calls: RawRequest[];
}

/** A fake transport: `routes` maps a path+query to a response (or a list served in turn). */
function fake(routes: Record<string, RawResponse | RawResponse[]> = {}): Fake {
	const calls: RawRequest[] = [];
	const served = new Map<string, number>();
	const transport: Transport = async (req) => {
		calls.push(req);
		const key = req.url.pathname + req.url.search;
		const route = routes[key];
		if (route === undefined) return { status: 404, headers: {}, body: "not found" };
		if (!Array.isArray(route)) return route;
		const i = served.get(key) ?? 0;
		served.set(key, i + 1);
		return route[Math.min(i, route.length - 1)] as RawResponse;
	};
	return { transport, calls };
}

const ok = (body = "ok", headers: Record<string, string> = {}): RawResponse => ({ status: 200, headers, body });
const resolvePublic = async (): Promise<string[]> => [PUBLIC];
const noWait = { sleep: async () => {}, now: () => 0 };

function door(f: Fake, extra: Partial<Parameters<typeof createSiteFetch>[0]> = {}) {
	return createSiteFetch({ url: "https://wp.example.com/", env: {}, transport: f.transport, resolve: resolvePublic, ...noWait, ...extra });
}

const rejects = async (p: Promise<unknown>, code: string): Promise<void> => {
	await assert.rejects(p, (e: unknown) => e instanceof SiteFetchError && e.code === code);
};

// Methods

test("only GET and HEAD; any other method throws before the transport runs", async () => {
	const f = fake({ "/": ok() });
	const fetch = door(f);
	for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "get"]) {
		await rejects(fetch("/", { method: method as "GET" }), "method");
	}
	assert.equal(f.calls.length, 0);
	assert.equal((await fetch("/")).status, 200);
	assert.equal((await fetch("/", { method: "HEAD" })).status, 200);
	assert.deepEqual(f.calls.map((c) => c.method), ["GET", "HEAD"]);
});

// HTTPS

test("https only; http throws without the localhost flag", () => {
	const f = fake();
	assert.throws(() => door(f, { url: "http://wp.example.com/" }), (e: unknown) => e instanceof SiteFetchError && e.code === "scheme");
	assert.throws(() => door(f, { url: "ftp://wp.example.com/" }), (e: unknown) => e instanceof SiteFetchError && e.code === "scheme");
});

test("http is allowed only for localhost and only with WPM_ALLOW_HTTP_LOCALHOST=1", async () => {
	const f = fake({ "/": ok() });
	const loop = async (): Promise<string[]> => ["127.0.0.1"];
	assert.throws(() => door(f, { url: "http://localhost:4601/", resolve: loop }), (e: unknown) => e instanceof SiteFetchError && e.code === "scheme");
	assert.throws(
		() => door(f, { url: "http://wp.example.com/", env: { WPM_ALLOW_HTTP_LOCALHOST: "1" } }),
		(e: unknown) => e instanceof SiteFetchError && e.code === "scheme",
	);
	assert.throws(
		() => door(f, { url: "http://127.0.0.1/", env: { WPM_ALLOW_HTTP_LOCALHOST: "1" } }),
		(e: unknown) => e instanceof SiteFetchError && e.code === "scheme",
	);
	const fetch = door(f, { url: "http://localhost:4601/", env: { WPM_ALLOW_HTTP_LOCALHOST: "1" }, resolve: loop });
	assert.equal((await fetch("/")).status, 200);
});

// URL credentials

test("a start URL with a user or password throws", () => {
	const f = fake();
	for (const url of ["https://bob@wp.example.com/", "https://bob:secret@wp.example.com/", "https://:secret@wp.example.com/"]) {
		assert.throws(() => door(f, { url }), (e: unknown) => e instanceof SiteFetchError && e.code === "credentials" && !String(e.message).includes("secret"));
	}
});

// Same origin

test("paths must stay on the origin; absolute and protocol-relative paths throw", async () => {
	const f = fake();
	const fetch = door(f);
	for (const path of ["https://evil.example.com/", "//evil.example.com/x", "evil", "\\\\evil.example.com/", "https://wp.example.com:8443/"]) {
		await rejects(fetch(path), "path");
	}
	assert.equal(f.calls.length, 0);
});

test("a redirect to another host, scheme or port is not followed; the error names the target", async () => {
	for (const location of ["https://evil.example.com/", "https://wp.example.com:8443/x", "http://wp.example.com/x", "//evil.example.com/y"]) {
		const f = fake({ "/a": { status: 301, headers: { location }, body: "" } });
		await rejects(door(f)("/a"), "origin");
		await assert.rejects(door(f)("/a"), (e: unknown) => e instanceof SiteFetchError && e.target === new URL(location, "https://wp.example.com/a").href);
		assert.equal(f.calls.length, 2, location);
	}
});

test("same-origin redirects are followed up to 5; the 6th throws", async () => {
	const routes: Record<string, RawResponse> = {};
	for (let i = 0; i < 5; i++) routes[`/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` }, body: "" };
	routes["/r5"] = ok("done");
	const f = fake(routes);
	const res = await door(f)("/r0");
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "done");
	assert.equal(res.url, "https://wp.example.com/r5");

	const g = fake({ ...routes, "/r5": { status: 302, headers: { location: "/r6" }, body: "" }, "/r6": ok() });
	await rejects(door(g)("/r0"), "redirects");
	assert.equal(g.calls.length, 6);
});

test("relative redirects resolve against the current URL; HEAD stays HEAD", async () => {
	const f = fake({ "/a/b": { status: 301, headers: { location: "c/" }, body: "" }, "/a/c/": ok() });
	const res = await door(f)("/a/b", { method: "HEAD" });
	assert.equal(res.url, "https://wp.example.com/a/c/");
	assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url.pathname}`), ["HEAD /a/b", "HEAD /a/c/"]);
});

// Public addresses

test("isPublicAddress rejects loopback, private, link-local, metadata and reserved ranges", () => {
	for (const a of [
		"127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
		"0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1",
		"::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe", "ff02::1", "2001:db8::1",
		"not-an-ip",
	]) {
		assert.equal(isPublicAddress(a), false, a);
	}
	for (const a of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(a), true, a);
});

test("embedded-IPv4 IPv6 forms: NAT64, mapped, compatible, 6to4 and Teredo", () => {
	for (const a of [
		"64:ff9b:1::a00:1", "64:ff9b:1::808:808", "64:ff9b:0:1::1", "64:ff9b:ffff::1", "64:ff9b::7f00:1", "64:ff9b:0:0:0:0:7f00:1", "64:ff9b::127.0.0.1",
		"::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:10.0.0.1", "::8.8.8.8", "::808:808",
		"2002:7f00:1::1", "2002:a00:1::1", "2002:a9fe:a9fe::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
	]) {
		assert.equal(isPublicAddress(a), false, a);
	}
	for (const a of ["64:ff9b::808:808", "64:ff9b:0:0:0:0:808:808", "64:ff9b::8.8.8.8", "::ffff:808:808", "2002:808:808::1"]) assert.equal(isPublicAddress(a), true, a);
});

test("IPv6 is an allowlist: only 2000::/3 can be public", () => {
	for (const a of ["::ffff:0:127.0.0.1", "::ffff:0:808:808", "1::1", "4000::1", "3fff::1", "3fff:fff::1", "5f00::1", "e000::1", "2001:db8::1"]) {
		assert.equal(isPublicAddress(a), false, a);
	}
	for (const a of ["2606:4700:4700::1111", "2a00:1450:4001::200e", "2002:808:808::1"]) assert.equal(isPublicAddress(a), true, a);
});

test("a resolver error becomes a SiteFetchError with code address", async () => {
	const f = fake({ "/": ok() });
	const resolve = async (): Promise<string[]> => {
		throw Object.assign(new Error("getaddrinfo ENOTFOUND wp.example.com"), { code: "ENOTFOUND" });
	};
	await rejects(door(f, { resolve })("/"), "address");
	assert.equal(f.calls.length, 0);
});

test("a host that resolves to any private address throws before the transport runs", async () => {
	for (const addrs of [["10.0.0.5"], [PUBLIC, "127.0.0.1"], ["169.254.169.254"], ["::1"], []]) {
		const f = fake({ "/": ok() });
		await rejects(door(f, { resolve: async () => addrs })("/"), "address");
		assert.equal(f.calls.length, 0, addrs.join());
	}
});

test("an IP-literal private host throws without asking the resolver", async () => {
	let asked = 0;
	const f = fake({ "/": ok() });
	const fetch = door(f, { url: "https://10.0.0.1/", resolve: async () => (asked++, [PUBLIC]) });
	await rejects(fetch("/"), "address");
	assert.equal(asked, 0);
	assert.equal(f.calls.length, 0);
});

test("the address check runs before every request and every redirect (DNS rebinding)", async () => {
	const answers = [[PUBLIC], [PUBLIC], ["127.0.0.1"]];
	let asked = 0;
	const resolve = async (): Promise<string[]> => answers[Math.min(asked++, answers.length - 1)] as string[];
	const f = fake({ "/a": ok(), "/b": { status: 302, headers: { location: "/c" }, body: "" }, "/c": ok() });
	const fetch = door(f, { resolve });
	await fetch("/a");
	await rejects(fetch("/b"), "address");
	assert.equal(asked, 3);
	assert.deepEqual(f.calls.map((c) => c.url.pathname), ["/a", "/b"]);
});

test("the transport is pinned to the address that was checked", async () => {
	const f = fake({ "/": ok() });
	await door(f, { resolve: async () => ["2606:4700::1111", PUBLIC] })("/");
	assert.equal(f.calls[0]?.address, "2606:4700::1111");
	assert.equal(f.calls[0]?.family, 6);
});

test("localhost may resolve to loopback only under the test flag", async () => {
	const f = fake({ "/": ok() });
	const env = { WPM_ALLOW_HTTP_LOCALHOST: "1" };
	await rejects(door(f, { url: "https://localhost/", resolve: async () => ["127.0.0.1"] })("/"), "address");
	const fetch = door(f, { url: "https://localhost/", env, resolve: async () => ["127.0.0.1", "::1"] });
	assert.equal((await fetch("/")).status, 200);
	await rejects(door(f, { url: "https://localhost/", env, resolve: async () => ["10.0.0.1"] })("/"), "address");
});

// Auth header scope

const creds = { WPM_WP_USER: USER, WPM_WP_APP_PASSWORD: PASSWORD };
const authHeader = (c: RawRequest | undefined): string | undefined => c?.headers.authorization;

test("auth goes only to wp/v2 paths under the discovered API root", async () => {
	const f = fake({});
	const fetch = door(f, { env: creds });
	const sent = async (path: string): Promise<boolean> => {
		await fetch(path, { auth: true });
		return authHeader(f.calls.at(-1)) !== undefined;
	};
	assert.equal(await sent("/wp-json/wp/v2/posts"), false, "no API root yet");
	fetch.setApiRoot("https://wp.example.com/wp-json/");
	assert.equal(await sent("/wp-json/wp/v2/posts"), true);
	assert.equal(await sent("/wp-json/wp/v2"), true);
	assert.equal(await sent("/wp-json/wp/v2/../../wp-admin/"), false);
	assert.equal(await sent("/wp-json/wp/v2%2F..%2F..%2Fwp-login.php"), false);
	assert.equal(await sent("/wp-json/"), false);
	assert.equal(await sent("/wp-json/yoast/v1/get_head"), false);
	assert.equal(await sent("/wp-json/wp/v2x/posts"), false);
	assert.equal(await sent("/about/"), false);
	assert.equal(await sent("/wp-sitemap.xml"), false);
	assert.equal(await sent("/other/wp-json/wp/v2/posts"), false);
	await fetch("/wp-json/wp/v2/posts");
	assert.equal(authHeader(f.calls.at(-1)), undefined, "auth not asked");
	assert.throws(() => fetch.setApiRoot("https://evil.example.com/wp-json/"), (e: unknown) => e instanceof SiteFetchError && e.code === "origin");
});

test("auth with a query-style API root (?rest_route=)", async () => {
	const f = fake({});
	const fetch = door(f, { env: creds });
	fetch.setApiRoot("https://wp.example.com/site/?rest_route=/");
	const sent = async (path: string): Promise<boolean> => {
		await fetch(path, { auth: true });
		return authHeader(f.calls.at(-1)) !== undefined;
	};
	assert.equal(await sent("/site/?rest_route=/wp/v2/posts"), true);
	assert.equal(await sent("/site/?rest_route=/wp/v2/posts&per_page=100"), true);
	assert.equal(await sent("/site/?rest_route=/"), false);
	assert.equal(await sent("/site/?rest_route=/wp/v2/posts&rest_route=/x"), false);
	assert.equal(await sent("/site/?rest_route=/wp/v2/../x"), false);
	assert.equal(await sent("/?rest_route=/wp/v2/posts"), false);
	assert.equal(await sent("/site/about/?rest_route=/wp/v2/posts"), false);
});

test("auth is never sent on a redirect hop", async () => {
	const f = fake({ "/wp-json/wp/v2/posts": { status: 301, headers: { location: "/wp-json/wp/v2/posts/" }, body: "" }, "/wp-json/wp/v2/posts/": ok() });
	const fetch = door(f, { env: creds });
	fetch.setApiRoot("https://wp.example.com/wp-json/");
	await fetch("/wp-json/wp/v2/posts", { auth: true });
	assert.ok(authHeader(f.calls[0]));
	assert.equal(authHeader(f.calls[1]), undefined);
});

test("auth header is Basic base64(user:password)", async () => {
	const f = fake({});
	const fetch = door(f, { env: creds });
	fetch.setApiRoot("https://wp.example.com/wp-json/");
	await fetch("/wp-json/wp/v2/users/me", { auth: true });
	assert.equal(authHeader(f.calls[0]), `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`);
});

test("credentials come only from WPM_WP_USER and WPM_WP_APP_PASSWORD", async () => {
	const f = fake({});
	const opts = { user: USER, password: PASSWORD, env: {} } as unknown as Partial<Parameters<typeof createSiteFetch>[0]>;
	const fetch = door(f, opts);
	fetch.setApiRoot("https://wp.example.com/wp-json/");
	await rejects(fetch("/wp-json/wp/v2/posts", { auth: true }), "credentials");
	assert.equal(f.calls.length, 0);
});

// Redaction

test("makeRedactor scrubs raw, base64 and URL-encoded forms", () => {
	const r = makeRedactor(USER, PASSWORD);
	const b64 = Buffer.from(`${USER}:${PASSWORD}`).toString("base64");
	const compact = PASSWORD.replaceAll(" ", "");
	const inputs = [
		PASSWORD,
		compact,
		b64,
		Buffer.from(`${USER}:${compact}`).toString("base64"),
		Buffer.from(PASSWORD).toString("base64"),
		Buffer.from(`${USER}:${PASSWORD}`).toString("base64url"),
		encodeURIComponent(PASSWORD),
		PASSWORD.replaceAll(" ", "+"),
		encodeURIComponent(`${PASSWORD}/`).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()),
		`Authorization: Basic ${b64}`,
	];
	for (const s of inputs) {
		const out = r(`before ${s} after`);
		assert.ok(out.startsWith("before ") && out.endsWith(" after"), out);
		for (const bad of [PASSWORD, compact, b64, encodeURIComponent(PASSWORD)]) assert.ok(!out.includes(bad), out);
		assert.ok(out.includes("[redacted]"), out);
	}
	assert.equal(makeRedactor(undefined, undefined)("plain"), "plain");
});

test("base64 of a longer blob hides the secret at byte offsets 1 and 2 too", () => {
	const r = makeRedactor(USER, PASSWORD);
	for (const secret of [`${USER}:${PASSWORD}`, PASSWORD]) {
		for (const k of [1, 2, 4, 5]) {
			for (const enc of ["base64", "base64url"] as const) {
				const blob = Buffer.from(`${"q".repeat(k)}${secret}tail-bytes`).toString(enc);
				const out = r(`x ${blob} y`);
				assert.ok(out.includes(REDACTED), `${enc} offset ${k}`);
				assert.ok(out.length < blob.length - 16, `${enc} offset ${k}: ${out}`);
			}
		}
	}
});

test("a 401 with a known password leaks it into no output string", async () => {
	const b64 = Buffer.from(`${USER}:${PASSWORD}`).toString("base64");
	const echo = `{"code":"rest_not_logged_in","message":"bad ${PASSWORD} ${b64} ${encodeURIComponent(PASSWORD)}"}`;
	const f = fake({
		"/wp-json/wp/v2/users/me": { status: 401, headers: { "www-authenticate": `Basic realm="${PASSWORD}"`, "x-echo": b64 }, body: echo },
		"/wp-json/wp/v2/boom": { status: 301, headers: { location: `https://evil.example.com/?p=${encodeURIComponent(PASSWORD)}` }, body: "" },
	});
	const logs: string[] = [];
	const fetch = door(f, { env: creds, log: (line) => logs.push(line) });
	fetch.setApiRoot("https://wp.example.com/wp-json/");
	const res = await fetch("/wp-json/wp/v2/users/me", { auth: true });
	const outputs: string[] = [await res.text(), res.url, inspect(res, { depth: 5 }), inspect(fetch, { depth: 5 }), ...logs];
	for (const [k, v] of res.headers) outputs.push(`${k}: ${v}`);
	try {
		await fetch("/wp-json/wp/v2/boom", { auth: true });
		assert.fail("should throw");
	} catch (e) {
		outputs.push(String(e), inspect(e, { depth: 5 }), JSON.stringify(e));
	}
	const compact = PASSWORD.replaceAll(" ", "");
	for (const s of outputs) {
		for (const bad of [PASSWORD, compact, b64, encodeURIComponent(PASSWORD)]) assert.ok(!s.includes(bad), s);
	}
	assert.equal(res.status, 401);
});

// Caps and retries

test("the request cap stops further requests", async () => {
	const f = fake({ "/": ok() });
	const fetch = door(f, { maxRequests: 3 });
	for (let i = 0; i < 3; i++) await fetch("/");
	await rejects(fetch("/"), "cap");
	assert.equal(f.calls.length, 3);
});

test("the default request cap is 2,000", async () => {
	const f = fake({ "/": ok() });
	const fetch = door(f);
	for (let i = 0; i < 2000; i++) await fetch("/");
	await rejects(fetch("/"), "cap");
});

test("the rate cap spaces requests (default 5 per second)", async () => {
	let clock = 0;
	const waits: number[] = [];
	const f = fake({ "/": ok() });
	const fetch = door(f, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
	for (let i = 0; i < 4; i++) await fetch("/");
	assert.deepEqual(waits, [200, 200, 200]);
});

test("429 and 5xx retry twice with backoff, then return the last answer", async () => {
	const waits: number[] = [];
	const sleep = async (ms: number): Promise<void> => void waits.push(ms);
	const f = fake({
		"/flaky": [{ status: 503, headers: {}, body: "" }, { status: 429, headers: {}, body: "" }, ok("fine")],
		"/down": { status: 500, headers: {}, body: "down" },
		"/missing": { status: 404, headers: {}, body: "" },
	});
	const fetch = door(f, { sleep, now: () => 0, rate: Infinity });
	assert.equal(await (await fetch("/flaky")).text(), "fine");
	assert.equal(f.calls.length, 3);
	assert.deepEqual(waits, [1000, 2000]);
	assert.equal((await fetch("/down")).status, 500);
	assert.equal(f.calls.length, 6);
	assert.equal((await fetch("/missing")).status, 404);
	assert.equal(f.calls.length, 7);
});

test("Retry-After in seconds is honored, up to 30 seconds", async () => {
	const waits: number[] = [];
	const f = fake({ "/a": [{ status: 429, headers: { "retry-after": "7" }, body: "" }, ok()], "/b": [{ status: 429, headers: { "retry-after": "999" }, body: "" }, ok()] });
	const fetch = door(f, { sleep: async (ms) => void waits.push(ms), now: () => 0, rate: Infinity });
	await fetch("/a");
	await fetch("/b");
	assert.deepEqual(waits, [7000, 30000]);
});

// Shape

test("query options are added to the path's own query string", async () => {
	const f = fake({});
	const fetch = door(f);
	await fetch("/?rest_route=/wp/v2/posts", { query: { per_page: "100", page: "2" } });
	await fetch("/wp-json/wp/v2/posts", { query: { per_page: "100" } });
	assert.deepEqual(f.calls.map((c) => c.url.pathname + c.url.search), ["/?rest_route=/wp/v2/posts&per_page=100&page=2", "/wp-json/wp/v2/posts?per_page=100"]);
});

test("Set-Cookie is dropped from returned headers", async () => {
	const f = fake({ "/": ok("x", { "set-cookie": "wordpress_logged_in=abc", "x-wp-total": "3" }) });
	const res = await door(f)("/");
	assert.equal(res.headers.get("set-cookie"), null);
	assert.equal(res.headers.get("x-wp-total"), "3");
});

// The default transport connects to the checked address

test("nodeTransport connects to the given address even when the host cannot resolve", async () => {
	const server = createServer((req, res) => res.end(`host=${req.headers.host}`));
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as { port: number }).port;
	try {
		const res = await nodeTransport({ url: new URL(`http://x.example.com:${port}/`), method: "GET", headers: {}, address: "127.0.0.1", family: 4 });
		assert.equal(res.body, `host=x.example.com:${port}`);
	} finally {
		server.close();
	}
});

test("nodeTransport has an overall deadline, not only an idle timeout", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(200);
		const t = setInterval(() => res.write("."), 20);
		res.on("close", () => clearInterval(t));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as { port: number }).port;
	try {
		const transport = createNodeTransport({ idleMs: 1000, deadlineMs: 200 });
		const started = Date.now();
		await assert.rejects(
			transport({ url: new URL(`http://x.example.com:${port}/`), method: "GET", headers: {}, address: "127.0.0.1", family: 4 }),
			(e: unknown) => e instanceof SiteFetchError && e.code === "transport",
		);
		assert.ok(Date.now() - started < 1500);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test("the default transport connects to the pinned address, not a fresh lookup", async () => {
	const server = createServer((req, res) => {
		res.setHeader("x-host", String(req.headers.host));
		res.end("hello");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as { port: number }).port;
	try {
		const fetch = createSiteFetch({ url: `http://localhost:${port}/`, env: { WPM_ALLOW_HTTP_LOCALHOST: "1" }, resolve: async () => ["127.0.0.1"] });
		const res = await fetch("/");
		assert.equal(await res.text(), "hello");
		assert.equal(res.headers.get("x-host"), `localhost:${port}`);
	} finally {
		server.close();
	}
});

// Replay

test("replay serves a manifest through the SiteFetch door, matching method, path and auth", async () => {
	const fetch = createReplayFetch(new URL("./fixtures/mini-replay/", import.meta.url));
	assert.equal(fetch.origin, "http://localhost:4799");
	const home = await fetch("/");
	assert.equal(home.status, 200);
	assert.equal(await home.text(), "<html>home</html>\n");
	assert.equal(home.headers.get("link"), '<http://localhost:4799/wp-json/>; rel="https://api.w.org/"');
	assert.equal((await fetch("/", { method: "HEAD" })).status, 204);
	const moved = await fetch("/old/");
	assert.equal(moved.url, "http://localhost:4799/");
	assert.equal((await fetch("/wp-json/wp/v2/posts", { query: { per_page: "100", page: "1" } })).status, 200);
	assert.equal((await fetch("/wp-json/wp/v2/posts", { query: { page: "1", per_page: "100" } })).status, 200, "query order does not matter");
	fetch.setApiRoot("http://localhost:4799/wp-json/");
	assert.equal((await fetch("/wp-json/wp/v2/posts", { auth: true, query: { per_page: "100", page: "1" } })).headers.get("x-wp-total"), "9");
	assert.equal((await fetch("/nope")).status, 404);
	assert.deepEqual(fetch.misses, ["GET /nope"]);
	await rejects(fetch("/x", { method: "POST" as "GET" }), "method");
});
