import { DEFAULT_SETTINGS as READER_DEFAULTS, type ReaderSettings } from '@epub-pp/core';

export interface PaletteColor {
	name: string;
	color: string;
}

export interface CopyFormat {
	/** Stable id (command ids / copy action refer to it). */
	id: string;
	name: string;
	template: string;
}

/** What a copy produces: plain text, a link, the alternate link type, or a copy format (`format:<id>`). */
export type CopyAction = 'text' | 'link' | 'alt-link' | `format:${string}`;

/** One entry of a configurable context menu. */
export interface MenuEntry {
	id: string;
	show: boolean;
}

export type LinkType = 'cfi' | 'text';
/** What a touch gesture on a highlight does (mobile). */
export type HighlightGestureAction = 'open' | 'comment' | 'menu' | 'color' | 'copy-link' | 'select' | 'none';
export const HIGHLIGHT_GESTURE_LABELS: Record<HighlightGestureAction, string> = {
	open: 'Open the note (link)',
	comment: 'Add / edit comment',
	menu: 'Open the highlight menu',
	color: 'Change color',
	'copy-link': 'Copy link',
	select: 'Select the paragraph',
	none: 'Nothing',
};
/** What copying a selection does when the book has an annotation file. */
export type AnnotationMode = 'copy' | 'insert' | 'both';
export const ANNOTATION_MODES: AnnotationMode[] = ['copy', 'insert', 'both'];
/** Frontmatter keys of annotation files. */
export const ANNOTATION_EPUB_KEY = 'epub';
export const ANNOTATION_MODE_KEY = 'epub-annotation-mode';
export type LinkStyle = 'auto' | 'wiki' | 'markdown';
export type OpenTarget = 'split' | 'tab' | 'current';

/** Desktop or mobile (phones and tablets): where a new device's appearance starts from. */
export type AppearancePlatform = 'desktop' | 'mobile';
/** The window's shape: horizontal (landscape) or vertical (portrait). */
export type Orientation = 'landscape' | 'portrait';
export const ORIENTATION_LABELS: Record<Orientation, string> = { landscape: 'Horizontal', portrait: 'Vertical' };

export interface DeviceInfo {
	name: string;
	platform: AppearancePlatform;
}

export interface EppSettings {
	/** Starting point of a device's appearance, per platform (and the appearance before devices existed). */
	appearance: Record<AppearancePlatform, ReaderSettings>;
	/** Devices that have used EPUB++ (id → name); each device keeps its id in local storage. */
	devices: Record<string, DeviceInfo>;
	/** Appearance for all books per device and orientation: `${deviceId}:${orientation}` → settings. */
	deviceAppearance: Record<string, ReaderSettings>;
	/** Per-book overrides: EPUB path → `${deviceId}:${orientation}` (or a legacy platform name) → changed settings. */
	bookAppearance: Record<string, Record<string, Partial<ReaderSettings>>>;
	palette: PaletteColor[];
	defaultColor: string;
	/** Color picked last in a menu or the palette (null = no color); undefined until first pick. */
	lastColor?: string | null;
	/** Include `&color=` in copied links. */
	colorInLinks: boolean;
	highlightOpacity: number;
	linkType: LinkType;
	linkStyle: LinkStyle;
	/** Display text of generated links. Variables: {{book}} {{author}} {{chapter}} {{text}} */
	aliasTemplate: string;
	copyFormats: CopyFormat[];
	/** What Ctrl/Cmd+C (and the system Copy menu) puts on the clipboard for a selection in an EPUB. */
	copyAction: CopyAction;
	/** Links without `&color=`: draw with the default color, or don't highlight them. */
	noColor: 'default' | 'none';
	/** Briefly highlight the passage after jumping to it from a link. */
	jumpHighlight: boolean;
	/** ms, including the fade-out. */
	jumpHighlightDuration: number;
	jumpHighlightColor: string;
	/** Copy selections as Markdown converted from the book's HTML (emphasis, lists…) instead of plain text. */
	copyMarkdown: boolean;
	/** Links clicked inside a preview: jump within the preview, or open the EPUB tab. */
	previewLinks: 'preview' | 'tab';
	/** Hover previews of EPUB links and `![[book.epub#…]]` embeds. */
	previews: boolean;
	/** Height of previews / embeds in px. */
	previewHeight: number;
	/** Where EPUB links open when no view of that EPUB is open yet. */
	openEpubIn: OpenTarget;
	/** Where the source note opens when clicking a highlight. */
	openNoteIn: OpenTarget;
	sidebarOpen: boolean;
	/** Mobile: open the EPUB++ menu when a selection settles. */
	selectionBar: boolean;
	/** Order and visibility of selection menu items: `link`, `alt-link`, `text`, `format:<id>`. */
	selectionMenu: MenuEntry[];
	/** Order and visibility of highlight menu items: `open`, `color`, `copy-link`. */
	highlightMenu: MenuEntry[];
	/** Folder for new annotation files; empty = next to the EPUB. */
	annotationFolder: string;
	/** File name (without .md). Variables: {{book}} {{author}} {{file}} */
	annotationFileName: string;
	/** Default for books with an annotation file (a file can override it in its frontmatter). */
	annotationMode: AnnotationMode;
	/** Resolve text-fragment links in annotation files to CFIs to place new annotations exactly. */
	annotationResolveTextFragments: boolean;
	/** Highlights tab: which highlights to list and how to group them. */
	highlightsFilter: 'all' | 'annotation' | 'other';
	highlightsGroup: 'book' | 'note' | 'chapter';
	/** "Split pane": reuse an open tab of the EPUB, or another pane, before splitting. */
	reusePanes: boolean;
	/** Mobile: what tapping, double-tapping and holding a highlight do. */
	highlightTap: HighlightGestureAction;
	highlightDoubleTap: HighlightGestureAction;
	highlightHold: HighlightGestureAction;
	/** What "Save as highlight" on another plugin's annotation inserts into the annotation file. */
	saveAnnotationAs: CopyAction;
	/** Annotation providers (other plugins) whose annotations aren't drawn in books. */
	hiddenProviders: string[];
	/** Bumped when settings need a one-time migration. */
	settingsVersion: number;
	/** Last reading position per EPUB path. */
	positions: Record<string, string>;
}

/** Asks for a comment: the quote is nested inside the callout, the comment follows it. */
export const COMMENT_TEMPLATE = '> [!quote|{{color}}] {{link}}\n> > {{text}}\n>\n> {{comment}}';

export const SELECTION_MENU_LABELS: Record<string, string> = {
	link: 'Link Only',
	'alt-link': 'Alternate Link (CFI ↔ Text Fragment)',
	text: 'Text Only',
};

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/** "Callout with comment" → "Callout with Comment". */
export function titleCase(text: string): string {
	return text.replace(/[^\s-]+/g, (w, i: number) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)));
}

/** Selection-menu label of a copy format ("As Callout with Comment"). */
export function formatMenuLabel(name: string): string {
	return `As ${titleCase(name)}`;
}

/** Selection-menu label of the alternate link type. */
export function altLinkLabel(linkType: LinkType): string {
	return linkType === 'cfi' ? 'Text-Fragment Link' : 'CFI Link';
}

export const HIGHLIGHT_MENU_LABELS: Record<string, string> = {
	open: 'Open the note',
	color: 'Change color',
	comment: 'Add / edit comment',
	'copy-link': 'Copy link',
	delete: 'Delete highlight',
};

export const DEFAULT_SETTINGS: EppSettings = {
	appearance: { desktop: { ...READER_DEFAULTS }, mobile: { ...READER_DEFAULTS } },
	devices: {},
	deviceAppearance: {},
	bookAppearance: {},
	palette: [
		{ name: 'yellow', color: '#ffd000' },
		{ name: 'red', color: '#ff5f5f' },
		{ name: 'green', color: '#4cc764' },
		{ name: 'blue', color: '#4c9bff' },
		{ name: 'purple', color: '#b07cff' },
	],
	defaultColor: 'yellow',
	colorInLinks: true,
	highlightOpacity: 0.4,
	linkType: 'cfi',
	linkStyle: 'auto',
	aliasTemplate: '{{book}}, {{chapter}}',
	copyFormats: [
		{ id: 'callout', name: 'Callout', template: '> [!quote|{{color}}] {{link}}\n> {{text}}' },
		{ id: 'quote', name: 'Quote', template: '> {{text}}\n\n{{link}}' },
		{ id: 'callout-comment', name: 'Callout with comment', template: COMMENT_TEMPLATE },
		{ id: 'text-with-link', name: 'Text with link', template: '{{text}} ({{link}})' },
	],
	annotationFolder: '',
	annotationFileName: '{{book}} - Annotations',
	annotationMode: 'both',
	annotationResolveTextFragments: true,
	highlightsFilter: 'all',
	highlightsGroup: 'book',
	reusePanes: true,
	highlightTap: 'open',
	highlightDoubleTap: 'comment',
	highlightHold: 'menu',
	selectionMenu: [],
	highlightMenu: [],
	settingsVersion: 3,
	copyAction: 'text',
	saveAnnotationAs: 'format:callout',
	hiddenProviders: [],
	noColor: 'default',
	jumpHighlight: true,
	jumpHighlightDuration: 2000,
	jumpHighlightColor: '#ffb000',
	previews: true,
	copyMarkdown: true,
	previewLinks: 'preview',
	previewHeight: 320,
	openEpubIn: 'split',
	openNoteIn: 'split',
	sidebarOpen: true,
	selectionBar: true,
	positions: {},
};

export function newFormatId(): string {
	return Math.random().toString(36).slice(2, 10);
}

/** Templates with {{comment}} ask for a comment before copying. */
export function needsComment(template: string): boolean {
	return template.includes('{{comment}}');
}

/** Keep a configured menu in sync with the available items: drop unknown ids, append new ones (shown). */
export function syncMenu(entries: MenuEntry[], ids: string[]): MenuEntry[] {
	const known = new Set(ids);
	const out = entries.filter((e) => known.has(e.id));
	const present = new Set(out.map((e) => e.id));
	for (const id of ids) if (!present.has(id)) out.push({ id, show: true });
	return out;
}

export function selectionMenuIds(s: EppSettings): string[] {
	return ['link', ...s.copyFormats.map((f) => `format:${f.id}`), 'alt-link', 'text'];
}

export function syncMenus(s: EppSettings): void {
	s.selectionMenu = syncMenu(s.selectionMenu ?? [], selectionMenuIds(s));
	s.highlightMenu = syncMenu(s.highlightMenu ?? [], Object.keys(HIGHLIGHT_MENU_LABELS));
}
