/**
 * The desktop engine: one `fff-epub serve` process for the session, started in the vault's folder.
 * It finds the books once and caches their text on disk, so no search starts cold; a newer search
 * stops the one before it. Protocol: fff-epub's CLI README (`serve`).
 */
import type { BookInfo, EngineState, GrepPage, GrepRequest, Hit, SearchEngine } from './types';
import { utf16Ranges } from './types';

// Electron's renderer has Node's require and process (desktop only; this package has no Node types)
declare const require: (id: string) => any;
declare const process: { platform: string };

/** What's used of Node's ChildProcess */
interface ChildProcess {
	stdin: { write(text: string): void; end(): void };
	stdout: { setEncoding(e: string): void; on(event: 'data', f: (chunk: string) => void): void };
	stderr: { setEncoding(e: string): void; on(event: 'data', f: (chunk: string) => void): void };
	on(event: 'error', f: (e: Error) => void): void;
	on(event: 'exit', f: (code: number | null) => void): void;
	kill(): void;
}

interface Pending {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

/** A match as `fff-epub serve` writes it */
interface ServeMatch {
	book: string;
	title: string;
	location: { cfi: string; chapter: string | null; line: number; utf16_column: number; line_text: string };
	ranges: { start: number; end: number }[];
	score: number | null;
	context_before: string[];
	context_after: string[];
}

/** Where `fff-epub` might be when Obsidian's PATH doesn't have it (apps don't get the shell's PATH) */
export function binaryCandidates(home: string, platform: string): string[] {
	const exe = platform === 'win32' ? 'fff-epub.exe' : 'fff-epub';
	const sep = platform === 'win32' ? '\\' : '/';
	const dirs = [`${home}${sep}.cargo${sep}bin`, `${home}${sep}.local${sep}bin`];
	if (platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
	return dirs.map((d) => `${d}${sep}${exe}`);
}

/** The `fff-epub` to run: the setting's, else the first that exists */
export function findBinary(setting: string): string | null {
	try {
		const fs = require('node:fs') as { existsSync(path: string): boolean } | null;
		const os = require('node:os') as { homedir(): string } | null;
		if (!fs || !os) return null;
		if (setting.trim()) return fs.existsSync(setting.trim()) ? setting.trim() : null;
		return binaryCandidates(os.homedir(), process.platform).find((p) => fs.existsSync(p)) ?? null;
	} catch {
		// No Node here (a phone, or mobile emulation)
		return null;
	}
}

export class NativeEngine implements SearchEngine {
	readonly name = 'native' as const;
	private child: ChildProcess | null = null;
	private current: EngineState = { kind: 'starting' };
	private readonly listeners = new Set<() => void>();
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private buffer = '';
	private stderr: string[] = [];
	private ready: Promise<void>;
	private markReady!: () => void;
	private disposed = false;
	private restarts = 0;

	constructor(
		private readonly binary: string,
		private readonly vaultPath: string,
		private readonly cfiAssertions: boolean,
	) {
		this.ready = new Promise((resolve) => (this.markReady = resolve));
		this.start();
	}

	private start(): void {
		const { spawn } = require('node:child_process') as {
			spawn(command: string, args: string[], options: { cwd: string; stdio: string[] }): ChildProcess;
		};
		// Every EPUB Obsidian sees, even ones a .gitignore leaves out (hidden folders stay out)
		const args = ['serve', '.', '--no-ignore'];
		if (this.cfiAssertions) args.push('--cfi-assertions');
		let child: ChildProcess;
		try {
			child = spawn(this.binary, args, { cwd: this.vaultPath, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (e) {
			this.fail(`Couldn't start ${this.binary}: ${(e as Error).message}`);
			return;
		}
		this.child = child;
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.receive(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			this.stderr.push(chunk);
			if (this.stderr.length > 20) this.stderr.shift();
		});
		child.on('error', (e) => this.fail(`Couldn't run ${this.binary}: ${e.message}`));
		child.on('exit', (code) => {
			if (this.child !== child) return;
			this.child = null;
			for (const p of this.pending.values()) p.reject(new Error('fff-epub stopped'));
			this.pending.clear();
			if (this.disposed) return;
			// Started again once or twice if it dies (a crash, a killed process); then it says why
			if (this.restarts < 2) {
				this.restarts++;
				this.ready = new Promise((resolve) => (this.markReady = resolve));
				this.setState({ kind: 'starting' });
				this.start();
			} else this.fail(`fff-epub stopped (exit ${code}): ${this.stderr.join('').trim().slice(-300)}`);
		});
	}

	private fail(message: string): void {
		this.setState({ kind: 'failed', message });
		this.markReady();
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

	/** Lines of JSON from the process */
	private receive(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf('\n')) !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (!line.trim()) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.event === 'ready') {
				this.setState({ kind: 'ready', books: msg.books });
				this.markReady();
			} else if (msg.event === 'warm' && this.current.kind === 'ready') {
				const done = msg.done >= msg.total;
				this.setState({ kind: 'ready', books: this.current.books, warming: done ? undefined : { done: msg.done, total: msg.total } });
			} else if (typeof msg.id === 'number') {
				const p = this.pending.get(msg.id);
				if (!p) continue;
				this.pending.delete(msg.id);
				if ('error' in msg) p.reject(new Error(msg.error));
				else p.resolve(msg.ok);
			}
		}
	}

	private async request<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
		await this.ready;
		if (this.current.kind === 'failed') throw new Error(this.current.message);
		const child = this.child;
		if (!child) throw new Error('fff-epub is not running');
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ id, op, ...body })}\n`);
		});
	}

	async books(): Promise<BookInfo[]> {
		const books = await this.request<{ id: string; title: string; metadata: { creators: string[] } }[]>('books');
		return books.map((b) => ({ id: b.id, title: b.title, creators: b.metadata.creators }));
	}

	async grep(request: GrepRequest): Promise<GrepPage> {
		const { scope } = request;
		const page = await this.request<any>('grep', {
			pattern: request.pattern,
			options: request.options,
			book_offset: request.offset,
			page_limit: request.pageLimit,
			books: scope.books,
			folders: scope.folders ?? [],
			books_query: scope.booksQuery || undefined,
		});
		const hits: Hit[] = (page.matches as ServeMatch[]).map((m) => ({
			book: m.book,
			title: m.title,
			cfi: m.location.cfi,
			chapter: m.location.chapter,
			line: m.location.line,
			column: m.location.utf16_column,
			lineText: m.location.line_text,
			ranges: utf16Ranges(m.location.line_text, m.ranges),
			score: m.score,
			before: m.context_before,
			after: m.context_after,
		}));
		return {
			hits,
			booksSearched: page.books_searched,
			booksWithMatches: page.books_with_matches,
			totalBooks: page.total_books,
			next: page.next_book_offset,
			aborted: page.aborted,
			errors: page.errors,
			ms: page.ms,
		};
	}

	cancel(): void {
		if (this.child && this.current.kind === 'ready') this.child.stdin.write(`${JSON.stringify({ id: 0, op: 'cancel' })}\n`);
	}

	rescan(): void {
		void this.request<{ books: number }>('rescan')
			.then((r) => {
				if (this.current.kind === 'ready') this.setState({ ...this.current, books: r.books });
			})
			.catch(() => {});
	}

	dispose(): void {
		this.disposed = true;
		this.child?.stdin.end();
		this.child?.kill();
		this.child = null;
		this.listeners.clear();
	}
}
