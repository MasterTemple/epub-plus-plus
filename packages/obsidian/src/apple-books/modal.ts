import { FuzzySuggestModal, Modal, Setting, TFile, type App } from 'obsidian';
import { ImportModal, type FilePlusPlusPlugin, type FppSettings } from 'file-plus-plus/obsidian';
import { PREFIX } from 'file-plus-plus/core';
import { groupByAsset, readAppleBooks, toImportJson, type AppleAsset, type AppleHighlight } from './apple-books';

/** What EPUB++ remembers about Apple Books imports. */
export interface AppleBooksSettings {
	/** Apple asset id → EPUB path in the vault ('' = skip that book). */
	appleBooksBooks?: Record<string, string>;
	/** The database imported last (a vault path). */
	appleBooksDatabase?: string;
}

type Plugin = FilePlusPlusPlugin & { settings: FppSettings & AppleBooksSettings };

/** The Apple Books annotation databases in the vault, newest first. */
export function appleDatabases(app: App): TFile[] {
	return app.vault
		.getFiles()
		.filter((f) => f.extension.toLowerCase() === 'sqlite')
		.sort((a, b) => b.stat.mtime - a.stat.mtime || b.path.localeCompare(a.path));
}

/** Read a vault database with its write-ahead log (`<path>-wal`, where its newest changes are). */
async function readVaultDatabase(app: App, file: TFile): Promise<AppleHighlight[]> {
	const db = new Uint8Array(await app.vault.readBinary(file));
	const walPath = `${file.path}-wal`;
	const wal = (await app.vault.adapter.exists(walPath)) ? new Uint8Array(await app.vault.adapter.readBinary(walPath)) : null;
	return readAppleBooks(db, wal);
}

/**
 * Import from Apple Books: pick the annotation database, match its books (Apple only knows them by an
 * id) to EPUBs in the vault once, then continue in the JSON import dialog.
 */
export class AppleBooksModal extends Modal {
	private highlights: AppleHighlight[] = [];
	private assets: AppleAsset[] = [];
	private bodyEl!: HTMLElement;

	constructor(
		app: App,
		private plugin: Plugin,
		private initial: TFile | null = null,
	) {
		super(app);
	}

	private get books(): Record<string, string> {
		return (this.plugin.settings.appleBooksBooks ??= {});
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('epp-apple-modal');
		this.titleEl.setText('Import highlights from Apple Books');
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Apple Books keeps highlights in an annotation database (AEAnnotation….sqlite, from ~/Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation on a Mac). Copy it into the vault together with its "-wal" file, which holds the newest highlights.',
		});
		const dbs = appleDatabases(this.app);
		const last = this.initial ?? dbs.find((f) => f.path === this.plugin.settings.appleBooksDatabase) ?? dbs[0] ?? null;
		new Setting(contentEl)
			.setName('Database')
			.setDesc(dbs.length ? 'An .sqlite file in the vault.' : 'No .sqlite files in the vault yet.')
			.addDropdown((d) => {
				for (const f of dbs) d.addOption(f.path, f.path);
				if (last) d.setValue(last.path);
				d.onChange((p) => {
					const f = this.app.vault.getFileByPath(p);
					if (f) void this.load(f);
				});
			});
		const picker = contentEl.createEl('input', { attr: { type: 'file', multiple: '', accept: '.sqlite,.sqlite-wal,.db' } });
		picker.style.display = 'none';
		picker.addEventListener('change', () => void this.loadPicked(picker.files));
		new Setting(contentEl)
			.setName('From your computer')
			.setDesc('Select the .sqlite file and its -wal file together.')
			.addButton((b) => b.setButtonText('Choose files…').onClick(() => picker.click()));
		this.bodyEl = contentEl.createDiv();
		if (last) void this.load(last);
	}

	private async load(file: TFile): Promise<void> {
		this.plugin.settings.appleBooksDatabase = file.path;
		void this.plugin.saveSettings();
		await this.read(file.path, () => readVaultDatabase(this.app, file));
	}

	private async loadPicked(files: FileList | null): Promise<void> {
		const list = [...(files ?? [])];
		const main = list.find((f) => !/-(wal|shm)$/.test(f.name));
		if (!main) return;
		const wal = list.find((f) => f.name === `${main.name}-wal`);
		await this.read(main.name, async () => readAppleBooks(new Uint8Array(await main.arrayBuffer()), wal ? new Uint8Array(await wal.arrayBuffer()) : null));
	}

	private async read(name: string, get: () => Promise<AppleHighlight[]>): Promise<void> {
		this.bodyEl.empty();
		this.bodyEl.createDiv({ cls: `${PREFIX}-import-info`, text: `Reading ${name}…` });
		try {
			this.highlights = await get();
			this.assets = groupByAsset(this.highlights);
		} catch (e) {
			this.highlights = [];
			this.assets = [];
			this.bodyEl.empty();
			this.bodyEl.createDiv({ cls: `${PREFIX}-import-errors`, text: `Could not read ${name}: ${(e as Error).message}` });
			return;
		}
		this.renderBooks();
	}

	private renderBooks(): void {
		const el = this.bodyEl;
		el.empty();
		const notes = this.highlights.filter((h) => h.note).length;
		el.createDiv({
			cls: `${PREFIX}-import-info`,
			text: `${this.highlights.length} highlights (${notes} with a note) in ${this.assets.length} books. Match each book to an EPUB in your vault; the choices are remembered for next time.`,
		});
		for (const a of this.assets) {
			const path = this.books[a.id];
			const file = path ? this.app.vault.getFileByPath(path) : null;
			const s = new Setting(el).setClass('epp-apple-book');
			s.nameEl.setText(file ? file.basename : path === '' ? 'Skipped' : path ? `Missing: ${path}` : 'Not matched yet');
			s.nameEl.toggleClass(`${PREFIX}-import-missing`, !!path && !file);
			const desc = s.descEl;
			desc.createDiv({ text: `${a.highlights.length} highlight${a.highlights.length === 1 ? '' : 's'}${a.chapters.length ? ` · ${a.chapters.slice(0, 3).join(' · ')}` : ''}` });
			for (const sample of a.samples.slice(0, 2)) desc.createDiv({ cls: 'epp-apple-sample', text: `“${sample}”` });
			s.addButton((b) => b.setButtonText(file ? 'Change…' : 'Choose…').onClick(() => this.choose(a)));
			if (path !== '')
				s.addExtraButton((b) =>
					b
						.setIcon('circle-slash')
						.setTooltip('Skip this book')
						.onClick(() => this.setBook(a.id, '')),
				);
		}
		const mapped = this.assets.filter((a) => this.books[a.id] && this.app.vault.getFileByPath(this.books[a.id]));
		const count = mapped.reduce((n, a) => n + a.highlights.length, 0);
		new Setting(el)
			.setDesc(mapped.length ? `${count} highlights from ${mapped.length} book${mapped.length === 1 ? '' : 's'}.` : 'Match at least one book.')
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('Continue…')
					.setCta()
					.setDisabled(!mapped.length)
					.onClick(() => {
						const json = toImportJson(this.highlights, this.books);
						this.close();
						new ImportModal(this.app, this.plugin, json).open();
					}),
			);
	}

	private choose(asset: AppleAsset): void {
		const epubs = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'epub');
		const modal = new (class extends FuzzySuggestModal<TFile> {
			getItems = () => epubs;
			getItemText = (f: TFile) => f.path;
			onChooseItem = (f: TFile) => owner.setBook(asset.id, f.path);
		})(this.app);
		const owner = this;
		modal.setPlaceholder(`EPUB for “${asset.samples[0]?.slice(0, 60) ?? asset.id}…”`);
		modal.open();
	}

	private setBook(id: string, path: string): void {
		this.books[id] = path;
		void this.plugin.saveSettings();
		this.renderBooks();
	}
}
