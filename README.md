# EPUB++

A [PDF++](https://github.com/ryotaushio/obsidian-pdf-plus)-style EPUB reader for Obsidian. Highlights are not stored in the EPUB or a sidecar file: **every link from a note into an EPUB passage is a highlight**.

```markdown
[[Moby Dick.epub#epubcfi(/6/14!/4/2/4/2,/1:0,/1:16)&color=yellow|Moby-Dick, Chapter 1]]
[[Moby Dick.epub#:~:text=Queequeg%20was%20a%20native%20of%20Rokovoko&color=blue|Queequeg]]
[the Manhattoes](Moby%20Dick.epub#epubcfi%28/6/14!/4/2/6/2,/1%3A0,/1%3A48%29&color=green)
```

Most of EPUB++ is [file-plus-plus](../file-plus-plus), a library shared with the other "++" plugins (e.g. Transcript++): the reader (highlights, annotation layers, search, text fragments, selection) and the whole Obsidian side (view, sidebar, menus, link interception, highlight index, annotation files, comments, previews, settings). This repo adds what is specific to EPUB:

| Package | What it is |
|---|---|
| `packages/core` (`@epub-pp/core`) | The EPUB engine: parsing, EPUB CFI, publisher CSS rewriting, `EpubReader` (a file-plus-plus `DocumentReader`), `BookText`. No Obsidian imports, so it can drive other apps (see `demo/`). |
| `packages/obsidian` | The Obsidian plugin (id `epub-plus-plus`): the EPUB `FileFormat` (`format.ts`) and `extractText` in the API. |

## Features

- **One document, no iframe.** All spine items are joined into a single document inside a shadow root. The shadow root isolates book CSS from Obsidian's CSS, and big books stay fast thanks to `content-visibility: auto` (Moby-Dick renders in about 100 ms, a 24 MB illustrated book in about 200 ms).
- **Publisher CSS kept, made adjustable.** Book stylesheets are rewritten rather than discarded:
  - `px`/`pt`/keyword font sizes and `rem` become multiples of the user's base size, so heading-to-body proportions survive font size changes.
  - `color`, `line-height`, `font-family` and `text-align` fall back through CSS variables, so themes and reader settings apply live without re-rendering.
  - `@font-face` rules are lifted to the document, because they don't work inside shadow roots, and renamed per book.
- **Links in either style.** Wiki or markdown links, using CFI (default) or Text Fragments (`:~:text=`), plus plain hrefs (`#chapter_010.xhtml#sec3`).
  - Clicking a link switches to the EPUB's tab (even an unloaded background tab), or opens it next to the note. With *Reuse tabs and panes*, it opens as a tab in an existing other pane before splitting again.
  - The link opening is intercepted, PDF++-style, through a patch of `Workspace.openLinkText`.
- **Footnotes where they're referenced.** Hovering a link to a note (`epub:type="noteref"`, a link into an `<aside>` or a footnote, or a superscript or short mark like `1`, `[12]`, `*`) shows the note in a popover; on a phone, tapping it does. Clicking (tapping) the popover goes to the note.
- **Live highlights.** Rendered with the CSS Custom Highlight API, so the DOM is never mutated and CFIs stay valid. They update as notes change.
  - Hide them with the eye button in the sidebar's Highlights tab, the *Show / hide highlights* command, or the setting; the sidebar still lists them. Comments in the margin have their own toggle (the comment button next to it); with highlights hidden, hovering or selecting a comment shows its highlight. Hovering a highlight (or its comment) dims the others, with a short animation.
- **Highlight actions.**
  - Click a highlight to open the source note at that line.
  - New highlight links carry `&updated=<UTC time>` (e.g. `20261008T140312Z`), rewritten whenever the highlight's color or comment changes, so the link records when it was last touched (shown in the sidebar and on margin comments; can be turned off).
  - Right-click it for *Change color* (rewrites `&color=` in the note, plus a surrounding `> [!quote|color]` callout header), *Open*, *Copy link*, and *Delete highlight* (removes the link, with its callout and comment, from the note; asks first only when there's a comment, and Shift-click skips the question).
- **Copy menu on any text.** Right-click a selection to get *Link Only*, *Text Only* and your copy formats (*As Callout*, *As Quote*, …), with the *Copy | Insert | Both* row on top when the book has an annotation file, or right-click without a selection to target the paragraph under the pointer (on a highlight, those items only copy).
  - A row of color swatches at the top of the menu picks the color the items use (the toolbar color). On a highlight, its own row recolors it.
  - Formats are templates (`{{text}}`, `{{link}}`, `{{color}}`, `{{chapter}}`, …), and multi-line values keep their `> ` prefix.
  - `{{context}}` is the selection `==highlighted==` in its sentence; select a whole sentence (with or without its final punctuation and quotes) and it comes with the sentences before and after, from the neighboring paragraphs at a paragraph's edge. The default *Highlight in context* format uses it.
  - Formats with `{{comment}}` ask for a comment first. The comment editor can use Vim keys (setting, off by default, desktop): a new comment starts in insert mode, Escape goes to normal mode (and, as a setting, keys like `jk` typed quickly), `:w` (or Ctrl/Cmd+Enter) saves and `:q` cancels. The default *Callout with comment* nests the quote and puts your comment below it.
  - Which items appear in the selection and highlight menus, and in what order, is configurable.
  - Ctrl/Cmd+C copies with a chosen action, and every copy style is a command you can bind to a hotkey.
  - **Number keys pick the color** (setting, off by default): 1–9 in palette order, 0 for no color, while a book is focused and you aren't typing. Obsidian's hotkeys need a modifier; *Use highlight color 1…9* and *Use no highlight color* are commands for that.
  - **Vim-like keys** (setting, off by default): `j` / `k` scroll (smoothly, and steadily while held), `d` / `u` half a screen, `f` / `b` a screen, `g g` / `G` jump to the beginning / end, `Ctrl+O` / `Ctrl+I` back / forward through the places you jumped from (Vim's jump list, across books: keys, the outline, search results, links in the book or from your notes; starting where the book opened; a link that opens a book starts it where the book would have opened by itself), `o` opens another book (as the command *Open EPUB file…*, a file picker for books only), `/` search, `n` / `N` the next / previous result, `Alt+C` / `Alt+W` / `Alt+R` toggle match case, whole word and regex in the search box (and in its results), `Escape` in the text clears the matches from the page (`n` / `N` bring them back), `] h` / `[ h` the next / previous highlight and `] c` / `[ c` the next / previous comment (after the one you went to last, or, once you scroll, after where you are; also commands), `Tab` moves into the outline (`j` / `k` or arrows move, `g g` / `G` the first / last entry, `h` / `l` fold, `Enter` goes there, `Tab` or `Escape` back to the text), `\` toggles the sidebar, `g c` comments in the margin, `g h` highlights, `h` labels the sentences in view (like Vimium's link hints or flash.nvim): type a label to highlight its sentence in the current color, as a copy format (*Callout* by default, inserted into the annotation file per its mode), or type it with Shift to pick words in that sentence (from a word to a word); the number keys change the color while the labels are up; with text selected, `h` highlights the selection instead; `c` does the same with a comment (*Callout with comment*); `H` / `C` highlight or comment on a passage from word to word: pick the sentence it starts in, its first word, the sentence it ends in and its last word (or, as a setting, the first and last word among every word in view), with what's picked so far shown selected; starting at a sentence's first word takes the opening quote or bracket before it, and ending at its last word the period or closing quote after it (each a setting); `Escape`, scrolling or a click puts the labels away (also commands, *Highlight / Comment on a sentence in view*, *… from a word to a word*; the label keys, `asdfjklghqweruio` by default, best first, one each while they fit and else two, and both formats are settings); `v` / `V` pick a sentence (Shift on its label: words in it) / a passage from word to word the same way and select it: then `h` highlights it, `c` comments on it, `y` copies its plain text and `Escape` lets go (also commands, *Select a sentence in view*, *Select from a word to a word in view*); `s h` labels the highlights in view and selects the one you type (underlined; a highlight just made with the keys is selected too), `s c` the same among highlights with a comment: then the number keys recolor it, `c` edits its comment, `d` deletes it (`d y` when it has a comment) and `Escape` lets go; `s f` labels the footnote links in view and shows the note of the one you type (`Enter` goes to it, `Escape` closes it); `Ctrl+Z` / `Ctrl+Y` undo / redo what was last written into a note from the book (a highlight added, recolored, commented on or deleted, a new annotation file; only while the note is as that left it; also commands), `m` + a letter sets a mark and `'` + the letter goes back to it (`a`–`z` in this book, `A`–`Z` across books, `''` where you were before the last jump; marks sync with your settings). A sidebar you closed with `\` and then opened with `Tab`, `/` or the search button closes again once you're back in the text (Enter, Escape in an empty search box, a click in the text). In the search box, `Ctrl+N` / `Ctrl+P` step through the results and `Enter` moves into them (`j` / `k`, `Enter` goes there, `/` back to the box). Change or turn off each one under *Settings → Reading → Keyboard*, by typing it or recording it: modifiers in front (`Ctrl+d`, `Alt+j`, `Mod+k`), several keys separated by spaces (`g g`). They work only while a book is focused and you aren't typing, and there they come before Obsidian's hotkeys; other keys still reach the hotkeys.
- **Annotation files.** A note per book with a heading per TOC entry; each heading links to its chapter with a point CFI, so it never draws a highlight. The note is tied to the book by its `epub` property. *Change annotation folder…* (command, or *Move…* next to the folder setting) moves existing annotation files to a new folder; when a book ends up with several, they are merged into one (annotations in book order, duplicates skipped, links to the merged files repointed).
  - While a book has one, copying from the selection menu can **insert** the annotation into the right chapter section, in book order. Placement uses a binary search over existing blocks by their CFI.
  - Text-fragment links are located in the book to compare them; this can be turned off. When the position is unclear, the annotation is appended to the end of the section.
  - *Copy*, *Insert* or *Both* is a global default, overridable per file via its `epub-annotation-mode` property or the row in the selection menu.
- **Comments on highlights.** A comment is the text after the double-embedded quote in a highlight's callout, the layout *Callout with comment* produces.
  - **In the margin**, Google Docs style: comments sit beside their passages and scroll with the book; the text moves left to make room. Hovering a card underlines its passage, clicking it lines it up with the passage (others make way), double-clicking edits it, right-clicking opens the highlight menu. Toggle it in settings, with the *Toggle comments in the margin* command (bind a hotkey), or from the tab's menu.
  - When the pane is too narrow for the margin (phones), hovering a highlight shows its comment; on mobile, tapping does.
  - The highlight menu has *Add comment* / *Edit comment*. Adding one double-embeds the callout's existing lines as they are and appends the comment.
- **Import highlights from JSON.** *Import highlights from JSON…* (command), or *Import highlights into EPUB++…* in a `.json` file's menu. Paste the JSON or pick a file; each highlight goes into its book's annotation file (created if needed), merged in book order.
  - Choose the format per kind, and turn kinds off: *No comment* (e.g. *Insert as Callout*) and *Comment* (e.g. *Insert as Callout with Comment*). The choices are remembered.
  - Duplicates are skipped: a highlight already in your notes (or earlier in the file) with the same passage **and** the same comment. Passages are compared in the book, so a CFI and a text fragment for the same words match.
  - A highlight already in the book's annotation file at the same passage (CFI) is rewritten in the format chosen now (e.g. after switching a format to `{{context}}`, importing again redoes the old callouts), with the import's color, date and comment; its own comment is kept when the import has none. One already in that format is left alone.
  - Highlights whose book or passage can't be found are listed afterwards, not imported.

  ```json
  [
    { "book": "Moby Dick.epub", "cfi": "epubcfi(/6/14!/4/2/4/6,/1:0,/1:76)", "comment": "The spleen line.", "color": "red", "updated": "2026-10-08T14:03:12Z" },
    { "book": "Moby Dick", "textFragment": ":~:text=Call%20me%20Ishmael", "color": "yellow" },
    { "book": "Books/Pride and Prejudice.epub", "text": "It is a truth universally acknowledged", "comment": "Famous opening." }
  ]
  ```

  `book` (or `file` / `path` / `title`): a path, file name, or name without `.epub`; without one, the book open when importing. The passage: `cfi` (or `locator`), `textFragment`, or just `text`. Optional: `comment` (or `note`), `color` (palette name or CSS color), `updated` (ISO date or epoch; becomes the link's `&updated=`). The list may also be wrapped as `{ "highlights": [...] }`.
- **Import from Apple Books.** *Import highlights from Apple Books…* (command), or the menu of an `.sqlite` file in the vault. Copy Apple Books' annotation database (`AEAnnotation….sqlite` from `~/Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation` on a Mac) into the vault **with its `-wal` file** (it holds the newest highlights).
  - Apple Books knows books only by an id, so match each one to an EPUB in your vault once (the dialog shows its chapters and a few highlights to recognize it by); the matches are remembered, follow renames, and books can be skipped. **Find matches** looks the unmatched books' highlights up in your vault's EPUBs and matches them for you; tabs (*To match*, *Matched*, *Skipped*) and a filter keep a long list manageable.
  - Then the JSON import continues as above (formats per kind, duplicates skipped, highlights imported before rewritten in the current format). Notes become comments, Apple's colors map to the palette (pink → red), and Apple's modification time becomes `&updated=`.
  - When your EPUB is another edition than Apple's, highlights whose CFI doesn't land on the same words are found by their text instead.
  - The results are a table per book: added, rewritten in the current format, already there, of a kind turned off (amber), not found (red; tap to see which), and the books that weren't imported (skipped in amber, unmatched in red).
  - The database is read by a small built-in SQLite reader (no native modules), so this works on mobile too.
- **Selecting by sentence.** A triple click selects the sentence under the pointer, a fourth click its paragraph.
- **Markdown copying.** Selections are converted from the book's HTML to Markdown (emphasis, including CSS-styled; lists; headings; line breaks) for copying and `{{text}}`. This can be turned off.
- **Sidebar.** The in-view sidebar has three tabs:
  - **Contents:** the table of contents, tracking the current chapter.
  - **Search:** case / whole word / regex; results are grouped by chapter and step with Enter / Shift+Enter.
  - **Highlights:** all highlights, those in the annotation file, or those elsewhere; grouped by book order, chapter or note, with comments rendered and annotation-file entries labeled by their section heading.
- **Annotations from other plugins.** Other plugins can mark passages in a book through EPUB++'s API, e.g. [Topos Bible](https://github.com/MasterTemple/topos-bible) marks Bible references.
  - Each plugin (provider) chooses how its annotations are drawn (a background, a dashed underline, a glow…). They're drawn below your highlights.
  - Each gets a sidebar tab: its annotations in book order, grouped by chapter, with a filter, Enter / Shift+Enter to step through them, and an eye button to show or hide them in the book.
  - Right-click one (hold or tap it on mobile) for *Save as highlight* and *Save with comment…*, which insert it into the annotation file (created if needed), plus the provider's own items. Hovering shows the provider's tooltip.
- **Previews.**
  - EPUB links preview on hover in Reading view, and in the editor without Ctrl/Cmd (toggle under Page preview).
  - Links inside a preview either jump within the preview or open the EPUB tab.
- **Backlinks.** Obsidian's Backlinks pane works for EPUBs. Hovering a backlink underlines its passage and scrolls to it.
- **Appearance.** Theme (match Obsidian, light, sepia, dark, publisher), font size and family, line spacing, alignment, reading width (`em`, `ch`, `px`, `%`), margins, and image dimming. Each device keeps its own settings, separately for a horizontal and a vertical window (rotate the phone or reshape the window to switch), and any book can have its own (*This book* in the appearance panel). Footnote references are drawn small and raised.
- **Mobile.**
  - Tapping, double-tapping and holding a highlight run configurable actions: open the note, add/edit comment, menu, color, copy link, or select the paragraph.
  - Selecting text, or double-tapping a paragraph, opens EPUB++'s menu. *System menu* hands the selection back to the OS toolbar.
  - Swiping towards the left drawer opens the EPUB++ sidebar first, and Obsidian's drawer on the next swipe. The sidebar is also a drawer on narrow desktop panes, via a container query.
  - Vertical swipes scroll the book instead of triggering Obsidian's pull-down.
  - The appearance panel is a bottom sheet on phones.
  - Floating ▲/▼ buttons step through search results.
- **Reading position** is saved per book as a CFI and restored exactly.
- **Book search** (ribbon's library icon, *Search books*, *Search this book*, or *Search in this book* on an EPUB's menu): every EPUB in the vault searched at once with [fff-epub](https://github.com/MasterTemple/fff-epub), in a tab.
  - *Text* (`'` `"` `-` also match curly quotes and dashes; a phrase stays in its paragraph), *Regex*, or *Fuzzy* (typos and gaps: "justfication by fath" finds "justification by faith"); smart case, whole words.
  - Where: all books, folders, the book in front, or books you pick by title, author, or path; and a filter on titles, authors, and paths.
  - Results grouped by book (or one list), books by path, most matches, or title; each match with its chapter, paragraph, ±1–3 paragraphs of context, whole paragraphs or the words around it, and its CFI. Click to open the book there (Ctrl/Cmd: a new tab); ↓/↑ and Enter from the search box; copy a link, a quote with its link, the paragraph, or the CFI.
  - On desktop it runs the native `fff-epub serve` once for the session: books' text is cached (`~/.cache/fff-epub/text`), so a page of matches across 1,800 books takes about 150 ms. Install it from the fff-epub repository (`cargo install --path crates/fff-epub-cli`); EPUB++ looks in `~/.cargo/bin` and the usual places, or set its path from the engine button. On phones (or without it) fff-epub runs as WebAssembly in a worker, a book at a time with progress: the same matches and CFIs, slower across many books.

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
const sel = reader.getSelection();                      // { locator (a CFI), text, textFragment(), tocItem, range }
const hits = reader.search('white whale', { wholeWord: true });
reader.on('relocated', (loc) => save(loc.locator));
reader.on('highlight-click', (e, highlights) => …);
reader.on('contextmenu', (e, { selection, highlights }) => …);
```

`BookText.extract(book, { blockSeparator })` gives a book's text per spine item without rendering it, and `cfi(spineIndex, start, end)` turns offsets in that text into the same range CFIs the reader produces. `reader.setLayer(id, specs, { style, priority, hidden })` draws a layer of annotations (painted with static ranges, so thousands are cheap); the reader emits `annotation-click` and `annotation-hover` for them.

The CFI helpers (`parseCfi`, `serializeCfi`, `compareCfi`, `pointToPath`, `resolvePath`) and EPUB locators (`parseEpubLocator`, `EPUB_SCHEMES`) are exported individually; text fragments and the generic reader come from `file-plus-plus/core`.

## Plugin API (for other Obsidian plugins)

Once the workspace event `epub-plus-plus:api-ready` has fired (its argument is the API, also at `app.plugins.plugins['epub-plus-plus'].api`). The types are in `packages/obsidian/src/api.ts` (shared parts: `FileApi` in file-plus-plus).

```ts
const api = app.plugins.plugins['epub-plus-plus']?.api;
const book = await api.extractText(file, { blockSeparator: '\n\n' }); // { sections: [{ spineIndex, href, title, text }], cfi() }
const cfi = book.cfi(section.spineIndex, start, end);                 // UTF-16 offsets in section.text
const unregister = api.registerAnnotationProvider({
  id: 'my-plugin', name: 'Names', icon: 'user',
  noun: 'names',                                                 // in sentences: "Filter names…"
  color: 'purple',                                               // palette name or CSS color
  style: (c) => `text-decoration: underline dotted 2px ${c};`,  // ::highlight() declarations
  annotations: (file) => [{ id: '1', locator: cfi, label: 'Ishmael' }],
  onClick: (annotations, event, ctx) => false,                  // true when handled
  menu: (menu, annotations, ctx) => menu.addItem(…),
  tooltip: (annotation, ctx) => annotation.label,
});
api.refreshAnnotations('my-plugin', [file.path]);               // after they change
```

`epub-plus-plus:api-unload` fires when EPUB++ unloads; register again on the next `api-ready`. `api.open(file, locator)` opens a book at a locator, and `api.link(file, locator, alias)` builds a link in the user's style.

## Development

file-plus-plus is a sibling checkout, linked with bun (until it is published):

```sh
(cd ../file-plus-plus && bun install && bun link)
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

`test-vault/` is an Obsidian vault whose `.obsidian/plugins/epub-plus-plus` is a symlink to `packages/obsidian/dist`. Open it in Obsidian, or drive an isolated headless instance (it never touches your running Obsidian):

```sh
scripts/obsidian-headless.sh mobile          # or desktop; CDP on :9333
bun scripts/cdp.ts --file scripts/obsidian-reload.js           # reload the plugin after a build
bun scripts/cdp.ts --eval "…" --shot shot.png
bun scripts/cdp-input.ts --tap 200,400 --eval "…"              # real touch/mouse/key input
scripts/obsidian-headless.sh stop
```

See `CLAUDE.md` for architecture notes and pitfalls.

## Known limitations

- Fixed-layout (pre-paginated) EPUBs are rendered as a scroll, not as pages.
- Scripted EPUB content is disabled.
- DRM-protected files are not supported.
- Highlight opacity changes apply to newly opened books.
