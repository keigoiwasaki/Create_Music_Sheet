import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { Document, Element } from '@xmldom/xmldom'

function directChildren(el: Element, tagName: string): Element[] {
  const out: Element[] = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i]
    if (child.nodeType === 1 && (child as Element).tagName === tagName) out.push(child as Element)
  }
  return out
}

function directChild(el: Element, tagName: string): Element | null {
  return directChildren(el, tagName)[0] ?? null
}

/** Deep-clones an element (and its attributes/children) into a different Document than the one it
 * currently belongs to. Written by hand rather than relying on `Document.importNode`, whose support
 * in @xmldom/xmldom has had rough edges historically — this is simple enough not to need it. */
function cloneElementInto(targetDoc: Document, source: Element): Element {
  const clone = targetDoc.createElement(source.tagName)
  for (let i = 0; i < source.attributes.length; i++) {
    const attr = source.attributes[i]
    clone.setAttribute(attr.name, attr.value)
  }
  for (let i = 0; i < source.childNodes.length; i++) {
    const child = source.childNodes[i]
    if (child.nodeType === 1) {
      clone.appendChild(cloneElementInto(targetDoc, child as Element))
    } else if (child.nodeType === 3) {
      clone.appendChild(targetDoc.createTextNode(child.nodeValue ?? ''))
    }
  }
  return clone
}

/** Sets (creating if absent) `<print new-page="yes"/>` as the first child of `measure`. */
function markAsPageStart(doc: Document, measure: Element): void {
  let print = directChild(measure, 'print')
  if (!print) {
    print = doc.createElement('print')
    measure.insertBefore(print, measure.firstChild)
  }
  print.setAttribute('new-page', 'yes')
}

/** MusicXML's own schema order for `<attributes>` children that can precede `<staves>` — used to
 * find the correct insertion point within whichever block `<staves>` is added to. */
const PRECEDES_STAVES = new Set(['divisions', 'key', 'time'])

/**
 * Ensures a part whose notes actually span multiple `<staff>` numbers (a two-hand grand staff)
 * declares `<staves>N</staves>` in its attributes — OSMD (and other MusicXML readers) need this to
 * know to render N separate staff systems; without it, a reader has been observed falling back to
 * ONE staff and cramming the other hand's notes onto it with a huge pile of ledger lines instead.
 * homr's own output has been found to omit `<staves>` inconsistently (present for some pieces,
 * absent for others) despite `<staff>` tags on notes being present and correct either way — this
 * patches that gap rather than trusting the source engine to always include it.
 *
 * Critically, this must land in the part's FIRST `<attributes>` block (typically the one holding
 * just `<divisions>`), not a later block that happens to carry the `<clef>` elements — confirmed by
 * direct testing: OSMD silently falls back to a single staff when `<staves>` is only present in a
 * later attributes block, even though that's still schema-valid MusicXML (a measure may legally
 * split its attributes across several `<attributes>` elements).
 */
function ensureStavesDeclared(doc: Document, part: Element): void {
  const measures = directChildren(part, 'measure')
  let maxStaff = 1
  for (const measure of measures) {
    for (const note of directChildren(measure, 'note')) {
      const staffText = directChild(note, 'staff')?.textContent
      const staffNum = staffText ? Number(staffText) : NaN
      if (Number.isFinite(staffNum)) maxStaff = Math.max(maxStaff, staffNum)
    }
  }
  if (maxStaff <= 1) return // single staff — nothing to declare

  const attributesBlocks = measures.flatMap((m) => directChildren(m, 'attributes'))
  if (attributesBlocks.some((a) => directChild(a, 'staves'))) return // already declared somewhere

  const target = attributesBlocks[0]
  if (!target) return

  const stavesEl = doc.createElement('staves')
  stavesEl.appendChild(doc.createTextNode(String(maxStaff)))

  const insertBefore = Array.from(target.childNodes).find(
    (n) => n.nodeType === 1 && !PRECEDES_STAVES.has((n as Element).tagName)
  )
  if (insertBefore) target.insertBefore(stavesEl, insertBefore)
  else target.appendChild(stavesEl)
}

/**
 * Merges per-page MusicXML texts (one OMR engine run per page, for engines with no multi-page/batch
 * mode of their own — e.g. homr, oemer) into a single piece.
 *
 * Page 1 becomes the base document; each part is identified by its `<part id>`. For every later
 * page:
 * - a part whose id already exists in the base document gets that page's `<measure>` elements
 *   appended to it (page-1-first-measure gets `<print new-page="yes">`, matching the convention
 *   `musicxml-notes.ts` already reads elsewhere — though the OSMD fallback path these engines'
 *   results always use doesn't actually need it, since it renders the whole piece as one continuous
 *   flow).
 * - a part id that NEVER appeared on page 1 is discarded (logged, not silently dropped) rather than
 *   spliced into the document — each page is recognized independently, so a part that only shows up
 *   starting midway through the piece has no measure history for earlier pages, which would corrupt
 *   `musicxml-notes.ts`'s lockstep-by-measure-index processing (see its own doc comment) for every
 *   part, not just the new one.
 * - a part that EXISTED on page 1 but wasn't detected on this specific page (the engine missed a
 *   hand/staff) is padded with empty `<measure>` elements — one per measure this page's OTHER parts
 *   gained — so every part's measure COUNT stays aligned across pages. A visibly blank measure where
 *   recognition failed is an honest signal; a silent count mismatch would permanently desync every
 *   part's timing and left/right-hand ordering from that point on.
 *
 * After merging, every part's measures are renumbered with one shared, 1-indexed counter (position
 * in the merged document, not the source engine's own per-page numbering, which restarts at 1 every
 * page).
 */
export function mergePageXmlTexts(xmlTexts: string[]): string {
  if (xmlTexts.length === 0) {
    throw new Error('mergePageXmlTexts: no pages to merge')
  }

  const parser = new DOMParser()
  const baseDoc = parser.parseFromString(xmlTexts[0], 'application/xml')
  const baseParts = Array.from(baseDoc.getElementsByTagName('part')) as Element[]
  const basePartById = new Map(baseParts.map((p) => [p.getAttribute('id'), p]))

  for (let pageIndex = 1; pageIndex < xmlTexts.length; pageIndex++) {
    const pageDoc = parser.parseFromString(xmlTexts[pageIndex], 'application/xml')
    const pageParts = Array.from(pageDoc.getElementsByTagName('part')) as Element[]

    const pageMeasuresById = new Map(pageParts.map((p) => [p.getAttribute('id'), directChildren(p, 'measure')]))
    const measuresThisPage = Math.max(0, ...Array.from(pageMeasuresById.values()).map((m) => m.length))

    for (const pagePart of pageParts) {
      const partId = pagePart.getAttribute('id')
      if (!basePartById.has(partId)) {
        console.warn(`mergePageXmlTexts: page ${pageIndex + 1} introduces unknown part id "${partId}" — discarding`)
      }
    }

    for (const basePart of baseParts) {
      const partId = basePart.getAttribute('id')
      const pageMeasures = pageMeasuresById.get(partId) ?? []
      let isFirstMeasureOfPageForThisPart = true

      for (const measure of pageMeasures) {
        const cloned = cloneElementInto(baseDoc, measure)
        if (isFirstMeasureOfPageForThisPart) {
          markAsPageStart(baseDoc, cloned)
          isFirstMeasureOfPageForThisPart = false
        }
        basePart.appendChild(cloned)
      }
      for (let i = pageMeasures.length; i < measuresThisPage; i++) {
        const empty = baseDoc.createElement('measure')
        if (isFirstMeasureOfPageForThisPart) {
          markAsPageStart(baseDoc, empty)
          isFirstMeasureOfPageForThisPart = false
        }
        basePart.appendChild(empty)
      }
    }
  }

  for (const part of baseParts) {
    directChildren(part, 'measure').forEach((measure, i) => {
      measure.setAttribute('number', String(i + 1))
    })
    ensureStavesDeclared(baseDoc, part)
  }

  return new XMLSerializer().serializeToString(baseDoc)
}
