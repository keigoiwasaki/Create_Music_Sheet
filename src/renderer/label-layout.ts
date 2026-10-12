/** A label not yet placed: anchored to a note/chord, but its final tier (distance from the note) is resolved during collision avoidance. */
export interface LabelCandidate {
  /** One or more solfège syllables, highest pitch first. A chord stacks vertically (one per line) instead of joining horizontally, so its footprint stays as narrow as a single note. */
  pitches: string[]
  centerX: number
  placeBelow: boolean
  /** Container-relative y of the edge nearest the note (bottom edge for "above" labels, top edge for "below" labels) at tier 0. */
  anchorY: number
  /** Playback timing (seconds), when known — used to highlight this label while it's sounding. */
  time?: number
  duration?: number
}

/** A candidate's final resolved position, in the same container-relative coordinate space. */
export interface PlacedLabel {
  pitches: string[]
  placeBelow: boolean
  centerX: number
  top: number
  bottom: number
  time?: number
  duration?: number
}

/** Pairs a rendered label element with the playback window during which it should be highlighted. */
export interface HighlightEntry {
  element: HTMLElement
  time: number
  duration: number
}

/** Builds highlight entries from placements + their corresponding rendered elements (same order), dropping any without timing. */
export function buildHighlightEntries(placements: PlacedLabel[], elements: HTMLElement[]): HighlightEntry[] {
  const entries: HighlightEntry[] = []
  placements.forEach((placement, i) => {
    if (placement.time !== undefined && placement.duration !== undefined) {
      entries.push({ element: elements[i], time: placement.time, duration: placement.duration })
    }
  })
  return entries
}

interface PlacedRect {
  left: number
  right: number
  top: number
  bottom: number
}

export const LABEL_FONT_SIZE = 9
export const LABEL_ABOVE_COLOR = '#7c3aed'
export const LABEL_BELOW_COLOR = '#b3541a'
const LABEL_LINE_HEIGHT = 11
const LABEL_TIER_GAP = 1
export const LABEL_NOTE_GAP = 3
const MAX_TIERS = 8

function rectsOverlap(a: PlacedRect, b: PlacedRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

let measureCtx: CanvasRenderingContext2D | null | undefined

function fontAt(fontScale: number): string {
  return `600 ${LABEL_FONT_SIZE * fontScale}px system-ui, -apple-system, "Hiragino Sans", sans-serif`
}

function measureTextWidth(text: string, fontScale: number): number {
  if (measureCtx === undefined) {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  if (!measureCtx) return text.length * 14 * fontScale
  measureCtx.font = fontAt(fontScale)
  return measureCtx.measureText(text).width
}

/**
 * Resolves final positions for all candidates, pushing a label outward into further tiers
 * whenever it would overlap an already-placed label. Pass all candidates for one overlay layer
 * together — collision checks only happen within a single call. Pure geometry, no DOM writes;
 * see `renderPlacementsToDom` / `drawPlacementsOnCanvas` for the two ways to paint the result.
 * `fontScale` (default 1 = the tuned 9px baseline) should match whatever the notation itself is
 * currently rendered at — e.g. the PDF overlay shrinks/grows with its panel's width, and a label
 * font fixed at 9px regardless would look oversized once the notation shrinks underneath it.
 */
export function computeLabelPlacements(candidates: LabelCandidate[], fontScale = 1): PlacedLabel[] {
  const placedRects: PlacedRect[] = []
  const results: PlacedLabel[] = []
  const lineHeight = LABEL_LINE_HEIGHT * fontScale
  const tierGap = LABEL_TIER_GAP * fontScale

  for (const candidate of candidates) {
    const halfWidth = Math.max(...candidate.pitches.map((p) => measureTextWidth(p, fontScale))) / 2
    const blockHeight = candidate.pitches.length * lineHeight
    let tier = 0
    let rect: PlacedRect

    do {
      const step = tier * (lineHeight + tierGap)
      const bottom = candidate.placeBelow ? candidate.anchorY + step + blockHeight : candidate.anchorY - step
      const top = bottom - blockHeight
      rect = { left: candidate.centerX - halfWidth, right: candidate.centerX + halfWidth, top, bottom }
      tier++
    } while (tier <= MAX_TIERS && placedRects.some((placed) => rectsOverlap(placed, rect)))

    placedRects.push(rect)
    results.push({
      pitches: candidate.pitches,
      placeBelow: candidate.placeBelow,
      centerX: candidate.centerX,
      top: rect.top,
      bottom: rect.bottom,
      time: candidate.time,
      duration: candidate.duration,
    })
  }

  return results
}

/** Builds the on-screen `.solfege-label` divs for a set of resolved placements (font-size inline, scaled; everything else from CSS), returned in the same order as `placements`. */
export function renderPlacementsToDom(placements: PlacedLabel[], layer: HTMLElement, fontScale = 1): HTMLElement[] {
  const elements: HTMLElement[] = []
  const fontSizePx = LABEL_FONT_SIZE * fontScale
  const lineHeightPx = LABEL_LINE_HEIGHT * fontScale
  for (const placement of placements) {
    const label = document.createElement('div')
    label.className = placement.placeBelow ? 'solfege-label solfege-label-below' : 'solfege-label'
    label.style.fontSize = `${fontSizePx}px`
    label.style.lineHeight = `${lineHeightPx}px`
    for (const pitch of placement.pitches) {
      const line = document.createElement('div')
      line.textContent = pitch
      label.appendChild(line)
    }
    label.style.left = `${placement.centerX}px`
    label.style.top = `${placement.placeBelow ? placement.top : placement.bottom}px`
    layer.appendChild(label)
    elements.push(label)
  }
  return elements
}

/** Convenience wrapper: computes placements and renders them to the DOM in one call. */
export function placeLabelsAvoidingOverlap(
  candidates: LabelCandidate[],
  layer: HTMLElement,
  fontScale = 1
): { placements: PlacedLabel[]; elements: HTMLElement[] } {
  const placements = computeLabelPlacements(candidates, fontScale)
  const elements = renderPlacementsToDom(placements, layer, fontScale)
  return { placements, elements }
}

/**
 * Paints resolved placements directly onto a canvas 2D context — used to bake labels into an
 * exported page image. `offsetY` shifts from the (possibly multi-page-stacked) placement
 * coordinate space into one page's own local canvas coordinates. `fontScale` should match what
 * the placements were originally computed with (see `computeLabelPlacements`).
 */
export function drawPlacementsOnCanvas(ctx: CanvasRenderingContext2D, placements: PlacedLabel[], offsetY: number, fontScale = 1): void {
  ctx.save()
  ctx.font = fontAt(fontScale)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const lineHeight = LABEL_LINE_HEIGHT * fontScale
  for (const placement of placements) {
    ctx.fillStyle = placement.placeBelow ? LABEL_BELOW_COLOR : LABEL_ABOVE_COLOR
    placement.pitches.forEach((pitch, index) => {
      const lineTop = placement.top + index * lineHeight - offsetY
      ctx.fillText(pitch, placement.centerX, lineTop)
    })
  }
  ctx.restore()
}
