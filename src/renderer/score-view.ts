import { OpenSheetMusicDisplay, TransposeCalculator } from 'opensheetmusicdisplay'
import type { GraphicalVoiceEntry } from 'opensheetmusicdisplay'
import { pitchToSolfege } from './solfege'
import { parseMusicXmlEvents, type ChordEvent } from './musicxml-notes'
import {
  buildHighlightEntries,
  LABEL_NOTE_GAP,
  placeLabelsAvoidingOverlap,
  type HighlightEntry,
  type LabelCandidate,
  type PlacedLabel,
} from './label-layout'

/**
 * Notes are rendered via the VexFlow backend, which exposes the rendered notehead SVG elements.
 * For a chord, all notes share one VexFlow StaveNode, so getNoteheadSVGs() returns the SAME
 * array (one entry per pitch in the chord) for every note in it; vfnoteIndex picks out the
 * element for this specific pitch.
 */
interface NoteheadProvider {
  getNoteheadSVGs(): HTMLElement[]
  vfnoteIndex: number
}

export class ScoreView {
  private readonly osmd: OpenSheetMusicDisplay
  private readonly labelLayer: HTMLElement
  private readonly container: HTMLElement
  private events: ChordEvent[] = []
  private highlightEntries: HighlightEntry[] = []
  private placements: PlacedLabel[] = []

  /**
   * `pageFormat`, e.g. "A4_P", splits rendering into fixed-size pages (for print/PDF export)
   * instead of one continuous scroll. `compactLayout` tightens page margins/system spacing and
   * drops the title to use less wasted space — but deliberately leaves note/measure spacing at
   * OSMD's normal density: compressing that (tried down to 0.2x) crammed enough measures per line
   * to make noteheads and labels overlap and become hard to read, which matters more than page count.
   */
  constructor(container: HTMLElement, labelLayer: HTMLElement, options: { pageFormat?: string; compactLayout?: boolean } = {}) {
    this.container = container
    this.labelLayer = labelLayer
    this.osmd = new OpenSheetMusicDisplay(container, {
      autoResize: false,
      drawTitle: true,
      pageFormat: options.pageFormat,
    })
    this.osmd.TransposeCalculator = new TransposeCalculator()
    if (options.compactLayout) {
      const rules = this.osmd.EngravingRules
      rules.RenderTitle = false
      rules.PageTopMargin *= 0.4
      rules.PageBottomMargin *= 0.4
      rules.MinSkyBottomDistBetweenSystems *= 0.4
      rules.BetweenStaffDistance *= 0.7
    }
  }

  async loadAndRender(content: Uint8Array | string): Promise<void> {
    const source = typeof content === 'string' ? content : new Blob([content as unknown as BlobPart])
    await this.osmd.load(source)
    this.osmd.render()
    // Playback timing is only derivable when we have the raw MusicXML text ourselves to re-parse.
    this.events = typeof content === 'string' ? parseMusicXmlEvents(content) : []
    this.renderLabels()
  }

  /**
   * Real re-engraving (not just a relabel): OSMD recomputes correct accidentals/key signature for
   * the shifted pitches, so `renderLabels` (which reads each note's own, now-transposed, Pitch)
   * naturally produces matching ドレミ labels with no extra pitch math needed here.
   */
  setTranspose(semitones: number): void {
    this.osmd.Sheet.Transpose = semitones
    this.osmd.updateGraphic()
    this.osmd.render()
    this.renderLabels()
  }

  getHighlightEntries(): HighlightEntry[] {
    return this.highlightEntries
  }

  /** Resolved label positions (container-relative), for baking labels into a page raster on export. */
  getPlacements(): PlacedLabel[] {
    return this.placements
  }

  private renderLabels(): void {
    this.labelLayer.replaceChildren()

    const containerRect = this.container.getBoundingClientRect()
    const measureRows = this.osmd.GraphicSheet.MeasureList

    const candidates: LabelCandidate[] = []
    let eventIndex = 0
    for (const row of measureRows) {
      for (const measure of row) {
        for (const staffEntry of measure.staffEntries) {
          staffEntry.graphicalVoiceEntries.forEach((voiceEntry, voiceIndex) => {
            const event = this.events[eventIndex]
            const candidate = this.buildLabelCandidate(voiceEntry, voiceIndex, containerRect, event)
            if (candidate) {
              candidates.push(candidate)
              eventIndex++
            }
          })
        }
      }
    }

    const { placements, elements } = placeLabelsAvoidingOverlap(candidates, this.labelLayer)
    this.placements = placements
    this.highlightEntries = buildHighlightEntries(placements, elements)
  }

  private getNoteheadRect(note: unknown): DOMRect | null {
    const provider = note as unknown as NoteheadProvider
    const noteheads = provider.getNoteheadSVGs?.()
    const notehead = noteheads?.[provider.vfnoteIndex] ?? noteheads?.[0]
    if (!notehead) return null
    const rect = notehead.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return rect
  }

  /**
   * One label per voice entry (chord), not per note: a chord's simultaneous notes stack
   * vertically (highest pitch on top) into one label anchored above the chord — or, for a
   * second voice sharing the staff, below it. Stacking instead of joining with "/" keeps every
   * label's horizontal footprint as narrow as a single note, so labels line up in a row.
   */
  private buildLabelCandidate(
    voiceEntry: GraphicalVoiceEntry,
    voiceIndex: number,
    containerRect: DOMRect,
    event: ChordEvent | undefined
  ): LabelCandidate | null {
    const items = voiceEntry.notes
      .filter((note) => !note.sourceNote.isRest() && !!note.sourceNote.Pitch)
      .map((note) => {
        const rect = this.getNoteheadRect(note)
        if (!rect) return null
        // TransposedPitch is set (instead of Pitch) once Sheet.Transpose is applied — Pitch alone
        // always stays the original, untransposed source value.
        const pitch = note.sourceNote.TransposedPitch ?? note.sourceNote.Pitch!
        return {
          rect,
          solfege: pitchToSolfege(pitch.FundamentalNote, pitch.AccidentalHalfTones),
          halfTone: pitch.getHalfTone(),
        }
      })
      .filter((item): item is { rect: DOMRect; solfege: string; halfTone: number } => item !== null)

    if (items.length === 0) return null

    const pitches = [...items]
      .sort((a, b) => b.halfTone - a.halfTone) // highest pitch first, top-to-bottom reading order
      .map((item) => item.solfege)

    const centerX = items.reduce((sum, item) => sum + item.rect.left + item.rect.width / 2, 0) / items.length - containerRect.left
    const placeBelow = voiceIndex % 2 === 1
    const anchorY = placeBelow
      ? Math.max(...items.map((item) => item.rect.bottom)) - containerRect.top + LABEL_NOTE_GAP
      : Math.min(...items.map((item) => item.rect.top)) - containerRect.top - LABEL_NOTE_GAP

    return { pitches, centerX, placeBelow, anchorY, time: event?.time, duration: event?.duration }
  }
}
