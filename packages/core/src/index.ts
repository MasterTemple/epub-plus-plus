export { EpubBook, type BookMetadata, type ManifestItem, type SpineItem } from './book/epub';
export { flattenToc, type TocItem } from './book/toc';
export { CssProcessor } from './css/rewrite';
export * from './locators/cfi';
export * from './locators/locator';
export * from './locators/text-fragment';
export { TextIndex, foldString } from './search/text-index';
export { searchIndex, type SearchMatch, type SearchOptions } from './search/search';
export {
	EpubReader,
	rangeText,
	type FlashOptions,
	type HighlightSpec,
	type Location,
	type ReaderOptions,
	type SearchResult,
	type SelectionInfo,
} from './render/reader';
export * from './render/settings';
