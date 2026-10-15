/**
 * Book search: fff-epub's search of every EPUB in the vault (or a folder, a book, or chosen books)
 * in a tab. Plain text, regular expressions, or typo-resistant fuzzy matching; results grouped by
 * book, each opening at its CFI, with links, quotes, and CFIs to copy. Laid out like Logoxide's
 * verse search.
 */
import {
	AbstractInputSuggest,
	ItemView,
	Menu,
	Notice,
	Platform,
	TFile,
	TFolder,
	debounce,
	prepareFuzzySearch,
	setIcon,
	type App,
	type ViewStateResult,
	type WorkspaceLeaf,
} from 'obsidian';
import type { FilePlusPlusPlugin } from 'file-plus-plus/obsidian';
import type { BookSearch, BookSearchSettings, EngineChoice } from './manager';
import { DEFAULT_GREP, bookLabel, snippet, type BookInfo, type Casing, type GrepMode, type GrepOptions, type GrepPage, type Hit, type Scope } from './types';

export const BOOK_SEARCH_VIEW = 'epp-book-search';

/** How many matches a page asks for (more load as the list scrolls to its end) */
const PAGE = 100;
/** Narrower than this, labels fold into icons and display options go behind a button */
const NARROW = 620;
/** Characters of the paragraph shown on each side of a match, when snippets are short */
const AROUND = 110;

type ScopeKind = 'all' | 'folders' | 'book' | 'books';
type GroupBy = 'book' | 'none';
type BookOrder = 'library' | 'matches' | 'title';

/** What a search tab saves with the workspace */
export interface PaneState {
	query: string;
	options: GrepOptions;
	scope: ScopeKind;
	folders: string[];
	books: string[];
	booksQuery: string;
	/** The book of `scope: 'book'` (the EPUB last in front) */
	book: string | null;
	look: {
		group: GroupBy;
		order: BookOrder;
		/** Whole paragraphs, or the words around each match */
		full: boolean;
		chapters: boolean;
		cfis: boolean;
	};
}

const DEFAULT_STATE: PaneState = {
	query: '',
	options: { ...DEFAULT_GREP },
	scope: 'all',
	folders: [],
	books: [],
	booksQuery: '',
	book: null,
	look: { group: 'book', order: 'library', full: false, chapters: true, cfis: false },
};

type Plugin = FilePlusPlusPlugin & { bookSearch: BookSearch; settings: BookSearchSettings };

const MODES: { value: GrepMode; label: string; icon: string; title: string }[] = [
	{ value: 'plaintext', label: 'Text', icon: 'type', title: 'The words as written' },
	{ value: 'regex', label: 'Regex', icon: 'regex', title: 'A regular expression' },
	{ value: 'fuzzy', label: 'Fuzzy', icon: 'sparkles', title: 'Typo resistant, like fff: "justfication" finds "justification"' },
];

const SCOPES: { value: ScopeKind; label: string; icon: string; title: string }[] = [
	{ value: 'all', label: 'All books', icon: 'library', title: 'Every EPUB in the vault' },
	{ value: 'folders', label: 'Folders', icon: 'folder-tree', title: 'The EPUBs in some folders' },
	{ value: 'book', label: 'This book', icon: 'book-open', title: 'The book open in front' },
	{ value: 'books', label: 'Books', icon: 'list-checks', title: 'Books you choose' },
];

const CASINGS: { value: Casing; label: string; title: string }[] = [
	{ value: 'smart', label: 'Aa', title: 'Smart case: insensitive unless the query has a capital (click: match case)' },
	{ value: 'sensitive', label: 'Aa', title: 'Matching case (click: ignore case)' },
	{ value: 'insensitive', label: 'aa', title: 'Ignoring case (click: smart case)' },
];

export class BookSearchView extends ItemView {
	private state: PaneState = structuredClone(DEFAULT_STATE);
	private hits: Hit[] = [];
	private page: GrepPage | null = null;
	/** Searching: books searched so far and how many there are (when the engine says) */
	private progress: { searched: number; total: number } | null = null;
	private searching = false;
	private error: string | null = null;
	private generation = 0;
	private collapsed = new Set<string>();
	private collapseAll = false;
	private books: BookInfo[] = [];
	private narrow = false;
	private displayOpen = false;
	private renderQueued = false;
	private unsubscribe: (() => void)[] = [];

	private queryEl!: HTMLInputElement;
	private controlsEl!: HTMLElement;
	private scopeEl!: HTMLElement;
	private displayEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private resultsEl!: HTMLElement;
	private moreObserver: IntersectionObserver | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: Plugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return BOOK_SEARCH_VIEW;
	}

	getDisplayText(): string {
		return this.state.query ? `Book search: ${this.state.query}` : 'Book search';
	}

	override getIcon(): string {
		return 'library';
	}

	override getState(): Record<string, unknown> {
		return { ...super.getState(), ...this.state };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const saved = (state ?? {}) as Partial<PaneState>;
		this.state = {
			...structuredClone(DEFAULT_STATE),
			...saved,
			options: { ...DEFAULT_GREP, ...saved.options },
			look: { ...DEFAULT_STATE.look, ...saved.look },
		};
		await super.setState(state, result);
		if (this.queryEl) {
			this.queryEl.value = this.state.query;
			this.renderControls();
			this.search();
		}
	}

	/** Searches a book, or with a query, from a command or a menu */
	focusOn(options: { book?: string | null; query?: string }): void {
		if (options.book !== undefined) {
			this.state.book = options.book;
			this.state.scope = options.book ? 'book' : 'all';
		}
		if (options.query !== undefined) this.state.query = options.query;
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
		// Not open yet: onOpen searches with this state
		if (!this.queryEl) return;
		this.queryEl.value = this.state.query;
		this.renderControls();
		this.search();
		this.queryEl.focus();
		this.queryEl.select();
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('epp-books-view');
		const pane = root.createDiv('epp-books');
		this.buildHeader(pane.createDiv('epp-books-header'));
		const body = pane.createDiv('epp-books-body');
		this.summaryEl = body.createDiv('epp-books-summary');
		this.resultsEl = body.createDiv('epp-books-results');

		const observer = new ResizeObserver(() => {
			const width = root.clientWidth;
			if (width === 0) return;
			const narrow = width < NARROW;
			if (narrow !== this.narrow) {
				this.narrow = narrow;
				pane.toggleClass('is-narrow', narrow);
				this.renderControls();
			}
		});
		observer.observe(root);
		this.register(() => observer.disconnect());

		// The book in front, for "This book"
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'epub' || file.path === this.state.book) return;
				this.state.book = file.path;
				if (this.state.scope === 'book') {
					this.renderControls();
					this.search();
				}
			}),
		);
		this.state.book ??= this.frontBook();
		this.watchEngine();
		this.unsubscribe.push(this.plugin.bookSearch.onChange(() => this.watchEngine()));
		this.renderControls();
		this.render();
		if (this.state.query) this.search();
		window.setTimeout(() => this.queryEl.focus(), 0);
	}

	override async onClose(): Promise<void> {
		this.generation++;
		this.plugin.bookSearch.peek()?.cancel();
		this.moreObserver?.disconnect();
		for (const u of this.unsubscribe) u();
		this.unsubscribe = [];
	}

	/** Follows the engine's state (ready, warming, failed) and reads its books */
	private engineUnsub: (() => void) | null = null;
	private watchEngine(): void {
		this.engineUnsub?.();
		const engine = this.plugin.bookSearch.get();
		this.engineUnsub = engine.onState(() => {
			this.renderSummary();
			if (engine.state().kind === 'ready' && this.books.length === 0) void this.loadBooks();
		});
		this.unsubscribe.push(() => this.engineUnsub?.());
		void this.loadBooks();
		this.renderSummary();
	}

	private async loadBooks(): Promise<void> {
		try {
			this.books = await this.plugin.bookSearch.books();
			this.renderSummary();
		} catch {
			// The engine says why in its state
		}
	}

	private frontBook(): string | null {
		const file = this.app.workspace.getActiveFile() ?? this.app.workspace.getLastOpenFiles().map((p) => this.app.vault.getFileByPath(p)).find((f) => f?.extension === 'epub');
		return file?.extension.toLowerCase() === 'epub' ? file.path : null;
	}

	// ---------------------------------------------------------------------------------------------
	// The header: the query, how to match, where to search, how results look
	// ---------------------------------------------------------------------------------------------

	private buildHeader(header: HTMLElement): void {
		const bar = header.createDiv('epp-books-querybar');
		icon(bar.createSpan('epp-books-querybar-icon'), 'search');
		this.queryEl = bar.createEl('input', {
			type: 'text',
			cls: 'epp-books-query',
			attr: { spellcheck: 'false', placeholder: 'Search your books…', 'aria-label': 'Search books' },
		});
		this.queryEl.value = this.state.query;
		const later = debounce(() => this.search(), 250, true);
		this.queryEl.addEventListener('input', () => {
			this.state.query = this.queryEl.value;
			// The tab's title has the query (an undocumented method)
			(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
			this.app.workspace.requestSaveLayout();
			later();
		});
		this.queryEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.search();
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				this.resultsEl.querySelector<HTMLElement>('.epp-books-card')?.focus();
			} else if (e.key === 'Escape' && this.searching) this.stop();
		});
		this.controlsEl = header.createDiv('epp-books-toggles');
		bar.appendChild(this.controlsEl);
		this.scopeEl = header.createDiv('epp-books-controls');
		this.displayEl = header.createDiv('epp-books-controls epp-books-display');
	}

	/** Draws the header's controls again from the state */
	private renderControls(): void {
		if (!this.controlsEl) return;
		const s = this.state;
		const o = s.options;

		// Inside the query bar: case, whole words, quotes, and the display button when narrow
		this.controlsEl.empty();
		const casing = CASINGS.find((c) => c.value === o.casing) ?? CASINGS[0]!;
		toggle(this.controlsEl, casing.label, casing.title, o.casing !== 'smart', () => {
			const order: Casing[] = ['smart', 'sensitive', 'insensitive'];
			this.setOptions({ casing: order[(order.indexOf(o.casing) + 1) % order.length]! });
		}).addClass(`is-${o.casing}`);
		toggle(this.controlsEl, 'ab', o.whole_word ? 'Whole words only (click: anywhere)' : 'Anywhere in words (click: whole words)', o.whole_word, () =>
			this.setOptions({ whole_word: !o.whole_word }),
		).addClass('is-word');
		if (o.mode === 'plaintext')
			toggle(this.controlsEl, '“”', o.fold_punctuation ? '\' " - also match curly quotes and dashes (click: exactly)' : 'Quotes and dashes match exactly (click: fold them)', o.fold_punctuation, () =>
				this.setOptions({ fold_punctuation: !o.fold_punctuation }),
			);
		if (this.narrow) {
			const b = iconButton(this.controlsEl, 'sliders-horizontal', this.displayOpen ? 'Hide display options' : 'Display options', () => {
				this.displayOpen = !this.displayOpen;
				this.renderControls();
			});
			b.toggleClass('is-active', this.displayOpen);
		}

		// Where and how
		this.scopeEl.empty();
		segmented(this.scopeEl, MODES, o.mode, 'How to match', (mode) => this.setOptions({ mode }));
		segmented(this.scopeEl, SCOPES, s.scope, 'Where to search', (scope) => {
			s.scope = scope;
			if (scope === 'book') s.book ??= this.frontBook();
			this.changed();
		});
		this.scopeEl.createSpan('epp-books-spacer');
		this.engineBadge(this.scopeEl);
		this.renderScopeRow();

		// How results look
		this.displayEl.empty();
		this.displayEl.toggle(!this.narrow || this.displayOpen);
		select(this.displayEl, 'Context', String(o.before_context), [['0', 'Paragraph only'], ['1', '±1 paragraph'], ['2', '±2 paragraphs'], ['3', '±3 paragraphs']], (v) =>
			this.setOptions({ before_context: Number(v), after_context: Number(v) }),
		);
		select(this.displayEl, 'Per book', String(o.max_matches_per_book), [['0', 'All matches'], ['1', '1 a book'], ['5', '5 a book'], ['20', '20 a book']], (v) =>
			this.setOptions({ max_matches_per_book: Number(v) }),
		);
		segmented(
			this.displayEl,
			[
				{ value: 'book' as GroupBy, label: 'By book', icon: 'library', title: 'Group matches by book' },
				{ value: 'none' as GroupBy, label: 'List', icon: 'list', title: 'One list' },
			],
			s.look.group,
			'Group',
			(group) => this.setLook({ group }),
		);
		if (s.look.group === 'book')
			select(this.displayEl, 'Order books', s.look.order, [['library', 'By path'], ['matches', 'Most matches'], ['title', 'By title']], (v) => this.setLook({ order: v as BookOrder }));
		this.displayEl.createSpan('epp-books-spacer');
		chip(this.displayEl, 'pilcrow', 'Whole paragraphs', 'Show whole paragraphs, not the words around each match', s.look.full, () => this.setLook({ full: !s.look.full }));
		chip(this.displayEl, 'list-tree', 'Chapters', 'Show each match’s chapter', s.look.chapters, () => this.setLook({ chapters: !s.look.chapters }));
		chip(this.displayEl, 'map-pin', 'CFIs', 'Show each match’s EPUB CFI', s.look.cfis, () => this.setLook({ cfis: !s.look.cfis }));
	}

	/** The scope's own row: folders, books, or the book in front */
	private renderScopeRow(): void {
		const s = this.state;
		let row = this.scopeEl.parentElement!.querySelector<HTMLElement>(':scope > .epp-books-scope');
		row?.remove();
		if (s.scope === 'all' && !s.booksQuery) {
			row = createDiv('epp-books-scope is-quiet');
			this.booksQueryInput(row);
			this.scopeEl.after(row);
			return;
		}
		row = createDiv('epp-books-scope');
		this.scopeEl.after(row);
		if (s.scope === 'book') {
			const label = row.createDiv('epp-books-scope-label');
			icon(label, 'book-open');
			label.createSpan({ text: 'In' });
			const book = s.book ? this.books.find((b) => b.id === s.book) : null;
			const name = row.createSpan({ cls: 'epp-books-chip is-book', text: book?.title ?? (s.book ? basename(s.book) : 'No EPUB open — open one, then search') });
			if (s.book) name.setAttr('title', s.book);
			return;
		}
		if (s.scope === 'folders') {
			const label = row.createDiv('epp-books-scope-label');
			icon(label, 'folder');
			label.createSpan({ text: 'In' });
			for (const folder of s.folders)
				removableChip(row, 'folder', folder, folder, () => {
					s.folders = s.folders.filter((f) => f !== folder);
					this.changed();
				});
			const input = row.createEl('input', { type: 'text', cls: 'epp-books-scope-input', attr: { placeholder: s.folders.length ? 'Add a folder' : 'Choose folders…' } });
			new FolderSuggest(this.app, input, (folder) => {
				if (!s.folders.includes(folder)) s.folders.push(folder);
				this.changed();
			});
		}
		if (s.scope === 'books') {
			const label = row.createDiv('epp-books-scope-label');
			icon(label, 'list-checks');
			label.createSpan({ text: 'In' });
			for (const id of s.books) {
				const book = this.books.find((b) => b.id === id);
				removableChip(row, 'book', book?.title ?? basename(id), id, () => {
					s.books = s.books.filter((b) => b !== id);
					this.changed();
				});
			}
			const input = row.createEl('input', { type: 'text', cls: 'epp-books-scope-input', attr: { placeholder: s.books.length ? 'Add a book' : 'Choose books by title, author, or path…' } });
			new BookSuggest(this.app, input, () => this.books.filter((b) => !s.books.includes(b.id)), (book) => {
				s.books.push(book.id);
				this.changed();
			});
		}
		if (s.scope !== 'books') this.booksQueryInput(row);
	}

	/** Narrows the scope to books whose title, author, or path has each word */
	private booksQueryInput(row: HTMLElement): void {
		const wrap = row.createDiv('epp-books-books-query');
		icon(wrap, 'filter');
		const input = wrap.createEl('input', {
			type: 'text',
			attr: { placeholder: 'Only books with these words in their title, author, or path', spellcheck: 'false', 'aria-label': 'Only books matching' },
		});
		input.value = this.state.booksQuery;
		const later = debounce(() => this.changed(false), 350, true);
		input.addEventListener('input', () => {
			this.state.booksQuery = input.value;
			later();
		});
	}

	private engineBadge(parent: HTMLElement): void {
		const manager = this.plugin.bookSearch;
		const engine = manager.get();
		const state = engine.state();
		const badge = parent.createEl('button', { cls: `epp-books-engine is-${engine.name} is-${state.kind}` });
		icon(badge, engine.name === 'native' ? 'zap' : 'cpu');
		badge.createSpan({ text: engine.name === 'native' ? 'Native' : 'WebAssembly' });
		badge.setAttr(
			'title',
			engine.name === 'native'
				? 'fff-epub runs beside Obsidian, its books’ text cached: fast across the whole library. Click to change'
				: `fff-epub in WebAssembly, a book at a time${manager.nativeProblem ? ` (native: ${manager.nativeProblem})` : ''}. Click to change`,
		);
		badge.addEventListener('click', (e) => this.engineMenu(e));
	}

	private engineMenu(e: MouseEvent): void {
		const manager = this.plugin.bookSearch;
		const menu = new Menu();
		const choose = (choice: EngineChoice, title: string, sub: string) =>
			menu.addItem((i) =>
				i
					.setTitle(title)
					.setChecked(manager.choice === choice)
					.setSection(sub)
					.onClick(() => void manager.setChoice(choice)),
			);
		choose('auto', 'Automatic (native when installed)', 'engine');
		if (Platform.isDesktopApp) choose('native', 'Native fff-epub', 'engine');
		choose('wasm', 'WebAssembly', 'engine');
		if (Platform.isDesktopApp)
			menu.addItem((i) =>
				i
					.setTitle('Path to fff-epub…')
					.setIcon('terminal')
					.setSection('path')
					.onClick(() => {
						const path = window.prompt('The fff-epub program (empty: ~/.cargo/bin and the usual places)', this.plugin.settings.bookSearchBinary ?? '');
						if (path !== null) void manager.setChoice(manager.choice, path.trim());
					}),
			);
		menu.addItem((i) =>
			i
				.setTitle('Find books again')
				.setIcon('refresh-cw')
				.setSection('path')
				.onClick(() => {
					manager.get().rescan();
					void this.loadBooks();
				}),
		);
		if (manager.nativeProblem && manager.choice !== 'wasm') menu.addItem((i) => i.setTitle(`Native: ${manager.nativeProblem}`).setDisabled(true).setSection('why'));
		menu.showAtMouseEvent(e);
	}

	private setOptions(update: Partial<GrepOptions>): void {
		this.state.options = { ...this.state.options, ...update };
		this.changed();
	}

	private setLook(update: Partial<PaneState['look']>): void {
		this.state.look = { ...this.state.look, ...update };
		this.app.workspace.requestSaveLayout();
		this.renderControls();
		this.render();
	}

	/** The search's settings changed: draw the controls and search again */
	private changed(redraw = true): void {
		this.app.workspace.requestSaveLayout();
		if (redraw) this.renderControls();
		this.search();
	}

	// ---------------------------------------------------------------------------------------------
	// Searching
	// ---------------------------------------------------------------------------------------------

	private searchScope(): Scope | null {
		const s = this.state;
		const booksQuery = s.booksQuery.trim() || undefined;
		switch (s.scope) {
			case 'all':
				return { booksQuery };
			case 'folders':
				return s.folders.length ? { folders: s.folders.map((f) => (f.endsWith('/') ? f : `${f}/`)), booksQuery } : null;
			case 'book':
				return s.book ? { books: [s.book] } : null;
			case 'books':
				return s.books.length ? { books: s.books } : null;
		}
	}

	/** Searches from the first page (or the next one, with `more`) */
	private search(more = false): void {
		const pattern = this.state.query;
		const scope = this.searchScope();
		const engine = this.plugin.bookSearch.get();
		const gen = ++this.generation;
		if (!more) {
			engine.cancel();
			this.hits = [];
			this.page = null;
			this.error = null;
			this.collapsed.clear();
		}
		if (!pattern.trim() || !scope) {
			this.searching = false;
			this.progress = null;
			this.render();
			return;
		}
		this.searching = true;
		this.progress = null;
		this.render();
		const offset = more ? (this.page?.next ?? 0) : 0;
		// Matches before this page, and those an engine reports book by book while it searches
		const before = this.hits;
		const streamed: Hit[] = [];
		void engine
			.grep({ pattern, options: this.state.options, scope, offset, pageLimit: PAGE }, (searched, total, found) => {
				if (gen !== this.generation) return;
				this.progress = { searched, total };
				streamed.push(...found);
				this.queueRender(() => {
					if (gen === this.generation) this.hits = [...before, ...streamed];
				});
			})
			.then((page) => {
				if (gen !== this.generation) return;
				this.hits = [...before, ...page.hits];
				this.page = page;
				this.searching = false;
				this.progress = null;
				if (page.errors.length) console.warn('[epp] book search:', page.errors);
				// WebAssembly learns titles and authors as it reads books
				if (engine.name === 'wasm') void this.loadBooks();
				this.render();
			})
			.catch((e: Error) => {
				if (gen !== this.generation) return;
				this.searching = false;
				this.progress = null;
				this.error = e.message;
				this.render();
			});
	}

	private stop(): void {
		this.plugin.bookSearch.get().cancel();
	}

	private queueRender(before?: () => void): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		window.requestAnimationFrame(() => {
			this.renderQueued = false;
			before?.();
			this.render();
		});
	}

	// ---------------------------------------------------------------------------------------------
	// Results
	// ---------------------------------------------------------------------------------------------

	private render(): void {
		if (!this.resultsEl) return;
		this.renderSummary();
		this.renderResults();
	}

	private renderSummary(): void {
		const el = this.summaryEl;
		if (!el) return;
		el.empty();
		const engine = this.plugin.bookSearch.get();
		const state = engine.state();
		const total = this.hits.length;
		const books = new Set(this.hits.map((h) => h.book)).size;
		const stat = (n: number, noun: string) => {
			const s = el.createSpan('epp-books-stat');
			s.createEl('strong', { text: n.toLocaleString() });
			s.appendText(` ${n === 1 ? noun : plural(noun)}`);
		};
		if (this.state.query.trim()) {
			stat(total, 'match');
			stat(books, 'book');
			if (this.page && !this.searching) el.createSpan({ cls: 'epp-books-muted', text: `${this.page.ms.toLocaleString()} ms` });
		} else el.createSpan({ cls: 'epp-books-muted', text: state.kind === 'ready' ? `${state.books.toLocaleString()} books` : '' });
		if (this.searching) {
			const p = this.progress;
			const busy = el.createSpan('epp-books-busy');
			busy.createSpan({ text: p ? `Searching ${p.searched.toLocaleString()} of ${p.total.toLocaleString()} books` : 'Searching…' });
			if (p && p.total > 0) {
				const bar = busy.createDiv('epp-books-progress');
				bar.createDiv({ cls: 'epp-books-progress-fill' }).style.width = `${Math.round((100 * p.searched) / p.total)}%`;
			}
			el.createEl('button', { cls: 'epp-books-link', text: 'Stop' }).addEventListener('click', () => this.stop());
		} else if (state.kind === 'ready' && state.warming) {
			const w = el.createSpan({ cls: 'epp-books-busy is-quiet', text: `Caching books’ text ${state.warming.done.toLocaleString()}/${state.warming.total.toLocaleString()}` });
			w.setAttr('title', 'fff-epub reads each book once and keeps its text, so searches after that are fast. Searching works meanwhile');
		} else if (state.kind === 'starting') el.createSpan({ cls: 'epp-books-busy is-quiet', text: 'Starting…' });
		el.createSpan('epp-books-spacer');
		if (this.state.look.group === 'book' && books > 1) {
			const collapse = () => {
				this.collapseAll = true;
				this.collapsed.clear();
				this.render();
			};
			const expand = () => {
				this.collapseAll = false;
				this.collapsed.clear();
				this.render();
			};
			if (this.narrow) {
				iconButton(el, 'chevrons-down-up', 'Collapse every book', collapse).toggleClass('is-active', this.collapseAll);
				iconButton(el, 'chevrons-up-down', 'Expand every book', expand);
			} else {
				el.createEl('button', { cls: `epp-books-link${this.collapseAll ? ' is-on' : ''}`, text: 'Collapse all' }).addEventListener('click', collapse);
				el.createEl('button', { cls: 'epp-books-link', text: 'Expand all' }).addEventListener('click', expand);
			}
		}
	}

	private renderResults(): void {
		const el = this.resultsEl;
		const scrollTop = el.scrollTop;
		el.empty();
		this.moreObserver?.disconnect();
		const state = this.plugin.bookSearch.get().state();
		if (state.kind === 'failed') return this.empty(el, 'alert-triangle', `Book search can’t start: ${state.message}`);
		if (this.error) return this.empty(el, 'alert-triangle', this.error);
		if (!this.state.query.trim()) return this.welcome(el);
		if (!this.searchScope())
			return this.empty(el, 'folder-search', this.state.scope === 'book' ? 'Open an EPUB to search it.' : this.state.scope === 'folders' ? 'Choose folders to search.' : 'Choose books to search.');
		if (this.hits.length === 0 && !this.searching) {
			this.empty(el, 'search-x', 'No matches.');
			const widen = this.state.scope !== 'all' || this.state.booksQuery || this.state.options.mode !== 'fuzzy';
			if (widen) {
				const actions = el.querySelector('.epp-books-empty')!.createDiv('epp-books-empty-actions');
				if (this.state.scope !== 'all' || this.state.booksQuery)
					actions.createEl('button', { text: 'Search every book' }).addEventListener('click', () => {
						this.state.scope = 'all';
						this.state.booksQuery = '';
						this.changed();
					});
				if (this.state.options.mode !== 'fuzzy')
					actions.createEl('button', { text: 'Try fuzzy' }).addEventListener('click', () => this.setOptions({ mode: 'fuzzy' }));
			}
			return;
		}

		if (this.state.look.group === 'none') {
			const cards = el.createDiv('epp-books-cards is-flat');
			for (const hit of this.hits) this.card(cards, hit, true);
		} else {
			for (const [book, hits] of this.groups()) {
				const collapsed = this.collapseAll ? !this.collapsed.has(book) : this.collapsed.has(book);
				const group = el.createDiv(`epp-books-group${collapsed ? ' is-collapsed' : ''}`);
				this.groupHead(group, book, hits);
				if (collapsed) continue;
				const cards = group.createDiv('epp-books-cards');
				for (const hit of hits) this.card(cards, hit, false);
			}
		}
		if (this.page?.next && !this.searching) {
			const more = el.createEl('button', { cls: 'epp-books-more', text: `Show more (${(this.page.totalBooks - this.page.next).toLocaleString()} books left)` });
			more.addEventListener('click', () => this.search(true));
			this.moreObserver = new IntersectionObserver((entries) => {
				if (entries.some((e) => e.isIntersecting) && !this.searching) this.search(true);
			}, { root: el, rootMargin: '300px 0px' });
			this.moreObserver.observe(more);
		}
		el.scrollTop = scrollTop;
	}

	/** Matches by book, in the chosen order */
	private groups(): [string, Hit[]][] {
		const byBook = new Map<string, Hit[]>();
		for (const hit of this.hits) {
			const list = byBook.get(hit.book);
			if (list) list.push(hit);
			else byBook.set(hit.book, [hit]);
		}
		const groups = [...byBook];
		if (this.state.look.order === 'matches') groups.sort((a, b) => b[1].length - a[1].length);
		if (this.state.look.order === 'title') groups.sort((a, b) => a[1][0]!.title.localeCompare(b[1][0]!.title));
		return groups;
	}

	private groupHead(group: HTMLElement, book: string, hits: Hit[]): void {
		const head = group.createDiv('epp-books-group-head');
		icon(head.createSpan('epp-books-caret'), 'chevron-down');
		icon(head.createSpan('epp-books-group-icon'), 'book');
		const info = this.books.find((b) => b.id === book);
		const name = head.createDiv('epp-books-group-name');
		name.createSpan({ cls: 'epp-books-group-title', text: hits[0]!.title || basename(book) });
		if (info?.creators.length) name.createSpan({ cls: 'epp-books-group-author', text: info.creators.join(', ') });
		name.setAttr('title', book);
		head.createSpan({ cls: 'epp-books-count', text: hits.length.toLocaleString() });
		const actions = head.createSpan('epp-books-actions');
		iconButton(actions, 'filter', 'Search only this book', (e) => {
			e.stopPropagation();
			this.state.scope = 'books';
			this.state.books = [book];
			this.changed();
		});
		iconButton(actions, 'arrow-up-right', 'Open the book', (e) => {
			e.stopPropagation();
			void this.openHit(hits[0]!, e.ctrlKey || e.metaKey, false);
		});
		head.addEventListener('click', () => {
			const toggled = this.collapsed.has(book);
			if (toggled) this.collapsed.delete(book);
			else this.collapsed.add(book);
			this.render();
		});
	}

	private card(parent: HTMLElement, hit: Hit, showBook: boolean): void {
		const look = this.state.look;
		const card = parent.createDiv({ cls: 'epp-books-card', attr: { tabindex: '0' } });
		const head = card.createDiv('epp-books-card-head');
		if (showBook) head.createSpan({ cls: 'epp-books-pill is-book', text: hit.title });
		if (look.chapters && hit.chapter) head.createSpan({ cls: 'epp-books-pill', text: hit.chapter, attr: { title: hit.chapter } });
		const where = head.createSpan('epp-books-where');
		where.setText(`¶ ${hit.line.toLocaleString()}`);
		where.setAttr('title', `Line ${hit.line}, column ${hit.column} of the book’s text`);
		if (hit.score !== null) head.createSpan({ cls: 'epp-books-score', text: String(hit.score), attr: { title: 'Fuzzy score' } });
		const actions = head.createSpan('epp-books-actions');
		iconButton(actions, 'link', 'Copy a link to it', (e) => {
			e.stopPropagation();
			this.copy(this.link(hit), 'Link copied');
		});
		iconButton(actions, 'quote', 'Copy it as a quote, with a link', (e) => {
			e.stopPropagation();
			this.copy(this.quote(hit), 'Quote copied');
		});
		iconButton(actions, 'more-horizontal', 'More', (e) => {
			e.stopPropagation();
			this.cardMenu(e, hit);
		});

		const body = card.createDiv('epp-books-text');
		for (const line of hit.before) body.createDiv({ cls: 'epp-books-context', text: shorten(line) });
		// A fuzzy match is marked whole, first letter to last (its letters alone look scattered)
		const first = hit.ranges[0];
		const last = hit.ranges[hit.ranges.length - 1];
		const whole: [number, number][] = first && last ? [[first[0], last[1]]] : [];
		const [text, ranges] = look.full ? [hit.lineText, whole] : snippet(hit.lineText, whole, AROUND);
		marked(body.createDiv('epp-books-line'), text, ranges);
		for (const line of hit.after) body.createDiv({ cls: 'epp-books-context', text: shorten(line) });
		if (look.cfis) card.createDiv({ cls: 'epp-books-cfi', text: hit.cfi });

		card.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('button')) return;
			// Selecting words in the preview isn't opening it
			if (window.getSelection()?.toString()) return;
			void this.openHit(hit, e.ctrlKey || e.metaKey);
		});
		card.addEventListener('auxclick', (e) => {
			if (e.button === 1) void this.openHit(hit, true);
		});
		card.addEventListener('contextmenu', (e) => this.cardMenu(e, hit));
		card.addEventListener('keydown', (e) => {
			const cards = [...this.resultsEl.querySelectorAll<HTMLElement>('.epp-books-card')];
			const i = cards.indexOf(card);
			if (e.key === 'Enter') void this.openHit(hit, e.ctrlKey || e.metaKey);
			else if (e.key === 'ArrowDown' || e.key === 'j') cards[i + 1]?.focus();
			else if (e.key === 'ArrowUp' || e.key === 'k') (cards[i - 1] ?? this.queryEl).focus();
			else return;
			e.preventDefault();
		});
	}

	private cardMenu(e: MouseEvent, hit: Hit): void {
		e.preventDefault();
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('Open').setIcon('book-open').onClick(() => void this.openHit(hit, false)));
		menu.addItem((i) => i.setTitle('Open in a new tab').setIcon('file-plus').onClick(() => void this.openHit(hit, true)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle('Copy link').setIcon('link').onClick(() => this.copy(this.link(hit), 'Link copied')));
		menu.addItem((i) => i.setTitle('Copy quote with link').setIcon('quote').onClick(() => this.copy(this.quote(hit), 'Quote copied')));
		menu.addItem((i) => i.setTitle('Copy paragraph').setIcon('pilcrow').onClick(() => this.copy(hit.lineText, 'Paragraph copied')));
		menu.addItem((i) => i.setTitle('Copy CFI').setIcon('map-pin').onClick(() => this.copy(hit.cfi, 'CFI copied')));
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle('Search only this book')
				.setIcon('filter')
				.onClick(() => {
					this.state.scope = 'books';
					this.state.books = [hit.book];
					this.changed();
				}),
		);
		menu.showAtMouseEvent(e);
	}

	private matchedText(hit: Hit): string {
		const first = hit.ranges[0];
		const last = hit.ranges[hit.ranges.length - 1];
		return first && last ? hit.lineText.slice(first[0], last[1]) : hit.title;
	}

	private link(hit: Hit): string {
		const file = this.app.vault.getFileByPath(hit.book);
		if (!file) return `[[${hit.book}#${hit.cfi}]]`;
		return this.plugin.documentLink(file, hit.cfi, this.matchedText(hit));
	}

	private quote(hit: Hit): string {
		const file = this.app.vault.getFileByPath(hit.book);
		const where = file ? this.plugin.documentLink(file, hit.cfi, [hit.title, hit.chapter].filter(Boolean).join(', ')) : hit.title;
		return `> ${hit.lineText}\n> — ${where}`;
	}

	private copy(text: string, done: string): void {
		void navigator.clipboard.writeText(text).then(() => new Notice(done, 1500));
	}

	/** Opens the book at the match (the range flashes), beside this tab unless asked for a new one */
	private async openHit(hit: Hit, newTab: boolean, atMatch = true): Promise<void> {
		const file = this.app.vault.getFileByPath(hit.book);
		if (!file) return void new Notice(`${hit.book} isn’t in the vault any more`);
		await this.plugin.openDocument(file, atMatch ? `#${hit.cfi}` : '', newTab ? 'tab' : undefined, { eState: { link: true } });
	}

	// ---------------------------------------------------------------------------------------------
	// Empty states
	// ---------------------------------------------------------------------------------------------

	private empty(el: HTMLElement, name: string, text: string): void {
		const box = el.createDiv('epp-books-empty');
		icon(box.createDiv('epp-books-empty-icon'), name);
		box.createEl('p', { text });
	}

	private welcome(el: HTMLElement): void {
		const box = el.createDiv('epp-books-welcome');
		const engine = this.plugin.bookSearch.get();
		const state = engine.state();
		const books = state.kind === 'ready' ? state.books : this.books.length;
		const top = box.createDiv('epp-books-welcome-head');
		icon(top.createDiv('epp-books-empty-icon'), 'library');
		top.createEl('h3', { text: 'Search your books' });
		top.createEl('p', {
			text: `${books.toLocaleString()} EPUB${books === 1 ? '' : 's'} in this vault · ${engine.name === 'native' ? 'native fff-epub, text cached' : 'fff-epub in WebAssembly'}`,
		});
		const tips = box.createEl('ul', 'epp-books-tips');
		const tip = (name: string, title: string, body: string) => {
			const li = tips.createEl('li');
			icon(li.createSpan('epp-books-tip-icon'), name);
			const t = li.createDiv();
			t.createEl('strong', { text: title });
			t.createDiv({ text: body });
		};
		tip('type', 'Text', 'Words as written. God’s finds God’s and God’s; a phrase stays in its paragraph.');
		tip('sparkles', 'Fuzzy', 'Typos and gaps: “justfication by fath” finds “justification by faith”.');
		tip('regex', 'Regex', 'ripgrep’s syntax: \\bRom(ans)? \\d+:\\d+');
		tip('mouse-pointer-click', 'Open', 'Click a match to open the book there (Ctrl/Cmd-click: a new tab); ↓ moves through matches, Enter opens.');
		if (engine.name === 'wasm' && this.plugin.bookSearch.nativeProblem && Platform.isDesktopApp)
			box.createDiv({ cls: 'epp-books-note', text: `Searching every book is faster with the native fff-epub (${this.plugin.bookSearch.nativeProblem}). Choose its path from the engine button above.` });
	}
}

// -------------------------------------------------------------------------------------------------
// Small DOM pieces
// -------------------------------------------------------------------------------------------------

function icon(el: HTMLElement, name: string): HTMLElement {
	setIcon(el, name);
	el.addClass('epp-books-icon');
	return el;
}

function iconButton(parent: HTMLElement, name: string, title: string, onClick: (e: MouseEvent) => void): HTMLElement {
	const b = parent.createEl('button', { cls: 'clickable-icon epp-books-icon-button', attr: { 'aria-label': title, title } });
	icon(b, name);
	b.addEventListener('click', onClick);
	return b;
}

/** A small on/off text button inside the query bar */
function toggle(parent: HTMLElement, text: string, title: string, on: boolean, onClick: () => void): HTMLElement {
	const b = parent.createEl('button', { cls: `epp-books-toggle${on ? ' is-on' : ''}`, text, attr: { 'aria-pressed': String(on), title, 'aria-label': title } });
	b.addEventListener('click', onClick);
	return b;
}

function chip(parent: HTMLElement, name: string, text: string, title: string, on: boolean, onClick: () => void): void {
	const b = parent.createEl('button', { cls: `epp-books-chip-toggle${on ? ' is-on' : ''}`, attr: { 'aria-pressed': String(on), title } });
	icon(b.createSpan(), name);
	b.createSpan({ cls: 'epp-books-label', text });
	b.addEventListener('click', onClick);
}

function removableChip(parent: HTMLElement, name: string, text: string, title: string, onRemove: () => void): void {
	const c = parent.createSpan({ cls: 'epp-books-chip', attr: { title } });
	icon(c.createSpan(), name);
	c.createSpan({ cls: 'epp-books-chip-text', text });
	const x = c.createEl('button', { text: '×', attr: { 'aria-label': `Remove ${text}` } });
	x.addEventListener('click', onRemove);
}

function segmented<T extends string>(parent: HTMLElement, options: { value: T; label: string; icon: string; title: string }[], value: T, label: string, onChange: (value: T) => void): void {
	const group = parent.createDiv({ cls: 'epp-books-segmented', attr: { role: 'radiogroup', 'aria-label': label } });
	for (const o of options) {
		const b = group.createEl('button', { cls: o.value === value ? 'is-on' : '', attr: { role: 'radio', 'aria-checked': String(o.value === value), title: o.title } });
		icon(b.createSpan(), o.icon);
		b.createSpan({ cls: 'epp-books-label', text: o.label });
		b.addEventListener('click', () => {
			if (o.value !== value) onChange(o.value);
		});
	}
}

function select(parent: HTMLElement, label: string, value: string, options: [string, string][], onChange: (value: string) => void): void {
	const s = parent.createEl('select', { cls: 'dropdown epp-books-select', attr: { 'aria-label': label, title: label } });
	for (const [v, text] of options) s.createEl('option', { value: v, text });
	s.value = value;
	s.addEventListener('change', () => onChange(s.value));
}

/** Text with ranges marked */
export function marked(el: HTMLElement, text: string, ranges: [number, number][]): void {
	let at = 0;
	for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
		if (from < at || from >= text.length) continue;
		el.appendText(text.slice(at, from));
		el.createEl('mark', { text: text.slice(from, Math.min(text.length, to)) });
		at = Math.min(text.length, to);
	}
	el.appendText(text.slice(at));
}

function plural(noun: string): string {
	return /(s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
}

function shorten(line: string): string {
	return line.length > AROUND * 2 ? `${line.slice(0, AROUND * 2)}…` : line;
}

function basename(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.replace(/\.epub$/i, '');
}

class FolderSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		private readonly input: HTMLInputElement,
		private readonly onPick: (folder: string) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		// Folders that have EPUBs in them (or under them)
		const withBooks = new Set<string>();
		for (const f of this.app.vault.getFiles())
			if (f.extension.toLowerCase() === 'epub')
				for (let p = f.parent; p && !p.isRoot(); p = p.parent) withBooks.add(p.path);
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && withBooks.has(f.path) && f.path.toLowerCase().includes(q))
			.map((f) => f.path)
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 50);
	}

	renderSuggestion(folder: string, el: HTMLElement): void {
		el.setText(folder);
	}

	override selectSuggestion(folder: string): void {
		this.input.value = '';
		this.onPick(folder);
		this.close();
	}
}

class BookSuggest extends AbstractInputSuggest<{ book: BookInfo; label: string; matches: [number, number][] }> {
	constructor(
		app: App,
		private readonly input: HTMLInputElement,
		private readonly books: () => BookInfo[],
		private readonly onPick: (book: BookInfo) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string) {
		const fuzzy = prepareFuzzySearch(query.trim());
		const found = [];
		for (const book of this.books()) {
			const label = bookLabel(book);
			const m = query.trim() ? fuzzy(label) : { score: 0, matches: [] };
			if (m) found.push({ book, label, matches: m.matches as [number, number][], score: m.score });
		}
		return found.sort((a, b) => b.score - a.score).slice(0, 50);
	}

	renderSuggestion(s: { book: BookInfo; label: string; matches: [number, number][] }, el: HTMLElement): void {
		el.addClass('epp-books-suggestion');
		marked(el.createDiv('epp-books-suggestion-title'), s.book.title, s.matches.filter(([a]) => a < s.book.title.length));
		const meta = [s.book.creators.join(', '), s.book.id].filter(Boolean).join(' · ');
		el.createDiv({ cls: 'epp-books-suggestion-meta', text: meta });
	}

	override selectSuggestion(s: { book: BookInfo }): void {
		this.input.value = '';
		this.onPick(s.book);
		this.close();
	}
}
