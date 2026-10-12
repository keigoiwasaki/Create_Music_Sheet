// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseMusicXmlEvents } from '../src/renderer/musicxml-notes'

function wrapPart(measuresXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">${measuresXml}</part>
</score-partwise>`
}

function wrapTwoParts(part1MeasuresXml: string, part2MeasuresXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>P1</part-name></score-part>
    <score-part id="P2"><part-name>P2</part-name></score-part>
  </part-list>
  <part id="P1">${part1MeasuresXml}</part>
  <part id="P2">${part2MeasuresXml}</part>
</score-partwise>`
}

describe('parseMusicXmlEvents timing', () => {
  it('advances time correctly within a single divisions value', () => {
    const xml = wrapPart(`
      <measure number="1">
        <attributes><divisions>4</divisions><sound tempo="60"/></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      </measure>
    `)
    const events = parseMusicXmlEvents(xml)
    expect(events).toHaveLength(2)
    // divisions=4, tempo=60 -> 1 second per quarter note (duration=4 ticks)
    expect(events[0].time).toBeCloseTo(0)
    expect(events[1].time).toBeCloseTo(1)
  })

  it('does not corrupt timing when divisions changes between measures (e.g. at a page boundary)', () => {
    const xml = wrapPart(`
      <measure number="1">
        <attributes><divisions>4</divisions><sound tempo="60"/></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      </measure>
      <measure number="2">
        <attributes><divisions>16</divisions></attributes>
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>16</duration><type>quarter</type></note>
        <note><pitch><step>F</step><octave>4</octave></pitch><duration>16</duration><type>quarter</type></note>
      </measure>
    `)
    const events = parseMusicXmlEvents(xml)
    expect(events).toHaveLength(4)

    // Before the fix, converting an accumulated raw-tick cursor with the *new* divisions (16
    // instead of 4) at the moment of use would have rescaled measure 1's ticks too, e.g. turning
    // an expected time of 2s into 2 * (4/16) = 0.5s -- collapsing note 3 backwards past note 2.
    const times = events.map((e) => e.time)
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1])
    }

    // Each quarter note is still exactly 1 second (tempo=60), regardless of divisions.
    expect(times[0]).toBeCloseTo(0)
    expect(times[1]).toBeCloseTo(1)
    expect(times[2]).toBeCloseTo(2)
    expect(times[3]).toBeCloseTo(3)
  })

  it('handles a chord (grouped notes) and backup/forward without producing negative times', () => {
    const xml = wrapPart(`
      <measure number="1">
        <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
        <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
        <backup><duration>2</duration></backup>
        <note><pitch><step>G</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
    `)
    const events = parseMusicXmlEvents(xml)
    expect(events).toHaveLength(2)
    expect(events[0].pitches).toEqual(['ミ', 'ド']) // highest pitch first
    expect(events[0].time).toBeCloseTo(0)
    expect(events[1].time).toBeGreaterThanOrEqual(0)
  })

  it('contains a single empty measure (e.g. a lost system/page in OMR) instead of collapsing every later measure onto one instant', () => {
    // Reproduces a real Audiveris failure: a measure Audiveris couldn't recognize at all comes
    // out as a totally empty <measure>, with no notes and no whole-measure rest. Before the fix,
    // the cursor carried the *previous* measure's end value (now permanently stale) into every
    // measure after it forever, since nothing in the empty measure ever advanced it — collapsing
    // the entire rest of the piece onto the same instant.
    const xml = wrapPart(`
      <measure number="1">
        <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
      <measure number="2"></measure>
      <measure number="3">
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
        <note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
    `)
    const events = parseMusicXmlEvents(xml)
    expect(events).toHaveLength(4)
    const times = events.map((e) => e.time)
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1])
    }
    // Measure 3 should pick up right where measure 1 left off (measure 2 contributed nothing),
    // not snap back to measure 1's own start.
    expect(times[2]).toBeCloseTo(1)
    expect(times[3]).toBeCloseTo(1.5)
  })

  it('keeps a bad backup/forward mismatch in one measure from throwing off every measure after it', () => {
    // A backup larger than anything actually advanced in that voice (a plausible OMR misread of
    // a duration) used to leave the cursor permanently behind — every later measure inherited the
    // broken value instead of the measure actually ending where its correct voice placed it.
    const xml = wrapPart(`
      <measure number="1">
        <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
        <backup><duration>100</duration></backup>
        <note><pitch><step>G</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
      <measure number="2">
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
    `)
    const events = parseMusicXmlEvents(xml)
    expect(events).toHaveLength(3)
    // Measure 2's note should follow measure 1's correct (furthest-reached) end, not the
    // corrupted backup result.
    expect(events[2].time).toBeCloseTo(0.5)
  })

  it('assigns a page number from <print new-page="yes"> markers, defaulting to page 1', () => {
    const xml = wrapPart(`
      <measure number="1">
        <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
      <measure number="2">
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
      <measure number="3">
        <print new-page="yes"/>
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
    `)
    const events = parseMusicXmlEvents(xml)
    expect(events.map((e) => e.page)).toEqual([1, 1, 2])
  })

  it('keeps a page\'s own chord count independent of later pages, so an OMR mismatch on one page cannot push every later page onto the wrong one', () => {
    // Mirrors the real failure this was built for: Audiveris's own position-data file
    // (parseOmrSheet's chordBoxes) and its MusicXML export can disagree on how many chords are on
    // a page when OMR partially fails to recognize a system — here, page 1's XML "lost" a note
    // that OMR's own sheet model still counted. Sequentially slicing chordEvents by an assumed
    // per-page count would push page 2's notes one slot early and keep them wrong for every page
    // after it; grouping by the page's own <print new-page> marker instead keeps page 2 correct
    // regardless of what happened on page 1.
    const xml = wrapPart(`
      <measure number="1">
        <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
      <measure number="2">
        <print new-page="yes"/>
        <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      </measure>
    `)
    const events = parseMusicXmlEvents(xml)
    const page2Events = events.filter((e) => e.page === 2)
    expect(page2Events.map((e) => e.pitches[0])).toEqual(['レ', 'ミ'])
  })

  it('tracks which staff (hand) each event belongs to, for piano-roll hand coloring', () => {
    const xml = wrapPart(`
      <measure number="1">
        <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
        <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type><staff>1</staff></note>
        <backup><duration>2</duration></backup>
        <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type><staff>2</staff></note>
      </measure>
    `)
    const events = parseMusicXmlEvents(xml)
    expect(events).toHaveLength(2)
    expect(events[0].staff).toBe(1)
    expect(events[1].staff).toBe(2)
  })

  it('interleaves two separate <part> elements SYSTEM-by-system, not measure-by-measure', () => {
    // A piano piece exported as two parts (one per hand, no <staff> tag) instead of one part with
    // two staves — equally common, and the shape that triggered this bug. parseOmrSheet's chordBoxes
    // follow the `.omr` book file's own hierarchy, which nests a whole SYSTEM's measures under one
    // part before the next part's — not one measure at a time. Here each system spans two measures
    // (the <print new-system="yes"> on measure 3 starts the second system), so the expected order is
    // part 1's measures 1+2, then part 2's measures 1+2, then part 1's measures 3+4, then part 2's.
    const xml = wrapTwoParts(
      `
        <measure number="1">
          <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="3">
          <print new-system="yes"/>
          <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="4">
          <note><pitch><step>F</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
      `,
      `
        <measure number="1">
          <attributes><divisions>2</divisions></attributes>
          <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>D</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="3">
          <print new-system="yes"/>
          <note><pitch><step>E</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="4">
          <note><pitch><step>F</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
      `
    )
    const events = parseMusicXmlEvents(xml)
    // Not ['ド','ド','レ','レ','ミ','ミ','ファ','ファ'] (measure-by-measure) and not
    // ['ド','レ','ミ','ファ','ド','レ','ミ','ファ'] (whole-part-then-whole-part) — system-by-system.
    expect(events.map((e) => e.pitches[0])).toEqual(['ド', 'レ', 'ド', 'レ', 'ミ', 'ファ', 'ミ', 'ファ'])
  })

  it('falls back to the part index as the staff/hand when a two-part export has no <staff> tag', () => {
    const xml = wrapTwoParts(
      `
        <measure number="1">
          <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
      `,
      `
        <measure number="1">
          <attributes><divisions>2</divisions></attributes>
          <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
      `
    )
    const events = parseMusicXmlEvents(xml)
    expect(events).toHaveLength(2)
    expect(events[0].staff).toBe(1)
    expect(events[1].staff).toBe(2)
  })

  it('resyncs a two-part export at every measure boundary instead of letting one part drift ahead', () => {
    // Part 2's measure 1 is missing half its notated duration (an ordinary OMR misread — a dropped
    // rest, a misjudged dotted rhythm). If each part tracked its own cursor independently, part 2's
    // measure 2 note would start wherever part 2's own (short) measure 1 left off — half a second
    // early — instead of where measure 2 actually begins. Resyncing both parts to the furthest either
    // one reached, at every measure boundary, keeps that single bad measure from throwing off every
    // later one — this is what the user reported as "the bottom staff is playing slightly ahead."
    const xml = wrapTwoParts(
      `
        <measure number="1">
          <attributes><divisions>2</divisions><sound tempo="120"/></attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
      `,
      `
        <measure number="1">
          <attributes><divisions>2</divisions></attributes>
          <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
        <measure number="2">
          <note><pitch><step>D</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type></note>
        </measure>
      `
    )
    const events = parseMusicXmlEvents(xml)
    const part2Measure2 = events.find((e) => e.pitches[0] === 'レ' && e.midiNotes[0] < 60)
    expect(part2Measure2?.time).toBeCloseTo(1) // measure 2 starts at t=1 (two quarters at 0.5s each), not 0.5
  })
})
