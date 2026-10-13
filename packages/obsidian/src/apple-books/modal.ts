import { ButtonComponent, FuzzySuggestModal, Modal, Notice, Setting, setIcon, TFile, type App } from 'obsidian';
import { EpubBook } from '@epub-pp/core';
import { ImportModal, type FilePlusPlusPlugin, type FppSettings } from 'file-plus-plus/obsidian';
import { PREFIX } from 'file-plus-plus/core';
import { assetProbes, groupByAsset, htmlText, looseText, matchScore, readAppleBooks, toImportJson, type AppleAsset, type AppleHighlight } from './apple-books';

/** What EPUB++ remembers about Apple Books imports. */
export interface AppleBooksSettings {
	/** Apple asset id → EPUB path in the vault ('' = skip that book). */
	appleBooksBooks?: Record<string, string>;
	/** The database imported last (a vault path). */
	appleBooksDatabase?: string;
}

type Plugin = FilePlusPlusPlugin & { settings: FppSettings & AppleBooksSettings };

/** A book's state: matched to an EPUB, skipped, not matched yet, or matched to an EPUB no longer in the vault. */
type Status = 'matched' | 'skipped' | 'unmatched' | 'missing';
/** The list's tabs. */
type Filter = 'todo' | 'matched' | 'skipped' | 'all';
const FILTER_OF: Record<Status, Exclude<Filter, 'all'>> = { matched: 'matched', skipped: 'skipped', unmatched: 'todo', missing: 'todo' };
const BADGES: Record<Status, string> = { matched: 'Matched', skipped: 'Skipped', unmatched: 'Not matched', missing: 'EPUB missing' };
const REASONS: Record<Status, string> = { matched: '', skipped: 'Skipped', unmatched: 'Not matched to an EPUB', missing: 'Its EPUB is no longer in the vault' };

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

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
	private listEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private filter: Filter = 'todo';
	private query = '';
	private searching = false;
	private stopSearch = false;

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

	override onClose(): void {
		this.stopSearch = true;
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

	private status(a: AppleAsset): Status {
		const path = this.books[a.id];
		if (path === '') return 'skipped';
		if (path === undefined) return 'unmatched';
		return this.app.vault.getFileByPath(path) ? 'matched' : 'missing';
	}

	/** What a book is called in the list: its EPUB, else what Apple Books knows of it (chapters). */
	private label(a: AppleAsset): string {
		const path = this.books[a.id];
		if (path) return path.split('/').pop()!.replace(/\.epub$/i, '');
		return a.chapters.length ? a.chapters.slice(0, 2).join(' · ') : `Book ${a.id.slice(0, 8)}`;
	}

	private renderBooks(): void {
		const el = this.bodyEl;
		el.empty();
		const notes = this.highlights.filter((h) => h.note).length;
		const counts: Record<Filter, number> = { all: this.assets.length, todo: 0, matched: 0, skipped: 0 };
		for (const a of this.assets) counts[FILTER_OF[this.status(a)]]++;
		if (this.filter !== 'all' && !counts[this.filter]) this.filter = 'all';

		const bar = el.createDiv('epp-apple-toolbar');
		bar.createDiv({
			cls: `${PREFIX}-import-info`,
			text: `${this.highlights.length} highlights (${notes} with a note) in ${this.assets.length} books. Match each book to an EPUB in your vault; the choices are remembered.`,
		});
		const row = bar.createDiv('epp-apple-toolbar-row');
		const search = row.createEl('input', { cls: 'epp-apple-search', attr: { type: 'search', placeholder: 'Filter books…', spellcheck: 'false' } });
		search.value = this.query;
		search.addEventListener('input', () => {
			this.query = search.value;
			this.renderList();
		});
		if (counts.todo) {
			const find = row.createEl('button', { cls: 'epp-apple-find' });
			setIcon(find.createSpan(), this.searching ? 'loader' : 'sparkles');
			find.createSpan({ text: this.searching ? 'Stop' : 'Find matches' });
			find.setAttr('aria-label', 'Look up the unmatched books\' highlights in the EPUBs of your vault');
			find.addEventListener('click', () => (this.searching ? (this.stopSearch = true) : void this.findMatches()));
		}
		const chips = bar.createDiv('epp-apple-chips');
		const names: [Filter, string][] = [
			['todo', 'To match'],
			['matched', 'Matched'],
			['skipped', 'Skipped'],
			['all', 'All'],
		];
		for (const [f, name] of names) {
			if (f !== 'all' && !counts[f]) continue;
			const chip = chips.createEl('button', { cls: `epp-apple-chip is-${f}` });
			chip.toggleClass('is-active', this.filter === f);
			chip.createSpan({ text: name });
			chip.createSpan({ cls: 'epp-apple-chip-count', text: String(counts[f]) });
			chip.addEventListener('click', () => {
				this.filter = f;
				this.renderBooks();
			});
		}
		if (counts.todo && this.filter === 'todo')
			chips.createEl('button', { cls: 'epp-apple-skip-rest mod-muted', text: 'Skip all unmatched' }).addEventListener('click', () => {
				for (const a of this.assets) if (FILTER_OF[this.status(a)] === 'todo') this.books[a.id] = '';
				void this.plugin.saveSettings();
				this.renderBooks();
			});
		this.progressEl = bar.createDiv({ cls: `${PREFIX}-import-info epp-apple-progress` });
		this.progressEl.hidden = !this.searching;

		this.listEl = el.createDiv('epp-apple-list');
		this.renderList();

		const mapped = this.assets.filter((a) => this.status(a) === 'matched');
		const count = mapped.reduce((n, a) => n + a.highlights.length, 0);
		const footer = el.createDiv('epp-apple-footer');
		footer.createDiv({
			cls: 'epp-apple-footer-info',
			text: mapped.length ? `${count} highlights from ${mapped.length} book${mapped.length === 1 ? '' : 's'}${counts.todo ? ` · ${counts.todo} not matched yet` : ''}` : 'Match at least one book.',
		});
		new ButtonComponent(footer).setButtonText('Cancel').onClick(() => this.close());
		new ButtonComponent(footer)
			.setButtonText('Continue…')
			.setCta()
			.setDisabled(!mapped.length)
			.onClick(() => {
				const json = toImportJson(this.highlights, this.books);
				const notImported = this.assets
					.filter((a) => this.status(a) !== 'matched')
					.map((a) => ({ name: this.label(a), count: a.highlights.length, reason: REASONS[this.status(a)], skipped: this.status(a) === 'skipped' }));
				this.close();
				new ImportModal(this.app, this.plugin, json, { notImported }).open();
			});
	}

	private renderList(): void {
		const el = this.listEl;
		el.empty();
		const q = this.query.trim().toLowerCase();
		const shown = this.assets.filter((a) => {
			if (this.filter !== 'all' && FILTER_OF[this.status(a)] !== this.filter) return false;
			return !q || [this.label(a), this.books[a.id] ?? '', ...a.chapters, ...a.samples].some((t) => t.toLowerCase().includes(q));
		});
		if (!shown.length) el.createDiv({ cls: 'epp-apple-empty', text: q ? 'No books match the filter.' : 'Nothing here.' });
		for (const a of shown) this.renderCard(el, a);
	}

	private renderCard(parent: HTMLElement, a: AppleAsset): void {
		const status = this.status(a);
		const card = parent.createDiv({ cls: `epp-apple-card is-${status}` });
		const main = card.createDiv('epp-apple-card-main');
		const head = main.createDiv('epp-apple-card-head');
		head.createSpan({ cls: 'epp-apple-badge', text: BADGES[status] });
		head.createSpan({ cls: 'epp-apple-count', text: `${a.highlights.length} highlight${a.highlights.length === 1 ? '' : 's'}` });
		const title = main.createDiv({ cls: 'epp-apple-card-title', text: this.label(a) });
		if (status === 'missing') title.setAttr('aria-label', `Not in the vault any more: ${this.books[a.id]}`);
		const path = this.books[a.id];
		if (path && a.chapters.length) main.createDiv({ cls: 'epp-apple-chapters', text: a.chapters.slice(0, 3).join(' · ') });
		if (a.samples[0]) main.createDiv({ cls: 'epp-apple-sample', text: `“${a.samples[0]}”` });

		const actions = card.createDiv('epp-apple-card-actions');
		const icon = (name: string, tip: string, run: () => void) => {
			const b = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tip } });
			setIcon(b, name);
			b.addEventListener('click', run);
		};
		if (status === 'skipped') {
			const b = actions.createEl('button', { cls: 'epp-apple-include' });
			setIcon(b.createSpan(), 'undo-2');
			b.createSpan({ text: 'Include' });
			b.addEventListener('click', () => this.setBook(a.id, undefined));
			return;
		}
		if (status === 'matched') icon('pencil', 'Choose another EPUB', () => this.choose(a));
		else {
			const b = actions.createEl('button', { cls: 'mod-cta epp-apple-choose' });
			setIcon(b.createSpan(), 'book-plus');
			b.createSpan({ text: 'Choose EPUB' });
			b.addEventListener('click', () => this.choose(a));
		}
		icon('circle-slash', 'Skip this book', () => this.setBook(a.id, ''));
	}

	/** Look the unmatched books' highlights up in the vault's EPUBs (those not matched yet), one EPUB at a time. */
	private async findMatches(): Promise<void> {
		const todo = this.assets.filter((a) => FILTER_OF[this.status(a)] === 'todo');
		const probes = new Map(todo.map((a) => [a, assetProbes(a)] as const));
		const taken = new Set(Object.values(this.books));
		const epubs = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'epub' && !taken.has(f.path));
		const best = new Map<AppleAsset, { file: TFile; score: number }>();
		let open = todo.filter((a) => probes.get(a)!.length);
		this.searching = true;
		this.stopSearch = false;
		this.renderBooks();
		for (const [i, file] of epubs.entries()) {
			if (this.stopSearch || !open.length) break;
			this.progressEl.setText(`Searching ${i + 1} of ${epubs.length} EPUBs: ${file.basename} · ${best.size} found`);
			let book: EpubBook | null = null;
			try {
				book = await EpubBook.open(await this.app.vault.readBinary(file));
				const parts: string[] = [];
				for (const item of book.spine) {
					try {
						parts.push(htmlText(book.text(item.href)));
					} catch {
						// an unreadable chapter: search the rest
					}
				}
				const text = looseText(parts.join(' '));
				for (const a of open) {
					const score = matchScore(probes.get(a)!, text);
					if (score >= 0.5 && score > (best.get(a)?.score ?? 0)) best.set(a, { file, score });
				}
				open = open.filter((a) => (best.get(a)?.score ?? 0) < 1);
			} catch (e) {
				console.warn('[epp] could not search', file.path, e);
			} finally {
				book?.destroy();
			}
			await sleep(0);
		}
		for (const [a, { file }] of best) this.books[a.id] = file.path;
		if (best.size) void this.plugin.saveSettings();
		this.searching = false;
		const left = todo.length - best.size;
		new Notice(`Matched ${best.size} of ${todo.length} book${todo.length === 1 ? '' : 's'}${left ? `; ${left} left to choose by hand` : ''}.`);
		if (!left) this.filter = 'matched';
		this.renderBooks();
	}

	private choose(asset: AppleAsset): void {
		// EPUBs not matched to another book first
		const taken = new Set(Object.entries(this.books).filter(([id]) => id !== asset.id).map(([, p]) => p));
		const epubs = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'epub').sort((a, b) => +taken.has(a.path) - +taken.has(b.path));
		const modal = new (class extends FuzzySuggestModal<TFile> {
			getItems = () => epubs;
			getItemText = (f: TFile) => f.path;
			onChooseItem = (f: TFile) => owner.setBook(asset.id, f.path);
		})(this.app);
		const owner = this;
		modal.setPlaceholder(`EPUB for “${asset.samples[0]?.slice(0, 60) ?? asset.id}…”`);
		modal.open();
	}

	private setBook(id: string, path: string | undefined): void {
		if (path === undefined) delete this.books[id];
		else this.books[id] = path;
		void this.plugin.saveSettings();
		this.renderBooks();
	}
}
