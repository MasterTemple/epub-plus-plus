# EPUB++

A [PDF++](https://github.com/ryotaushio/obsidian-pdf-plus)-style EPUB reader for Obsidian. Highlights are not stored in the EPUB or a sidecar file: **every link from a note into an EPUB passage is a highlight**.

```markdown
[[Moby Dick.epub#epubcfi(/6/14!/4/2/4/2,/1:0,/1:16)&color=yellow|Moby-Dick, Chapter 1]]
[[Moby Dick.epub#:~:text=Queequeg%20was%20a%20native%20of%20Rokovoko&color=blue|Queequeg]]
[the Manhattoes](Moby%20Dick.epub#epubcfi%28/6/14!/4/2/6/2,/1%3A0,/1%3A48%29&color=green)
```

The repo has two packages:

| Package | What it is |
|---|---|
| `packages/core` (`@epub-pp/core`) | A framework-agnostic EPUB engine: parsing, rendering, EPUB CFI, Text Fragments, highlights, search. No Obsidian imports, so it can drive other apps (see `demo/`). |
| `packages/obsidian` | The Obsidian plugin (id `epub-plus-plus`). A thin layer over core: view, link interception, highlight index, menus, settings. |

## Features

- **One document, no iframe.** All spine items are joined into a single document inside a shadow root. The shadow root isolates book CSS from Obsidian's CSS, and big books stay fast thanks to `content-visibility: auto` (Moby-Dick renders in about 100 ms, a 24 MB illustrated book in about 200 ms).
- **Publisher CSS kept, made adjustable.** Book stylesheets are rewritten rather than discarded:
  - `px`/`pt`/keyword font sizes and `rem` become multiples of the user's base size, so heading-to-body proportions survive font size changes.
  - `color`, `line-height`, `font-family` and `text-align` fall back through CSS variables, so themes and reader settings apply live without re-rendering.
  - `@font-face` rules are lifted to the document, because they don't work inside shadow roots, and renamed per book.
- **Links in either style.** Wiki or markdown links, using CFI (default) or Text Fragments (`:~:text=`), plus plain hrefs (`#chapter_010.xhtml#sec3`).
  - Clicking a link reuses an open tab for that EPUB, or opens it in a split by default.
  - The link opening is intercepted, PDF++-style, through a patch of `Workspace.openLinkText`.
- **Live highlights.** Rendered with the CSS Custom Highlight API, so the DOM is never mutated and CFIs stay valid. They update as notes change.
- **Highlight actions.**
  - Click a highlight to open the source note at that line.
  - Right-click it for *Change color* (rewrites `&color=` in the note, plus a surrounding `> [!quote|color]` callout header), *Open*, and *Copy link*.
- **Copy menu on any text.** Right-click a selection to get *Copy link* plus your copy formats (callout, quote, …), or right-click without a selection to target the paragraph under the pointer.
  - Tapping a colored item uses your previous color; its arrow opens a color picker.
  - Formats are templates (`{{text}}`, `{{link}}`, `{{color}}`, `{{chapter}}`, …), and multi-line values keep their `> ` prefix.
  - Formats with `{{comment}}` ask for a comment first. The default *Callout with comment* nests the quote and puts your comment below it.
  - Which items appear in the selection and highlight menus, and in what order, is configurable.
  - Ctrl/Cmd+C copies with a chosen action, and every copy style is a command you can bind to a hotkey.
- **Annotation files.** A note per book with a heading per TOC entry; each heading links to its chapter with a point CFI, so it never draws a highlight. The note is tied to the book by its `epub` property.
  - While a book has one, copying from the selection menu can **insert** the annotation into the right chapter section, in book order. Placement uses a binary search over existing blocks by their CFI.
  - Text-fragment links are located in the book to compare them; this can be turned off. When the position is unclear, the annotation is appended to the end of the section.
  - *Copy*, *Insert* or *Both* is a global default, overridable per file via its `epub-annotation-mode` property or the row in the selection menu.
- **Comments on highlights.** A comment is the text after the double-embedded quote in a highlight's callout, the layout *Callout with comment* produces.
  - Hovering a highlight shows its comment; on mobile, tapping does.
  - The highlight menu has *Add comment* / *Edit comment*. Adding one double-embeds the callout's existing lines as they are and appends the comment.
- **Markdown copying.** Selections are converted from the book's HTML to Markdown (emphasis, including CSS-styled; lists; headings; line breaks) for copying and `{{text}}`. This can be turned off.
- **Sidebar.** The in-view sidebar has a table of contents (tracks the current chapter), search (case / whole word / regex, results grouped by chapter, Enter / Shift+Enter to step through), and a list of the book's highlights.
- **Previews.**
  - EPUB links preview on hover in Reading view, and in the editor without Ctrl/Cmd (toggle under Page preview).
  - Links inside a preview either jump within the preview or open the EPUB tab.
- **Backlinks.** Obsidian's Backlinks pane works for EPUBs. Hovering a backlink underlines its passage and scrolls to it.
- **Appearance.** Theme (match Obsidian, light, sepia, dark, publisher), font size and family, line spacing, alignment, reading width (`em`, `ch`, `px`, `%`), margins, and image dimming.
- **Mobile.**
  - Selecting text, or double-tapping a paragraph, opens EPUB++'s menu. *System menu* hands the selection back to the OS toolbar.
  - Swiping towards the left drawer opens the EPUB++ sidebar first, and Obsidian's drawer on the next swipe. The sidebar is also a drawer on narrow desktop panes, via a container query.
  - Vertical swipes scroll the book instead of triggering Obsidian's pull-down.
  - The appearance panel is a bottom sheet on phones.
  - Floating ▲/▼ buttons step through search results.
- **Reading position** is saved per book as a CFI and restored exactly.

### Link format details

- The subpath is `#<locator>[&color=<name>]`, where `<locator>` is `epubcfi(...)` or `:~:text=...`.
- Generated CFIs omit `[id]` assertions by default, because the `[` and `]` characters break wikilinks.
- Markdown links encode `(`, `)` and `:`. Obsidian ignores markdown links whose destination contains a raw `:`, and runs `decodeURI` on destinations; `parseLocator` accepts both encoded and decoded forms.

## Core API (outside Obsidian)

```ts
import { EpubBook, EpubReader } from '@epub-pp/core';

const book = await EpubBook.open(arrayBuffer);          // metadata, spine, toc, resources
const reader = new EpubReader(hostElement, book, { settings: { theme: 'sepia', fontSize: 18 } });
await reader.render();

reader.goTo('epubcfi(/6/14!/4/2/4/2,/1:0,/1:16)');     // or ':~:text=…', an href, or a TocItem
reader.setHighlights([{ id: '1', locator: 'epubcfi(...)', color: 'yellow' }]);
reader.updateSettings({ fontSize: 22, width: 65, widthUnit: 'ch' });
const sel = reader.getSelection();                      // { cfi, text, textFragment(), tocItem, range }
const hits = reader.search('white whale', { wholeWord: true });
reader.on('relocated', (loc) => save(loc.cfi));
reader.on('highlight-click', (e, highlights) => …);
reader.on('contextmenu', (e, { selection, highlights }) => …);
```

The CFI (`parseCfi`, `serializeCfi`, `compareCfi`, `pointToPath`, `resolvePath`), Text Fragment and locator helpers are exported individually.

## Development

```sh
bun install
bun run fixtures        # download sample EPUBs (fixtures/ and test-vault/Books/)
bun test                # unit tests (CFI, CSS rewriting, link utils)
bun run typecheck
bun run build           # → packages/obsidian/dist/{main.js,manifest.json,styles.css}
bun run dev             # watch build
bun run install-plugin ~/Obsidian   # build + copy main.js/manifest.json/styles.css into a vault (works with mobile sync)
bun run demo            # http://localhost:3737 (core reader without Obsidian)
bun run test:browser    # with the demo running: CFI/text-fragment round trips, TOC, search, scaling
```

`test-vault/` is an Obsidian vault whose `.obsidian/plugins/epub-plus-plus` is a symlink to `packages/obsidian/dist`. You can open it in Obsidian, or drive an isolated headless instance:

```sh
electron43 /usr/lib/obsidian/app.asar --user-data-dir=/tmp/obs --ozone-platform=headless --remote-debugging-port=9333
bun scripts/cdp.ts --port 9333 --file scripts/obsidian-reload.js   # reload the plugin after a build
bun scripts/cdp.ts --port 9333 --eval "…" --shot shot.png
```

## Known limitations

- Fixed-layout (pre-paginated) EPUBs are rendered as a scroll, not as pages.
- Scripted EPUB content is disabled.
- DRM-protected files are not supported.
- Highlight opacity changes apply to newly opened books.
