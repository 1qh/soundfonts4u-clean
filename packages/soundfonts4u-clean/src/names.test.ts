import { describe, expect, test } from 'bun:test'
import { isSourceAbbreviation } from './names.js'
describe('isSourceAbbreviation', () => {
  test.each(['OB', 'JP', 'KG', 'CC', 'DG', 'RF', 'AR', 'SG', 'CP', 'C', 'V'])('drops %s', w => {
    expect(isSourceAbbreviation(w)).toBe(true)
  })
  test.each(['EP', 'FM', 'DX', 'TR', 'SFX', 'Pad', 'Saw', 'Dry', 'Lead'])('keeps %s', w => {
    expect(isSourceAbbreviation(w)).toBe(false)
  })
})
