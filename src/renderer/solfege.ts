/**
 * Fixed-do (固定ド) pitch-class to katakana solfège mapping.
 * Keys are semitone values matching OSMD's Pitch.NoteEnum (C=0, D=2, E=4, F=5, G=7, A=9, B=11).
 */
const BASE_SOLFEGE: Record<number, string> = {
  0: 'ド',
  2: 'レ',
  4: 'ミ',
  5: 'ファ',
  7: 'ソ',
  9: 'ラ',
  11: 'シ',
}

/**
 * @param fundamentalNote NoteEnum value of the natural pitch class (0,2,4,5,7,9,11)
 * @param accidentalHalfTones half-tone offset from the accidental (+1 sharp, -1 flat, 0 natural, etc.)
 */
export function pitchToSolfege(fundamentalNote: number, accidentalHalfTones: number): string {
  const base = BASE_SOLFEGE[fundamentalNote]
  if (base === undefined) {
    throw new Error(`Unknown fundamental note value: ${fundamentalNote}`)
  }
  if (accidentalHalfTones > 0) {
    return base + '#'.repeat(accidentalHalfTones)
  }
  if (accidentalHalfTones < 0) {
    return base + '♭'.repeat(-accidentalHalfTones)
  }
  return base
}

const NATURAL_SEMITONES = [0, 2, 4, 5, 7, 9, 11]

/**
 * Solfège for a raw semitone value (any MIDI note, or just a 0-11 pitch class) with no inherent
 * "spelling" to preserve — e.g. after transposing. Always spells black keys with '#' (never '♭'),
 * since there's no key signature context to decide which is more natural.
 */
export function solfegeForPitchClass(semitone: number): string {
  const pitchClass = ((semitone % 12) + 12) % 12
  let fundamental = NATURAL_SEMITONES[0]
  for (const n of NATURAL_SEMITONES) if (n <= pitchClass) fundamental = n
  return pitchToSolfege(fundamental, pitchClass - fundamental)
}
