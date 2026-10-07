import { DEFAULT_SETTINGS as READER_DEFAULTS, type ReaderSettings } from '@epub-pp/core';

export interface PaletteColor {
	name: string;
	color: string;
}

export interface CopyFormat {
	name: string;
	template: string;
}

export type LinkType = 'cfi' | 'text';
export type LinkStyle = 'auto' | 'wiki' | 'markdown';
export type OpenTarget = 'split' | 'tab' | 'current';

export interface EppSettings {
	reader: ReaderSettings;
	palette: PaletteColor[];
	defaultColor: string;
	/** Include `&color=` in copied links. */
	colorInLinks: boolean;
	highlightOpacity: number;
	linkType: LinkType;
	linkStyle: LinkStyle;
	/** Display text of generated links. Variables: {{book}} {{author}} {{chapter}} {{text}} */
	aliasTemplate: string;
	copyFormats: CopyFormat[];
	/** Where EPUB links open when no view of that EPUB is open yet. */
	openEpubIn: OpenTarget;
	/** Where the source note opens when clicking a highlight. */
	openNoteIn: OpenTarget;
	sidebarOpen: boolean;
	/** Mobile: show a floating copy bar while text is selected. */
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
		{ name: 'Callout', template: '> [!quote|{{color}}] {{link}}\n> {{text}}' },
		{ name: 'Quote', template: '> {{text}}\n\n{{link}}' },
		{ name: 'Text with link', template: '{{text}} ({{link}})' },
	],
	openEpubIn: 'split',
	openNoteIn: 'split',
	sidebarOpen: true,
	selectionBar: true,
	positions: {},
};
