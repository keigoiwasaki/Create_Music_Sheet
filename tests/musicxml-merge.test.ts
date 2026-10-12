import { describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import type { Element } from '@xmldom/xmldom'
import { mergePageXmlTexts } from '../src/main/musicxml-merge'

function page(partsXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">${partsXml}</score-partwise>`
}

function part(id: string, measuresXml: string): string {
  return `<part id="${id}">${measuresXml}</part>`
}

function measure(noteStep: string): string {
  return `<measure number="1"><note><pitch><step>${noteStep}</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note></measure>`
}

describe('mergePageXmlTexts', () => {
  it('merges two pages with matching part ids — measure count sums, numbers renumbered continuously', () => {
    const page1 = page(part('P1', measure('C') + measure('D')))
    const page2 = page(part('P1', measure('E')))

    const merged = mergePageXmlTexts([page1, page2])
    const doc = new DOMParser().parseFromString(merged, 'application/xml')
    const measures = Array.from(doc.getElementsByTagName('measure'))

    expect(measures).toHaveLength(3)
    expect(measures.map((m) => m.getAttribute('number'))).toEqual(['1', '2', '3'])
    const steps = measures.map((m) => m.getElementsByTagName('step')[0].textContent)
    expect(steps).toEqual(['C', 'D', 'E'])
  })

  it('marks the first measure of a later page with <print new-page="yes">', () => {
    const page1 = page(part('P1', measure('C')))
    const page2 = page(part('P1', measure('D') + measure('E')))

    const merged = mergePageXmlTexts([page1, page2])
    const doc = new DOMParser().parseFromString(merged, 'application/xml')
    const measures = Array.from(doc.getElementsByTagName('measure'))

    expect(measures[0].getElementsByTagName('print')).toHaveLength(0)
    const print1 = measures[1].getElementsByTagName('print')
    expect(print1).toHaveLength(1)
    expect(print1[0].getAttribute('new-page')).toBe('yes')
    expect(measures[2].getElementsByTagName('print')).toHaveLength(0)
  })

  it('discards a part id that only appears on a later page, never splicing it in mid-document', () => {
    const page1 = page(part('P1', measure('C')))
    const page2 = page(part('P1', measure('D')) + part('P2', measure('G')))

    const merged = mergePageXmlTexts([page1, page2])
    const doc = new DOMParser().parseFromString(merged, 'application/xml')
    const parts = Array.from(doc.getElementsByTagName('part'))

    expect(parts).toHaveLength(1) // P2 discarded, not spliced in
    expect(parts[0].getAttribute('id')).toBe('P1')
  })

  it('pads a part missing from a page with empty measures, keeping all parts measure-count-aligned', () => {
    const page1 = page(part('P1', measure('C')) + part('P2', measure('E')))
    // page 2: P1 has 2 measures, P2 is completely missing (recognition failed to detect that staff)
    const page2 = page(part('P1', measure('D') + measure('F')))

    const merged = mergePageXmlTexts([page1, page2])
    const doc = new DOMParser().parseFromString(merged, 'application/xml')
    const parts = Array.from(doc.getElementsByTagName('part'))

    expect(parts).toHaveLength(2)
    const p1Measures = Array.from(parts[0].getElementsByTagName('measure'))
    const p2Measures = Array.from(parts[1].getElementsByTagName('measure'))

    // both parts end up with the same measure COUNT (1 from page1 + 2 from page2 = 3 each)
    expect(p1Measures).toHaveLength(3)
    expect(p2Measures).toHaveLength(3)
    // P2's page-2 measures are empty placeholders (no notes), not dropped entirely
    expect(p2Measures[1].getElementsByTagName('note')).toHaveLength(0)
    expect(p2Measures[2].getElementsByTagName('note')).toHaveLength(0)
  })

  it('returns the single page unchanged (renumbered) when only one page is given', () => {
    const only = page(part('P1', measure('C') + measure('D')))
    const merged = mergePageXmlTexts([only])
    const doc = new DOMParser().parseFromString(merged, 'application/xml')
    expect(Array.from(doc.getElementsByTagName('measure'))).toHaveLength(2)
  })

  it('inserts a missing <staves> declaration into the FIRST attributes block, not a later one', () => {
    // Mirrors a real homr quirk: <staff> tags on notes are correct, and <staves> is present
    // elsewhere in later measures, but NEVER in measure 1 at all — and when it reconstructs a
    // single combined block, <divisions> and <key>/<time>/<clef> arrive split across two separate
    // <attributes> elements (itself schema-valid). Confirmed by directly testing against OSMD:
    // putting <staves> in the second (clef-bearing) block renders fine as XML but OSMD silently
    // falls back to one staff anyway — it must land in the FIRST block, alongside <divisions>.
    const measuresXml = `
      <measure number="1">
        <attributes>
          <divisions>2</divisions>
        </attributes>
        <attributes>
          <key><fifths>0</fifths></key>
          <time><beats>4</beats><beat-type>4</beat-type></time>
          <clef number="1"><sign>G</sign><line>2</line></clef>
          <clef number="2"><sign>F</sign><line>4</line></clef>
        </attributes>
        <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type><staff>1</staff></note>
        <backup><duration>2</duration></backup>
        <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><type>quarter</type><staff>2</staff></note>
      </measure>
    `
    const merged = mergePageXmlTexts([page(part('P1', measuresXml))])
    const doc = new DOMParser().parseFromString(merged, 'application/xml')
    const attributesBlocks = Array.from(doc.getElementsByTagName('attributes'))
    expect(attributesBlocks).toHaveLength(2)

    const staves = attributesBlocks[0].getElementsByTagName('staves')
    expect(staves).toHaveLength(1)
    expect(staves[0].textContent).toBe('2')
    expect(attributesBlocks[1].getElementsByTagName('staves')).toHaveLength(0) // not duplicated into the second block

    // must sit right after <divisions> (the only thing preceding it in this block) per schema order
    const firstBlockChildren = Array.from(attributesBlocks[0].childNodes)
      .filter((n) => n.nodeType === 1)
      .map((n) => (n as Element).tagName)
    expect(firstBlockChildren).toEqual(['divisions', 'staves'])
  })

  it('does not add <staves> when a part only ever uses staff 1 (or no staff tags at all)', () => {
    const merged = mergePageXmlTexts([page(part('P1', measure('C')))])
    const doc = new DOMParser().parseFromString(merged, 'application/xml')
    expect(doc.getElementsByTagName('staves')).toHaveLength(0)
  })

  it('leaves an already-correct <staves> declaration untouched', () => {
    const measuresXml = `
      <measure number="1">
        <attributes>
          <staves>2</staves>
        </attributes>
        <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><staff>1</staff></note>
        <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type><staff>2</staff></note>
      </measure>
    `
    const merged = mergePageXmlTexts([page(part('P1', measuresXml))])
    const doc = new DOMParser().parseFromString(merged, 'application/xml')
    expect(doc.getElementsByTagName('staves')).toHaveLength(1)
  })
})
