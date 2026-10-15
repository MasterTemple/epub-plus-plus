/**
 * The WebAssembly engine (phones, or desktops without `fff-epub`): fff-epub's bindings in a worker,
 * fed one book at a time from the vault. Slower than the native process (one thread, every book
 * read when it's searched), so it reports progress as it goes and searches stop when superseded.
 */
import type { App, TFile } from 'obsidian';
import wasm from 'fff-epub-wasm';
import workerSource from 'epp-search-worker';
import type { FromWorker, ToWorker } from './worker';
import { booksInScope, type BookInfo, type EngineState, type GrepPage, type GrepRequest, type Hit, type SearchEngine } from './types';

/** A match as the bindings give it (UTF-16 offsets) */
interface WasmMatch {
	location: { cfi: string; chapter: string | null | undefined; line: number; column: number; lineText: string };
	ranges: { start: number; end: number }[];
	score: number;
	contextBefore: string[];
	contextAfter: string[];
}

export class WasmEngine implements SearchEngine {
	readonly name = 'wasm' as const;
	private worker: Worker | null = null;
	private url: string | null = null;
	private current: EngineState = { kind: 'starting' };
	private readonly listeners = new Set<() => void>();
	private gen = 0;
	/** The reply a search is waiting for (replies to searches since stopped are dropped) */
	private waiting: { gen: number; path: string; resolve: (msg: FromWorker) => void } | null = null;
	private ready: Promise<void>;

	constructor(
		private readonly app: App,
		cfiAssertions: boolean,
		/** Titles and authors seen so far, by path (kept by the plugin) */
		private readonly known: Map<string, BookInfo>,
		private readonly learned: (book: BookInfo) => void,
	) {
		this.ready = new Promise((resolve) => {
			try {
				this.url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
				this.worker = new Worker(this.url);
				this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
					if (e.data.type === 'ready') {
						this.setState({ kind: 'ready', books: this.files().length });
						resolve();
					} else this.deliver(e.data);
				};
				this.worker.onerror = (e) => {
					this.setState({ kind: 'failed', message: e.message || 'the search worker failed' });
					resolve();
				};
				this.send({ type: 'init', wasm, cfiAssertions });
			} catch (e) {
				this.setState({ kind: 'failed', message: (e as Error).message });
				resolve();
			}
		});
	}

	private deliver(msg: FromWorker): void {
		const w = this.waiting;
		if (!w || msg.type === 'ready' || msg.gen !== w.gen || msg.path !== w.path) return;
		this.waiting = null;
		w.resolve(msg);
	}

	/** Lets a search waiting on the worker go, as stopped */
	private release(): void {
		const w = this.waiting;
		this.waiting = null;
		w?.resolve({ type: 'error', gen: w.gen, path: w.path, message: 'stopped' });
	}

	private send(msg: ToWorker, transfer: Transferable[] = []): void {
		this.worker?.postMessage(msg, transfer);
	}

	private setState(state: EngineState): void {
		this.current = state;
		for (const l of this.listeners) l();
	}

	state(): EngineState {
		return this.current;
	}

	onState(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private files(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === 'epub');
	}

	async books(): Promise<BookInfo[]> {
		return this.files().map((f) => this.known.get(f.path) ?? { id: f.path, title: f.basename, creators: [] });
	}

	/** The worker's answer for one book (it may ask for the book's bytes first) */
	private async searchBook(gen: number, file: TFile, request: GrepRequest): Promise<FromWorker> {
		const key = `${file.stat.size}:${file.stat.mtime}`;
		const answer = () => new Promise<FromWorker>((resolve) => (this.waiting = { gen, path: file.path, resolve }));
		const base = { gen, path: file.path, key, pattern: request.pattern, options: request.options };
		let reply = answer();
		this.send({ type: 'grep', ...base });
		let msg = await reply;
		if (msg.type === 'need' && gen === this.gen) {
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			reply = answer();
			this.send({ type: 'book', ...base, bytes }, [bytes.buffer]);
			msg = await reply;
		}
		return msg;
	}

	async grep(request: GrepRequest, onProgress?: (searched: number, total: number, hits: Hit[]) => void): Promise<GrepPage> {
		await this.ready;
		const started = performance.now();
		this.release();
		const gen = ++this.gen;
		const byPath = new Map(this.files().map((f) => [f.path, f]));
		const order = booksInScope([...byPath.values()], request.scope, this.known);
		const page: GrepPage = { hits: [], booksSearched: 0, booksWithMatches: 0, totalBooks: order.length, next: 0, aborted: false, errors: [], ms: 0 };
		if (this.current.kind !== 'ready') {
			page.errors.push(this.current.kind === 'failed' ? this.current.message : 'not ready');
			return page;
		}
		for (let i = request.offset; i < order.length; i++) {
			if (gen !== this.gen) {
				page.aborted = true;
				page.next = i;
				break;
			}
			const file = byPath.get(order[i]!)!;
			const msg = await this.searchBook(gen, file, request);
			if (gen !== this.gen) {
				page.aborted = true;
				page.next = i;
				break;
			}
			page.booksSearched++;
			if (msg.type === 'error') page.errors.push(`${file.path}: ${msg.message}`);
			if (msg.type === 'result') {
				const info = { id: file.path, title: msg.title || file.basename, creators: msg.creators };
				const old = this.known.get(file.path);
				if (!old || old.title !== info.title || old.creators.join() !== info.creators.join()) this.learned(info);
				const found = (msg.matches as WasmMatch[]).map((m): Hit => ({
					book: file.path,
					title: info.title,
					cfi: m.location.cfi,
					chapter: m.location.chapter ?? null,
					line: m.location.line,
					column: m.location.column,
					lineText: m.location.lineText,
					ranges: m.ranges.map((r) => [r.start, r.end] as [number, number]),
					score: request.options.mode === 'fuzzy' ? m.score : null,
					before: m.contextBefore,
					after: m.contextAfter,
				}));
				if (found.length > 0) page.booksWithMatches++;
				page.hits.push(...found);
				onProgress?.(i + 1 - request.offset, order.length - request.offset, found);
			} else onProgress?.(i + 1 - request.offset, order.length - request.offset, []);
			if (request.pageLimit > 0 && page.hits.length >= request.pageLimit) {
				page.next = i + 1 < order.length ? i + 1 : 0;
				break;
			}
		}
		page.ms = Math.round(performance.now() - started);
		return page;
	}

	cancel(): void {
		this.gen++;
		this.release();
	}

	rescan(): void {
		if (this.current.kind === 'ready') this.setState({ kind: 'ready', books: this.files().length });
	}

	dispose(): void {
		this.cancel();
		this.worker?.terminate();
		this.worker = null;
		if (this.url) URL.revokeObjectURL(this.url);
		this.listeners.clear();
	}
}
