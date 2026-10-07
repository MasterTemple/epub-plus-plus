# EPUB++ — notes for Claude

PDF++-style EPUB reader for Obsidian. Links from notes into an EPUB *are* the highlights. User-facing overview: `README.md`.

## Workflow the user expects

- **Tooling:** use `bun`, not npm or pnpm, and `fd` / `rg`, not find / grep.
- **After each change:**
  1. Run `bun test` and `bun run typecheck`.
  2. Commit (git identity is repo-local, a GitHub no-reply address; don't change it).
  3. Run `scripts/install.sh ~/Obsidian`. This copies `main.js`, `manifest.json` and `styles.css` into the user's vault, which syncs to their phone. Symlinks don't sync.
- **Mobile matters as much as desktop.** Test both (see Testing).
- **Don't touch the user's running Obsidian.** Test only in the isolated headless instance.

## Layout

```
packages/core/       @epub-pp/core — framework-agnostic engine (no Obsidian imports)
  book/              EpubBook (fflate unzip, OPF, spine, TOC from nav/NCX), XML helpers
  css/rewrite.ts     publisher CSS → shadow-root CSS (scoping, font scaling, var() fallbacks, @font-face lifting)
  locators/          cfi.ts (parse/serialize/compare, DOM↔CFI), text-fragment.ts, locator.ts (subpath parsing)
  render/            reader.ts (EpubReader), content.ts (spine item → DOM), settings.ts (themes/base CSS), markdown.ts
  book/extract.ts    BookText: per-spine-item text without rendering, offsets → CFIs (for other plugins)
  search/            text-index.ts (normalized/folded text ↔ DOM map), search.ts
packages/obsidian/   the plugin (id `epub-plus-plus`)
  main.ts            plugin: settings, link interception (openLinkText patch), copy, annotations, commands
  view.ts            EpubView (FileView): toolbar, menus, touch gestures, selection menu (mobile)
  sidebar.ts         Contents / Search / Highlights tabs
  highlight-index.ts vault links → highlights (+ comments, headings) per EPUB
  api.ts             public API for other plugins: extractText, annotation providers (reader layers, sidebar tabs)
  annotations.ts     annotation files (create, find by `epub` frontmatter, insert)
  annotation-utils.ts / comment-utils.ts / link-utils.ts   pure, unit-tested text logic
  embed.ts           embed registry: ![[book.epub#…]] and hover previews
demo/                Bun dev server + test page for the core reader in plain Chromium
scripts/             install, fixtures, headless Obsidian + CDP drivers (see Testing)
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
scripts/obsidian-headless.sh mobile      # or desktop; own profile, CDP on :9333 (`EPP_CDP_PORT=…` for all three scripts; it refuses a port in use); `… stop` to quit
bun run build && bun scripts/cdp.ts --file scripts/obsidian-reload.js       # reload plugin after a build
bun scripts/cdp.ts --eval "…js…" [--shot out.png] [--logs ms] [--throttle 6] [--title Settings]
bun scripts/cdp-input.ts --click x,y[,mods] | --tap x,y | --dbltap x,y | --hold x,y | --swipe x1,y1,x2,y2 | --drag … | --hover x,y,mods | --rightclick x,y | --key ctrl+c  [--eval "…"]
```

- **Page scripts:** wrap them in one async IIFE and prepend `scripts/obsidian-helpers.js` (`getView()`, `reloadPlugin()`, `sleep`). Top-level `const`s persist between evaluations.
- **Real input:** use `cdp-input.ts` (real CDP mouse/touch/key events), not `.click()`, for anything involving selection, menus, gestures or Ctrl+C. Read the clipboard with `require('electron').clipboard.readText()`.
- **Phone speed:** `--throttle 6` approximates a phone when measuring performance.
- **Screenshots:** look at them after UI changes. A modal or menu left open by a previous step blocks later input.
- **Settings window:** it opens as a separate page; target it with `--title Settings`.

## Gotchas learned the hard way

- **Markdown links:**
  - Obsidian ignores markdown link destinations containing a raw `:`, and runs `decodeURI` on them, which keeps `%3A` and `%2C` encoded.
  - So `mdEncode` encodes `( ) :`, and `parseLocator` accepts both the encoded and decoded forms.
  - Generated CFIs omit `[id]` assertions, because `[` `]` break wikilinks.
- **Point vs range CFIs:**
  - Point CFIs (annotation-file headings) are positions, not highlights; the index skips them.
  - Highlights must be ranges.
- **Shadow DOM:**
  - Obsidian sets `user-select: none` on `<body>`, so the scroller forces `user-select: text`.
  - `rem` units refer to Obsidian's root, so they're rewritten.
  - `@font-face` doesn't work inside shadow roots, so it's lifted to the document.
- **Annotation layers** (other plugins' annotations, `reader.setLayer`) can number thousands: they're StaticRanges, hit-tested only against those bucketed under the element at the pointer. `BookText` CFIs must equal the reader's: both walk the original document structure (rendering imports it unchanged).
- **Live Ranges are expensive:** Chromium updates every live Range on every DOM mutation. Use `StaticRange` for bulk painting (search results). Keep live ranges for user highlights only, since those are few and need hit-testing.
- **Per-window globals:** `CSS.highlights` and `Highlight` belong to each window. `EpubReader` uses its host's `doc` / `win`, and the view rebuilds the reader on `onWindowMigrated` (tab dragged to a popout).
- **Scroll position:** moving or hiding the host resets `scrollTop`. The reader keeps an anchor Range and restores it via a ResizeObserver (on reappear or width change).
- **Obsidian view lifecycle:**
  - `onLoadFile` can run before `onOpen`, so build the UI in the constructor.
  - Don't name fields `titleEl` (it shadows `View.titleEl`).
  - Background tabs are deferred views. Find them via `getViewState().state.file` and call `loadIfDeferred()`.
- **Mobile touch:**
  - Obsidian's pull-down gesture can't see the shadow scroller, so vertical swipes are stopped unless the book is at the top.
  - Tapping a selection fires `contextmenu`; `preventDefault` there blocks the OS selection toolbar ("System menu" relies on not doing so).
  - The release after a long press emits a synthetic mousedown/click; call `preventDefault` on that `touchend`.
  - Every tap also emits a mouse move, so hover UI must be desktop-only.
- **Selection in shadow DOM:** WebKit and Chromium differ, so try `shadowRoot.getSelection()`, then both `getComposedRanges` signatures (`{shadowRoots:[…]}` and spread), then a plain range.
- **Menus:**
  - Obsidian `Menu` items: the color arrow and the Copy/Insert/Both row are custom DOM inside `item.dom`. They stop pointer, touch and click events so the item's own action doesn't run.
  - `afterMenuHidden` / `keepPendingSelection` hand the "pending selection" from one menu to the next (e.g. the color picker).
- **Private APIs in use:**
  - `app.embedRegistry` (embeds and previews), `app.commands.removeCommand`, `app.setting.openTabById`, `app.emulateMobile`.
  - `editor.cm.posAtDOM` for editor hover, and the `openLinkText` patch (via `monkey-around`).
- **Settings:** `loadSettings` deep-clones the defaults (shared arrays used to leak) and migrates using `settingsVersion`. When adding copy formats or menu items, keep `syncMenus()` and `syncFormatCommands()` in mind.
