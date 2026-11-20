---
name: wp-assess
description: Score how hard a WordPress site's move to Astro or EmDash will be and write report.md, a plain report with coverage gaps first, a score and reason for each part, blockers, the proposed content model, next steps and themes that fit. Use after wp-inventory, when someone asks whether or how they can move their WordPress site.
---

# wp-assess

Reads `inventory.json` (from `wp-inventory`) and `model.json` (from `wp-content-model`), and writes `assessment.json`: one scored finding per part of the move. You then write `report.md` for the user from those three files.

## Setup (once)

The scripts live in the wp-esc repo. They need Node 26 or newer.

```sh
git clone https://github.com/astronomic-dev/wp-esc.git ~/wp-esc
cd ~/wp-esc && npm install
```

Run every command from the user's working folder, where `inventory.json` is.

## Steps

### 1. Score the move

```sh
node ~/wp-esc/bin/wp-assess.mjs --inventory inventory.json
```

- If `model.json` is missing, the script proposes one from the inventory first and writes it next to `assessment.json`. If the user has not reviewed it yet, say so in the report.
- `--model <file>` reads a model from another path. `--out <file>` changes where `assessment.json` goes.
- `--no-themes` leaves out theme matches. Use it when the user does not want them; then leave out section 6 of the report.

### 2. Read the three files

- `inventory.json`: read `coverage` first. Note every area that is `partial`, `failed` or `not-visible`.
- `assessment.json`:
  - `findings`: each has an `area`, a `score` (`easy`, `some-work`, `hard` or `blocker`), a `reason`, a `next` step, and sometimes a `count` and `items`. Areas include posts, pages, custom types, fields, repeaters, unclear fields, page builders, shortcodes, comments, store, members, courses, forms, hidden types, stored data, languages, addresses (old URLs that change), media and menus. A finding's `count` is how many of its `items` there are. For addresses, that is every old URL that changes or needs review on either target, query URLs included; the reason gives the number for each target, split into groups that add up to it. For menus, it is the number of menus; the reason gives the links.
  - `blockers`: the areas scored `blocker`. Always present; empty when there are none.
  - `storePaths`: ways to keep selling, when the site has a store.
  - `themes`: matching themes, best first, or `"none-fit"`. Missing when `--no-themes` was used.
- `model.json`: the proposed content model and its `check` notes.

### 3. Write report.md

Write in plain words for the site owner, not for a developer. Short sentences. Use the findings' own reasons; do not make the move sound easier than the scores say.

Start with what the report could not see, then the six sections in this order:

**What this report could not see.** List every coverage gap from `inventory.json`, with its `detail`, and the levels used (`levels`). If anything is partial, say the counts below may be low. Never call a partial result complete. If a higher level would fill a gap, say what it would add (see `wp-inventory`).

1. **What the site is.** Content types and counts, taxonomies, plugins, page builder, theme, menus, comments, languages.
2. **A score for each part.** A table: part, score (easy, some work, hard, blocker), and the reason, from `findings`.
3. **Blockers.** From `blockers`: store, members, courses, shortcodes, page-builder markup and anything else scored `blocker`, each with its `next` step. Include the `storePaths` options when there is a store. If `blockers` is empty, say there are none.
   **Data to export before you switch.** Under its own heading, list each `stored-data` finding (plugin data no import brings over, such as Flamingo's saved form messages and contacts) with its `next` step. It is not a blocker unless it is scored `blocker`.
4. **The proposed content model.** Collections, fields, taxonomies and routes from `model.json`, with every `check` note marked "check this". Say the user should review it with `wp-content-model` before strict files are written.
5. **Next steps.** The EmDash importer path or the plain Astro path, as `wp-content-model` describes them, and `wp-redirect-plan` for the old URLs.
6. **Themes that fit.** From `themes`: each theme's name, link and reason. If it is `"none-fit"`, say no listed theme fits. Leave this section out when `themes` is missing.

Use only the links the files give you. Add no other links.

Some facts to state plainly when they apply:

- Draft and private posts: the `posts` finding names them (up to 20). Say they are not public now, and ask which to move.
- Comments: the `comments` finding says what happens to them on each target, and how many wait for approval.
- Custom content types: plugin, builder and theme data (form setups, page builder templates, Flamingo) is never counted as a custom type. The model leaves it out.
- Menus: a block theme's Navigation block does not import. The `menus` finding says to rebuild it by hand.
- Addresses: say how many old addresses change and why, from the `addresses` finding. A move from a subfolder (`/site/`) to the root changes every address.

### 4. An HTML page (optional)

If the user wants a page to share, write `report.html` from the finished `report.md`, after `report.md` is done. Keep the same content and order.

## Notes

- The reports can hold author names and draft titles. Treat them as private to the user.
- The scores come from fixed rules, so the same inventory gives the same scores. Your job is to explain them clearly, not to change them.
