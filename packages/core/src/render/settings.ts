export type ThemeName = 'auto' | 'light' | 'dark' | 'sepia' | 'publisher';
export type WidthUnit = 'px' | 'ch' | 'em' | '%';
export type TextAlign = 'publisher' | 'left' | 'justify';

export interface ReaderSettings {
	/** `auto` follows the host page (Obsidian theme variables, or system colors). */
	theme: ThemeName;
	/** Base font size in px. Publisher sizes scale relative to this. */
	fontSize: number;
	/** CSS font-family; empty string keeps the publisher's fonts. */
	fontFamily: string;
	/** Unitless line height; null keeps the publisher's. */
	lineHeight: number | null;
	textAlign: TextAlign;
	/** Maximum reading width; 0 = no limit. */
	width: number;
	widthUnit: WidthUnit;
	/** Horizontal padding in px. */
	margin: number;
	/** Slightly dim images in dark themes. */
	dimImages: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	theme: 'auto',
	fontSize: 18,
	fontFamily: '',
	lineHeight: null,
	textAlign: 'publisher',
	width: 42,
	widthUnit: 'em',
	margin: 24,
	dimImages: true,
};

interface ThemeColors {
	bg: string;
	fg: string;
	link: string;
	dark: boolean;
}

const THEMES: Record<Exclude<ThemeName, 'publisher'>, ThemeColors> = {
	auto: {
		bg: 'var(--background-primary, Canvas)',
		fg: 'var(--text-normal, CanvasText)',
		link: 'var(--text-accent, LinkText)',
		dark: false,
	},
	light: { bg: '#ffffff', fg: '#1d1d1f', link: '#2e5fa8', dark: false },
	dark: { bg: '#1c1c1e', fg: '#d6d6d6', link: '#8ab4f8', dark: true },
	sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8a4b16', dark: false },
};

/** CSS custom properties to set on the host element for the given settings. */
export function settingsToVars(s: ReaderSettings, hostIsDark: boolean): Record<string, string | null> {
	const themed = s.theme !== 'publisher';
	const t = themed ? THEMES[s.theme as keyof typeof THEMES] : null;
	const dark = s.theme === 'auto' ? hostIsDark : !!t?.dark;
	return {
		'--epp-font-size': `${s.fontSize}px`,
		'--epp-font-family': s.fontFamily || null,
		'--epp-line-height': s.lineHeight ? String(s.lineHeight) : null,
		'--epp-text-align': s.textAlign === 'publisher' ? null : s.textAlign,
		'--epp-max-width': s.width > 0 ? `${s.width}${s.widthUnit}` : 'none',
		'--epp-margin': `${s.margin}px`,
		'--epp-bg': t ? t.bg : '#ffffff',
		'--epp-fg': t ? t.fg : '#000000',
		'--epp-text-color': t ? t.fg : null,
		'--epp-link-color': t ? t.link : null,
		'--epp-bg-override': t ? 'transparent' : null,
		'--epp-img-filter': dark && s.dimImages ? 'brightness(0.85)' : 'none',
		'--epp-color-scheme': dark ? 'dark' : 'light',
	};
}

export const BASE_CSS = /* css */ `
@layer epp-base, publisher, epp-user;

:host {
	display: block;
	position: relative;
	overflow: hidden;
	contain: strict;
}
.epp-scroller {
	all: initial;
	display: block;
	position: absolute;
	inset: 0;
	overflow-y: auto;
	overflow-x: hidden;
	background: var(--epp-bg);
	color: var(--epp-fg);
	color-scheme: var(--epp-color-scheme);
	font-family: serif;
	-webkit-text-size-adjust: none;
	text-size-adjust: none;
	overscroll-behavior: contain;
	/* Host apps (e.g. Obsidian) often set user-select: none on <body>; 'auto' would inherit it. */
	-webkit-user-select: text;
	user-select: text;
	-webkit-touch-callout: default;
}
.epp-scroller:focus { outline: none; }
.epp-content {
	box-sizing: content-box;
	max-width: var(--epp-max-width, none);
	margin: 0 auto;
	padding: 2em var(--epp-margin, 24px) 50vh;
	font-size: var(--epp-font-size);
}

@layer epp-base {
	.epp-html {
		display: block;
		font-size: var(--epp-font-size);
		line-height: var(--epp-line-height, normal);
		font-family: var(--epp-font-family, serif);
		text-align: var(--epp-text-align, start);
		color: var(--epp-text-color, inherit);
		content-visibility: auto;
		contain-intrinsic-size: auto 800px;
		overflow-wrap: break-word;
	}
	.epp-body { display: block; margin: 0; }
	.epp-html + .epp-html { margin-top: 3em; }
}

@layer epp-user {
	.epp-html img, .epp-html video { max-width: 100%; height: auto; filter: var(--epp-img-filter); }
	.epp-html svg { max-width: 100%; max-height: 95vh; }
	.epp-html img { max-height: 95vh; object-fit: contain; }
	.epp-themed .epp-html a[href] { color: var(--epp-link-color); }
	.epp-html table { max-width: 100%; }
	.epp-html pre { white-space: pre-wrap; }
}
`;
