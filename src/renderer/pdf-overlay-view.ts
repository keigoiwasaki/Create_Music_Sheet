import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument } from 'pdf-lib'
import type { OmrSheetData } from './omr-sheet'
import type { ChordEvent } from './musicxml-notes'
import { solfegeForPitchClass } from './solfege'
import {
  buildHighlightEntries,
  drawPlacementsOnCanvas,
  LABEL_NOTE_GAP,
  placeLabelsAvoidingOverlap,
  type HighlightEntry,
  type LabelCandidate,
  type PlacedLabel,
} from './label-layout'

GlobalWorkerOptions.workerSrc = workerUrl

const DEFAULT_PAGE_WIDTH_PX = 900
const PAGE_GAP_PX = 16

interface RenderedPage {
  canvas: HTMLCanvasElement
  /** Page size in PDF points (72dpi) — used as the exported page's physical size. */
  pointWidth: number
  pointHeight: number
  /** Cumulative top (in the same stacked-page coordinate space as placements) where this page starts. */
  topOffset: number
}

/** Geometry + pitch for one label, kept around so `setTranspose` can relabel without re-rendering the PDF pages. */
interface RawCandidate {
  midiNotes: number[]
  centerX: number
  anchorY: number
  time: number
  duration: number
}

/**
 * Renders the ORIGINAL PDF pages (via pdf.js) and overlays solfège labels at the pixel positions
 * Audiveris detected for each chord's noteheads — so the user sees their own sheet music with
 * ドレミ written on it, not a re-engraved copy.
 */
export class PdfOverlayView {
  private readonly container: HTMLElement
  private readonly labelLayer: HTMLElement
  private dpr = 1
  private pages: RenderedPage[] = []
  /** Parallel arrays: placements[i] belongs to pages[pagePerPlacement[i]]. */
  private placements: PlacedLabel[] = []
  private pagePerPlacement: number[] = []
  private highlightEntries: HighlightEntry[] = []
  private rawCandidates: RawCandidate[] = []
  /** Label font size scales with however wide the page is currently rendered — otherwise a fixed
   * font looks oversized once the panel (and so the PDF raster) is dragged narrower, and undersized
   * once it's widened past the tuned baseline. */
  private fontScale = 1

  constructor(container: HTMLElement, labelLayer: HTMLElement) {
    this.container = container
    this.labelLayer = labelLayer
  }

  async render(pdfBytes: Uint8Array, sheets: OmrSheetData[], chordEvents: ChordEvent[]): Promise<void> {
    this.container.replaceChildren()
    this.labelLayer.replaceChildren()
    this.pages = []
    this.dpr = window.devicePixelRatio || 1
    // Measured before any canvases are appended — #score-container is a plain block element, so
    // this reflects the column's actual CSS-driven width (which varies with the piano-roll panel).
    const pageWidthPx = this.container.clientWidth || DEFAULT_PAGE_WIDTH_PX
    this.fontScale = Math.min(1.8, Math.max(0.45, pageWidthPx / DEFAULT_PAGE_WIDTH_PX))

    // pdf.js transfers (detaches) the buffer behind `data` to its worker, so a caller reusing the
    // same `pdfBytes` across multiple render() calls (e.g. reflowing after a panel resize) would
    // otherwise fail on the second call — pass a fresh copy instead of the caller's own buffer.
    const pdf = await getDocument({ data: pdfBytes.slice() }).promise
    const candidates: LabelCandidate[] = []
    const candidatePageIndex: number[] = []
    const rawCandidates: RawCandidate[] = []
    let cumulativeTop = 0

    // Grouped by MusicXML's own `<print new-page="yes">` markers (ChordEvent.page), not by
    // sequentially consuming `sheet.chordBoxes.length` events per page — the OMR position-data
    // file (parseOmrSheet's chordBoxes) and Audiveris's own MusicXML export can disagree on a
    // page's chord count when OMR partially fails to recognize a system, and sequential slicing
    // would let that single discrepancy drift every later page's labels onto the wrong notes (or
    // off the end entirely) instead of staying contained to the one affected page.
    const eventsByPage = new Map<number, ChordEvent[]>()
    for (const event of chordEvents) {
      const list = eventsByPage.get(event.page)
      if (list) list.push(event)
      else eventsByPage.set(event.page, [event])
    }

    const pageCount = Math.min(pdf.numPages, sheets.length)
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const sheet = sheets[pageNumber - 1]
      const sheetEvents = eventsByPage.get(pageNumber) ?? []

      const page = await pdf.getPage(pageNumber)
      const unscaledViewport = page.getViewport({ scale: 1 })
      const scale = pageWidthPx / unscaledViewport.width
      const viewport = page.getViewport({ scale })

      const canvas = document.createElement('canvas')
      canvas.width = viewport.width * this.dpr
      canvas.height = viewport.height * this.dpr
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      canvas.style.display = 'block'
      canvas.style.marginBottom = `${PAGE_GAP_PX}px`
      canvas.style.background = '#fff'
      this.container.appendChild(canvas)

      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(this.dpr, this.dpr)
        await page.render({ canvasContext: ctx, viewport, canvas }).promise
      }

      this.pages.push({
        canvas,
        pointWidth: unscaledViewport.width,
        pointHeight: unscaledViewport.height,
        topOffset: cumulativeTop,
      })

      const pixelScale = sheet.pageWidth > 0 ? viewport.width / sheet.pageWidth : 1

      sheet.chordBoxes.forEach((box, index) => {
        const event = sheetEvents[index]
        if (!event || event.pitches.length === 0) return
        const centerX = (box.x + box.w / 2) * pixelScale
        const anchorY = cumulativeTop + box.y * pixelScale - LABEL_NOTE_GAP
        candidates.push({
          pitches: event.pitches,
          centerX,
          placeBelow: false,
          anchorY,
          time: event.time,
          duration: event.duration,
        })
        candidatePageIndex.push(pageNumber - 1)
        rawCandidates.push({ midiNotes: event.midiNotes, centerX, anchorY, time: event.time, duration: event.duration })
      })

      cumulativeTop += viewport.height + PAGE_GAP_PX
    }

    const { placements, elements } = placeLabelsAvoidingOverlap(candidates, this.labelLayer, this.fontScale)
    this.placements = placements
    this.pagePerPlacement = candidatePageIndex
    this.highlightEntries = buildHighlightEntries(placements, elements)
    this.rawCandidates = rawCandidates
  }

  getHighlightEntries(): HighlightEntry[] {
    return this.highlightEntries
  }

  /**
   * Relabels in place — the original PDF raster can't move a notehead to show real transposed
   * notation, so (unlike ScoreView) this only recomputes each label's text for the shifted pitch,
   * keeping it anchored at the note's original, unmoved position. Geometry/order match `render`'s
   * candidates exactly, so `pagePerPlacement` (used by `exportAnnotatedPdf`) stays valid untouched.
   */
  setTranspose(semitones: number): void {
    this.labelLayer.replaceChildren()
    const candidates: LabelCandidate[] = this.rawCandidates.map((c) => ({
      pitches: c.midiNotes.map((midi) => solfegeForPitchClass(midi + semitones)),
      centerX: c.centerX,
      placeBelow: false,
      anchorY: c.anchorY,
      time: c.time,
      duration: c.duration,
    }))
    const { placements, elements } = placeLabelsAvoidingOverlap(candidates, this.labelLayer, this.fontScale)
    this.placements = placements
    this.highlightEntries = buildHighlightEntries(placements, elements)
  }

  /** Bakes the labels into each page's raster and assembles a new single-file PDF. */
  async exportAnnotatedPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()

    for (let pageIndex = 0; pageIndex < this.pages.length; pageIndex++) {
      const page = this.pages[pageIndex]
      const exportCanvas = document.createElement('canvas')
      exportCanvas.width = page.canvas.width
      exportCanvas.height = page.canvas.height
      const ctx = exportCanvas.getContext('2d')
      if (!ctx) continue

      ctx.drawImage(page.canvas, 0, 0)
      ctx.scale(this.dpr, this.dpr)
      const pagePlacements = this.placements.filter((_, i) => this.pagePerPlacement[i] === pageIndex)
      drawPlacementsOnCanvas(ctx, pagePlacements, page.topOffset, this.fontScale)

      const pngUrl = exportCanvas.toDataURL('image/png')
      const pngBytes = Uint8Array.from(atob(pngUrl.split(',')[1]), (c) => c.charCodeAt(0))
      const pngImage = await doc.embedPng(pngBytes)
      const pdfPage = doc.addPage([page.pointWidth, page.pointHeight])
      pdfPage.drawImage(pngImage, { x: 0, y: 0, width: page.pointWidth, height: page.pointHeight })
    }

    return doc.save()
  }
}
