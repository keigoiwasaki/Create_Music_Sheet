import { OpenSheetMusicDisplay, TransposeCalculator } from 'opensheetmusicdisplay'
import type { GraphicalMeasure, GraphicalVoiceEntry } from 'opensheetmusicdisplay'
import { pitchToSolfege } from './solfege'
import { getTempoBpm } from './musicxml-notes'
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

/** Scale used by `compactLayout` for both `EngravingRules.StaffHeight` and the ドレミ label font —
 * see the ScoreView constructor doc for how this was tuned. Note: OSMD's own `zoom` was tried
 * first and measured to have NO effect on page count — it scales the page itself along with its
 * content (like zooming a PDF viewer), not how much fits on a fixed physical page. `StaffHeight`
 * shrinks the staff relative to the page, which does reduce page count. */
const COMPACT_ZOOM = 0.6
/** `compactLayout`'s page-margin scale — looser than the system/note-spacing scaling below, so
 * pages keep visible breathing room top and bottom instead of content running to the edge. */
const COMPACT_MARGIN_SCALE = 0.7

export class ScoreView {
  private readonly osmd: OpenSheetMusicDisplay
  private readonly labelLayer: HTMLElement
  private readonly container: HTMLElement
  private highlightEntries: HighlightEntry[] = []
  private placements: PlacedLabel[] = []
  /** Seconds per whole note (4 beats at the piece's tempo) — the single conversion factor from
   * OSMD's own Fraction-based (whole-note-unit) timestamps into the real seconds audio playback
   * uses, read from the same `<sound tempo>` detection `musicxml-notes.ts` uses for playback, so
   * the two can never drift apart even if OSMD's own internal tempo detection differs. */
  private secondsPerWholeNote = (60 / 120) * 4
  /** Matches `COMPACT_ZOOM` in `compactLayout` mode, so the ドレミ overlay (ours, not OSMD's)
   * shrinks along with the notation instead of staying full-size — see the constructor doc. */
  private labelFontScale = 1

  /**
   * `pageFormat`, e.g. "A4_P", splits rendering into fixed-size pages (for print/PDF export)
   * instead of one continuous scroll. `compactLayout` drops the title and instrument/part name
   * (OSMD would otherwise print something like "Instr P1" before the first system — a generic
   * fallback name from the OMR engine, not meaningful to show), tightens system spacing, keeps a
   * deliberately looser `COMPACT_MARGIN_SCALE` around the page edges than the rest (content
   * touching the page edge looked cramped even though it saved room), shrinks the staff itself
   * (`StaffHeight *= COMPACT_ZOOM` — unlike OSMD's own `zoom`, see `COMPACT_ZOOM`'s doc, this
   * actually fits more per physical page), and fits more measures per line (same `COMPACT_ZOOM`
   * on note/measure spacing). Verified against a 125-measure piece: 18 pages down to 11 with all
   * of this combined (margins were loosened back up afterward, trading a couple of pages for
   * visible breathing room), with no notehead/label overlap even in dense chord passages.
   * `labelFontScale` is kept in sync with `COMPACT_ZOOM` (see `renderLabels`): the ドレミ labels are
   * our own overlay, not part of OSMD's own rendering, so without this they'd stay full-size over
   * the shrunk staff and look oversized — and could overlap each other, since collision-avoidance
   * in label-layout.ts sizes its boxes from this same scale. An earlier, far more aggressive
   * spacing-only attempt (0.2x, no staff shrink) did overlap and was reverted; this combination
   * sits well clear of that.
   */
  constructor(container: HTMLElement, labelLayer: HTMLElement, options: { pageFormat?: string; compactLayout?: boolean } = {}) {
    this.container = container
    this.labelLayer = labelLayer
    this.osmd = new OpenSheetMusicDisplay(container, {
      autoResize: false,
      // The app shows its own title (driven by the file name the user gave the piece, kept in
      // sync with history renames — see app.ts's `scoreTitle`), not whatever OSMD parses out of
      // the MusicXML's embedded metadata (often missing, garbled, or just the OMR engine's own
      // placeholder — unrelated to what the user actually sees in the history list).
      drawTitle: false,
      pageFormat: options.pageFormat,
    })
    this.osmd.TransposeCalculator = new TransposeCalculator()
    if (options.compactLayout) {
      this.labelFontScale = COMPACT_ZOOM
      const rules = this.osmd.EngravingRules
      rules.StaffHeight *= COMPACT_ZOOM
      rules.RenderTitle = false
      rules.RenderPartNames = false
      rules.PageTopMargin *= COMPACT_MARGIN_SCALE
      rules.PageBottomMargin *= COMPACT_MARGIN_SCALE
      rules.MinSkyBottomDistBetweenSystems *= 0.4
      rules.BetweenStaffDistance *= 0.7
      rules.VoiceSpacingMultiplierVexflow *= 0.6
      rules.MinNoteDistance *= 0.6
    }
  }

  async loadAndRender(content: Uint8Array | string): Promise<void> {
    const source = typeof content === 'string' ? content : new Blob([content as unknown as BlobPart])
    await this.osmd.load(source)
    this.osmd.render()
    if (typeof content === 'string') {
      const tempo = getTempoBpm(content)
      this.secondsPerWholeNote = (60 / tempo) * 4
    }
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
    for (const row of measureRows) {
      for (const measure of row) {
        for (const staffEntry of measure.staffEntries) {
          staffEntry.graphicalVoiceEntries.forEach((voiceEntry, voiceIndex) => {
            const candidate = this.buildLabelCandidate(voiceEntry, voiceIndex, containerRect, measure)
            if (candidate) candidates.push(candidate)
          })
        }
      }
    }

    const { placements, elements } = placeLabelsAvoidingOverlap(candidates, this.labelLayer, this.labelFontScale)
    this.placements = placements
    this.highlightEntries = buildHighlightEntries(placements, elements)
  }

  /**
   * Timing read straight from OSMD's own parsed structure (measure's absolute position + this
   * voice entry's position within it, both as Fractions in whole-note units), not by matching
   * against a separately re-parsed event list by array index. That sequential-index approach broke
   * the moment OSMD's own internal note-traversal order (strictly chronological across staves —
   * see below) diverged from `musicxml-notes.ts`'s own emission order (per-staff within a measure,
   * matching the source MusicXML document order, which is NOT chronological when a measure has
   * multiple staves interleaved via `<backup>`/`<forward>`) — producing correct ドレミ text (read
   * independently from OSMD's own note data, see `buildLabelCandidate` below) sitting on a note
   * whose highlight timing actually belonged to a different note. Reading time/duration directly
   * from the same graphical object the label is being placed on makes this category of mismatch
   * structurally impossible, for any future piece or OMR engine, not just this one case.
   */
  private computeTiming(voiceEntry: GraphicalVoiceEntry, measure: GraphicalMeasure): { time: number; duration: number } | null {
    const sourceMeasure = measure.parentSourceMeasure
    if (!sourceMeasure) return null
    const firstPitchedNote = voiceEntry.notes.find((n) => !n.sourceNote.isRest())
    if (!firstPitchedNote) return null

    const absoluteWholeNotes = sourceMeasure.AbsoluteTimestamp.RealValue + voiceEntry.parentVoiceEntry.Timestamp.RealValue
    const lengthWholeNotes = firstPitchedNote.sourceNote.Length.RealValue
    return {
      time: absoluteWholeNotes * this.secondsPerWholeNote,
      duration: lengthWholeNotes * this.secondsPerWholeNote,
    }
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
    measure: GraphicalMeasure
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

    const timing = this.computeTiming(voiceEntry, measure)
    return { pitches, centerX, placeBelow, anchorY, time: timing?.time, duration: timing?.duration }
  }
}
