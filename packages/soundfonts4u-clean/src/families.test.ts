import { describe, expect, test } from 'bun:test'
import { keywordFamilies } from './families.js'
const cases: { name: string; title: string; want: string }[] = [
  { name: 'DreamyEP', title: 'an electric piano glued to an adjective', want: 'EPiano' },
  { name: 'BigRoom', title: 'a drum room glued to an adjective', want: 'Drums' },
  { name: 'ChamberStr', title: 'a strings abbreviation glued to a word', want: 'Strings' },
  { name: 'TwinLP', title: 'a guitar model glued to a word', want: 'EGuitar' },
  { name: 'TR-909', title: 'a drum machine written with a dash', want: 'Drums' },
  { name: 'E.Piano 1', title: 'an electric piano written with a dot', want: 'EPiano' },
  { name: 'DynC5', title: 'a piano model with a digit glued to a word', want: 'Piano' },
  { name: 'S&S Bright', title: 'a piano maker written with an ampersand', want: 'Piano' }
]
describe('keywordFamilies', () => {
  test.each(cases)('$title', ({ name, want }) => {
    expect(keywordFamilies(name)).toContain(want)
  })
  test('offers every family a name matches so none is chosen by keyword order', () => {
    expect(keywordFamilies('Steel Drums').toSorted()).toStrictEqual(['Acoustic', 'Drums', 'Mallets'])
  })
  test('does not read a plain word as an electric piano', () => {
    expect(keywordFamilies('Tone Piano')).not.toContain('EPiano')
  })
})
