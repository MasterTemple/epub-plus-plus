# EPUB++ — notes for Claude

PDF++-style EPUB reader for Obsidian. Links from notes into an EPUB *are* the highlights. User-facing overview: `README.md`.

## Workflow the user expects

- **Tooling:** use `bun`, not npm or pnpm, and `fd` / `rg`, not find / grep.
- **After each change:**
  1. Run `bun test` and `bun run typecheck` (and in `../file-plus-plus` when it changed; commit there too).
  2. Commit (git identity is repo-local, a GitHub no-reply address; don't change it).
  3. Run `scripts/install.sh ~/Obsidian`. This copies `main.js`, `manifest.json` and `styles.css` into the user's vault, which syncs to their phone. Symlinks don't sync.
- **Mobile matters as much as desktop.** Test both (see Testing).
- **Don't touch the user's running Obsidian.** Test only in the isolated headless instance.

## Layout

Most of the code is in the shared library **file-plus-plus** (`../file-plus-plus`, linked with bun; read its CLAUDE.md for the reader, the Obsidian layer, the `fpp` → `epp` prefix and most gotchas). This repo keeps what is EPUB-specific:

```
packages/core/       @epub-pp/core — EPUB engine (no Obsidian imports)
  book/              EpubBook (fflate unzip, OPF, spine, TOC from nav/NCX), XML helpers, extract.ts (BookText)
  css/rewrite.ts     publisher CSS → shadow-root CSS (scoping, font scaling, var() fallbacks, @font-face lifting)
  locators/          cfi.ts (parse/serialize/compare, DOM↔CFI), locator.ts (cfi / text / href schemes)
  render/            reader.ts (EpubReader extends DocumentReader), content.ts (spine item → DOM), epub-css.ts
packages/obsidian/   the plugin (id `epub-plus-plus`, prefix `epp`)
  main.ts            EpubPlusPlus extends FilePlusPlusPlugin; extractText API; settings migration
  format.ts          the EPUB FileFormat (CFI positions, preview spine items, {{cfi}})
  api.ts             EpubPlusPlusApi = FileApi + extractText
demo/                Bun dev server + test page for the core reader in plain Chromium
scripts/             install, fixtures, wrappers around file-plus-plus's headless Obsidian + CDP drivers
test-vault/          dev vault; .obsidian/plugins/epub-plus-plus → ../../../packages/obsidian/dist (symlink)
```

## Commands

```sh
bun test                          # unit tests (core CFI/CSS, plugin text logic)
bun run typecheck
bun run build                     # → packages/obsidian/dist
scripts/install.sh ~/Obsidian     # build + copy into the user's vault
bun run fixtures                  # sample EPUBs into fixtures/ and test-vault/Books/
bun run demo                      # :3737 core reader; `bun run test:browser` = CFI/text-fragment/TOC/search round trips
```

## Testing in real Obsidian (headless, isolated)

```sh
scripts/obsidian-headless.sh mobile      # or desktop; own profile, CDP on :9333 (`FPP_CDP_PORT=…` for all three scripts; it refuses a port in use); `… stop` to quit
bun run build && bun scripts/cdp.ts --file scripts/obsidian-reload.js       # reload plugin after a build
bun scripts/cdp.ts --eval "…js…" [--shot out.png] [--logs ms] [--throttle 6] [--title Settings]
bun scripts/cdp-input.ts --click x,y[,mods] | --tap x,y | --dbltap x,y | --hold x,y | --swipe x1,y1,x2,y2 | --drag … | --hover x,y,mods | --rightclick x,y | --key ctrl+c  [--eval "…"]
```

- **Page scripts:** wrap them in one async IIFE and prepend `scripts/obsidian-helpers.js` (`getView()`, `reloadPlugin()`, `sleep`). Top-level `const`s persist between evaluations.
- **Real input:** use `cdp-input.ts` (real CDP mouse/touch/key events), not `.click()`, for anything involving selection, menus, gestures or Ctrl+C. Read the clipboard with `require('electron').clipboard.readText()`.
- **Phone speed:** `--throttle 6` approximates a phone when measuring performance.
- **Screenshots:** look at them after UI changes. A modal or menu left open by a previous step blocks later input.
- **Settings window:** it opens as a separate page; target it with `--title Settings`.

## Gotchas learned the hard way (EPUB-specific; the general ones are in file-plus-plus's CLAUDE.md)

- **CFIs:** generated CFIs omit `[id]` assertions, because `[` `]` break wikilinks. Point CFIs (annotation-file headings) are positions, not highlights; highlights must be ranges.
- **Shadow DOM:** `rem` units refer to Obsidian's root, so they're rewritten; `@font-face` is lifted to the document (`data-epp-fonts`).
- **`BookText` CFIs must equal the reader's:** both walk the original document structure (rendering imports it unchanged).
- **Prefix:** EPUB code uses its own `epp-` names (`epp-html`, `data-epp-spine`, `data-epp-css`) and `PREFIX` for library-owned ones (CSS variables, link attributes, the user layer). Unit tests see `fpp`, builds `epp`.
- **Settings:** EPUB++'s data.json predates the library: `openEpubIn` → `openIn` (`migrateSettings`), `linkType: 'cfi'` → `'primary'` (library v4).
