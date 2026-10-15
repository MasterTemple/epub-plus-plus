/**
 * The book search's engine for the plugin's lifetime: the native `fff-epub serve` process on
 * desktop when it's installed, else WebAssembly. Books are rescanned when EPUBs are added, removed,
 * or renamed; titles and authors seen are kept in the plugin's folder, so phones (which never open
 * every book) can still find books by title.
 */
import { FileSystemAdapter, Platform, TAbstractFile, TFile, debounce, normalizePath } from 'obsidian';
import type { FilePlusPlusPlugin } from 'file-plus-plus/obsidian';
import { NativeEngine, findBinary } from './native';
import type { BookInfo, SearchEngine } from './types';
import { WasmEngine } from './wasm';

export type EngineChoice = 'auto' | 'native' | 'wasm';

export interface BookSearchSettings {
	/** Which engine searches books */
	bookSearchEngine?: EngineChoice;
	/** The `fff-epub` program (empty: look in the usual places) */
	bookSearchBinary?: string;
}

type Plugin = FilePlusPlusPlugin & { settings: BookSearchSettings & { linkType?: string } };

const BOOKS_FILE = 'book-search-books.json';

export class BookSearch {
	private engine: SearchEngine | null = null;
	/** Why the native engine isn't used, when it was wanted */
	nativeProblem: string | null = null;
	readonly known = new Map<string, BookInfo>();
	private readonly listeners = new Set<() => void>();
	private readonly saveKnown = debounce(() => void this.writeKnown(), 2000, true);
	private readonly rescanSoon = debounce(() => this.engine?.rescan(), 1500, true);

	constructor(private readonly plugin: Plugin) {
		void this.readKnown();
		const isEpub = (f: TAbstractFile) => f instanceof TFile && f.extension.toLowerCase() === 'epub';
		const changed = (f: TAbstractFile) => {
			if (isEpub(f)) this.rescanSoon();
		};
		plugin.registerEvent(plugin.app.vault.on('create', changed));
		plugin.registerEvent(plugin.app.vault.on('delete', changed));
		plugin.registerEvent(
			plugin.app.vault.on('rename', (f, old) => {
				if (isEpub(f) || old.toLowerCase().endsWith('.epub')) this.rescanSoon();
			}),
		);
	}

	/** Called when the engine is replaced (settings changed) */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get choice(): EngineChoice {
		return this.plugin.settings.bookSearchEngine ?? 'auto';
	}

	/** The engine if it has started (closing views mustn't start one) */
	peek(): SearchEngine | null {
		return this.engine;
	}

	/** The engine, started the first time it's asked for */
	get(): SearchEngine {
		this.engine ??= this.create();
		return this.engine;
	}

	private create(): SearchEngine {
		this.nativeProblem = null;
		const adapter = this.plugin.app.vault.adapter;
		if (this.choice !== 'wasm') {
			if (!Platform.isDesktopApp || Platform.isMobile || !(adapter instanceof FileSystemAdapter)) this.nativeProblem = 'only on desktop';
			else {
				const binary = findBinary(this.plugin.settings.bookSearchBinary ?? '');
				if (binary) return new NativeEngine(binary, adapter.getBasePath(), false);
				this.nativeProblem = this.plugin.settings.bookSearchBinary
					? `${this.plugin.settings.bookSearchBinary} doesn't exist`
					: 'fff-epub isn’t installed (cargo install --path crates/fff-epub-cli)';
			}
		}
		return new WasmEngine(this.plugin.app, false, this.known, (book) => {
			this.known.set(book.id, book);
			this.saveKnown();
		});
	}

	async setChoice(choice: EngineChoice, binary?: string): Promise<void> {
		this.plugin.settings.bookSearchEngine = choice;
		if (binary !== undefined) this.plugin.settings.bookSearchBinary = binary;
		await this.plugin.saveSettings();
		this.restart();
	}

	restart(): void {
		this.engine?.dispose();
		this.engine = null;
		for (const l of this.listeners) l();
	}

	/** Every book, with what's known of it (from the native engine, the whole library's metadata) */
	async books(): Promise<BookInfo[]> {
		const books = await this.get().books();
		if (this.get().name === 'native') {
			let changed = false;
			for (const b of books) {
				const old = this.known.get(b.id);
				if (!old || old.title !== b.title || old.creators.join() !== b.creators.join()) {
					this.known.set(b.id, b);
					changed = true;
				}
			}
			if (changed) this.saveKnown();
		}
		return books;
	}

	private get knownPath(): string {
		return normalizePath(`${this.plugin.manifest.dir}/${BOOKS_FILE}`);
	}

	private async readKnown(): Promise<void> {
		try {
			const text = await this.plugin.app.vault.adapter.read(this.knownPath);
			for (const [id, title, creators] of JSON.parse(text) as [string, string, string[]][]) this.known.set(id, { id, title, creators });
		} catch {
			// None yet
		}
	}

	private async writeKnown(): Promise<void> {
		const rows = [...this.known.values()].map((b) => [b.id, b.title, b.creators]);
		await this.plugin.app.vault.adapter.write(this.knownPath, JSON.stringify(rows));
	}

	dispose(): void {
		this.engine?.dispose();
		this.engine = null;
		this.listeners.clear();
	}
}
