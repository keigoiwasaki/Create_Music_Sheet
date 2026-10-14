export interface PlaybackNote {
  /** Seconds from the start of playback. */
  time: number
  /** Seconds the note should sound for. */
  duration: number
  /** MIDI note number (69 = A4). */
  midi: number
}

/**
 * Flattens chord/note events (as parsed from MusicXML) into individual scheduled notes.
 * `transpose` shifts pitch by semitones (karaoke-style key change) — audio only, independent of
 * `speed`, and independent of the sheet music / ドレミ labels, which always show the original key.
 */
export function chordEventsToPlaybackNotes(
  events: { time: number; duration: number; midiNotes: number[] }[],
  speed = 1,
  transpose = 0
): PlaybackNote[] {
  const notes: PlaybackNote[] = []
  for (const event of events) {
    for (const midi of event.midiNotes) {
      notes.push({ time: event.time / speed, duration: event.duration / speed, midi: midi + transpose })
    }
  }
  return notes
}

/**
 * A struck string's harmonic n is scaled by |sin(n·π·β)|/n, where β is the hammer's strike point
 * as a fraction of the string length (~1/7 on a real piano) — this is what gives piano tone its
 * characteristic spectrum (a partial near the 7th harmonic goes to ~zero), as opposed to the
 * smooth, evenly-decaying harmonic series a generic plucked/organ tone has.
 */
function buildHammerStruckHarmonics(count: number, strikePosition = 1 / 7): number[] {
  const amplitudes: number[] = []
  for (let n = 1; n <= count; n++) {
    amplitudes.push(Math.abs(Math.sin(n * Math.PI * strikePosition)) / n)
  }
  const peak = Math.max(...amplitudes)
  return amplitudes.map((a) => a / peak)
}

/** A plain sawtooth-ish series (all harmonics present, decaying as 1/n) for a synth-lead character. */
function buildSawtoothHarmonics(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 1 / (i + 1))
}

/** Only odd harmonics (drawbar-organ-ish), each a bit weaker than the last. */
function buildOrganHarmonics(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 1 / (i / 2 + 1) ** 1.3 : 0))
}

/** A sparser, irregularly-spaced set (skips/weakens some harmonics) for an electric-piano/bell-ish tine character. */
function buildBellLikeHarmonics(count: number): number[] {
  const base = [1, 0.12, 0.55, 0.06, 0.32, 0.04, 0.2, 0.03, 0.12, 0.02, 0.08]
  return base.slice(0, count)
}

/** Mostly the fundamental with one distinct, quieter overtone near the 4th harmonic — a woody, marimba/xylophone-ish character. */
function buildMarimbaHarmonics(count: number): number[] {
  const base = [1, 0.08, 0.04, 0.18, 0.03, 0.015, 0.008]
  return Array.from({ length: count }, (_, i) => base[i] ?? 0.004)
}

/**
 * A selectable sound character — the harmonic content (timbre) plus the envelope/filter shape
 * that together make different instruments sound distinct, not just "piano but tweaked". All of
 * these intentionally use a single oscillator per note (see `schedulePianoNote`): doubling voices
 * multiplies the real-time CPU cost enough, across a dense piece with pedal-style tails, to
 * overload audio rendering and cause dropouts — worse than a plainer tone.
 */
export interface VoicePreset {
  id: string
  label: string
  harmonics: number[]
  attack: number
  punch: number
  /** Gain fraction (of peak) right after the initial hammer-strike punch. */
  settleFactor: number
  /** Gain fraction (of the settle level) during the held/ring phase — close to 1 holds almost flat (organ/synth), lower decays further (piano/e-piano). */
  sustainFactor: number
  ringScale: number
  ringMin: number
  ringMax: number
  /** Multiplier on the starting lowpass cutoff (relative to the note's fundamental). */
  brightnessScale: number
  /** The lowpass cutoff the filter sweeps *to* by the end of the note, as a multiplier on the fundamental — close to `brightnessScale` means little sweep (sustained, even timbre); much lower means it visibly darkens over the note's life. */
  filterEndScale: number
  filterFloorHz: number
}

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: 'piano',
    label: 'ピアノ',
    harmonics: buildHammerStruckHarmonics(14),
    attack: 0.006,
    punch: 0.1,
    settleFactor: 0.4,
    sustainFactor: 0.3,
    ringScale: 1.15,
    ringMin: 0.25,
    ringMax: 2.2,
    brightnessScale: 6,
    filterEndScale: 1.5,
    filterFloorHz: 700,
  },
  {
    id: 'epiano',
    label: 'エレピ',
    harmonics: buildBellLikeHarmonics(11),
    attack: 0.003,
    punch: 0.16,
    settleFactor: 0.55,
    sustainFactor: 0.42,
    ringScale: 0.9,
    ringMin: 0.3,
    ringMax: 1.4,
    brightnessScale: 4,
    filterEndScale: 1.3,
    filterFloorHz: 500,
  },
  {
    id: 'organ',
    label: 'オルガン',
    harmonics: buildOrganHarmonics(10),
    attack: 0.012,
    punch: 0.02,
    settleFactor: 0.97,
    sustainFactor: 0.95,
    ringScale: 1,
    ringMin: 0.15,
    ringMax: 6,
    brightnessScale: 2.4,
    filterEndScale: 2.2,
    filterFloorHz: 2000,
  },
  {
    id: 'synth',
    label: 'シンセ',
    harmonics: buildSawtoothHarmonics(12),
    attack: 0.002,
    punch: 0.03,
    settleFactor: 0.85,
    sustainFactor: 0.75,
    ringScale: 0.35,
    ringMin: 0.2,
    ringMax: 0.7,
    brightnessScale: 8,
    filterEndScale: 3,
    filterFloorHz: 1200,
  },
  {
    id: 'guitar',
    label: 'ギター',
    // Same hammer-struck-harmonics formula as the piano preset, but with the strike/pluck point
    // much closer to the bridge (a smaller fraction of the string) — a guitar pluck is typically
    // nearer one end than a piano hammer, which pushes the harmonic nulls higher and gives a
    // brighter, more "twangy" spectrum than the piano preset's.
    harmonics: buildHammerStruckHarmonics(12, 1 / 5),
    attack: 0.004,
    punch: 0.05,
    settleFactor: 0.5,
    sustainFactor: 0.35,
    ringScale: 0.9,
    ringMin: 0.3,
    ringMax: 1.6,
    brightnessScale: 5,
    filterEndScale: 1.8,
    filterFloorHz: 600,
  },
  {
    id: 'marimba',
    label: 'マリンバ',
    harmonics: buildMarimbaHarmonics(8),
    attack: 0.002,
    punch: 0.015,
    settleFactor: 0.6,
    sustainFactor: 0.15, // wooden bars damp out fast — little held "ring" after the initial strike
    ringScale: 0.55,
    ringMin: 0.18,
    ringMax: 0.9,
    brightnessScale: 3.5,
    filterEndScale: 1.2,
    filterFloorHz: 400,
  },
  {
    id: 'strings',
    label: 'ストリングス',
    harmonics: buildSawtoothHarmonics(12),
    attack: 0.09, // a bow "swells in" rather than striking — much slower than every other preset
    punch: 0.05,
    settleFactor: 0.9,
    sustainFactor: 0.85, // stays nearly as loud as it starts, like a sustained bowed note
    ringScale: 1.4,
    ringMin: 0.6,
    ringMax: 3,
    brightnessScale: 3,
    filterEndScale: 2.5,
    filterFloorHz: 900,
  },
]

export const DEFAULT_VOICE_PRESET = VOICE_PRESETS[0]

export function buildVoiceWave(ctx: BaseAudioContext, preset: VoicePreset): PeriodicWave {
  const real = new Float32Array(preset.harmonics.length + 1)
  const imag = new Float32Array(preset.harmonics.length + 1)
  preset.harmonics.forEach((amplitude, i) => {
    imag[i + 1] = amplitude
  })
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false })
}

/**
 * Synthesizes a short, exponentially-decaying noise burst as a convolution impulse response —
 * a cheap stand-in for a room/soundboard reverb (no audio asset to ship or load).
 */
function buildImpulseResponse(ctx: BaseAudioContext, duration = 1.2, decay = 3.2): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.max(1, Math.floor(rate * duration))
  const impulse = ctx.createBuffer(2, length, rate)
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay)
    }
  }
  return impulse
}

/**
 * Builds a reverb "send" node: connect note gains to it directly (as an extra fan-out destination
 * alongside the dry output) and it mixes a wet, decaying tail into `destination` — simulating the
 * sustain-pedal/soundboard resonance a real piano has, where notes bloom and blend into each other
 * instead of stopping cleanly.
 */
export function createReverbSend(ctx: BaseAudioContext, destinations: AudioNode | AudioNode[], wetLevel = 0.16): AudioNode {
  const convolver = ctx.createConvolver()
  convolver.buffer = buildImpulseResponse(ctx)
  const wetGain = ctx.createGain()
  wetGain.gain.value = wetLevel
  convolver.connect(wetGain)
  for (const destination of Array.isArray(destinations) ? destinations : [destinations]) {
    wetGain.connect(destination)
  }
  return convolver
}

/**
 * Schedules one tone (shaped by `preset`) onto `destinations` (pass a reverb send alongside the
 * dry destination for pedal-like resonance — see `createReverbSend`). A single oscillator per
 * note through a 4-stage envelope (attack → settle → sustain/ring → release) and a closing
 * lowpass filter, both shaped by pitch and velocity. Shared by every voice preset and by live
 * playback (AudioPlayer).
 */
export function schedulePianoNote(
  ctx: BaseAudioContext,
  destinations: AudioNode | AudioNode[],
  wave: PeriodicWave,
  note: PlaybackNote,
  baseTime: number,
  preset: VoicePreset = DEFAULT_VOICE_PRESET
): OscillatorNode {
  if (!Number.isFinite(note.time) || !Number.isFinite(note.duration) || !Number.isFinite(note.midi)) {
    throw new Error(`non-finite note data: ${JSON.stringify(note)}`)
  }

  const freq = 440 * Math.pow(2, (note.midi - 69) / 12)
  // Clamp: a malformed backup/forward upstream could otherwise produce a negative start time,
  // which AudioScheduledSourceNode.start() throws on.
  const start = Math.max(baseTime, baseTime + note.time)

  // Real piano strings decay at very different rates by pitch — short, light bass strings ring
  // for seconds, while thin treble strings die out quickly. Scale the (pedal-style, for ringScale
  // > 1 presets) sustain tail by distance from middle C accordingly — still capped, since too long
  // a tail across a dense passage is what overloaded audio rendering last time this was tuned.
  const pitchRingFactor = Math.min(1.6, Math.max(0.55, 1.5 - (note.midi - 48) * 0.012))
  const ring = Math.min(Math.max(note.duration * preset.ringScale * pitchRingFactor, preset.ringMin), preset.ringMax)
  // Small per-note velocity variance so a run of identical note values doesn't sound mechanically uniform.
  const velocity = 0.88 + Math.random() * 0.24 // ~[0.88, 1.12]
  const peak = 0.21 * velocity
  const settlePoint = start + preset.attack + preset.punch
  const sustainPoint = settlePoint + ring * 0.6
  const decayEnd = settlePoint + ring
  const stopAt = decayEnd + 0.15

  // Harder hits and higher notes both sound brighter on a real piano — open the filter further for both.
  const brightness = velocity + Math.max(0, (note.midi - 60) / 48) * 0.5
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 0.7
  filter.frequency.setValueAtTime(Math.min(freq * preset.brightnessScale * brightness, 11000), start)
  filter.frequency.exponentialRampToValueAtTime(Math.max(freq * preset.filterEndScale, preset.filterFloorHz), decayEnd)

  const gain = ctx.createGain()
  const settleLevel = peak * preset.settleFactor
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + preset.attack) // strike
  gain.gain.exponentialRampToValueAtTime(settleLevel, settlePoint) // initial settle
  gain.gain.exponentialRampToValueAtTime(settleLevel * preset.sustainFactor, sustainPoint) // held/ring phase
  gain.gain.exponentialRampToValueAtTime(0.0001, decayEnd) // final release tail

  const osc = ctx.createOscillator()
  osc.setPeriodicWave(wave)
  osc.frequency.value = freq

  osc.connect(filter)
  filter.connect(gain)
  for (const destination of Array.isArray(destinations) ? destinations : [destinations]) {
    gain.connect(destination)
  }
  osc.start(start)
  osc.stop(stopAt)
  return osc
}

const NOTE_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']
// The bundled recordings (src/renderer/public/piano-samples, see its LICENSE.md for provenance)
// cover every semitone from C1 to C8 — nearly the full 88-key range, missing only the bottom three
// keys (A0/A#0/B0), which essentially never appear in piano sheet music.
const SAMPLE_MIN_MIDI = 24
const SAMPLE_MAX_MIDI = 108

function midiToSampleName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}`
}

const pianoSampleBuffers = new Map<number, AudioBuffer>()
let pianoSamplesPromise: Promise<void> | null = null

/**
 * Loads the bundled real-piano recordings in the background, decoded once and cached here for the
 * lifetime of the renderer process. Call this once, early (e.g. alongside `warmUpAudioContext` at
 * app startup) — `AudioPlayer.play()` never awaits it: a note whose sample has already finished
 * loading plays from the recording, and any note still missing (only possible for a click in the
 * first second or two after the app window opens) transparently falls back to the synthesized tone
 * (`schedulePianoNote`) for just that one call.
 */
export function loadPianoSamples(): Promise<void> {
  if (pianoSamplesPromise) return pianoSamplesPromise
  pianoSamplesPromise = (async () => {
    const ctx = new AudioContext()
    try {
      const midiNumbers = Array.from({ length: SAMPLE_MAX_MIDI - SAMPLE_MIN_MIDI + 1 }, (_, i) => SAMPLE_MIN_MIDI + i)
      await Promise.all(
        midiNumbers.map(async (midi) => {
          try {
            const response = await fetch(`piano-samples/${midiToSampleName(midi)}.mp3`)
            if (!response.ok) return
            const arrayBuffer = await response.arrayBuffer()
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
            pianoSampleBuffers.set(midi, audioBuffer)
          } catch (err) {
            console.warn('Failed to load piano sample for midi', midi, err)
          }
        })
      )
    } finally {
      void ctx.close()
    }
  })()
  return pianoSamplesPromise
}

/**
 * Schedules one note as playback of a real recorded piano sample instead of synthesis — see
 * `schedulePianoNote` for the synthesized fallback used by every other voice preset (and by piano
 * itself until its samples finish loading). `buffer` is an exact recording for `note.midi` only
 * when it falls in the bundled C1–C8 range; outside that (rare), the nearest edge sample is pitch-
 * shifted via `playbackRate` rather than left silent.
 */
function scheduleSampledPianoNote(
  ctx: BaseAudioContext,
  destinations: AudioNode | AudioNode[],
  buffer: AudioBuffer,
  note: PlaybackNote,
  sampleMidi: number,
  baseTime: number
): AudioBufferSourceNode {
  const start = Math.max(baseTime, baseTime + note.time)

  // Same pitch-dependent ring/tail shaping as the synthesized piano preset (schedulePianoNote) —
  // bass notes ring longer, treble notes die out faster, still capped so a dense passage's tails
  // don't stack up and overload audio rendering.
  const pitchRingFactor = Math.min(1.6, Math.max(0.55, 1.5 - (note.midi - 48) * 0.012))
  const ring = Math.min(Math.max(note.duration * 1.15 * pitchRingFactor, 0.25), 2.2)
  const velocity = 0.85 + Math.random() * 0.3
  const releaseStart = start + ring
  const stopAt = releaseStart + 0.3

  const gain = ctx.createGain()
  // The recording already has its own natural hammer-strike transient — only a sub-5ms fade-in to
  // avoid a click from starting the buffer exactly at a non-zero sample, not a synthesized attack.
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(velocity, start + 0.005)
  gain.gain.setValueAtTime(velocity, releaseStart)
  // Fades the recording's own tail out early for notes cut short by a fast passage, instead of
  // always letting the full recorded decay ring out and bleed into the next note.
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.playbackRate.value = Math.pow(2, (note.midi - sampleMidi) / 12)
  source.connect(gain)
  for (const destination of Array.isArray(destinations) ? destinations : [destinations]) {
    gain.connect(destination)
  }
  source.start(start)
  source.stop(stopAt)
  return source
}

const LEAD_IN = 0.15
/** Extra time after the last note's onset to let its longer pedal tail (and reverb) ring out before tearing down the AudioContext. */
export const TAIL_BUFFER = 1.6
/** Notes scheduled per animation frame — see `AudioPlayer.scheduleInChunks`. Small enough to stay
 * well under a frame budget even on slower hardware, large enough that even a long piece finishes
 * scheduling within a handful of frames. */
const AUDIO_SCHEDULE_CHUNK_SIZE = 150

/**
 * The very first `AudioContext` created in a renderer process pays a one-time cost to spin up the
 * browser's audio rendering thread and negotiate with the OS audio device — measured at 200ms+,
 * long enough to visibly freeze the UI if it happens synchronously inside the user's first click
 * on the play button. Call this once, as early as possible (e.g. right after the app window loads,
 * not tied to any user action), so that cost is absorbed in the background; every `AudioContext`
 * created afterwards — including the real one in `AudioPlayer.play()` — is then fast (observed:
 * ~2ms instead of ~250ms).
 */
export function warmUpAudioContext(): void {
  const ctx = new AudioContext()
  void ctx.close()
}

/**
 * Minimal Web Audio synth with a handful of selectable voices (see `VOICE_PRESETS`): one
 * oscillator per note through a 4-stage decay envelope and a closing lowpass filter (both shaped
 * by pitch and velocity), with a shared reverb send for resonance, instead of a flat sustained tone.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null
  private wave: PeriodicWave | null = null
  private oscillators: AudioScheduledSourceNode[] = []
  private endTimer: number | null = null
  private startedAt = 0
  private voice: VoicePreset = DEFAULT_VOICE_PRESET

  get isPlaying(): boolean {
    return this.ctx !== null
  }

  setVoice(preset: VoicePreset): void {
    this.voice = preset
  }

  /** Seconds of audio-clock time elapsed since playback began (0 if not playing). */
  getElapsedSeconds(): number {
    if (!this.ctx) return 0
    return Math.max(0, this.ctx.currentTime - this.startedAt)
  }

  play(notes: PlaybackNote[], onEnd: () => void): void {
    this.stop()
    if (notes.length === 0) {
      onEnd()
      return
    }

    const ctx = new AudioContext()
    this.ctx = ctx
    this.wave = buildVoiceWave(ctx, this.voice)
    this.startedAt = ctx.currentTime + LEAD_IN
    // The reverb send is a nice-to-have (ambience); if it fails to build for any reason, playback
    // must still work with a plain dry signal rather than go silent.
    let destinations: AudioNode[] = [ctx.destination]
    try {
      destinations = [ctx.destination, createReverbSend(ctx, ctx.destination)]
    } catch (err) {
      console.warn('Reverb unavailable, falling back to dry audio', err)
    }

    // maxEnd is cheap to get up front (no Web Audio node creation) — computing it before scheduling
    // means the end-of-playback timer starts immediately, independent of how long the scheduling
    // loop below actually takes.
    const maxEnd = notes.reduce((max, n) => Math.max(max, n.time + n.duration), 0)
    this.endTimer = window.setTimeout(() => {
      this.stop()
      onEnd()
    }, (maxEnd + TAIL_BUFFER) * 1000)

    this.scheduleInChunks(notes, 0, ctx, destinations)
  }

  /**
   * Builds each note's Web Audio graph (oscillator + filter + gain, see `schedulePianoNote`) in
   * small batches across animation frames instead of one synchronous loop over every note. A long,
   * dense piece (observed: ~2600 notes) was measured blocking the main thread for 100ms+ in one
   * tick when scheduled synchronously — long enough to visibly freeze the UI right as playback
   * starts. This is safe to split up because Web Audio schedules each oscillator by its own
   * absolute clock (`start(ctx.currentTime + ...)`), not by when the JS call scheduling it
   * happens — a note scheduled a few milliseconds "later" in wall-clock JS time still starts at
   * the exact right audio time, as long as that time hasn't already passed (the `LEAD_IN` buffer
   * before the very first note gives this comfortable margin even across several chunked frames).
   */
  private scheduleInChunks(notes: PlaybackNote[], startIndex: number, ctx: AudioContext, destinations: AudioNode[]): void {
    // Captured so a stop() (or a new play() replacing this.ctx) mid-chunking is detected and this
    // stale continuation aborts instead of scheduling onto a context that's no longer playing.
    const generation = this.ctx
    const end = Math.min(startIndex + AUDIO_SCHEDULE_CHUNK_SIZE, notes.length)

    for (let i = startIndex; i < end; i++) {
      const note = notes[i]
      try {
        // Real recordings only exist for the piano voice; every other preset keeps its synthesized
        // tone. Even for piano, a note falls back to synthesis if its sample hasn't finished
        // loading yet (only possible within the first second or two after app startup).
        const sampleMidi = Math.min(SAMPLE_MAX_MIDI, Math.max(SAMPLE_MIN_MIDI, Math.round(note.midi)))
        const buffer = this.voice.id === 'piano' ? pianoSampleBuffers.get(sampleMidi) : undefined
        const node = buffer
          ? scheduleSampledPianoNote(ctx, destinations, buffer, note, sampleMidi, this.startedAt)
          : schedulePianoNote(ctx, destinations, this.wave!, note, this.startedAt, this.voice)
        this.oscillators.push(node)
      } catch (err) {
        // A single malformed note (e.g. bad timing from an OMR/MusicXML edge case) must not
        // abort scheduling of every note after it.
        console.warn('Skipping unplayable note', note, err)
      }
    }

    if (end < notes.length && this.ctx === generation) {
      requestAnimationFrame(() => this.scheduleInChunks(notes, end, ctx, destinations))
    }
  }

  stop(): void {
    if (this.endTimer !== null) {
      window.clearTimeout(this.endTimer)
      this.endTimer = null
    }
    for (const osc of this.oscillators) {
      try {
        osc.stop()
      } catch {
        // already stopped
      }
    }
    this.oscillators = []
    this.wave = null
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
    }
  }
}
