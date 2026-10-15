import { BookText, EpubBook, type CfiOptions, type EpubReader } from '@epub-pp/core';
import { FilePlusPlusPlugin, type FppSettings } from 'file-plus-plus/obsidian';
import { TFile, type WorkspaceLeaf } from 'obsidian';
import { AppleBooksModal, type AppleBooksSettings } from './apple-books/modal';
import type { EpubPlusPlusApi } from './api';
import { epubFormat } from './format';
import { BookSearch, type BookSearchSettings } from './search/manager';
import { BOOK_SEARCH_VIEW, BookSearchView } from './search/view';

/** EPUB++: EPUBs read in Obsidian, with highlights backed by links in notes (see file-plus-plus). */
export default class EpubPlusPlus extends FilePlusPlusPlugin<EpubBook, EpubReader> {
	readonly format = epubFormat;
	declare api: EpubPlusPlusApi;
	declare settings: FppSettings & AppleBooksSettings & BookSearchSettings;
	/** Searching every book's text with fff-epub (the book search tab) */
	bookSearch!: BookSearch;

	protected override async onLoaded(): Promise<void> {
		this.bookSearch = new BookSearch(this);
		this.register(() => this.bookSearch.dispose());
		this.registerView(BOOK_SEARCH_VIEW, (leaf) => new BookSearchView(leaf, this));
		this.addRibbonIcon('library', 'Search books', () => void this.openBookSearch());
		this.addCommand({ id: 'search-books', name: 'Search books', callback: () => void this.openBookSearch() });
		this.addCommand({
			id: 'search-this-book',
			name: 'Search this book',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension.toLowerCase() !== 'epub') return false;
				if (!checking) void this.openBookSearch({ book: file.path });
				return true;
			},
		});
		this.addCommand({ id: 'import-apple-books', name: 'Import highlights from Apple Books…', callback: () => new AppleBooksModal(this.app, this).open() });
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && file.extension.toLowerCase() === 'epub')
					menu.addItem((i) =>
						i
							.setTitle('Search in this book')
							.setIcon('search')
							.onClick(() => void this.openBookSearch({ book: file.path })),
					);
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'sqlite') return;
				menu.addItem((i) =>
					i
						.setTitle('Import Apple Books highlights into EPUB++…')
						.setIcon('import')
						.onClick(() => new AppleBooksModal(this.app, this, file).open()),
				);
			}),
		);
		// Books matched to Apple Books ids follow renames.
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				const books = this.settings.appleBooksBooks;
				if (!books) return;
				let changed = false;
				for (const [id, path] of Object.entries(books))
					if (path === oldPath) {
						books[id] = file.path;
						changed = true;
					}
				if (changed) void this.saveSettings();
			}),
		);
	}

	/** Opens the book search tab (the one already open, else a new one), searching a book or a query */
	async openBookSearch(options: { book?: string | null; query?: string } = {}): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | undefined = workspace.getLeavesOfType(BOOK_SEARCH_VIEW)[0];
		if (!leaf) {
			// A new tab, or the current leaf where there's no tab group to add to (nothing open, phones)
			try {
				leaf = workspace.getLeaf('tab');
			} catch {
				leaf = workspace.getLeaf(false);
			}
			await leaf.setViewState({ type: BOOK_SEARCH_VIEW, active: true });
		}
		await workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof BookSearchView) view.focusOn(options);
	}

	protected override createApi(): EpubPlusPlusApi {
		return {
			...this.baseApi(),
			extractText: async (file, opts) => {
				const book = await EpubBook.open(await this.app.vault.readBinary(file));
				try {
					const text = await BookText.extract(book, opts);
					const titles = new Map<string, string>();
					for (const t of book.flatToc) {
						const path = t.href?.split('#')[0];
						if (path && t.label && !titles.has(path)) titles.set(path, t.label);
					}
					const sections = text.sections.map((s) => ({ ...s, index: s.spineIndex, title: titles.get(s.href) ?? null }));
					const cfi = (spine: number, start: number, end: number, o?: CfiOptions) => text.cfi(spine, start, end, o);
					// `locator` is file-plus-plus's generic name for `cfi`
					return { sections, cfi, locator: (spine, start, end) => cfi(spine, start, end) };
				} finally {
					book.destroy();
				}
			},
		};
	}

	protected override migrateSettings(data: Record<string, any>): void {
		// Renamed in file-plus-plus.
		if (data.openEpubIn && !data.openIn) this.settings.openIn = data.openEpubIn;
		delete (this.settings as { openEpubIn?: unknown }).openEpubIn;
	}
}
