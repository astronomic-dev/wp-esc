# wp-esc

This file tells a coding agent (Claude Code, Cursor, or another coding agent) how this repo works. Read it before you change anything. `README.md` is the user guide.

Claude Code reads this file when the project has no `CLAUDE.md`. If you also want a `CLAUDE.md`, make its first line `@AGENTS.md` so this file still loads.

## What this is

Four skills that read a WordPress site and plan its move to Astro or EmDash: `wp-inventory`, `wp-content-model`, `wp-assess` and `wp-redirect-plan`. Each skill is an instruction file in `skills/<name>/SKILL.md` plus a Node script in `bin/`. The scripts fetch, parse and count, and write versioned JSON. The agent running a skill reads that JSON, judges, and writes the Markdown for the user.

If you were asked to move a WordPress site, follow the skills in `skills/`, in this order: `wp-inventory`, `wp-content-model`, `wp-assess`, `wp-redirect-plan`. The rest of this file is for changing the tool itself.

## Commands

Node 26 or newer (`.nvmrc`). It runs the `.ts` files directly, with type stripping. There is no build step.

```sh
npm install
npm test                                  # fast tests: recorded fixtures, no network
node bin/wp-inventory.mjs --help          # each script prints its options
```

## Layout

- `bin/`: the four scripts. Each parses its flags and calls `src/`.
- `src/contracts/` and `schema/`: the formats of `inventory.json`, `model.json` and `assessment.json`. A test keeps the TypeScript types and the JSON schemas in step. Change both together, and bump the version when a change is not backward compatible.
- `src/http/`: the one fetch door. Site-bound: HTTPS only, same origin, GET only, request and rate caps, redaction.
- `src/sources/`: the readers. `public/` (level 1), `wxr/` (level 2, streaming XML), `auth/` (level 3).
- `src/model/`: the content model proposal, the Astro content config and the EmDash seed.
- `src/emdash/steps.ts`: the EmDash import steps the skills print.
- `src/assess/` and `data/themes.json`: the scoring rules and theme matches.
- `src/redirects/`: the redirect plan and the Cloudflare files.
- `test/`: `*.test.ts`, hand-written sample inventories (`samples/`), recorded responses (`fixtures/`), and the Docker test sites that recorded them (`sites/`).

## Rules

- Never weaken a level 3 safety rule: HTTPS only, same origin (a redirect to another host stops the run), GET only, request and rate caps, the password read only from `WPM_WP_USER` and `WPM_WP_APP_PASSWORD`, never written anywhere, and redacted from errors. Each rule has a test.
- No network in the fast tests. They replay `test/fixtures/` through `src/http/replay.ts`.
- Coverage is honest: every reader records what it read, what failed and what it could not see. Never report a partial result as complete.
- Imports between `.ts` files keep the `.ts` extension. No enums, parameter properties or namespaces (type stripping cannot run them).
- Keep dependencies few and pinned exactly.
- User-facing text is plain US English, in short sentences.
- Never commit a real password, a real export file or a real site's data. Test fixtures come from the Docker test sites only.

## Re-recording fixtures

`node test/sites/record.mjs` brings up the three test sites in Docker, seeds them, records every response the readers ask for, and always tears down. It needs Docker and network for images and plugins. The slow tests (`WPM_SLOW=1`) also use Docker.
