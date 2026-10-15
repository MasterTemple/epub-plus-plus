/**
 * The WebAssembly engine's worker: fff-epub's bindings, a few books kept open, one book searched at
 * a time. It has no vault access: when it lacks a book it asks for its bytes (`need`), so the main
 * thread reads only books the worker hasn't kept. Bundled on its own and embedded in main.js
 * (`epp-search-worker` in esbuild.config.ts); the plugin hands it the WebAssembly.
 */
import init, { Casing, EpubBook, EpubGrep, GrepMode, OffsetUnit } from 'fff-epub';
import type { GrepOptions } from './types';

/** Books kept open, most recently used last */
const KEEP = 6;

export type ToWorker =
	| { type: 'init'; wasm: Uint8Array; cfiAssertions: boolean }
	| { type: 'grep'; gen: number; path: string; key: string; pattern: string; options: GrepOptions }
	| { type: 'book'; gen: number; path: string; key: string; bytes: Uint8Array; pattern: string; options: GrepOptions };

export type FromWorker =
	| { type: 'ready' }
	| { type: 'need'; gen: number; path: string }
	| { type: 'result'; gen: number; path: string; title: string; creators: string[]; matches: unknown[] }
	| { type: 'error'; gen: number; path: string; message: string };

const open: { path: string; key: string; book: EpubBook }[] = [];
let cfiAssertions = false;
let ready: Promise<void> | null = null;

const post = (message: FromWorker) => (self as unknown as Worker).postMessage(message);

function grepOptions(o: GrepOptions): EpubGrep {
	const mode = o.mode === 'regex' ? GrepMode.Regex : o.mode === 'fuzzy' ? GrepMode.Fuzzy : GrepMode.PlainText;
	const casing = o.casing === 'sensitive' ? Casing.Sensitive : o.casing === 'insensitive' ? Casing.Insensitive : Casing.Smart;
	return EpubGrep.create()
		.mode(mode)
		.casing(casing)
		.foldPunctuation(o.fold_punctuation)
		.wholeWord(o.whole_word)
		.maxPerBook(o.max_matches_per_book)
		.beforeContext(o.before_context)
		.afterContext(o.after_context);
}

function search(gen: number, path: string, book: EpubBook, pattern: string, options: GrepOptions): void {
	const grep = grepOptions(options);
	try {
		const matches = book.grep(pattern, grep, OffsetUnit.Utf16);
		post({ type: 'result', gen, path, title: book.title(), creators: book.metadata().creators, matches });
	} finally {
		grep.dispose();
	}
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
	const msg = e.data;
	if (msg.type === 'init') {
		cfiAssertions = msg.cfiAssertions;
		ready = init(msg.wasm);
		await ready;
		post({ type: 'ready' });
		return;
	}
	await ready;
	try {
		if (msg.type === 'grep') {
			const i = open.findIndex((b) => b.path === msg.path && b.key === msg.key);
			if (i === -1) return post({ type: 'need', gen: msg.gen, path: msg.path });
			const [kept] = open.splice(i, 1);
			open.push(kept!);
			search(msg.gen, msg.path, kept!.book, msg.pattern, msg.options);
		} else if (msg.type === 'book') {
			const book = EpubBook.fromBytes(msg.bytes, cfiAssertions);
			if (!book) throw new Error("couldn't read it");
			for (const old of open.filter((b) => b.path === msg.path)) old.book.dispose();
			open.splice(0, open.length, ...open.filter((b) => b.path !== msg.path));
			open.push({ path: msg.path, key: msg.key, book });
			while (open.length > KEEP) open.shift()!.book.dispose();
			search(msg.gen, msg.path, book, msg.pattern, msg.options);
		}
	} catch (err) {
		// Errors from the bindings carry their reason in `value`
		const reason = (err as { value?: { message?: string } })?.value?.message ?? (err as Error)?.message ?? String(err);
		post({ type: 'error', gen: msg.gen, path: msg.path, message: reason });
	}
};
