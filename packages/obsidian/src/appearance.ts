import type { ReaderSettings, ThemeName, TextAlign, WidthUnit } from '@epub-pp/core';
import { Setting, setIcon, type SliderComponent, type TextComponent } from 'obsidian';
import type EpubPlusPlus from './main';

const FONT_PRESETS: Record<string, string> = {
	'': 'Publisher',
	'var(--font-text)': 'Obsidian text font',
	'Georgia, "Times New Roman", serif': 'Serif',
	'system-ui, -apple-system, "Segoe UI", sans-serif': 'Sans-serif',
	'"Atkinson Hyperlegible", Verdana, sans-serif': 'Hyperlegible',
	'ui-monospace, Menlo, Consolas, monospace': 'Monospace',
};

/**
 * Reader appearance controls, shared by the in-view popover and the settings tab.
 * Every change applies live to all open EPUB views and is persisted.
 */
export function buildAppearanceControls(container: HTMLElement, plugin: EpubPlusPlus, onChange?: () => void): void {
	const s = () => plugin.settings.reader;
	const update = async (patch: Partial<ReaderSettings>) => {
		await plugin.updateReaderSettings(patch);
		onChange?.();
	};

	new Setting(container).setName('Theme').addDropdown((d) =>
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
	new Setting(container)
		.setName('Font size')
		.setDesc('Publisher sizes (headings, footnotes…) scale proportionally.')
		.addExtraButton((b) => b.setIcon('minus').setTooltip('Smaller').onClick(() => setSize(s().fontSize - 1)))
		.addSlider((sl) => (sizeSlider = sl).setLimits(8, 40, 1).setValue(s().fontSize).setDynamicTooltip().onChange((v) => update({ fontSize: v })))
		.addExtraButton((b) => b.setIcon('plus').setTooltip('Larger').onClick(() => setSize(s().fontSize + 1)));

	// Font: preset dropdown, plus a custom-family row shown only for "Custom…".
	const isCustom = () => !(s().fontFamily in FONT_PRESETS);
	let customRow: Setting;
	new Setting(container).setName('Font').addDropdown((d) =>
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
	new Setting(container)
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

	new Setting(container).setName('Text alignment').addDropdown((d) =>
		d
			.addOptions({ publisher: 'Publisher', left: 'Left', justify: 'Justified' })
			.setValue(s().textAlign)
			.onChange((v) => update({ textAlign: v as TextAlign })),
	);

	let widthText: TextComponent;
	new Setting(container)
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

	new Setting(container).setName('Side margins').addSlider((sl) => sl.setLimits(0, 120, 4).setValue(s().margin).setDynamicTooltip().onChange((v) => update({ margin: v })));

	new Setting(container).setName('Dim images in dark themes').addToggle((t) => t.setValue(s().dimImages).onChange((v) => update({ dimImages: v })));
}

/** Floating appearance popover inside an EPUB view. */
export class AppearancePanel {
	private open = false;

	constructor(
		private plugin: EpubPlusPlus,
		private el: HTMLElement,
	) {
		el.addEventListener('mousedown', (e) => e.stopPropagation());
	}

	toggle(force?: boolean): void {
		this.open = force ?? !this.open;
		this.el.toggleClass('is-open', this.open);
		if (this.open) {
			this.el.empty();
			const header = this.el.createDiv('epp-appearance-header');
			header.createDiv({ text: 'Appearance', cls: 'epp-appearance-title' });
			const close = header.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Close' } });
			setIcon(close, 'x');
			close.addEventListener('click', () => this.toggle(false));
			buildAppearanceControls(this.el.createDiv(), this.plugin);
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
		}
	}

	private cleanup: (() => void) | null = null;
}
