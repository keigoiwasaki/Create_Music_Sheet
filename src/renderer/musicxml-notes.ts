import { pitchToSolfege } from './solfege'

const STEP_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const DEFAULT_TEMPO_BPM = 120

export interface ChordEvent {
  /** Solfège syllables, highest pitch first. */
  pitches: string[]
  /** MIDI note numbers, same order as `pitches` (69 = A4). */
  midiNotes: number[]
  /** Seconds from the start of the piece. */
  time: number
  /** Seconds this chord/note sounds for. */
  duration: number
  /**
   * 1 = top staff (typically right hand on a piano grand staff), 2+ = lower staff. Comes from the
   * MusicXML `<staff>` tag when present; when a piece instead uses two separate `<part>` elements
   * for the two hands (equally common, and indistinguishable from a single annotated staff without
   * this fallback), the part's own 1-indexed position stands in for it — see `parseMusicXmlEvents`.
   */
  staff: number | null
  /**
   * 1-indexed page number, from MusicXML's own `<print new-page="yes">` markers (page 1 before
   * the first one). This is Audiveris's own authoritative page layout, independent of how many
   * chords its separate `.omr` position-data file reports per page — the two can disagree when
   * OMR partially fails to recognize a system (producing, say, an unexpectedly empty measure),
   * and aligning by this instead of by assuming the two counts match per page is what keeps the
   * ドレミ labels (parseOmrSheet's chordBoxes, matched per page) from drifting onto the wrong
   * notes, or going missing entirely, once such a mismatch happens anywhere before the last page.
   */
  page: number
}

function directChild(el: Element, tagName: string): Element | null {
  for (const child of Array.from(el.children)) {
    if (child.tagName === tagName) return child
  }
  return null
}

interface GroupItem {
  solfege: string
  midi: number
  height: number
}

interface Timing {
  time: number
  duration: number
  staff: number | null
  page: number
}

interface MeasureEvents {
  groups: GroupItem[][]
  timings: Timing[]
}

/**
 * Ordered chord/note events across the whole piece, skipping rests. A run of `<note><chord/></note>`
 * siblings collapses into one event (pitches highest first) — the same grouping/order Audiveris's
 * own sheet model uses, so this lines up with parseOmrSheet's chordBoxes (matched per page via
 * `.page`). Each event also carries its timing (assuming a single tempo for the whole piece — the
 * first `<sound tempo>` found, or 120bpm — so mid-piece tempo changes aren't reflected), used for
 * both audio playback and highlighting the currently-playing label.
 *
 * A piano piece can come out of Audiveris as ONE `<part>` with two `<staff>`-tagged voices, or as
 * TWO SEPARATE `<part>` elements with no `<staff>` tag at all — both are valid, roughly equally
 * common MusicXML shapes for a grand staff, and this handles both.
 *
 * For the two-part shape, all parts are walked in LOCKSTEP, one measure index at a time, instead of
 * each part accumulating its own time cursor independently from start to finish. Two things depend
 * on this:
 *
 * 1. Timing sync. Measure N of every part represents the *same instant* in the piece by definition
 *    (that's what makes them the same piece, notated on separate staves) — but each part's note
 *    durations are OMR output, not ground truth, and the two parts' durations for "the same" measure
 *    don't always sum to exactly the same length (a misread dotted rhythm, a dropped or extra rest —
 *    ordinary OMR noise). Letting each part's cursor run on its own duration sum compounds that noise
 *    measure after measure, so one part (often the accompaniment) gradually drifts ahead of or behind
 *    the other over the piece, even though each individual measure's error is tiny. Resyncing both
 *    parts to a single shared cursor at every measure boundary — advancing it by whichever part
 *    reached furthest in that measure, the same `measureMaxSeconds` rule already used to contain a
 *    single bad measure within one part — stops that per-measure noise from ever accumulating.
 * 2. Label order. This also has to match parseOmrSheet's chordBoxes order exactly, and that order
 *    comes from the `.omr` book file's own hierarchy: within each `<system>`, Audiveris nests ALL of
 *    one `<part>`'s measures before the next `<part>`'s — a whole system's worth of top-staff
 *    measures, then that same system's bottom-staff measures, not one measure at a time. So events
 *    are grouped into per-part, per-system buckets (a system boundary is a measure whose `<print>`
 *    child carries `new-system="yes"` or `new-page="yes"` — a new page always starts a new system
 *    too) and emitted system-by-system, part-by-part within each system — independent of the timing
 *    pass above, which only decides each event's `.time`.
 */
/** The single tempo (first `<sound tempo>` found, or 120bpm) this whole module assumes for the
 * piece. Exported so any OTHER code deriving timing from the same MusicXML — e.g. `score-view.ts`
 * computing highlight timing straight from OSMD's own parsed structure — uses the exact same value,
 * rather than risking two independently-detected tempos drifting apart. */
export function getTempoBpm(xmlText: string): number {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const tempoAttr = doc.querySelector('sound[tempo]')?.getAttribute('tempo')
  return tempoAttr ? Number(tempoAttr) : DEFAULT_TEMPO_BPM
}

export function parseMusicXmlEvents(xmlText: string): ChordEvent[] {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const tempo = getTempoBpm(xmlText)

  const parts = Array.from(doc.getElementsByTagName('part'))
  const partMeasureLists = parts.map((part) => Array.from(part.children).filter((c) => c.tagName === 'measure'))
  const maxMeasureCount = partMeasureLists.reduce((max, list) => Math.max(max, list.length), 0)

  const divisionsPerPart = parts.map(() => 1)
  const perPartSystems: MeasureEvents[][] = parts.map(() => [])
  const currentSystemPerPart: MeasureEvents[] = parts.map(() => ({ groups: [], timings: [] }))

  // Shared across every part — see point 1 in the doc comment above.
  let measureStartSeconds = 0
  let currentPage = 1

  for (let measureIndex = 0; measureIndex < maxMeasureCount; measureIndex++) {
    let startsNewSystem = false
    let startsNewPage = false
    for (let p = 0; p < parts.length; p++) {
      const printEl = partMeasureLists[p][measureIndex] && directChild(partMeasureLists[p][measureIndex], 'print')
      if (printEl?.getAttribute('new-page') === 'yes') startsNewPage = true
      if (printEl?.getAttribute('new-page') === 'yes' || printEl?.getAttribute('new-system') === 'yes') startsNewSystem = true
    }
    if (startsNewSystem) {
      for (let p = 0; p < parts.length; p++) {
        if (currentSystemPerPart[p].groups.length > 0) {
          perPartSystems[p].push(currentSystemPerPart[p])
          currentSystemPerPart[p] = { groups: [], timings: [] }
        }
      }
    }
    if (startsNewPage) currentPage++

    let measureMaxSecondsGlobal = measureStartSeconds

    for (let p = 0; p < parts.length; p++) {
      const measure = partMeasureLists[p][measureIndex]
      if (!measure) continue

      let cursorSeconds = measureStartSeconds
      let measureMaxSeconds = measureStartSeconds
      let groupStartSeconds = 0
      const groups: GroupItem[][] = []
      const timings: Timing[] = []

      for (const el of Array.from(measure.children)) {
        if (el.tagName === 'attributes') {
          const divisionsText = directChild(el, 'divisions')?.textContent
          if (divisionsText) divisionsPerPart[p] = Number(divisionsText) || 1
        } else if (el.tagName === 'backup') {
          const duration = Number(directChild(el, 'duration')?.textContent ?? '0')
          cursorSeconds -= duration * (60 / tempo / divisionsPerPart[p])
        } else if (el.tagName === 'forward') {
          const duration = Number(directChild(el, 'duration')?.textContent ?? '0')
          cursorSeconds += duration * (60 / tempo / divisionsPerPart[p])
          measureMaxSeconds = Math.max(measureMaxSeconds, cursorSeconds)
        } else if (el.tagName === 'note') {
          const isChord = !!directChild(el, 'chord')
          const duration = Number(directChild(el, 'duration')?.textContent ?? '0')
          const secondsPerDivision = 60 / tempo / divisionsPerPart[p]
          const durationSeconds = Math.max(duration, 1) * secondsPerDivision

          if (!isChord) groupStartSeconds = cursorSeconds

          if (!directChild(el, 'rest')) {
            const pitchEl = directChild(el, 'pitch')
            const step = pitchEl && directChild(pitchEl, 'step')?.textContent
            if (pitchEl && step && step in STEP_SEMITONE) {
              const octave = Number(directChild(pitchEl, 'octave')?.textContent ?? '4')
              const alter = Number(directChild(pitchEl, 'alter')?.textContent ?? '0')
              const item: GroupItem = {
                solfege: pitchToSolfege(STEP_SEMITONE[step], alter),
                midi: 12 * (octave + 1) + STEP_SEMITONE[step] + alter,
                height: STEP_SEMITONE[step] + alter + octave * 12,
              }
              const time = Math.max(0, groupStartSeconds)
              const staffText = directChild(el, 'staff')?.textContent
              // Falls back to this note's PART index (1 = first part) only when the XML has no
              // <staff> tag at all — a part-per-hand export never has one, since <staff> is how a
              // single part distinguishes multiple staves, not how separate parts are told apart.
              const staff = staffText ? Number(staffText) : parts.length > 1 ? p + 1 : null

              if (isChord && groups.length > 0) {
                groups[groups.length - 1].push(item)
                timings[timings.length - 1].duration = Math.max(timings[timings.length - 1].duration, durationSeconds)
              } else {
                groups.push([item])
                timings.push({ time, duration: durationSeconds, staff, page: currentPage })
              }
            }
          }

          if (!isChord) {
            cursorSeconds += duration * secondsPerDivision
            measureMaxSeconds = Math.max(measureMaxSeconds, cursorSeconds)
          }
        }
      }

      measureMaxSecondsGlobal = Math.max(measureMaxSecondsGlobal, measureMaxSeconds)
      currentSystemPerPart[p].groups.push(...groups)
      currentSystemPerPart[p].timings.push(...timings)
    }

    measureStartSeconds = measureMaxSecondsGlobal
  }

  for (let p = 0; p < parts.length; p++) {
    if (currentSystemPerPart[p].groups.length > 0) perPartSystems[p].push(currentSystemPerPart[p])
  }

  const maxSystemCount = perPartSystems.reduce((max, systems) => Math.max(max, systems.length), 0)
  const groups: GroupItem[][] = []
  const timings: Timing[] = []
  for (let systemIndex = 0; systemIndex < maxSystemCount; systemIndex++) {
    for (const partSystems of perPartSystems) {
      const system = partSystems[systemIndex]
      if (!system) continue
      groups.push(...system.groups)
      timings.push(...system.timings)
    }
  }

  return groups.map((items, index) => {
    const sorted = [...items].sort((a, b) => b.height - a.height) // highest pitch first, top-to-bottom reading order
    return {
      pitches: sorted.map((item) => item.solfege),
      midiNotes: sorted.map((item) => item.midi),
      time: timings[index].time,
      duration: timings[index].duration,
      staff: timings[index].staff,
      page: timings[index].page,
    }
  })
}
