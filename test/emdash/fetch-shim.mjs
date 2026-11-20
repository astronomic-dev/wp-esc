// Preloaded into the EmDash test site (`node --import`), never shipped to a real site.
//
// EmDash's importer refuses local targets on purpose (src/security/ssrf.ts: no
// localhost, no private IPs, and every hostname is resolved through Cloudflare's
// DNS-over-HTTPS and must give a public address). The test WordPress runs on
// localhost, so this shim stands in for a public host, and only for one made-up name:
//
//   - A DNS-over-HTTPS query for WPM_SHIM_HOST answers with a public address
//     (it is never dialed), so EmDash's own SSRF check runs and passes.
//   - A fetch to http://WPM_SHIM_HOST/... goes to WPM_SHIM_TARGET/... instead.
//
// Every other request goes through untouched, and EmDash's code is not changed.

const host = process.env.WPM_SHIM_HOST;
const target = process.env.WPM_SHIM_TARGET;
const PUBLIC_IP = "93.184.215.14";

if (host && target) {
	const real = globalThis.fetch;
	globalThis.fetch = async function shimmedFetch(input, init) {
		const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
		if (url.hostname === "cloudflare-dns.com" && url.searchParams.get("name") === host) {
			const type = url.searchParams.get("type");
			const Answer = type === "A" ? [{ name: host, type: 1, TTL: 60, data: PUBLIC_IP }] : [];
			return new Response(JSON.stringify({ Status: 0, Answer }), { headers: { "content-type": "application/dns-json" } });
		}
		if (url.hostname === host) {
			const to = new URL(url.pathname + url.search, target);
			const res = typeof input === "string" || input instanceof URL ? await real(to, init) : await real(new Request(to, input), init);
			// A redirect back to the target's own origin is shown as the made-up host.
			const location = res.headers.get("location");
			if (!location || !location.startsWith(new URL(target).origin)) return res;
			const headers = new Headers(res.headers);
			headers.set("location", `http://${host}${location.slice(new URL(target).origin.length)}`);
			return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
		}
		return real(input, init);
	};
}
