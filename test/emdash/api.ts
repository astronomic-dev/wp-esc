// A small client for the EmDash admin API, as the admin's own pages call it:
// a session cookie and the X-EmDash-Request header that EmDash's CSRF check wants.

export class EmDash {
	readonly origin: string;
	private cookies = new Map<string, string>();

	constructor(origin: string) {
		this.origin = origin;
	}

	async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
		const headers: Record<string, string> = { "X-EmDash-Request": "1", Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
		const res = await fetch(this.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(";");
			const eq = pair.indexOf("=");
			this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
		const text = await res.text();
		let json: any;
		try {
			json = JSON.parse(text);
		} catch {}
		return { status: res.status, json, text };
	}

	/** The response's data (EmDash wraps successes as { data }), or a thrown error with the body. */
	async ok(method: string, path: string, body?: unknown): Promise<any> {
		const r = await this.call(method, path, body);
		if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 1500)}`);
		return r.json && typeof r.json === "object" && "data" in r.json ? r.json.data : r.json;
	}
}
