// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseOmrSheet } from '../src/renderer/omr-sheet'

/** A minimal but structurally-real sheet#N.xml: one page, two chords across two measures. */
function buildSheetXml(): string {
  return `<?xml version="1.0"?>
<sheet last-persistent-id="1">
  <picture width="900" height="1200"/>
  <sig>
    <head id="10" shape="NOTEHEAD_BLACK" staff="1"><bounds x="50" y="130" w="26" h="21"/></head>
    <head id="11" shape="NOTEHEAD_BLACK" staff="3"><bounds x="50" y="630" w="26" h="21"/></head>
    <relation source="20" target="10"><containment/></relation>
    <relation source="21" target="11"><containment/></relation>
    <head-chord id="20" staff="1"><bounds x="50" y="130" w="26" h="21"/></head-chord>
    <head-chord id="21" staff="3"><bounds x="50" y="630" w="26" h="21"/></head-chord>
  </sig>
  <measures>
    <measure id="1">
      <voice id="1">
        <slots>
          <entry><key>1</key><value chord="20" status="BEGIN"/></entry>
        </slots>
      </voice>
    </measure>
    <measure id="2">
      <voice id="1">
        <slots>
          <entry><key>1</key><value chord="21" status="BEGIN"/></entry>
        </slots>
      </voice>
    </measure>
  </measures>
</sheet>`
}

describe('parseOmrSheet', () => {
  it('extracts page size and chord boxes', () => {
    const result = parseOmrSheet(buildSheetXml())
    expect(result.pageWidth).toBe(900)
    expect(result.pageHeight).toBe(1200)
    expect(result.chordBoxes).toHaveLength(2)
    expect(result.chordBoxes[0]).toEqual({ x: 50, y: 130, w: 26, h: 21 })
    expect(result.chordBoxes[1]).toEqual({ x: 50, y: 630, w: 26, h: 21 })
  })
})
