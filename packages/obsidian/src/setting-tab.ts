import { PluginSettingTab, Setting, type App } from 'obsidian';
import { buildAppearanceControls } from './appearance';
import type EpubPlusPlus from './main';
import type { LinkStyle, LinkType, OpenTarget } from './settings';

export class EppSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: EpubPlusPlus,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName('Reading').setHeading();
		buildAppearanceControls(containerEl.createDiv(), this.plugin);

		new Setting(containerEl).setName('Links').setHeading();
		new Setting(containerEl)
			.setName('Link type')
			.setDesc('EPUB CFI links are exact. Text fragment links are human-readable and survive edits to the EPUB file.')
			.addDropdown((d) =>
				d
					.addOptions({ cfi: 'EPUB CFI', text: 'Text fragment' })
					.setValue(s.linkType)
					.onChange(async (v) => {
						s.linkType = v as LinkType;
						await save();
					}),
			);
		new Setting(containerEl)
			.setName('Link format')
			.setDesc('"Vault default" follows Settings → Files & links → Use [[Wikilinks]].')
			.addDropdown((d) =>
				d
					.addOptions({ auto: 'Vault default', wiki: '[[Wikilink]]', markdown: '[Markdown](link)' })
					.setValue(s.linkStyle)
					.onChange(async (v) => {
						s.linkStyle = v as LinkStyle;
						await save();
					}),
			);
		new Setting(containerEl)
			.setName('Link display text')
			.setDesc('Variables: {{book}}, {{author}}, {{chapter}}, {{text}}, {{file}}.')
			.addText((t) =>
				t.setValue(s.aliasTemplate).onChange(async (v) => {
					s.aliasTemplate = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName('Include color in links')
			.setDesc('Adds "&color=<name>" so the highlight is drawn in that color.')
			.addToggle((t) =>
				t.setValue(s.colorInLinks).onChange(async (v) => {
					s.colorInLinks = v;
					await save();
				}),
			);
		const targets = { split: 'Split pane', tab: 'New tab', current: 'Current tab' };
		new Setting(containerEl)
			.setName('Open EPUB links in')
			.setDesc('Used when the EPUB is not open yet; an open EPUB is reused and scrolled.')
			.addDropdown((d) =>
				d
					.addOptions(targets)
					.setValue(s.openEpubIn)
					.onChange(async (v) => {
						s.openEpubIn = v as OpenTarget;
						await save();
					}),
			);
		new Setting(containerEl)
			.setName('Open notes from highlights in')
			.addDropdown((d) =>
				d
					.addOptions(targets)
					.setValue(s.openNoteIn)
					.onChange(async (v) => {
						s.openNoteIn = v as OpenTarget;
						await save();
					}),
			);

		new Setting(containerEl).setName('Copy formats').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Shown in the right-click menu. Variables: {{text}}, {{link}}, {{color}}, {{book}}, {{author}}, {{chapter}}, {{cfi}}, {{file}}, {{path}}. Multi-line text keeps the "> " prefix of its line.',
		});
		s.copyFormats.forEach((fmt, i) => {
			new Setting(containerEl)
				.addText((t) =>
					t
						.setPlaceholder('Name')
						.setValue(fmt.name)
						.onChange(async (v) => {
							fmt.name = v;
							await save();
						}),
				)
				.addTextArea((t) => {
					t.inputEl.rows = 3;
					t.inputEl.addClass('epp-template');
					t.setValue(fmt.template).onChange(async (v) => {
						fmt.template = v;
						await save();
					});
				})
				.addExtraButton((b) =>
					b
						.setIcon('trash')
						.setTooltip('Remove')
						.onClick(async () => {
							s.copyFormats.splice(i, 1);
							await save();
							this.display();
						}),
				);
		});
		new Setting(containerEl).addButton((b) =>
			b.setButtonText('Add format').onClick(async () => {
				s.copyFormats.push({ name: 'New format', template: '{{text}} {{link}}' });
				await save();
				this.display();
			}),
		);

		new Setting(containerEl).setName('Highlights').setHeading();
		new Setting(containerEl)
			.setName('Default color')
			.addDropdown((d) => {
				for (const p of s.palette) d.addOption(p.name, p.name);
				d.setValue(s.defaultColor).onChange(async (v) => {
					s.defaultColor = v;
					await save();
					this.plugin.refreshPalette();
				});
			});
		new Setting(containerEl)
			.setName('Highlight opacity')
			.addSlider((sl) =>
				sl
					.setLimits(0.1, 1, 0.05)
					.setValue(s.highlightOpacity)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.highlightOpacity = v;
						await save();
					}),
			)
			.setDesc('Applies to newly opened EPUBs.');
		s.palette.forEach((p, i) => {
			new Setting(containerEl)
				.addText((t) =>
					t
						.setPlaceholder('name')
						.setValue(p.name)
						.onChange(async (v) => {
							const was = p.name;
							p.name = v.trim().replace(/\s+/g, '-');
							if (s.defaultColor === was) s.defaultColor = p.name;
							await save();
							this.plugin.refreshPalette();
						}),
				)
				.addColorPicker((c) =>
					c.setValue(p.color).onChange(async (v) => {
						p.color = v;
						await save();
						this.plugin.refreshPalette();
					}),
				)
				.addExtraButton((b) =>
					b
						.setIcon('trash')
						.setTooltip('Remove')
						.onClick(async () => {
							s.palette.splice(i, 1);
							await save();
							this.plugin.refreshPalette();
							this.display();
						}),
				);
		});
		new Setting(containerEl).addButton((b) =>
			b.setButtonText('Add color').onClick(async () => {
				s.palette.push({ name: `color${s.palette.length + 1}`, color: '#888888' });
				await save();
				this.plugin.refreshPalette();
				this.display();
			}),
		);

		new Setting(containerEl).setName('Mobile').setHeading();
		new Setting(containerEl)
			.setName('Selection toolbar')
			.setDesc('Show copy buttons while text is selected (there is no right-click on mobile).')
			.addToggle((t) =>
				t.setValue(s.selectionBar).onChange(async (v) => {
					s.selectionBar = v;
					await save();
				}),
			);
	}
}
