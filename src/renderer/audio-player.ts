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

const LEAD_IN = 0.15
/** Extra time after the last note's onset to let its longer pedal tail (and reverb) ring out before tearing down the AudioContext. */
export const TAIL_BUFFER = 1.6

/**
 * Minimal Web Audio synth with a handful of selectable voices (see `VOICE_PRESETS`): one
 * oscillator per note through a 4-stage decay envelope and a closing lowpass filter (both shaped
 * by pitch and velocity), with a shared reverb send for resonance, instead of a flat sustained tone.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null
  private wave: PeriodicWave | null = null
  private oscillators: OscillatorNode[] = []
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
    let maxEnd = 0

    for (const note of notes) {
      try {
        this.oscillators.push(schedulePianoNote(ctx, destinations, this.wave, note, this.startedAt, this.voice))
      } catch (err) {
        // A single malformed note (e.g. bad timing from an OMR/MusicXML edge case) must not
        // abort scheduling of every note after it in the loop.
        console.warn('Skipping unplayable note', note, err)
        continue
      }
      maxEnd = Math.max(maxEnd, note.time + note.duration)
    }

    this.endTimer = window.setTimeout(() => {
      this.stop()
      onEnd()
    }, (maxEnd + TAIL_BUFFER) * 1000)
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
