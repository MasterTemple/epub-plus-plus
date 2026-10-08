import { BookText, EpubBook, type EpubReader } from '@epub-pp/core';
import { FilePlusPlusPlugin } from 'file-plus-plus/obsidian';
import type { EpubPlusPlusApi } from './api';
import { epubFormat } from './format';

/** EPUB++: EPUBs read in Obsidian, with highlights backed by links in notes (see file-plus-plus). */
export default class EpubPlusPlus extends FilePlusPlusPlugin<EpubBook, EpubReader> {
	readonly format = epubFormat;
	declare api: EpubPlusPlusApi;

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
					const sections = text.sections.map((s) => ({ ...s, title: titles.get(s.href) ?? null }));
					return { sections, cfi: (spine, start, end, o) => text.cfi(spine, start, end, o) };
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
