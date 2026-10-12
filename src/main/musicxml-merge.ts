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
  }

  return new XMLSerializer().serializeToString(baseDoc)
}
