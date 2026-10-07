import { PluginSettingTab, Setting, debounce, type App } from 'obsidian';
import { buildAppearanceControls, globalAppearance } from './appearance';
import type EpubPlusPlus from './main';
import { HIGHLIGHT_GESTURE_LABELS, HIGHLIGHT_MENU_LABELS, SELECTION_MENU_LABELS, altLinkLabel, formatMenuLabel, type AppearancePlatform, type HighlightGestureAction, needsComment, newFormatId, syncMenus, type AnnotationMode, type CopyAction, type LinkStyle, type LinkType, type OpenTarget } from './settings';

export class EppSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: EpubPlusPlus,
	) {
		super(app, plugin);
	}

	/** Which platform's appearance the Reading section edits (this device's by default). */
	private appearancePlatform: AppearancePlatform | null = null;

	private appearanceSection(containerEl: HTMLElement): void {
		const plugin = this.plugin;
		const platform = (this.appearancePlatform ??= plugin.platform);
		new Setting(containerEl)
			.setName('Appearance for')
			.setDesc('Desktop and mobile (phones and tablets) keep separate appearance settings.')
			.addDropdown((d) =>
				d
					.addOptions({ desktop: 'Desktop', mobile: 'Mobile' })
					.setValue(platform)
					.onChange((v) => {
						this.appearancePlatform = v as AppearancePlatform;
						this.display();
					}),
			);
		buildAppearanceControls(containerEl.createDiv(), globalAppearance(plugin, platform));

		const books = Object.entries(plugin.settings.bookAppearance).filter(([, b]) => b[platform] && Object.keys(b[platform]!).length);
		if (!books.length) return;
		new Setting(containerEl)
			.setName('Books with their own appearance')
			.setDesc(`Set from a book's Appearance panel ("This book"). Their own settings win over the ones above on ${platform}.`);
		for (const [path, b] of books) {
			const keys = Object.keys(b[platform]!).join(', ');
			new Setting(containerEl)
				.setClass('epp-subsetting')
				.setName(path.split('/').pop()!.replace(/\.epub$/i, ''))
				.setDesc(keys)
				.addExtraButton((x) =>
					x
						.setIcon('rotate-ccw')
						.setTooltip('Use the settings for all books')
						.onClick(async () => {
							await plugin.resetBookAppearance(path, platform);
							this.display();
						}),
				);
		}
	}

	/** Reorderable, toggleable list of menu items. */
	private menuEditor(container: HTMLElement, title: string, key: 'selectionMenu' | 'highlightMenu', label: (id: string) => string): void {
		const s = this.plugin.settings;
		const list = s[key];
		new Setting(container).setName(title).setDesc(key === 'selectionMenu' ? 'On mobile, "System menu" is always added last.' : '');
		const box = container.createDiv('epp-menu-editor');
		list.forEach((entry, i) => {
			const row = new Setting(box).setName(label(entry.id));
			row.settingEl.addClass('epp-menu-editor-row');
			row.settingEl.toggleClass('is-hidden-item', !entry.show);
			row.addExtraButton((b) =>
				b
					.setIcon('arrow-up')
					.setTooltip('Move up')
					.setDisabled(i === 0)
					.onClick(async () => {
						[list[i - 1], list[i]] = [list[i], list[i - 1]];
						await this.plugin.saveSettings();
						this.display();
					}),
			);
			row.addExtraButton((b) =>
				b
					.setIcon('arrow-down')
					.setTooltip('Move down')
					.setDisabled(i === list.length - 1)
					.onClick(async () => {
						[list[i + 1], list[i]] = [list[i], list[i + 1]];
						await this.plugin.saveSettings();
						this.display();
					}),
			);
			row.addToggle((t) =>
				t
					.setTooltip('Show in menu')
					.setValue(entry.show)
					.onChange(async (v) => {
						entry.show = v;
						row.settingEl.toggleClass('is-hidden-item', !v);
						await this.plugin.saveSettings();
					}),
			);
		});
	}

	override display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const syncCommands = debounce(() => this.plugin.syncFormatCommands(), 800, true);
		containerEl.empty();

		new Setting(containerEl).setName('Reading').setHeading();
		this.appearanceSection(containerEl);

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
			.setName('Reuse tabs and panes')
			.setDesc('With "Split pane": if the EPUB is already open in a tab of another pane, switch to it there; otherwise open it as a new tab in an existing other pane before creating a new split.')
			.addToggle((t) =>
				t.setValue(s.reusePanes).onChange(async (v) => {
					s.reusePanes = v;
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

		new Setting(containerEl).setName('Copying').setHeading();
		new Setting(containerEl)
			.setName('Copy text as Markdown')
			.setDesc("Convert the book's formatting (italics, bold, lists, headings, line breaks) to Markdown when copying or inserting a selection ({{text}}). Off: plain text.")
			.addToggle((t) =>
				t.setValue(s.copyMarkdown).onChange(async (v) => {
					s.copyMarkdown = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName('Ctrl/Cmd+C copies')
			.setDesc('What copying a selection in an EPUB puts on the clipboard (also used by the system Copy menu).')
			.addDropdown((d) => {
				d.addOption('text', 'Plain text');
				d.addOption('link', 'Link');
				d.addOption('alt-link', s.linkType === 'cfi' ? 'Text-fragment link' : 'CFI link');
				for (const f of s.copyFormats) d.addOption(`format:${f.id}`, f.name);
				d.setValue(this.plugin.resolveCopyAction(s.copyAction) ? s.copyAction : 'text').onChange(async (v) => {
					s.copyAction = v as CopyAction;
					await save();
				});
			});
		new Setting(containerEl)
			.setName('Other copy shortcuts')
			.setDesc('Each copy style is a command ("EPUB++: Copy selection as …"); assign keys to them under Hotkeys.')
			.addButton((b) =>
				b.setButtonText('Open hotkeys').onClick(() => {
					const setting = (this.app as any).setting;
					const tab = setting?.openTabById?.('hotkeys');
					tab?.searchComponent?.setValue?.('EPUB++: Copy');
					tab?.updateHotkeyVisibility?.();
				}),
			);

		new Setting(containerEl).setName('Copy formats').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Shown in the right-click menu. Variables: {{text}}, {{link}}, {{color}}, {{book}}, {{author}}, {{chapter}}, {{cfi}}, {{file}}, {{path}}, and {{comment}} (asks for a comment when copying). Multi-line values keep the "> " prefix of their line.',
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
							syncCommands();
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
							if (s.copyAction === `format:${fmt.id}`) s.copyAction = 'text';
							syncMenus(s);
							await save();
							this.plugin.syncFormatCommands();
							this.display();
						}),
				);
		});
		new Setting(containerEl).addButton((b) =>
			b.setButtonText('Add format').onClick(async () => {
				s.copyFormats.push({ id: newFormatId(), name: 'New format', template: '{{text}} {{link}}' });
				syncMenus(s);
				await save();
				this.plugin.syncFormatCommands();
				this.display();
			}),
		);

		new Setting(containerEl).setName('Context menus').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Choose which items appear in the right-click / tap menus, and their order.',
		});
		this.menuEditor(containerEl, 'Selection menu', 'selectionMenu', (id) => {
			if (id.startsWith('format:')) {
				const f = s.copyFormats.find((x) => `format:${x.id}` === id);
				return f ? formatMenuLabel(f.name) : id;
			}
			if (id === 'alt-link') return altLinkLabel(s.linkType);
			return SELECTION_MENU_LABELS[id] ?? id;
		});
		this.menuEditor(containerEl, 'Highlight menu', 'highlightMenu', (id) => HIGHLIGHT_MENU_LABELS[id] ?? id);

		new Setting(containerEl).setName('Highlights').setHeading();
		new Setting(containerEl)
			.setName('Links without a color')
			.setDesc('For links that have no "&color=…".')
			.addDropdown((d) =>
				d
					.addOptions({ default: 'Highlight with the default color', none: "Don't highlight" })
					.setValue(s.noColor)
					.onChange(async (v) => {
						s.noColor = v as 'default' | 'none';
						await save();
						for (const view of this.plugin.epubViews()) view.refreshHighlights();
					}),
			);
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

		new Setting(containerEl).setName('Annotation files').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'An annotation file is a note with a heading per chapter (from the table of contents), linked to the book by its "epub" property. Create one from the Highlights tab, the EPUB tab menu, or the command palette. While a book has one, copying from the selection menu can insert the annotation in the right chapter, in book order.',
		});
		new Setting(containerEl)
			.setName('When copying a selection')
			.setDesc('Default for books with an annotation file. Each file can override it (the Copy / Insert / Both row in the selection menu, saved in its "epub-annotation-mode" property).')
			.addDropdown((d) =>
				d
					.addOptions({ copy: 'Copy to clipboard', insert: 'Insert into the annotation file', both: 'Copy and insert' })
					.setValue(s.annotationMode)
					.onChange(async (v) => {
						s.annotationMode = v as AnnotationMode;
						await save();
					}),
			);
		new Setting(containerEl)
			.setName('Folder for new annotation files')
			.setDesc('Leave empty to create them next to the EPUB.')
			.addText((t) =>
				t
					.setPlaceholder('e.g. Reading/Annotations')
					.setValue(s.annotationFolder)
					.onChange(async (v) => {
						s.annotationFolder = v;
						await save();
					}),
			);
		new Setting(containerEl)
			.setName('File name')
			.setDesc('Variables: {{book}}, {{author}}, {{file}}.')
			.addText((t) =>
				t.setValue(s.annotationFileName).onChange(async (v) => {
					s.annotationFileName = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName('Place text-fragment links exactly')
			.setDesc('Locate text-fragment annotations in the book to order new ones among them. Turn off if inserting is slow; they are then added at the end of the chapter section.')
			.addToggle((t) =>
				t.setValue(s.annotationResolveTextFragments).onChange(async (v) => {
					s.annotationResolveTextFragments = v;
					await save();
				}),
			);

		new Setting(containerEl).setName('Annotations from other plugins').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Other plugins can mark passages in books (for example Bible references). Each gets its own sidebar tab, where its eye button shows or hides it in the book. Right-click one (or hold it on mobile) to save it as a highlight in the annotation file.',
		});
		new Setting(containerEl)
			.setName('Save as highlight inserts')
			.setDesc('What "Save as highlight" adds to the annotation file (created if needed). Templates can use {{label}}, the annotation\'s name. "Save with comment" uses the first format with {{comment}}.')
			.addDropdown((d) => {
				d.addOption('link', 'Link');
				for (const f of s.copyFormats) if (!needsComment(f.template)) d.addOption(`format:${f.id}`, f.name);
				const current = this.plugin.saveFormat();
				d.setValue(typeof current === 'string' ? current : `format:${current.id}`).onChange(async (v) => {
					s.saveAnnotationAs = v as CopyAction;
					await save();
				});
			});
		const providers = [...this.plugin.providers.values()];
		for (const p of providers)
			new Setting(containerEl).setName(`Show ${p.name}`).addToggle((t) =>
				t.setValue(!s.hiddenProviders.includes(p.id)).onChange((v) => this.plugin.setProviderHidden(p.id, !v)),
			);

		new Setting(containerEl).setName('Jumping to a passage').setHeading();
		const applyFlash = () => {
			for (const view of this.plugin.epubViews()) view.applyFlashSettings();
		};
		let flashRows: Setting[] = [];
		new Setting(containerEl)
			.setName('Highlight the passage after opening a link')
			.setDesc('Shown on top of existing highlights, then fades out.')
			.addToggle((t) =>
				t.setValue(s.jumpHighlight).onChange(async (v) => {
					s.jumpHighlight = v;
					for (const r of flashRows) r.settingEl.toggle(v);
					await save();
				}),
			);
		flashRows = [
			new Setting(containerEl).setName('Duration').setDesc('Seconds, including the fade-out.').addSlider((sl) =>
				sl
					.setLimits(0.5, 10, 0.5)
					.setValue(s.jumpHighlightDuration / 1000)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.jumpHighlightDuration = Math.round(v * 1000);
						await save();
						applyFlash();
					}),
			),
			new Setting(containerEl).setName('Color').addColorPicker((c) =>
				c.setValue(s.jumpHighlightColor).onChange(async (v) => {
					s.jumpHighlightColor = v;
					await save();
					applyFlash();
				}),
			),
		];
		for (const r of flashRows) {
			r.settingEl.addClass('epp-subsetting');
			r.settingEl.toggle(s.jumpHighlight);
		}

		new Setting(containerEl).setName('Previews').setHeading();
		new Setting(containerEl)
			.setName('Hover previews and embeds')
			.setDesc('Preview the linked passage when hovering an EPUB link (with Page preview), and render ![[book.epub#…]] embeds.')
			.addToggle((t) =>
				t.setValue(s.previews).onChange(async (v) => {
					s.previews = v;
					await save();
					this.plugin.updatePreviews();
				}),
			);
		new Setting(containerEl)
			.setName('Links inside previews')
			.setDesc('Clicking a link to another place in the book inside a hover preview or embed. Ctrl/Cmd-click always opens a new EPUB tab.')
			.addDropdown((d) =>
				d
					.addOptions({ preview: 'Jump there in the preview', tab: 'Open in the EPUB tab' })
					.setValue(s.previewLinks)
					.onChange(async (v) => {
						s.previewLinks = v as 'preview' | 'tab';
						await save();
					}),
			);
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'In the editor, EPUB links preview on plain hover. Change that under Settings → Page preview → "EPUB++: EPUB links in the editor".',
		});
		new Setting(containerEl)
			.setName('Preview height')
			.addSlider((sl) =>
				sl
					.setLimits(160, 800, 20)
					.setValue(s.previewHeight)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.previewHeight = v;
						await save();
					}),
			);

		new Setting(containerEl).setName('Mobile').setHeading();
		const gesture = (name: string, key: 'highlightTap' | 'highlightDoubleTap' | 'highlightHold') =>
			new Setting(containerEl).setName(name).addDropdown((d) =>
				d
					.addOptions(HIGHLIGHT_GESTURE_LABELS)
					.setValue(s[key])
					.onChange(async (v) => {
						s[key] = v as HighlightGestureAction;
						await save();
					}),
			);
		gesture('Tap a highlight', 'highlightTap');
		gesture('Double-tap a highlight', 'highlightDoubleTap');
		gesture('Hold a highlight', 'highlightHold');
		new Setting(containerEl)
			.setName('Selection menu')
			.setDesc("Open EPUB++'s copy menu when you select text (there is no right-click on mobile). Its \"System menu\" item brings back the phone's own menu.")
			.addToggle((t) =>
				t.setValue(s.selectionBar).onChange(async (v) => {
					s.selectionBar = v;
					await save();
				}),
			);
	}
}
