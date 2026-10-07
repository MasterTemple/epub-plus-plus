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

export type LinkType = 'cfi' | 'text';
export type LinkStyle = 'auto' | 'wiki' | 'markdown';
export type OpenTarget = 'split' | 'tab' | 'current';

export interface EppSettings {
	reader: ReaderSettings;
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
	/** Last reading position per EPUB path. */
	positions: Record<string, string>;
}

export const DEFAULT_SETTINGS: EppSettings = {
	reader: { ...READER_DEFAULTS },
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
		{ id: 'text-with-link', name: 'Text with link', template: '{{text}} ({{link}})' },
	],
	copyAction: 'text',
	noColor: 'default',
	jumpHighlight: true,
	jumpHighlightDuration: 2000,
	jumpHighlightColor: '#ffb000',
	previews: true,
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
