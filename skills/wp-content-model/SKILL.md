---
name: wp-content-model
description: Propose the content model for a WordPress site's move to Astro or EmDash from inventory.json, show it to the user for review, then write the Astro content config (src/content.config.ts) and a schema-only EmDash seed (seed/seed.json) with the EmDash import steps. Use after wp-inventory, when someone wants to plan collections and fields for the new site.
---

# wp-content-model

Turns `inventory.json` (from `wp-inventory`) into a proposed content model, `model.json`. After the user reviews it, it writes the strict schema files:

- `src/content.config.ts` for a plain Astro site
- `seed/seed.json` for an EmDash site: collections, fields, taxonomies and menus, with no content
- `seed/emdash-steps.md`: the EmDash import steps for this seed

## Setup (once)

The scripts live in the wp-esc repo. They need Node 26 or newer.

```sh
git clone https://github.com/astronomic-dev/wp-esc.git ~/wp-esc
cd ~/wp-esc && npm install
```

Run every command from the user's working folder, where `inventory.json` is.

## Steps

### 1. Propose the model

```sh
node ~/wp-esc/bin/wp-content-model.mjs --inventory inventory.json
```

This writes `model.json` and prints how many collections, taxonomies, menus, notes to check and "Left out" notes it has. Running it again overwrites `model.json`, so do not run it again after the user has edited the file.

**A later, deeper inventory.** If the user has already reviewed a `model.json` and you then run `wp-inventory` at a higher level (for example level 3 after level 1), do not propose over the reviewed file. Run the new inventory and the new proposal in a new folder (`--out level3`). Compare the new `model.json` with the reviewed one, and show the user what changed: new fields, new fill counts, new notes. Carry the user's edits over into the new file (names, types, required flags, routes, removed fields), or carry the new findings into the reviewed file, whichever is less work. Then use that one file for step 3.

### 2. Show the proposal and wait for review

Do not write the strict files yet. Show the user the model in plain words:

- Each collection: its new name, the WordPress post type it comes from (`from`), its URL pattern (`route`), and its fields with their types and whether they are required.
- Each taxonomy, with its term page pattern (`route`). Term pages live there, not in `routes`.
- Each menu and its links. A menu read from a Navigation block (a block theme) has a `check` note: compare its links with the header on the live site. When the old site has both a classic menu and a Navigation block, the note names both; ask the user which one the header shows.
- The site routes in `routes`. Each kind appears only when the old site had it:
  - `home`: always `/`.
  - `search`: the search results page.
  - `archive`: a list of one collection's entries, with `collection` (for example the posts list at `/news/`, or `/services/`).
  - `blog`: the posts list, when the posts move under their own path (for example `/blog/`) and no archive route lists them.
  - `feed`: the RSS feed, at `/rss.xml`.
  - `author`: author pages, for example `/author/{slug}/`.

  There is no date route: date archives go to the posts list. EmDash does not make a feed or author pages; `seed/emdash-steps.md` says what to build.
- Every `check` note, on a collection, field (repeater rows too), taxonomy or menu. The count the script prints is the number of these notes. They cover the parts the script is unsure about: sparse, serialized, mixed-type, relation, multilingual, repeater and flexible fields, which default to optional, loose types. Explain each one and ask the user what the field really holds.
- Fill counts follow one rule. A field no entry fills says "No entry has one. Remove it?". A field filled on fewer than half its entries says "Filled on N of M. Keep it?". Ask the user each question. At level 1, the excerpt and SEO counts come from the REST API, which fills them from WordPress defaults, so the note says the counts can be high.
- The "Left out" notes, in `leftOut` on the model (post types) and on each collection (fields). They are not `check` notes and are not in the printed count of notes to check. They name every inventory field and post type the model does not keep: WordPress internal keys, SEO plugin keys with no place on the new site, and post types that hold plugin, builder or theme data (Elementor templates, block theme templates and navigation, ACF field groups). Two need the user's action: Contact Form 7 forms (`wpcf7_contact_form`) hold the form setup, fields and mail settings, which the user needs to rebuild the forms; Flamingo (`flamingo_*`) holds saved form messages, which the user should save before the switch. Confirm with the user that none of the others is site content.
- The front page and the posts page. When the old site showed a page at its root, the pages note names it: build it at `/` and do not also publish it at its own path (for example `/home/`). When a page was the posts page, the note names it: the posts list takes its path, so drop the page or move its text onto the list. At level 1 the script cannot see which page lists the posts; if a page is called news or blog, the note asks the user whether it is the blog.
- If the old home page listed the latest posts, the posts note says so: the post list moves to the blog route, and the user decides what the new home page shows.

Posts carry `date` and `modified` fields from WordPress. Image fields stay as images in `model.json`.

Ask the user to confirm or change names, types, required flags and routes. Make the changes they ask for in `model.json` itself. Then wait for a clear go-ahead before step 3.

### 3. Write the strict files

For a plain Astro site:

```sh
node ~/wp-esc/bin/wp-content-model.mjs --model model.json --astro
```

For EmDash:

```sh
node ~/wp-esc/bin/wp-content-model.mjs --model model.json --seed --inventory inventory.json
```

Use `--out <dir>` to write somewhere other than the current folder. `--astro --seed` writes both.

## The plain Astro path

- Copy `src/content.config.ts` into the Astro project. Entries live in `content/<collection>/` as Markdown.
- Image fields are optional in `content.config.ts` until the media files are copied into the project, because Astro's `image()` fails the build for a missing file. The file says so next to each field. Remove `.optional()` once every entry has its image.
- Every "Check:" comment in the file is a note from the proposal. Read them with the user.
- These skills do not move the content itself for plain Astro. The user (or you, with them) moves the entries into Markdown.

## The EmDash path

EmDash 1.4.0 imports WordPress content with its own importer and the EmDash Exporter plugin. The seed gives it a matching schema first. `seed/emdash-steps.md` holds the full steps for this seed, plus a list of where the seed differs from `model.json` (the seed follows what EmDash's import asks for). Walk the user through that file. EmDash has no nested URLs: a child page moves to `/<slug>`, and a child term to `/<taxonomy prefix>/<slug>` (for example `/category/setup`). In short:

**Most exact path, for an existing WordPress site.** Build the seed from the Exporter's own analysis, so the field types match the import screen exactly:

1. On the WordPress site, install and activate the EmDash Exporter plugin, version 1.2.0 or later (from github.com/emdash-cms/wp-emdash). It needs an Administrator account.
2. Save the analysis. This needs an application password for an Administrator, and the same rules as `wp-inventory` level 3 apply: say that it carries that user's full rights, ask for a new one for this run, have the user set `WPM_WP_USER` and `WPM_WP_APP_PASSWORD` in their own terminal, and give the revoke steps after. Then run:

   ```sh
   printf 'user = "%s:%s"\n' "$WPM_WP_USER" "$WPM_WP_APP_PASSWORD" | curl -K - 'https://www.example.com/wp-json/emdash/v1/analyze' -o emdash-analyze.json
   ```

   `printf` is built into the shell, so this hands the password to curl on its input. Do not use `curl -u "$WPM_WP_USER:$WPM_WP_APP_PASSWORD"`: that puts the password in curl's arguments, which other users on the machine can see in the process list.

   Use the site's real address. `seed/emdash-steps.md` has the command with it filled in (a site with plain links uses `?rest_route=/emdash/v1/analyze`).
3. Write the seed again: `node ~/wp-esc/bin/wp-content-model.mjs --model model.json --seed --emdash-analyze emdash-analyze.json`.
4. Revoke the application password under Users > Profile > Application Passwords, and run `unset WPM_WP_USER WPM_WP_APP_PASSWORD`.

`emdash-analyze.json` lists the site's authors and their email addresses. Tell the user to keep it private and delete it after the move.

**A fresh EmDash site** (not run yet):

1. Copy `seed/seed.json` into the EmDash project at `seed/seed.json`, before the site runs for the first time.
2. Start the site and open the admin. The setup wizard applies the seed: collections, fields, taxonomies and menus, with no content. Then create the admin account.
3. Import (below).

**An EmDash site that is already set up** will not apply `seed.json` again:

1. Add the collections and fields from `seed/emdash-steps.md` in the admin under Content Types. Keep every field optional until the import is done. Skip reference fields: the import screen adds them. Or skip this step and let the import add what is missing.
2. Import (below).

**Import:**

1. In WordPress, open Tools > EmDash Migration and copy the migration key.
2. In the EmDash admin, open Import > WordPress, enter the site's address and paste the key.
3. Check each post type on the import screen. Ready: go on. Add fields or New collection: leave it on. Incompatible: change that field to the type the screen names, then check again.
4. Start the import. Media comes in its own step after the content.

## Next

Run `wp-assess` for the move report, and `wp-redirect-plan` for the redirects.
