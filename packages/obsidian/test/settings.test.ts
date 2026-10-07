import { describe, expect, test } from 'bun:test';
import { altLinkLabel, formatMenuLabel, titleCase } from '../src/settings';

describe('selection menu labels', () => {
	test('title-cases format names, keeping small words lowercase', () => {
		expect(titleCase('callout with comment')).toBe('Callout with Comment');
		expect(titleCase('text with link')).toBe('Text with Link');
		expect(titleCase('a quote')).toBe('A Quote');
	});
	test('formats read "As …"', () => {
		expect(formatMenuLabel('Callout with comment')).toBe('As Callout with Comment');
		expect(formatMenuLabel('Quote')).toBe('As Quote');
	});
	test('alternate link names the other link type', () => {
		expect(altLinkLabel('cfi')).toBe('Text-Fragment Link');
		expect(altLinkLabel('text')).toBe('CFI Link');
	});
});
