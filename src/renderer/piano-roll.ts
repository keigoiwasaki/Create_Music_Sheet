import { solfegeForPitchClass } from './solfege'

export interface RollNote {
  time: number
  duration: number
  midi: number
  label: string
  /** MusicXML staff number (1 = top staff / right hand on a piano grand staff), when known. */
  staff: number | null
}

/**
 * Flattens chord/note events (as parsed from MusicXML) into individual falling-note entries.
 * `transpose` shifts pitch by semitones (karaoke-style key change) — both the key each note falls
 * on AND its ドレミ label follow the shift, since (unlike the sheet-music overlay) this view is
 * entirely app-drawn and has no original engraving to stay faithful to.
 */
export function chordEventsToRollNotes(
  events: { time: number; duration: number; midiNotes: number[]; pitches: string[]; staff: number | null }[],
  speed = 1,
  transpose = 0
): RollNote[] {
  const notes: RollNote[] = []
  for (const event of events) {
    event.midiNotes.forEach((midi, i) => {
      notes.push({
        time: event.time / speed,
        duration: event.duration / speed,
        midi: midi + transpose,
        label: transpose === 0 ? (event.pitches[i] ?? '') : solfegeForPitchClass(midi + transpose),
        staff: event.staff,
      })
    })
  }
  return notes
}

const WHITE_SEMITONES = new Set([0, 2, 4, 5, 7, 9, 11])

function isWhiteKey(midi: number): boolean {
  return WHITE_SEMITONES.has(((midi % 12) + 12) % 12)
}

/** Which hand(s) are currently muted — darkens that hand's notes/keys so the practiced hand stands out. */
export interface HandMuteState {
  right: boolean
  left: boolean
}

// Close to the roll's own background (#1a1033) so a muted hand actually fades away instead of
// standing out as a visible gray shape — and the same color for every state (never brightens to
// an "active" shade either; see `isHandMuted`/`drawFrame`) so a muted key never lights up.
const MUTED_COLOR = '#2a2240'

function isHandMuted(staff: number | null, muted?: HandMuteState): boolean {
  const isLeftHand = staff !== null && staff >= 2
  return Boolean(isLeftHand ? muted?.left : muted?.right)
}

/** Right hand (staff 1 or unknown) = blue, left hand (staff 2+) = green — a lighter "active" shade of the same hue while the note sounds. */
function colorsForStaff(staff: number | null): { base: string; active: string; keyTint: string } {
  const isLeftHand = staff !== null && staff >= 2
  if (isLeftHand) return { base: '#059669', active: '#34d399', keyTint: '#a7f3d0' }
  return { base: '#2563eb', active: '#60a5fa', keyTint: '#bfdbfe' }
}

/**
 * Draws a "falling notes" piano-roll frame (Synthesia-style): a keyboard fixed at the bottom,
 * note bars scrolling down from above and landing on the correct key exactly at their onset time.
 * Notes are colored by hand (MusicXML staff) so the two hands stay visually distinguishable.
 */
export class PianoRollRenderer {
  private readonly ctx: CanvasRenderingContext2D
  private readonly notes: RollNote[]
  private readonly minMidi: number
  private readonly maxMidi: number
  private readonly whiteKeyCount: number
  private readonly keyboardHeight: number
  private readonly pixelsPerSecond: number
  // Logical (CSS-pixel) size — NOT canvas.width/height, which is deliberately set to a
  // devicePixelRatio-scaled physical resolution for crisp rendering on HiDPI displays (otherwise
  // the roll looks visibly soft/blurry, especially on Retina screens). `ctx.scale(dpr, dpr)` in
  // the constructor maps every draw call below back into this logical space transparently, so nothing
  // else in this file needs to know about dpr at all.
  private readonly width: number
  private readonly height: number
  private muted: HandMuteState = { right: false, left: false }
  private showLabels = true

  constructor(
    private readonly canvas: HTMLCanvasElement,
    notes: RollNote[],
    pixelsPerSecond = 160,
    dpr = window.devicePixelRatio || 1
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2Dコンテキストを取得できませんでした')
    this.ctx = ctx
    ctx.scale(dpr, dpr)
    this.width = canvas.width / dpr
    this.height = canvas.height / dpr
    this.notes = notes
    this.pixelsPerSecond = pixelsPerSecond
    this.keyboardHeight = Math.round(this.height * 0.16)

    const midis = notes.map((n) => n.midi)
    const lo = midis.length > 0 ? Math.min(...midis) : 60
    const hi = midis.length > 0 ? Math.max(...midis) : 72
    this.minMidi = Math.max(21, lo - 2)
    this.maxMidi = Math.min(108, hi + 2)

    let whiteCount = 0
    for (let m = this.minMidi; m <= this.maxMidi; m++) if (isWhiteKey(m)) whiteCount++
    this.whiteKeyCount = Math.max(whiteCount, 1)
  }

  /** Updates which hand is muted — takes effect on the next `drawFrame`, no rebuild needed. */
  setMuted(muted: HandMuteState): void {
    this.muted = muted
  }

  /** Whether to draw the ドレミ label on every note bar, regardless of how small it is — or on none at all. */
  setShowLabels(show: boolean): void {
    this.showLabels = show
  }

  private whiteKeyWidth(): number {
    return this.width / this.whiteKeyCount
  }

  private xForMidi(midi: number): { x: number; width: number; white: boolean } {
    const w = this.whiteKeyWidth()
    let whiteIndex = 0
    for (let m = this.minMidi; m < midi; m++) if (isWhiteKey(m)) whiteIndex++
    if (isWhiteKey(midi)) {
      return { x: whiteIndex * w, width: w, white: true }
    }
    return { x: whiteIndex * w - w * 0.3, width: w * 0.6, white: false }
  }

  drawFrame(currentTime: number): void {
    const { ctx, width, height } = this
    ctx.fillStyle = '#1a1033'
    ctx.fillRect(0, 0, width, height)

    const rollHeight = height - this.keyboardHeight
    const activeByMidi = new Map<number, number | null>()

    for (const note of this.notes) {
      const startY = rollHeight - (note.time - currentTime) * this.pixelsPerSecond
      const endY = rollHeight - (note.time + note.duration - currentTime) * this.pixelsPerSecond
      if (startY < 0 || endY > rollHeight) continue

      const muted = isHandMuted(note.staff, this.muted)
      // A muted note never counts as "active" — it has no sound to correlate with a highlight, so
      // lighting it up (and the key under it) would be actively misleading, not just unmuted-looking.
      const isActive = !muted && currentTime >= note.time && currentTime < note.time + note.duration
      if (isActive) activeByMidi.set(note.midi, note.staff)

      const { x, width } = this.xForMidi(note.midi)
      const top = Math.max(0, endY)
      const height = Math.max(4, startY - top)

      if (muted) {
        ctx.fillStyle = MUTED_COLOR
      } else {
        const colors = colorsForStaff(note.staff)
        ctx.fillStyle = isActive ? colors.active : colors.base
      }
      ctx.beginPath()
      ctx.roundRect(x + 1, top, Math.max(width - 2, 2), height, 4)
      ctx.fill()

      if (this.showLabels && !muted) {
        ctx.fillStyle = '#fff'
        ctx.font = '600 12px system-ui, -apple-system, "Hiragino Sans", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(note.label, x + width / 2, top + 4)
      }
    }

    this.drawKeyboard(activeByMidi)
  }

  private drawKeyboard(activeByMidi: Map<number, number | null>): void {
    const { ctx, height } = this
    const top = height - this.keyboardHeight

    for (let m = this.minMidi; m <= this.maxMidi; m++) {
      if (!isWhiteKey(m)) continue
      const { x, width } = this.xForMidi(m)
      const active = activeByMidi.get(m)
      ctx.fillStyle = active !== undefined ? colorsForStaff(active).keyTint : '#f8fafc'
      ctx.fillRect(x, top, width, this.keyboardHeight)
      ctx.strokeStyle = '#334155'
      ctx.lineWidth = 1
      ctx.strokeRect(x, top, width, this.keyboardHeight)
    }
    for (let m = this.minMidi; m <= this.maxMidi; m++) {
      if (isWhiteKey(m)) continue
      const { x, width } = this.xForMidi(m)
      const active = activeByMidi.get(m)
      ctx.fillStyle = active !== undefined ? colorsForStaff(active).active : '#0f172a'
      ctx.fillRect(x, top, width, this.keyboardHeight * 0.62)
    }
  }
}
