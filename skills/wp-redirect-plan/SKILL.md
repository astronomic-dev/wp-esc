---
name: wp-redirect-plan
description: Plan the redirects for a WordPress site's move to Astro or EmDash. Maps every old URL in inventory.json to its new address from model.json and writes redirects.csv, a Cloudflare _redirects file and Cloudflare redirect rules for old query URLs. Use after wp-inventory and wp-content-model, before the new site goes live.
---

# wp-redirect-plan

Reads the URL ledger in `inventory.json` (from `wp-inventory`) and the new URL rules in `model.json` (from `wp-content-model`). Writes, for each target:

- `redirects.csv`: one row per old URL, for a person to read: `old`, `new`, `status`, `kind`, `note`, `target` (`astro` or `emdash`, the plan the row is for). Pattern lines come last, with a note that starts "Pattern:".
- `_redirects`: the Cloudflare redirects file (Cloudflare Pages and Workers static assets)
- `cloudflare-rules.json`: Cloudflare Single Redirect rules for old URLs with a query string, which `_redirects` cannot match
- `_redirects.overflow`: only when there are more than 2,000 exact lines, the lines past Cloudflare's limit
- `query-redirects.json` with its handler, `query-redirects.worker.ts` (Astro) or `query-redirects.middleware.ts` (EmDash): only when the plan has old query URLs; see "Old query URLs" below

## Setup (once)

The scripts live in the wp-esc repo. They need Node 26 or newer.

```sh
git clone https://github.com/astronomic-dev/wp-esc.git ~/wp-esc
cd ~/wp-esc && npm install
```

Run every command from the user's working folder, where `inventory.json` and `model.json` are.

## Steps

### 1. Make the plan

Use the reviewed `model.json`, so the routes are the ones the user agreed to.

```sh
node ~/wp-esc/bin/wp-redirect-plan.mjs --inventory inventory.json --model model.json --origin https://www.example.com
```

- `--target both` (the default) writes two sets, each in its own folder: `astro/` (the routes in `model.json`) and `emdash/` (EmDash's URL patterns: child pages at `/<slug>`, no trailing slash). Use `--target astro` or `--target emdash` when the user has picked one; then the files are written straight into the output folder.
- `--origin` is the new site's address, used for the full target URLs in the rules. Without it, the old site's address is used, which is right when the domain stays the same. Set it when the new site has another address, for example a test address or a local test site.
- `--out <dir>` changes the output folder.

The script prints a summary: how many rows redirect (`301`), how many stay the same (`same`), and how many need review (`review`), plus any warnings. The "Order:" and "Warning:" lines come once, after both plans; a line that only one plan gives names it. Line counts for `_redirects` count only redirect lines, not the comment lines at the top. A `_redirects` with no redirect lines has nothing to add.

What the plan always does:

- The site root is never sent to another page. It is the home page, at `/` on the new site. So is the front page's own address (for example `/?page_id=12`).
- A subfolder install (the old site at `/site/`) moves to the root of the new site, so every old URL redirects out of `/site/`. The summary says so. If the user wants to keep `/site/`, they must serve the new site from `/site/` and change the new paths by hand.
- `_redirects` ends with pattern lines for URL families no list holds in full: each post's feed, later pages of the post list (`/page/2/`), date archives (`/2024/12/`), and, for each term and author page, its later pages (`/category/news/page/*`, sent to page 1) and its feeds (`/category/news/feed/*`, sent to the new feed). They are made only when they are safe: a pattern never catches an old URL that has no exact redirect line of its own. Cloudflare checks the exact lines first. When a family gets no line, the summary's "Pattern lines:" line says why, for example "/%postname%/ makes a feed pattern unsafe".
- The comments feed (`/comments/feed/`, or `?feed=comments-rss2`) goes to the home page: the new site has no comments feed.
- With plain permalinks (`?p=123`), old feeds (`?feed=rss2`), date archives (`?m=202401`) and later pages (`?paged=2`) are query URLs. They go in the query map with real targets, like `?p=`.

### 2. List the review rows for the user

Open `redirects.csv` for the target the user picked and list every row with status `review`: the old URL and its `note`. The plan never guesses: a review row is an old URL it could not place, for example a post type with no page on the new site, two old URLs that land on one new path, or a query URL with an unknown ID. Ask the user where each one should go (or whether it can go nowhere). Then add it by hand:

- An old path with no query: add `<old path> <new path> 301` to `_redirects`.
- An old query URL (`?page_id=18`): `_redirects` cannot match it. Add it inside the `"redirects"` object of `query-redirects.json`, as `"<old path and query>": "<new path>"` (keys sort the query params by name; leave the `"about"` line as it is), or add a rule to `cloudflare-rules.json` if the user uses the rules.

A review row for an attachment page names its file when the inventory knows it. Send the page to its file only if the new site keeps that file path.

Rows with status `same` need no redirect. Rows with `301` are in `_redirects` already.

### 3. Say where the files go

- **`_redirects`**: in the new site's `public/` folder, so the build copies it to the root of the output. This works the same for a plain Astro site and an EmDash site deployed to Cloudflare.
- **`cloudflare-rules.json`**: add these rules to the domain's Cloudflare zone, under Rules > Redirect Rules, before (or with) the switch to the new site. The file's `rules` array is the body Cloudflare's Rulesets API takes. Cloudflare runs these rules before `_redirects`, which is what makes them work: `_redirects` matches by path only, so a line for `/` would also catch `/?p=26`.
- **Rule limits**: Cloudflare's Free plan allows 10 Single Redirect rules (Pro 25, Business 50). When the plan has more than 10 rules, the script warns; tell the user to check their plan's limit before adding them. Past 50, no plan up to Business can hold them, and the script says so in one line: use the query map and its handler.
- **`_redirects.overflow`**: Cloudflare reads at most 2,000 exact lines and 100 pattern lines in `_redirects`. If this file exists, tell the user how many lines did not fit and that they need another way to serve them, such as a Bulk Redirect list.

## Old query URLs (?p=123)

WordPress sites answer to query URLs such as `?p=123`, `?page_id=45` and `?cat=6`, and old links and search results often use them. `_redirects` cannot match a query string, so the plan offers two ways to redirect them.

The plan also writes a query map and a small handler that runs on the new site. It has no rule limit, so it is the default when there are more than 10 query URLs. With 10 or fewer, the user can pick the handler or the Cloudflare rules.

- **`query-redirects.json`**: every old query URL the plan placed, under `"redirects"`, mapped to its new path. Rows marked `review` are left out, and the summary names only the query params of the URLs the map holds.
- **Astro target, `query-redirects.worker.ts`**: a Cloudflare Worker in front of the static site. Put it at `worker/query-redirects.ts` and the map at `worker/query-redirects.json`. The file's header has the `wrangler.jsonc` lines (`main`, `assets.binding: "ASSETS"` and `run_worker_first` for the few paths that had query URLs). Other requests go straight to the static files, and `_redirects` still applies.
- **EmDash target, `query-redirects.middleware.ts`**: Astro middleware. Put it at `src/middleware.ts` (or add it to an existing one with `sequence()`), and the map at `src/query-redirects.json`. EmDash's own redirects match the path only, so keep the paths listed in the file's header out of EmDash's redirects. The plan already leaves them out of `_redirects`; the map holds those path redirects itself. If the user picks the Cloudflare rules instead of the middleware, add those lines (they are in `redirects.csv`) to `_redirects`.

The handler answers only GET and HEAD, with a 301. It looks up exact keys, and it sends visitors only to paths on the same site. Other query parameters, such as `utm_source`, are not part of the lookup and are not carried over. Tell the user which set to use, and to test a few old `?p=` links after launch.

## Notes

- Redirects for Netlify and Vercel are not written yet. `redirects.csv` holds every row, so the user can copy them into another host's format.
- Check a handful of old URLs on the new site after launch, including a few from the review list.
