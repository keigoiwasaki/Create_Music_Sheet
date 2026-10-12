import { describe, expect, it } from 'vitest'
import { chordEventsToRollNotes } from '../src/renderer/piano-roll'

const events = [{ time: 0, duration: 1, midiNotes: [60], pitches: ['ド'], staff: 1 }]

describe('chordEventsToRollNotes', () => {
  it('passes through pitch and label unchanged with no transpose', () => {
    const [note] = chordEventsToRollNotes(events)
    expect(note.midi).toBe(60)
    expect(note.label).toBe('ド')
  })

  it('shifts both the MIDI pitch and the label together under a key change', () => {
    const [note] = chordEventsToRollNotes(events, 1, 2)
    expect(note.midi).toBe(62)
    expect(note.label).toBe('レ')
  })

  it('divides time/duration by speed independently of transpose', () => {
    const [note] = chordEventsToRollNotes(events, 2, -1)
    expect(note.time).toBe(0)
    expect(note.duration).toBe(0.5)
    expect(note.midi).toBe(59)
    expect(note.label).toBe('シ')
  })
})
