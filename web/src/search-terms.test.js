import { expect, test } from 'bun:test';
import { searchTerms } from './search-terms.js';

test('the words of a search, without its filters', () => {
  expect(searchTerms('Compost tea')).toEqual(['compost', 'tea']);
  expect(searchTerms('in:Garden #tools is:todo compost')).toEqual(['compost']);
  expect(searchTerms('IN:"My Notes/Home" IS:TODO #a/b soil')).toEqual(['soil']);
  expect(searchTerms('#tools')).toEqual([]);
  expect(searchTerms('')).toEqual([]);
  expect(searchTerms(undefined)).toEqual([]);
});

test('terms are unique, a letter alone is skipped, and anything that isn’t a whole filter stays a word', () => {
  expect(searchTerms('soil Soil SOIL a')).toEqual(['soil']);
  expect(searchTerms('École élève')).toEqual(['école', 'élève']);
  expect(searchTerms('in: is:done foo#bar')).toEqual(['in', 'is', 'done', 'foo', 'bar']);
});
