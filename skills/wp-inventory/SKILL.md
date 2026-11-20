---
name: wp-inventory
description: Read a WordPress site and write inventory.json, a fixed-format list of its content types, fields, taxonomies, plugins, page builders, menus and every old URL. Use it first when someone wants to move a WordPress site to Astro or EmDash, or asks what is on their WordPress site. Starts with the public site only (level 1); an export file (level 2) or an application password (level 3) adds more.
---

# wp-inventory

Reads a WordPress site and writes `inventory.json`. The other skills (`wp-content-model`, `wp-assess`, `wp-redirect-plan`) read that file.

The script fetches and counts. You read the result, explain it, and help the user decide what to do next.

## Setup (once)

The scripts live in the wp-esc repo, not in this skill folder. They need Node 26 or newer.

```sh
git clone https://github.com/astronomic-dev/wp-esc.git ~/wp-esc
cd ~/wp-esc && npm install
```

Below, `~/wp-esc` is where you cloned it. Run every command from the user's own working folder, so the output files land there.

## Steps

### 1. Start at level 1

Level 1 needs nothing from the user but the site's address. It reads only what anyone can see: the public REST API (`/wp-json`), every sitemap, and page HTML.

```sh
node ~/wp-esc/bin/wp-inventory.mjs --url https://www.example.com
```

- The address must use `https://`. The script refuses plain `http://`.
- WPM_ALLOW_HTTP_LOCALHOST=1 lets the scripts read an http:// site on localhost, such as a test site on your own computer. Do not set it for a live site.
- It sends only GET requests, only to the site's own address, at most 5 per second and 2,000 in all.
- It writes `inventory.json` in the current folder. `--out <file>` writes it to that path instead. It writes no other file.
- If the address redirects to another site (another host, scheme or port), the script does not follow it. It still writes `inventory.json`, with a `site` coverage line that names the target. Tell the user: WordPress Address and Site Address (Settings > General) may differ. If the target is the real site, run again with `--url <target>`. An export file can still be read with `--wxr`.

### 2. Read `coverage` first

Before you say anything about the site, read the `coverage` array in `inventory.json`. Each entry has an `area`, a `source`, a `status` and a `detail`:

- `complete`: everything in that area was read.
- `partial`: some of it was read. Say what is missing, using `detail`.
- `failed`: the script tried and could not read it. Say why.
- `not-visible`: this level cannot see it.

Tell the user about every `partial`, `failed` and `not-visible` area before you give counts. Never call a partial result complete. If the REST API was off or locked, say so: the script fell back to sitemaps and HTML, so counts and fields are thinner.

Then give a short summary: content types and counts, taxonomies, plugins found, page builder, menus, comments, and how many old URLs are in the ledger (`urls`).

- `builders`, `shortcodes` and `blocks` count content items (posts, pages and the like) that use each one. At level 1 they come from the REST content of every item. WordPress has already run the shortcodes in that content, so level 1 finds a shortcode only from the HTML it prints (Contact Form 7, gallery, audio, video and playlist). An export shows them all. Only when the REST API gave no content do they come from the HTML sample, and then theme template blocks count too. The `html` coverage line says which.
- Every level 1 run writes one `urls` coverage line, also when it added nothing ("Added no URLs …"). It counts the URLs in the ledger that no content list names: date archives, later list pages (`/page/2/` and on, for the home page, the posts page, each category, tag and author) and feeds (the site feed, each category, tag and author feed, and each post type archive feed). Its numbers equal the ledger's entries of each kind, and it says how many were also seen in the page HTML. The last page of a list is a guess at 10 posts per page. A category's list counts the posts in its child categories too.
- With plain links (`?p=123`), the old site also answers query URLs that no ledger can list in full: `?m=YYYYMM`, `?paged=N` and `?p=N&feed=rss2`. The `urls` line names them. The script adds the ones that post dates and counts imply, up to a cap.

### 3. Say what level 2 or 3 would add, and let the user decide

No level sees everything. Tell the user plainly what each one adds for this site, based on the coverage gaps you found. Level 1 is always a fine place to stop.

| Level | The user does | It adds | It still misses |
| --- | --- | --- | --- |
| 1. URL | Nothing | Public content, sitemaps, plugins seen in page HTML | Custom fields not in the REST API, drafts, private posts, menus (no public menus endpoint), the full plugin list |
| 2. Export file | Tools > Export > All content in WordPress, then sends you the `.xml` file | Custom fields (post meta), drafts, menus | Media files, site settings, plugin-owned tables (many store, form and member records), post types marked not exportable |
| 3. Application password | Makes an application password for this run | The full plugin list, settings, drafts and private posts, user counts | Plugin-owned tables, and post types or fields not shown in the REST API |

For the most complete source when moving to EmDash, point the user to the EmDash Exporter plugin (the `wp-content-model` skill covers it).

### 4. Level 2: add the export file

Ask the user to export the site in WordPress (Tools > Export > All content) and give you the file path.

```sh
node ~/wp-esc/bin/wp-inventory.mjs --url https://www.example.com --wxr ./site.WordPress.xml
```

`--wxr` alone means level 2, so `--level 2` is not needed. Without `--url`, only the file is read. To add the file to an inventory from an earlier run, use `--merge inventory.json`.

The export file holds the site's content, including drafts. Treat it as private.

### 5. Level 3: add an application password (optional)

Before you ask for one, tell the user these things plainly:

- An application password carries the full rights of the user who makes it. If that user is an Administrator, the password can do anything an Administrator can.
- The script only reads (GET requests), only from the site's own address over HTTPS, and never follows a redirect to another host. It never writes the password to a file, a log, or `inventory.json`.
- Level 1 (and level 2) are always an option. They do not need a password.

If the user wants level 3:

1. Ask them to make a new application password just for this run: in WordPress, Users > Profile > Application Passwords, give it a name such as `wp-esc`, and click Add New Application Password.
2. Ask them to put the user name and the password in the environment themselves, in their own terminal, so the password never appears in this conversation:

   ```sh
   export WPM_WP_USER='their-user-name'
   export WPM_WP_APP_PASSWORD='the new password'
   ```

   Do not ask them to paste the password to you. Do not write it into any file, command, or note. The script reads it only from `WPM_WP_USER` and `WPM_WP_APP_PASSWORD`.
3. Run:

   ```sh
   node ~/wp-esc/bin/wp-inventory.mjs --url https://www.example.com --level 3
   ```

   With an export file, run all levels at once. Keep `--level 3`: `--level 2` would leave out the password step.

   ```sh
   node ~/wp-esc/bin/wp-inventory.mjs --url https://www.example.com --level 3 --wxr export.xml
   ```

   Use `--merge inventory.json` only to join an inventory from an earlier run (for example a level 1 run on another day). A run with `--level 3 --wxr` does not need it.

   If level 1 finds no REST API (for example, the site redirects to another host), the script sends no password request. It writes `inventory.json` with what levels 1 and 2 read and exits with an error that says so.

### 6. End level 3 with the revoke steps

As soon as the level 3 run ends, whether it worked or not, give the user these steps:

1. In WordPress, open Users > Profile > Application Passwords.
2. Find the password made for this run (for example `wp-esc`) and click Revoke.
3. In the terminal, clear the variables: `unset WPM_WP_USER WPM_WP_APP_PASSWORD`.

## Output

`inventory.json` has a fixed, versioned format (`version`). Main parts:

- `site`, `levels`, `coverage`
- `types` with `fields` (each with sample values, how often it is filled, its shape and a `confidence`)
- `taxonomies`, `plugins`, `builders`, `shortcodes`, `blocks`, `menus`
- `authors`, `media`, `comments` counts, when the level can see them
- `permalinks`
- `urls`: the URL ledger, every old URL by kind (posts, pages, terms, authors, dates, feeds, attachments, pagination, query URLs such as `?p=123`)
- `storedElsewhere`: plugin data the export does not carry, when a storing plugin is found

The file can hold author names and draft titles. Treat it as private to the user.

## Next

Run `wp-content-model` to propose the new content model, then `wp-assess` for the report.
