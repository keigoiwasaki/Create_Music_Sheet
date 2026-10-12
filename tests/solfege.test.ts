import { describe, expect, it } from 'vitest'
import { pitchToSolfege, solfegeForPitchClass } from '../src/renderer/solfege'

describe('pitchToSolfege', () => {
  it('maps natural pitch classes to katakana fixed-do names', () => {
    expect(pitchToSolfege(0, 0)).toBe('ド')
    expect(pitchToSolfege(2, 0)).toBe('レ')
    expect(pitchToSolfege(4, 0)).toBe('ミ')
    expect(pitchToSolfege(5, 0)).toBe('ファ')
    expect(pitchToSolfege(7, 0)).toBe('ソ')
    expect(pitchToSolfege(9, 0)).toBe('ラ')
    expect(pitchToSolfege(11, 0)).toBe('シ')
  })

  it('appends sharp markers for positive accidental half-tones', () => {
    expect(pitchToSolfege(0, 1)).toBe('ド#')
    expect(pitchToSolfege(5, 2)).toBe('ファ##')
  })

  it('appends flat markers for negative accidental half-tones', () => {
    expect(pitchToSolfege(2, -1)).toBe('レ♭')
    expect(pitchToSolfege(11, -2)).toBe('シ♭♭')
  })

  it('throws for an unknown fundamental note value', () => {
    expect(() => pitchToSolfege(1, 0)).toThrow()
  })
})

describe('solfegeForPitchClass', () => {
  it('maps the 12 chromatic semitones using sharps only', () => {
    expect(['ド', 'ド#', 'レ', 'レ#', 'ミ', 'ファ', 'ファ#', 'ソ', 'ソ#', 'ラ', 'ラ#', 'シ']).toEqual(
      Array.from({ length: 12 }, (_, i) => solfegeForPitchClass(i))
    )
  })

  it('wraps any MIDI note number to its pitch class', () => {
    expect(solfegeForPitchClass(60)).toBe('ド') // C4
    expect(solfegeForPitchClass(61)).toBe('ド#') // C#4
    expect(solfegeForPitchClass(-1)).toBe('シ') // B-1, wraps to pitch class 11
  })

  it('transposing by +2 semitones turns ド into レ, matching a whole-step key change', () => {
    expect(solfegeForPitchClass(0 + 2)).toBe('レ')
  })
})
