import { expect, test } from 'bun:test';
import { cfiScheme, hrefScheme, parseEpubLocator } from '../src/locators/locator';

const cfi = 'epubcfi(/6/14!/4/2,/1:0,/1:16)';

test('parseLocator', () => {
	expect(parseEpubLocator('epubcfi(/6/14!/4/2/6/2,/1%3A0,/1%3A48)&color=green')).toEqual({ cfi: 'epubcfi(/6/14!/4/2/6/2,/1:0,/1:48)', params: { color: 'green' } });
	expect(parseEpubLocator(`#${cfi}&color=yellow`)).toEqual({ cfi, params: { color: 'yellow' } });
	expect(parseEpubLocator('epubcfi%28/6/4!/4/2/1:0%29&color=red')).toEqual({ cfi: 'epubcfi(/6/4!/4/2/1:0)', params: { color: 'red' } });
	expect(parseEpubLocator('OPS/ch1.xhtml#p3')).toEqual({ href: 'OPS/ch1.xhtml#p3', params: {} });
	expect(parseEpubLocator('epubcfi(/6/4[a^)b]!/4/2/1:0)').cfi).toBe('epubcfi(/6/4[a^)b]!/4/2/1:0)');
});

test('point CFIs and hrefs are positions, range CFIs highlights', () => {
	expect(cfiScheme.isRange!('epubcfi(/6/4!/4/2,/1:0,/1:5)')).toBe(true);
	expect(cfiScheme.isRange!('epubcfi(/6/4!/4/2/1:0)')).toBe(false);
	expect(hrefScheme.isRange).toBeUndefined();
	expect(parseEpubLocator(':~:text=a&color=red')).toEqual({ textFragment: ':~:text=a', params: { color: 'red' } });
});
