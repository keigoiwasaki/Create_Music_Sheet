export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface OmrSheetData {
  /** Pixel size of the page image Audiveris analyzed (matches the rasterized PDF page). */
  pageWidth: number
  pageHeight: number
  /** Union bounding box of each chord's noteheads, ordered measure → voice(asc) → time — matching MusicXML note order. */
  chordBoxes: Rect[]
}

export function directChild(el: Element, tagName: string): Element | null {
  for (const child of Array.from(el.children)) {
    if (child.tagName === tagName) return child
  }
  return null
}

export function directChildren(el: Element, tagName: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tagName)
}

function unionRects(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * Parses one sheet#N.xml from an Audiveris .omr book file. Reconstructs, per measure and per
 * voice (in the same order Audiveris's MusicXML exporter walks them), the pixel bounding box of
 * each chord's noteheads on the original page image — using the same head/chord/containment
 * graph the OMR engine itself uses, not a re-engraved layout.
 */
export function parseOmrSheet(xmlText: string): OmrSheetData {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')

  const picture = doc.getElementsByTagName('picture')[0]
  const pageWidth = Number(picture?.getAttribute('width') ?? 0)
  const pageHeight = Number(picture?.getAttribute('height') ?? 0)

  const headsById = new Map<string, Rect>()
  for (const head of Array.from(doc.getElementsByTagName('head'))) {
    const id = head.getAttribute('id')
    const bounds = directChild(head, 'bounds')
    if (!id || !bounds) continue
    headsById.set(id, {
      x: Number(bounds.getAttribute('x')),
      y: Number(bounds.getAttribute('y')),
      w: Number(bounds.getAttribute('w')),
      h: Number(bounds.getAttribute('h')),
    })
  }

  const chordToHeadIds = new Map<string, string[]>()
  for (const relation of Array.from(doc.getElementsByTagName('relation'))) {
    if (!directChild(relation, 'containment')) continue
    const source = relation.getAttribute('source')
    const target = relation.getAttribute('target')
    if (!source || !target || !headsById.has(target)) continue
    const list = chordToHeadIds.get(source)
    if (list) list.push(target)
    else chordToHeadIds.set(source, [target])
  }

  const chordBoxes: Rect[] = []
  for (const measure of Array.from(doc.getElementsByTagName('measure'))) {
    const voices = directChildren(measure, 'voice').sort(
      (a, b) => Number(a.getAttribute('id') ?? 0) - Number(b.getAttribute('id') ?? 0)
    )
    for (const voice of voices) {
      for (const entry of Array.from(voice.getElementsByTagName('entry'))) {
        const value = directChild(entry, 'value')
        if (!value || value.getAttribute('status') !== 'BEGIN') continue
        const chordId = value.getAttribute('chord')
        const headIds = chordId ? chordToHeadIds.get(chordId) : undefined
        if (!headIds || headIds.length === 0) continue
        chordBoxes.push(unionRects(headIds.map((id) => headsById.get(id)!)))
      }
    }
  }

  return { pageWidth, pageHeight, chordBoxes }
}
