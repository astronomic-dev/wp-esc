# wp-esc: move from WordPress to Astro

Four skills for your coding agent that read a WordPress site and plan its move to [Astro](https://astro.build) or [EmDash](https://emdashcms.com). They tell you what is on the site, how hard the move is, what the new content model should be, and which redirects you need.

Each skill is a short instruction file plus a small Node script. The scripts fetch, parse and count, so the same site gives the same results every run. Your agent reads the results, explains them, and writes the report.

## The skills

| Skill | Reads | Writes |
| --- | --- | --- |
| `wp-inventory` | The site, at level 1, 2 or 3 | `inventory.json` |
| `wp-content-model` | `inventory.json` | `model.json` (a proposal), then after your review `src/content.config.ts` and an EmDash `seed/seed.json` (schema only) with `seed/emdash-steps.md` |
| `wp-assess` | `inventory.json`, `model.json` | `assessment.json`; your agent then writes `report.md` |
| `wp-redirect-plan` | `inventory.json`, `model.json` | `redirects.csv`, `_redirects`, `cloudflare-rules.json`, and for old query URLs `query-redirects.json` with its handler, for plain Astro and for EmDash |

Run them in that order. `wp-assess` proposes the model itself when `model.json` is missing.

## Install

```sh
npx skills add astronomic-dev/wp-esc
```

To add one skill: `npx skills add astronomic-dev/wp-esc --skill wp-inventory`.

The skills run the scripts in this repo, so clone it once as well. The scripts need Node 26 or newer.

```sh
git clone https://github.com/astronomic-dev/wp-esc.git ~/wp-esc
cd ~/wp-esc
corepack enable
pnpm install
```

The repo uses pnpm. It ships `pnpm-lock.yaml`, and `package.json` names the pnpm version (`packageManager`), so `corepack enable` gets that version for you. `npm install` also works, but it writes a `package-lock.json` into the folder.

You can also run the scripts yourself. Each one prints its options with `--help`:

```sh
node ~/wp-esc/bin/wp-inventory.mjs --url https://www.example.com
node ~/wp-esc/bin/wp-content-model.mjs --inventory inventory.json
node ~/wp-esc/bin/wp-assess.mjs --inventory inventory.json
node ~/wp-esc/bin/wp-redirect-plan.mjs --inventory inventory.json --model model.json
```

## The three access levels

The skills start at level 1. Each level adds more, and no level sees everything. Every run records what it read, what failed and what it could not see (`coverage` in `inventory.json`), and the report lists those gaps first.

| Level | You do | It reads | It still misses |
| --- | --- | --- | --- |
| 1. URL | Nothing | The public REST API (`/wp-json`), every sitemap, page HTML. Plugins and page builders are found from asset paths and markup. | Fields not in the REST API, drafts and private posts, menus, the full plugin list. If the REST API is off, it falls back to sitemaps and HTML. |
| 2. Export file | Export the site (Tools > Export) | Custom fields (post meta), drafts, menus | Media files, site settings, plugin-owned tables (many store, form and member records), post types marked not exportable |
| 3. Application password | Make an application password for this run | The full plugin list, settings, drafts and private posts, user counts | Plugin-owned tables, and post types or fields not shown in the REST API |

The user count is in the "users" coverage line of `inventory.json`. `authors` counts only the people who wrote content, so it can be lower.

You can add level 2 or 3 later. Do a level 3 run (`wp-inventory --url https://www.example.com --level 3 --wxr export.xml`) and the skills after it in a new folder, so it does not overwrite a `model.json` you have already reviewed. Then compare the two and carry your edits over.

For the most complete source when moving to EmDash, use the EmDash Exporter plugin. `wp-content-model` explains how.

## Safety

An application password carries the full rights of the user who makes it. Level 3 is optional, and level 1 is always an option. When you use it:

- Make a new application password just for this run, and revoke it right after. The skill gives you the steps.
- The password is read only from the environment (`WPM_WP_USER` and `WPM_WP_APP_PASSWORD`). It is never written to a file, a log, the report or `inventory.json`, and error output is redacted.
- HTTPS only. The scripts refuse plain HTTP. One switch exists for tests only. WPM_ALLOW_HTTP_LOCALHOST=1 lets the scripts read an http:// site on localhost, such as a test site on your own computer. Do not set it for a live site.
- Requests go only to the site's own address. A redirect to another host stops the run, so the password is never sent elsewhere.
- GET requests only, at most 5 a second and 2,000 a run.

These promises are tested.

The output files can hold author names, draft titles and, from the EmDash Exporter, author email addresses. Keep them private.

## Redirects

`wp-redirect-plan` writes Cloudflare files. `_redirects` goes in the new site's `public/` folder. It holds one line per old URL. It may end with a few pattern lines for URL families no list holds in full (post feeds, later pages, date archives). When it writes none, the summary tells you why. `cloudflare-rules.json` holds Single Redirect rules for old URLs with a query string, which `_redirects` cannot match; Cloudflare runs them before `_redirects`. Cloudflare's Free plan allows 10 such rules; for more, use the handler below. Every row the plan cannot place is marked `review` in `redirects.csv` for you to decide.

- The site root is never sent to another page. It maps to `/` on the new site.
- A site in a subfolder (`https://www.example.com/site/`) moves to the root of the new site, so every old URL redirects out of `/site/`.
- Pass `--origin https://new.example.com` when the new site has another address, such as a test address. The rules then send visitors there. Without it, the rules use the old address.

### Old query URLs (?p=123)

WordPress answers to query URLs such as `?p=123`, `?page_id=45` and `?cat=6`. `_redirects` cannot match a query string, so the plan offers Cloudflare rules (one each, 10 on the Free plan) or the handler below.

The plan also writes a query map and a small handler that runs on the new site, with no rule limit. It is the default when there are more than 10 query URLs.

- `query-redirects.json` maps each old query URL to its new path.
- For a plain Astro site on Cloudflare, `query-redirects.worker.ts` is a Worker in front of the static files. It runs only on the few paths that had query URLs; its header has the `wrangler.jsonc` setup.
- For EmDash, `query-redirects.middleware.ts` is Astro middleware. EmDash's own redirects match the path only, so this handles the query part.

The handler answers GET and HEAD with a 301, uses exact matches only, and sends visitors only to paths on the same site.

## What it does not do

- It does not move content into a plain Astro site. For EmDash, EmDash's own importer moves the content.
- It does not fix shortcodes or page-builder markup. It finds and counts them.
- It does not change anything on the WordPress site. It only reads.
- It does not compare the old and new sites after the move.
- It writes redirects for Cloudflare only. Netlify and Vercel are not covered yet; `redirects.csv` has every row for other hosts.

## Tests

```sh
pnpm test
```

The tests replay recorded responses from three test WordPress sites (`test/fixtures/`), so they need no network. `test/sites/` holds the Docker setup that recorded them.

## License

MIT. See [LICENSE](LICENSE).
