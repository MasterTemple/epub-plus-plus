import type { ReaderSettings, ThemeName, TextAlign, WidthUnit } from '@epub-pp/core';
import { Platform, Setting, setIcon, type SliderComponent, type TextComponent } from 'obsidian';
import type EpubPlusPlus from './main';
import { ORIENTATION_LABELS } from './settings';

const FONT_PRESETS: Record<string, string> = {
	'': 'Publisher',
	'var(--font-text)': 'Obsidian text font',
	'Georgia, "Times New Roman", serif': 'Serif',
	'system-ui, -apple-system, "Segoe UI", sans-serif': 'Sans-serif',
	'"Atkinson Hyperlegible", Verdana, sans-serif': 'Hyperlegible',
	'ui-monospace, Menlo, Consolas, monospace': 'Monospace',
};

/** What a set of appearance controls edits: all books on a platform, or one book. */
export interface AppearanceTarget {
	settings(): ReaderSettings;
	update(patch: Partial<ReaderSettings>): Promise<void>;
	/** Rows of settings this returns true for are marked (a book's own settings). */
	overridden?(key: keyof ReaderSettings): boolean;
}

/** All books' appearance for a device and orientation (default: this device, now). */
export function globalAppearance(plugin: EpubPlusPlus, key?: string): AppearanceTarget {
	return {
		settings: () => plugin.allBooksAppearance(key),
		update: (patch) => plugin.updateReaderSettings(patch, { key }),
	};
}

/** One book's appearance on this device, in the current orientation. */
export function bookAppearance(plugin: EpubPlusPlus, path: string): AppearanceTarget {
	return {
		settings: () => plugin.readerSettings(path),
		update: (patch) => plugin.updateReaderSettings(patch, { path }),
		overridden: (key) => key in plugin.bookAppearance(path),
	};
}

/**
 * Reader appearance controls, shared by the in-view popover and the settings tab.
 * Every change applies live to open EPUB views and is persisted.
 */
export function buildAppearanceControls(container: HTMLElement, target: AppearanceTarget, onChange?: () => void): void {
	const s = () => target.settings();
	const rows: [Setting, (keyof ReaderSettings)[]][] = [];
	const track = (row: Setting, ...keys: (keyof ReaderSettings)[]) => {
		rows.push([row, keys]);
		return row;
	};
	const mark = () => {
		for (const [row, keys] of rows) row.settingEl.toggleClass('epp-overridden', !!target.overridden && keys.some((k) => target.overridden!(k)));
	};
	const update = async (patch: Partial<ReaderSettings>) => {
		await target.update(patch);
		mark();
		onChange?.();
	};

	track(new Setting(container), 'theme').setName('Theme').addDropdown((d) =>
		d
			.addOptions({ auto: 'Match Obsidian', light: 'Light', sepia: 'Sepia', dark: 'Dark', publisher: "Publisher's colors" })
			.setValue(s().theme)
			.onChange((v) => update({ theme: v as ThemeName })),
	);

	let sizeSlider: SliderComponent;
	const setSize = (n: number) => {
		const v = Math.min(40, Math.max(8, n));
		sizeSlider.setValue(v);
		update({ fontSize: v });
	};
	track(new Setting(container), 'fontSize')
		.setName('Font size')
		.setDesc('Publisher sizes (headings, footnotes…) scale proportionally.')
		.addExtraButton((b) => b.setIcon('minus').setTooltip('Smaller').onClick(() => setSize(s().fontSize - 1)))
		.addSlider((sl) => (sizeSlider = sl).setLimits(8, 40, 1).setValue(s().fontSize).setDynamicTooltip().onChange((v) => update({ fontSize: v })))
		.addExtraButton((b) => b.setIcon('plus').setTooltip('Larger').onClick(() => setSize(s().fontSize + 1)));

	// Font: preset dropdown, plus a custom-family row shown only for "Custom…".
	const isCustom = () => !(s().fontFamily in FONT_PRESETS);
	let customRow: Setting;
	track(new Setting(container), 'fontFamily').setName('Font').addDropdown((d) =>
		d
			.addOptions({ ...FONT_PRESETS, __custom: 'Custom…' })
			.setValue(isCustom() ? '__custom' : s().fontFamily)
			.onChange((v) => {
				customRow.settingEl.toggle(v === '__custom');
				if (v !== '__custom') update({ fontFamily: v });
			}),
	);
	customRow = new Setting(container)
		.setName('Custom font family')
		.setDesc('Any CSS font-family list.')
		.addText((t) =>
			t
				.setPlaceholder('e.g. "Literata", serif')
				.setValue(isCustom() ? s().fontFamily : '')
				.onChange((v) => update({ fontFamily: v })),
		);
	customRow.settingEl.addClass('epp-subsetting');
	customRow.settingEl.toggle(isCustom());

	// Line spacing: the toggle stays put; the slider lives on its own row underneath.
	let lastLineHeight = s().lineHeight ?? 1.6;
	let lineRow: Setting;
	track(new Setting(container), 'lineHeight')
		.setName('Override line spacing')
		.setDesc("Off keeps the publisher's line spacing.")
		.addToggle((t) =>
			t.setValue(s().lineHeight !== null).onChange((on) => {
				lineRow.settingEl.toggle(on);
				update({ lineHeight: on ? lastLineHeight : null });
			}),
		);
	lineRow = new Setting(container).setName('Line spacing').addSlider((sl) =>
		sl
			.setLimits(1, 2.6, 0.05)
			.setValue(lastLineHeight)
			.setDynamicTooltip()
			.onChange((v) => {
				lastLineHeight = v;
				update({ lineHeight: v });
			}),
	);
	lineRow.settingEl.addClass('epp-subsetting');
	lineRow.settingEl.toggle(s().lineHeight !== null);

	track(new Setting(container), 'textAlign').setName('Text alignment').addDropdown((d) =>
		d
			.addOptions({ publisher: 'Publisher', left: 'Left', justify: 'Justified' })
			.setValue(s().textAlign)
			.onChange((v) => update({ textAlign: v as TextAlign })),
	);

	let widthText: TextComponent;
	track(new Setting(container), 'width', 'widthUnit')
		.setName('Reading width')
		.setDesc('0 = fill the pane. "ch" ≈ characters per line.')
		.addText((t) => {
			widthText = t;
			t.inputEl.type = 'number';
			t.inputEl.addClass('epp-number');
			t.setValue(String(s().width)).onChange((v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n >= 0) update({ width: n });
			});
		})
		.addDropdown((d) =>
			d
				.addOptions({ em: 'em', ch: 'characters', px: 'px', '%': '%' })
				.setValue(s().widthUnit)
				.onChange((v) => {
					const unit = v as WidthUnit;
					const defaults: Record<WidthUnit, number> = { em: 42, ch: 70, px: 720, '%': 90 };
					widthText.setValue(String(defaults[unit]));
					update({ widthUnit: unit, width: defaults[unit] });
				}),
		);

	track(new Setting(container), 'margin').setName('Side margins').addSlider((sl) => sl.setLimits(0, 120, 4).setValue(s().margin).setDynamicTooltip().onChange((v) => update({ margin: v })));

	track(new Setting(container), 'dimImages')
		.setName('Dim images in dark themes')
		.addToggle((t) => t.setValue(s().dimImages).onChange((v) => update({ dimImages: v })));
	mark();
}

/** Floating appearance popover inside an EPUB view. */
export class AppearancePanel {
	private open = false;
	/** Edit this book's own appearance instead of all books'. */
	private bookScope: boolean | null = null;

	constructor(
		private plugin: EpubPlusPlus,
		private el: HTMLElement,
		private bookPath: () => string | undefined,
	) {
		el.addEventListener('mousedown', (e) => e.stopPropagation());
	}

	toggle(force?: boolean): void {
		this.open = force ?? !this.open;
		this.el.toggleClass('is-open', this.open);
		// On phones the panel is a bottom sheet; Obsidian's navbar would cover it.
		this.el.doc.body.toggleClass('epp-appearance-open', this.open && Platform.isMobile);
		if (this.open) {
			this.render();
			const outside = (e: MouseEvent) => {
				if (!this.el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.epp-toolbar-button, .menu, .tooltip')) {
					this.toggle(false);
				}
			};
			window.setTimeout(() => document.addEventListener('mousedown', outside), 0);
			this.cleanup = () => document.removeEventListener('mousedown', outside);
		} else {
			this.cleanup?.();
			this.cleanup = null;
			this.bookScope = null;
		}
	}

	private render(): void {
		const plugin = this.plugin;
		const path = this.bookPath();
		const hasOwn = () => !!path && Object.keys(plugin.bookAppearance(path)).length > 0;
		// Opens on "This book" when the book already has its own settings.
		this.bookScope ??= hasOwn();
		const bookScope = !!path && this.bookScope;

		this.el.empty();
		const header = this.el.createDiv('epp-appearance-header');
		header.createDiv({ text: 'Appearance', cls: 'epp-appearance-title' });
		const close = header.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Close' } });
		setIcon(close, 'x');
		close.addEventListener('click', () => this.toggle(false));

		const where = `on this device, ${ORIENTATION_LABELS[plugin.orientation].toLowerCase()}`;
		const scopeRow = this.el.createDiv('epp-appearance-scope');
		const scopes = scopeRow.createDiv('epp-segmented');
		const scopeButton = (label: string, book: boolean) => {
			const b = scopes.createDiv({ cls: 'epp-mode-button', text: label });
			b.toggleClass('is-active', book === bookScope);
			b.addEventListener('click', () => {
				this.bookScope = book;
				this.render();
			});
		};
		scopeButton('All books', false);
		if (path) scopeButton('This book', true);
		let reset: HTMLElement | null = null;
		if (bookScope) {
			reset = scopeRow.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Use the settings for all books' } });
			setIcon(reset, 'rotate-ccw');
			reset.toggle(hasOwn());
			reset.addEventListener('click', async () => {
				await plugin.resetBookAppearance(path!, plugin.appearanceKey());
				this.render();
			});
		}
		this.el.createDiv({
			cls: 'epp-appearance-note',
			text: bookScope ? `Only this book, ${where}. Marked settings differ from all books.` : `All books, ${where}.`,
		});

		const target = bookScope ? bookAppearance(plugin, path!) : globalAppearance(plugin);
		buildAppearanceControls(this.el.createDiv(), target, () => reset?.toggle(hasOwn()));
	}

	/** The device or orientation changed: show the settings that apply now. */
	refresh(): void {
		if (this.open) this.render();
	}

	private cleanup: (() => void) | null = null;
}
