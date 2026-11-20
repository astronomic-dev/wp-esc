// The fetch door every reader goes through. Frozen after Chunk 0a.
//
// A SiteFetch is bound to one site origin. Readers pass a path on that site
// (for example `/wp-json/wp/v2/posts` or `/?rest_route=/`) and never build absolute URLs.
// Task 3 implements it (src/http/site-fetch.ts); tests pass a replay (src/http/replay.ts).
//
// - `method` is GET (default) or HEAD. Nothing else exists.
// - `auth: true` asks for the application password header. The door sends it only
//   to paths under the discovered API root and the `wp/v2` namespace.
// - `query` is added to the path's own query string.
// - `url` on the response is the final absolute URL after same-origin redirects.

export interface FetchOptions { method?: "GET" | "HEAD"; auth?: boolean; query?: Record<string, string> }
export interface SiteResponse { status: number; headers: Headers; text(): Promise<string>; url: string }
export type SiteFetch = (path: string, opts?: FetchOptions) => Promise<SiteResponse>;
