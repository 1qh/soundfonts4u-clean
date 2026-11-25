const FILLER = new Set(['a', 'an', 'and', 'of', 'the', 'with'])
const CAMEL_BOUNDARY = /(?<lower>[a-z])(?<upper>[A-Z])/gv
const NON_LETTERS = /[^A-Za-z]+/gv
const splitWords = (raw: string): string[] =>
  raw
    .replaceAll(CAMEL_BOUNDARY, '$<lower> $<upper>')
    .replaceAll(NON_LETTERS, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 0 && !FILLER.has(w.toLowerCase()))
const NON_ALPHANUMERIC = /[^A-Za-z0-9]+/gv
const spacedWords = (raw: string): string =>
  raw.replaceAll(CAMEL_BOUNDARY, '$<lower> $<upper>').replaceAll(NON_ALPHANUMERIC, ' ').trim()
export { spacedWords, splitWords }
