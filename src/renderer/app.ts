import '../shared/types'
import { ScoreView } from './score-view'
import { PdfOverlayView } from './pdf-overlay-view'
import { parseOmrSheet, type OmrSheetData } from './omr-sheet'
import { parseMusicXmlEvents, type ChordEvent } from './musicxml-notes'
import { AudioPlayer, chordEventsToPlaybackNotes, VOICE_PRESETS, warmUpAudioContext } from './audio-player'
import { chordEventsToRollNotes, PianoRollRenderer, type HandMuteState } from './piano-roll'
import { exportOsmdAsPdf } from './svg-pdf-export'
import { decryptPdfIfNeeded } from './pdf-decrypt'
import { rasterizePdfPagesToPng } from './pdf-rasterize'
import type { HighlightEntry } from './label-layout'
import type { ConvertPdfResponse, ConvertPdfResult, HistoryEntry } from '../shared/types'

const appLayout = document.getElementById('app-layout') as HTMLElement
const divider = document.getElementById('divider') as HTMLElement
const collapseScoreButton = document.getElementById('collapse-score-button') as HTMLButtonElement
const collapseSidebarButton = document.getElementById('collapse-sidebar-button') as HTMLButtonElement
const toggleLabelsButton = document.getElementById('toggle-labels-button') as HTMLButtonElement
const sidebar = document.getElementById('sidebar') as HTMLElement
const openButton = document.getElementById('open-button') as HTMLButtonElement
const engineSelect = document.getElementById('engine-select') as HTMLSelectElement
const engineHint = document.getElementById('engine-hint') as HTMLElement
const passwordModal = document.getElementById('password-modal') as HTMLElement
const passwordInput = document.getElementById('password-input') as HTMLInputElement
const passwordError = document.getElementById('password-error') as HTMLElement
const passwordCancelButton = document.getElementById('password-cancel-button') as HTMLButtonElement
const passwordSubmitButton = document.getElementById('password-submit-button') as HTMLButtonElement
const historySelect = document.getElementById('history-select') as HTMLSelectElement
const historyDeleteButton = document.getElementById('history-delete-button') as HTMLButtonElement
const downloadButton = document.getElementById('download-button') as HTMLButtonElement
const muteRightCheckbox = document.getElementById('mute-right') as HTMLInputElement
const muteLeftCheckbox = document.getElementById('mute-left') as HTMLInputElement
const rollShowLabelsCheckbox = document.getElementById('roll-show-labels') as HTMLInputElement
const speedSlider = document.getElementById('speed') as HTMLInputElement
const speedLabel = document.getElementById('speed-label') as HTMLElement
const keyShiftSlider = document.getElementById('key-shift') as HTMLInputElement
const keyShiftLabel = document.getElementById('key-shift-label') as HTMLElement
const voiceSelect = document.getElementById('voice-select') as HTMLSelectElement
const statusEl = document.getElementById('status') as HTMLElement
const scoreScroll = document.getElementById('score-scroll') as HTMLElement
const scoreContainer = document.getElementById('score-container') as HTMLElement
const labelLayer = document.getElementById('label-layer') as HTMLElement
const rollPanel = document.getElementById('roll-panel') as HTMLElement
const rollCanvas = document.getElementById('roll-canvas') as HTMLCanvasElement
const rollPlayButton = document.getElementById('roll-play-button') as HTMLButtonElement

// Normal display: the original PDF with ドレミ overlaid at Audiveris's detected pixel positions,
// when that position data (.omr) is available — falls back to an OSMD re-engraving otherwise.
const scoreView = new ScoreView(scoreContainer, labelLayer)
const pdfOverlayView = new PdfOverlayView(scoreContainer, labelLayer)
const audioPlayer = new AudioPlayer()

/** Which view currently owns #score-container: the plain annotated-PDF export only applies to "pdf". */
let activeMode: 'osmd' | 'pdf' = 'osmd'
let currentPdfBaseName = 'score'
let currentMusicXmlText: string | null = null
// Cached so the score panel can be fully re-rendered (at a new width) after the divider is
// dragged, without re-fetching the PDF/OMR data from disk.
let currentPdfBytes: Uint8Array | null = null
let currentSheets: OmrSheetData[] | null = null
let currentChordEvents: ChordEvent[] | null = null
let highlightFrame: number | null = null
let highlightedElements = new Set<HTMLElement>()
let seekTime = 0
// The speed actually in effect for the segment currently playing — frozen at the moment playback
// (re)started. Deliberately NOT read live from speedSlider.value: currentElapsedTime() needs the
// speed that was active while time was elapsing, not whatever the slider shows right now (which
// may have already moved to a new value the user hasn't committed to a restart yet).
let activeSpeed = 1
let seekMarkerElement: HTMLElement | null = null
let rollRenderer: PianoRollRenderer | null = null
// The scroll target (#score-scroll.scrollTop) the last auto-scroll-to-playhead move aimed for —
// `null` means "not following yet" (forces the very next playing note to scroll immediately,
// rather than waiting for a big enough jump). See `autoScrollToPlayhead`.
let lastAutoScrollTop: number | null = null

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message
  statusEl.classList.toggle('error', isError)
}

function activeView(): ScoreView | PdfOverlayView {
  return activeMode === 'pdf' ? pdfOverlayView : scoreView
}

function currentMuteState(): HandMuteState {
  return { right: muteRightCheckbox.checked, left: muteLeftCheckbox.checked }
}

function clearHighlights(): void {
  for (const el of highlightedElements) el.classList.remove('playing')
  highlightedElements = new Set()
}

/**
 * Renders the current piece into a detached, off-screen (not display:none, so it still lays out
 * at a real width), A4-paginated OSMD instance, exports it as a printable multi-page PDF with
 * labels baked in, then discards the instance. Kept separate from the live `scoreView` (which
 * stays in continuous "Endless" layout for on-screen scrolling) purely for this fixed-page export.
 */
async function buildExportPdf(transpose: number): Promise<Uint8Array> {
  if (!currentMusicXmlText) throw new Error('楽譜が読み込まれていません')

  const wrapper = document.createElement('div')
  wrapper.style.position = 'fixed'
  wrapper.style.left = '-99999px'
  wrapper.style.top = '0'
  wrapper.style.width = '794px' // A4 portrait @ 96dpi
  const container = document.createElement('div')
  const tempLabelLayer = document.createElement('div')
  wrapper.append(container, tempLabelLayer)
  document.body.appendChild(wrapper)

  try {
    const view = new ScoreView(container, tempLabelLayer, { pageFormat: 'A4_P', compactLayout: true })
    await view.loadAndRender(currentMusicXmlText)
    view.setTranspose(transpose)
    return await exportOsmdAsPdf(container, view.getPlacements())
  } finally {
    wrapper.remove()
  }
}

function setSeekMarker(element: HTMLElement | null): void {
  seekMarkerElement?.classList.remove('seek-target')
  seekMarkerElement = element
  seekMarkerElement?.classList.add('seek-target')
}

/**
 * Re-renders the current score at #score-container's current width — both PdfOverlayView and
 * ScoreView lay out at whatever width they're given, but only at render time, so resizing the
 * panel (dragging the divider, or resizing the window) alone doesn't reflow already-rendered
 * content: it has to be asked to render again.
 */
async function reflowScore(): Promise<void> {
  if (!currentMusicXmlText) return
  if (activeMode === 'pdf' && currentPdfBytes && currentSheets && currentChordEvents) {
    await pdfOverlayView.render(currentPdfBytes, currentSheets, currentChordEvents)
    pdfOverlayView.setTranspose(Number(keyShiftSlider.value))
  } else if (activeMode === 'osmd') {
    await scoreView.loadAndRender(currentMusicXmlText)
    scoreView.setTranspose(Number(keyShiftSlider.value))
  }
  clearHighlights()
  setSeekMarker(null)
  // Every label's on-screen position just changed along with the layout, so the last scroll
  // target (an absolute pixel offset) no longer means anything — let the next playing note decide fresh.
  lastAutoScrollTop = null
  scrollAnim = null
}

/** Same left/right split used for piano-roll coloring: staff 1 (or unknown) = right hand, staff 2+ = left hand. */
function isStaffMuted(staff: number | null): boolean {
  const isLeftHand = staff !== null && staff >= 2
  return isLeftHand ? muteLeftCheckbox.checked : muteRightCheckbox.checked
}

/** Where playback currently is, in the piece's own (unscaled-by-speed) timeline. */
function currentElapsedTime(): number {
  if (!audioPlayer.isPlaying) return seekTime
  return seekTime + audioPlayer.getElapsedSeconds() * activeSpeed
}

/**
 * All of the piece's notes, in their original (unscaled) time domain, matching `elapsed` in
 * tickHighlight below — NOT the wall-clock domain audio scheduling uses (that distinction matters
 * once speed != 1x).
 */
function buildFullRollNotes() {
  if (!currentMusicXmlText) return []
  return chordEventsToRollNotes(parseMusicXmlEvents(currentMusicXmlText), 1, Number(keyShiftSlider.value))
}

/** (Re)builds the piano-roll renderer for the whole piece — the roll is always showing, so this runs on every piece load. */
function setupPianoRoll(): void {
  // The canvas's backing-store resolution is set to devicePixelRatio× its CSS size (not 1:1) so
  // the roll renders crisply on HiDPI/Retina displays instead of looking soft/blurry — CSS still
  // sizes the element at `width:100%; height:100%` regardless of this internal resolution.
  const dpr = window.devicePixelRatio || 1
  const cssWidth = rollPanel.clientWidth || 300
  const cssHeight = rollPanel.clientHeight || 280
  rollCanvas.width = Math.round(cssWidth * dpr)
  rollCanvas.height = Math.round(cssHeight * dpr)
  rollRenderer = new PianoRollRenderer(rollCanvas, buildFullRollNotes(), 160, dpr)
  rollRenderer.setMuted(currentMuteState())
  rollRenderer.setShowLabels(rollShowLabelsCheckbox.checked)
  rollRenderer.drawFrame(currentElapsedTime())
}

function applyHighlightSet(entries: HighlightEntry[], elapsed: number, previous: Set<HTMLElement>): Set<HTMLElement> {
  const next = new Set<HTMLElement>()
  for (const entry of entries) {
    if (elapsed >= entry.time && elapsed < entry.time + entry.duration) {
      next.add(entry.element)
    }
  }
  for (const el of previous) if (!next.has(el)) el.classList.remove('playing')
  for (const el of next) if (!previous.has(el)) el.classList.add('playing')
  return next
}

// How far below the score panel's own top padding the playing line should land — not flush
// against the very edge, so the staff/system doesn't look clipped.
const AUTO_SCROLL_TOP_PADDING = 40
// Only actually scroll when the target moves by more than this — a chord's several notes land at
// slightly different label heights (tier-stacked to avoid overlapping), and without a threshold
// that jitter would make the view creep around during a single line instead of holding still.
const AUTO_SCROLL_TRIGGER_PX = 50
const AUTO_SCROLL_ANIM_MS = 450

// Driven by `tickScrollAnim` from inside the same rAF loop as the piano-roll's own redraw — NOT
// `Element.scrollTo({ behavior: 'smooth' })`. That native smooth-scroll runs as a second, separate
// animation system alongside the roll's rAF loop; the two competing for the same frame budget is
// what caused the roll to visibly slow down right at the moment each auto-scroll kicked in
// (reported after a first fix already removed a `getBoundingClientRect` layout-thrashing issue —
// this is the second, independent cause of "sudden slowdowns"). Tweening scrollTop by hand here
// keeps everything on one clock, so a scroll in progress costs no more than the handful of extra
// arithmetic operations below.
let scrollAnim: { from: number; to: number; startedAt: number } | null = null

function startScrollAnim(to: number): void {
  scrollAnim = { from: scoreScroll.scrollTop, to, startedAt: performance.now() }
}

function tickScrollAnim(): void {
  if (!scrollAnim) return
  const t = Math.min(1, (performance.now() - scrollAnim.startedAt) / AUTO_SCROLL_ANIM_MS)
  const eased = 1 - Math.pow(1 - t, 3) // ease-out cubic
  scoreScroll.scrollTop = scrollAnim.from + (scrollAnim.to - scrollAnim.from) * eased
  if (t >= 1) scrollAnim = null
}

/**
 * Keeps the currently-playing line scrolled to the top of the score panel, like a line follower —
 * moves only when playback has reached a new system/row (a big vertical jump), not for every note
 * within the line that's already at the top.
 *
 * Reads the label's own `style.top` (already set, in the same scroll-content coordinate space, by
 * `renderPlacementsToDom` in label-layout.ts) instead of `getBoundingClientRect()`. This runs once
 * per animation frame during playback, right after `applyHighlightSet` just toggled `.playing` on
 * some labels — calling `getBoundingClientRect()` there forces a synchronous layout recalculation
 * on every single frame ("layout thrashing"), which was the actual cause of the choppy piano-roll
 * playback this was meant to fix: a plain property read costs nothing by comparison and makes the
 * whole function layout-free.
 */
function autoScrollToPlayhead(element: HTMLElement): void {
  const topPx = parseFloat(element.style.top)
  if (!Number.isFinite(topPx)) return
  const targetScrollTop = Math.max(0, topPx - AUTO_SCROLL_TOP_PADDING)

  if (lastAutoScrollTop !== null && Math.abs(targetScrollTop - lastAutoScrollTop) < AUTO_SCROLL_TRIGGER_PX) return

  lastAutoScrollTop = targetScrollTop
  startScrollAnim(targetScrollTop)
}

/** Re-reads which entries to highlight every frame rather than freezing them at playback start. */
function tickHighlight(speed: number, offset: number): void {
  if (!audioPlayer.isPlaying) {
    clearHighlights()
    highlightFrame = null
    return
  }

  const elapsed = offset + audioPlayer.getElapsedSeconds() * speed
  highlightedElements = applyHighlightSet(activeView().getHighlightEntries(), elapsed, highlightedElements)
  rollRenderer?.drawFrame(elapsed)

  const leadingElement = highlightedElements.values().next().value
  if (leadingElement) autoScrollToPlayhead(leadingElement)
  tickScrollAnim()

  highlightFrame = requestAnimationFrame(() => tickHighlight(speed, offset))
}

function startPlayback(fromTime: number): void {
  if (!currentMusicXmlText) return

  const speed = Number(speedSlider.value)
  activeSpeed = speed
  const transpose = Number(keyShiftSlider.value)
  const allEvents = parseMusicXmlEvents(currentMusicXmlText)
  const eventsFromSeek = allEvents
    .filter((event) => event.time + event.duration > fromTime && !isStaffMuted(event.staff))
    .map((event) => ({ ...event, time: Math.max(0, event.time - fromTime) }))
  const notes = chordEventsToPlaybackNotes(eventsFromSeek, speed, transpose)

  setSeekMarker(null)
  rollPlayButton.textContent = '一時停止'
  audioPlayer.play(notes, () => {
    rollPlayButton.textContent = '▶'
    seekTime = 0
  })

  // Forces the very first playing note of this (re)started segment to scroll immediately,
  // regardless of how close it is to wherever the view already happens to be sitting.
  lastAutoScrollTop = null
  scrollAnim = null

  if (highlightFrame !== null) cancelAnimationFrame(highlightFrame)
  highlightFrame = requestAnimationFrame(() => tickHighlight(speed, fromTime))
}

async function setCurrentPiece(musicXmlText: string | null): Promise<void> {
  currentMusicXmlText = musicXmlText
  rollPlayButton.disabled = !musicXmlText
  toggleLabelsButton.disabled = !musicXmlText
  seekTime = 0
  setSeekMarker(null)
  audioPlayer.stop()
  if (highlightFrame !== null) {
    cancelAnimationFrame(highlightFrame)
    highlightFrame = null
  }
  clearHighlights()
  rollPlayButton.textContent = '▶'
  lastAutoScrollTop = null
  scrollAnim = null

  if (musicXmlText) {
    setupPianoRoll()
    // By this point the score (PDF or re-engraved OSMD) is already painted — fade the ドレミ
    // overlay in just after, like a second transparent sheet being laid on top, rather than
    // having both appear in the same instant.
    labelLayer.classList.remove('labels-ready')
    void labelLayer.offsetWidth // force a reflow so the opacity:0 state commits before animating
    window.setTimeout(() => labelLayer.classList.add('labels-ready'), 220)
  } else {
    rollRenderer = null
    labelLayer.classList.remove('labels-ready')
  }
}

async function refreshHistory(selectCacheKey?: string): Promise<void> {
  const entries = await window.musicSheet.listHistory()
  historySelect.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = entries.length === 0 ? '(履歴はありません)' : '(選択してください)'
  historySelect.appendChild(placeholder)

  for (const entry of entries) {
    const option = document.createElement('option')
    option.value = entry.cacheKey
    const date = new Date(entry.convertedAt)
    const engineSuffix = entry.engine === 'homr' ? '(homr)' : ''
    option.textContent = `${entry.originalFileName} (${date.toLocaleDateString('ja-JP')} ${date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}) ${engineSuffix}`.trim()
    historySelect.appendChild(option)
  }

  if (selectCacheKey) historySelect.value = selectCacheKey
  historyDeleteButton.disabled = !historySelect.value
}

/** Renders a successful conversion result (fresh or from history) — shared by both entry points. */
async function loadConvertResult(result: ConvertPdfResult, displayName: string): Promise<void> {
  currentPdfBaseName = displayName.replace(/\.pdf$/i, '')
  const musicXmlText = await window.musicSheet.readMusicXmlText(result.musicXmlPath)

  if (!result.omrPath) {
    // Fallback: no .omr position data available, re-engrave from MusicXML instead of overlaying the original PDF.
    setStatus('楽譜を描画しています(位置情報なし: 再描画表示)...')
    activeMode = 'osmd'
    currentPdfBytes = null
    currentSheets = null
    currentChordEvents = null
    await scoreView.loadAndRender(musicXmlText)
    scoreView.setTranspose(Number(keyShiftSlider.value))
    downloadButton.disabled = false
    await setCurrentPiece(musicXmlText)
    setStatus('')
    return
  }

  setStatus('元のPDFにドレミを重ねています...')
  const [pdfBytes, sheetXmls] = await Promise.all([
    window.musicSheet.readScoreFile(result.pdfPath),
    window.musicSheet.readOmrSheets(result.omrPath),
  ])

  const sheets = sheetXmls.map(parseOmrSheet)
  const chordEvents = parseMusicXmlEvents(musicXmlText)
  currentPdfBytes = pdfBytes
  currentSheets = sheets
  currentChordEvents = chordEvents

  activeMode = 'pdf'
  await pdfOverlayView.render(pdfBytes, sheets, chordEvents)
  pdfOverlayView.setTranspose(Number(keyShiftSlider.value))
  downloadButton.disabled = false
  await setCurrentPiece(musicXmlText)
  setStatus('')
}

window.musicSheet.onOmrProgress((message) => {
  setStatus(message)
})

engineSelect.addEventListener('change', () => {
  engineHint.hidden = engineSelect.value !== 'homr'
})

speedSlider.addEventListener('input', () => {
  speedLabel.textContent = `${Number(speedSlider.value).toFixed(2)}x`
})

// Applied on release (not every 'input' tick while dragging) so a continuous drag across the
// range doesn't retrigger playback dozens of times — 'change' fires once the value is committed.
speedSlider.addEventListener('change', () => {
  if (audioPlayer.isPlaying) {
    seekTime = currentElapsedTime()
    startPlayback(seekTime)
  }
})

keyShiftSlider.addEventListener('input', () => {
  const value = Number(keyShiftSlider.value)
  keyShiftLabel.textContent = value === 0 ? '0' : value > 0 ? `+${value}` : `${value}`

  // Relabel/re-engrave whichever score view is currently loaded — the PDF overlay can only
  // relabel in place (the raster noteheads can't move), while OSMD truly re-engraves with
  // correct accidentals for the new key.
  if (activeMode === 'osmd') scoreView.setTranspose(value)
  else pdfOverlayView.setTranspose(value)
  rollRenderer?.drawFrame(currentElapsedTime())

  if (audioPlayer.isPlaying) {
    seekTime = currentElapsedTime()
    startPlayback(seekTime)
  } else {
    setSeekMarker(null)
  }
})

for (const preset of VOICE_PRESETS) {
  const option = document.createElement('option')
  option.value = preset.id
  option.textContent = preset.label
  voiceSelect.appendChild(option)
}

voiceSelect.addEventListener('change', () => {
  const preset = VOICE_PRESETS.find((p) => p.id === voiceSelect.value) ?? VOICE_PRESETS[0]
  audioPlayer.setVoice(preset)
  if (audioPlayer.isPlaying) {
    seekTime = currentElapsedTime()
    startPlayback(seekTime)
  }
})

/**
 * Shows the password popup and resolves with whatever the user types in (on submit/Enter), or
 * `null` if they cancel (click Cancel or press Escape) — `decryptPdfIfNeeded` calls this again,
 * with `attemptFailed: true`, for each wrong guess.
 */
function promptForPassword(attemptFailed: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    passwordError.hidden = !attemptFailed
    passwordInput.value = ''
    passwordModal.hidden = false
    passwordInput.focus()

    const cleanup = (): void => {
      passwordModal.hidden = true
      passwordSubmitButton.removeEventListener('click', onSubmit)
      passwordCancelButton.removeEventListener('click', onCancel)
      passwordInput.removeEventListener('keydown', onKeydown)
    }
    const onSubmit = (): void => {
      cleanup()
      resolve(passwordInput.value)
    }
    const onCancel = (): void => {
      cleanup()
      resolve(null)
    }
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') onSubmit()
      else if (event.key === 'Escape') onCancel()
    }

    passwordSubmitButton.addEventListener('click', onSubmit)
    passwordCancelButton.addEventListener('click', onCancel)
    passwordInput.addEventListener('keydown', onKeydown)
  })
}

async function convertViaAudiveris(effectivePdfPath: string): Promise<ConvertPdfResponse> {
  setStatus('楽譜を認識しています(Audiveris)...')
  return window.musicSheet.convertPdfToMusicXml(effectivePdfPath)
}

/** Returns `null` (already reported via setStatus) if homr isn't installed — the caller should
 * just stop, not treat `null` as a ConvertPdfError. */
async function convertViaHomr(effectivePdfPath: string, pdfBytes: Uint8Array): Promise<ConvertPdfResponse | null> {
  setStatus('homrの利用可否を確認しています...')
  if (!(await window.musicSheet.checkHomrAvailable())) {
    setStatus('homrが見つかりません。vendor/homr/README.md の手順でインストールしてください。', true)
    return null
  }

  setStatus('PDFをページ画像に変換しています...')
  const pngPages = await rasterizePdfPagesToPng(pdfBytes)

  setStatus(`楽譜を認識しています(homr・実験的: 全${pngPages.length}ページ、1ページ数分〜十数分かかることがあります)...`)
  return window.musicSheet.convertPdfToMusicXmlViaHomr(effectivePdfPath, pngPages)
}

openButton.addEventListener('click', async () => {
  const pdfPath = await window.musicSheet.openPdfDialog()
  if (!pdfPath) return

  openButton.disabled = true
  downloadButton.disabled = true
  await setCurrentPiece(null)

  try {
    // Audiveris and pdf-lib can't open a password-protected PDF themselves (see pdf-decrypt.ts) —
    // check for one and, if needed, decrypt to a plain rebuilt PDF before OMR ever sees it.
    setStatus('PDFを確認しています...')
    const originalBytes = await window.musicSheet.readScoreFile(pdfPath)
    const bytesToConvert = await decryptPdfIfNeeded(originalBytes, promptForPassword)
    if (bytesToConvert === null) {
      setStatus('キャンセルしました')
      return
    }

    const fileName = pdfPath.split(/[\\/]/).pop() ?? 'score.pdf'
    // Only when it was actually decrypted (bytesToConvert is a new buffer, not the same bytes we
    // just read) does the OMR engine need a different file — handing it the rebuilt, unprotected
    // PDF instead of the original, since that's the one it can actually read.
    const effectivePdfPath = bytesToConvert === originalBytes ? pdfPath : await window.musicSheet.writeTempPdf(bytesToConvert, fileName)

    const result =
      engineSelect.value === 'homr' ? await convertViaHomr(effectivePdfPath, bytesToConvert) : await convertViaAudiveris(effectivePdfPath)
    if (!result) return // already reported (not-available / canceled) inside the helper
    if (!result.ok) {
      setStatus(result.message, true)
      return
    }

    await loadConvertResult(result, fileName)
    await refreshHistory()
  } catch (err) {
    setStatus(`エラー: ${(err as Error).message}`, true)
  } finally {
    openButton.disabled = false
  }
})

historySelect.addEventListener('change', async () => {
  const cacheKey = historySelect.value
  historyDeleteButton.disabled = !cacheKey
  if (!cacheKey) return

  const entries = await window.musicSheet.listHistory()
  const entry = entries.find((e: HistoryEntry) => e.cacheKey === cacheKey)
  if (!entry) return

  downloadButton.disabled = true
  await setCurrentPiece(null)
  setStatus('履歴から読み込んでいます...')
  try {
    await loadConvertResult(
      { ok: true, pdfPath: entry.pdfPath, musicXmlPath: entry.musicXmlPath, omrPath: entry.omrPath, fromCache: true, engine: entry.engine },
      entry.originalFileName
    )
  } catch (err) {
    setStatus(`エラー: ${(err as Error).message}`, true)
  }
})

historyDeleteButton.addEventListener('click', async () => {
  const cacheKey = historySelect.value
  if (!cacheKey) return
  await window.musicSheet.deleteHistoryEntry(cacheKey)
  await refreshHistory()
  setStatus('履歴を削除しました')
})

downloadButton.addEventListener('click', async () => {
  if (!currentMusicXmlText) return

  downloadButton.disabled = true
  const transpose = Number(keyShiftSlider.value)
  const keySuffix = transpose === 0 ? '' : `_キー${transpose > 0 ? '+' : ''}${transpose}`

  try {
    let bytes: Uint8Array
    let suffix = keySuffix
    if (activeMode === 'pdf' && transpose === 0) {
      setStatus('PDFを書き出しています...')
      bytes = await pdfOverlayView.exportAnnotatedPdf()
    } else {
      // Either the OSMD fallback mode already, or the original PDF can't show a real
      // transposition (its noteheads can't move) — fall back to a freshly re-engraved OSMD PDF.
      if (activeMode === 'pdf') {
        setStatus('元のPDFは移調できないため、五線譜を描き直して書き出しています...')
        suffix += '_五線譜'
      } else {
        setStatus('PDFを書き出しています...')
      }
      bytes = await buildExportPdf(transpose)
    }

    const saved = await window.musicSheet.saveFile(bytes, `${currentPdfBaseName}_ドレミ付き${suffix}.pdf`)
    setStatus(saved ? '保存しました' : '保存をキャンセルしました')
  } catch (err) {
    setStatus(`エラー: ${(err as Error).message}`, true)
  } finally {
    downloadButton.disabled = false
  }
})

// The roll's own overlay button doubles as the play/pause control (replaces a separate toolbar button).
rollPlayButton.addEventListener('click', () => {
  if (audioPlayer.isPlaying) {
    // Capture the current position *before* stopping (stop() makes isPlaying false, at which
    // point currentElapsedTime() would just return the old, stale seekTime) so the next play
    // resumes from here instead of restarting from the beginning.
    seekTime = currentElapsedTime()
    audioPlayer.stop()
    rollPlayButton.textContent = '▶'
    return
  }

  startPlayback(seekTime)
})

function findClosestEntry(entries: HighlightEntry[], clientX: number, clientY: number): HighlightEntry | null {
  let closest: HighlightEntry | null = null
  let closestDistance = Infinity
  for (const entry of entries) {
    const rect = entry.element.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const distance = Math.hypot(cx - clientX, cy - clientY)
    if (distance < closestDistance) {
      closestDistance = distance
      closest = entry
    }
  }
  return closest
}

// Click anywhere on the score to pick where playback starts — jumps immediately if already playing.
scoreContainer.addEventListener('click', (event) => {
  if (!currentMusicXmlText) return
  const closest = findClosestEntry(activeView().getHighlightEntries(), event.clientX, event.clientY)
  if (!closest) return

  seekTime = closest.time
  if (audioPlayer.isPlaying) {
    startPlayback(seekTime)
  } else {
    setSeekMarker(closest.element)
    setStatus(`再生位置を指定しました(${seekTime.toFixed(1)}秒)`)
    rollRenderer?.drawFrame(seekTime)
  }
})

function handleMuteChange(): void {
  rollRenderer?.setMuted(currentMuteState())
  rollRenderer?.drawFrame(currentElapsedTime())
  if (audioPlayer.isPlaying) {
    seekTime = currentElapsedTime()
    startPlayback(seekTime)
  }
}
// Muting both hands at once isn't a meaningful practice mode, so the two checkboxes are mutually
// exclusive: checking one always unchecks the other (whichever was checked most recently wins).
muteRightCheckbox.addEventListener('change', () => {
  if (muteRightCheckbox.checked) muteLeftCheckbox.checked = false
  handleMuteChange()
})
muteLeftCheckbox.addEventListener('change', () => {
  if (muteLeftCheckbox.checked) muteRightCheckbox.checked = false
  handleMuteChange()
})

rollShowLabelsCheckbox.addEventListener('change', () => {
  rollRenderer?.setShowLabels(rollShowLabelsCheckbox.checked)
  rollRenderer?.drawFrame(currentElapsedTime())
})

// Draggable divider between the score and the sidebar — the chosen width (inline style) takes
// precedence over the CSS default (50/50) until the app is reloaded.
let dividerDragging = false
let dividerStartX = 0
let dividerStartWidth = 0
const SIDEBAR_MIN_WIDTH = 260
const SCORE_MIN_WIDTH = 240

divider.addEventListener('mousedown', (event) => {
  dividerDragging = true
  dividerStartX = event.clientX
  dividerStartWidth = sidebar.getBoundingClientRect().width
  divider.classList.add('dragging')
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
})

window.addEventListener('mousemove', (event) => {
  if (!dividerDragging) return
  const delta = event.clientX - dividerStartX
  const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - SCORE_MIN_WIDTH - divider.offsetWidth)
  const newWidth = Math.min(maxWidth, Math.max(SIDEBAR_MIN_WIDTH, dividerStartWidth - delta))
  sidebar.style.flexBasis = `${newWidth}px`
  sidebar.style.width = `${newWidth}px`
})

window.addEventListener('mouseup', () => {
  if (!dividerDragging) return
  dividerDragging = false
  divider.classList.remove('dragging')
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  void reflowScore()
})

// Also reflow on a plain window resize (not just divider drags) so the score never ends up
// narrower or wider than the panel actually showing it.
let resizeDebounce: number | null = null
window.addEventListener('resize', () => {
  if (resizeDebounce !== null) window.clearTimeout(resizeDebounce)
  resizeDebounce = window.setTimeout(() => {
    resizeDebounce = null
    void reflowScore()
  }, 200)
})

// Collapse buttons on the divider — hide either side entirely so the other can use the full
// window width. Showing one side always hides the other (there's no point hiding both).
let scoreHidden = false
let sidebarHidden = false

function updateCollapseButtons(): void {
  collapseScoreButton.textContent = scoreHidden ? '楽譜を表示' : '楽譜を隠す'
  collapseScoreButton.classList.toggle('active', scoreHidden)
  collapseSidebarButton.textContent = sidebarHidden ? '設定を表示' : '設定を隠す'
  collapseSidebarButton.classList.toggle('active', sidebarHidden)
}

collapseScoreButton.addEventListener('click', async () => {
  scoreHidden = !scoreHidden
  if (scoreHidden) sidebarHidden = false
  appLayout.classList.toggle('hide-score', scoreHidden)
  appLayout.classList.toggle('hide-sidebar', sidebarHidden)
  updateCollapseButtons()
  if (!scoreHidden) await reflowScore()
})

collapseSidebarButton.addEventListener('click', () => {
  sidebarHidden = !sidebarHidden
  if (sidebarHidden) scoreHidden = false
  appLayout.classList.toggle('hide-sidebar', sidebarHidden)
  appLayout.classList.toggle('hide-score', scoreHidden)
  updateCollapseButtons()
  if (!sidebarHidden) setupPianoRoll()
})

// Toggles the ドレミ overlay on the score, like swapping between a labeled and an unlabeled copy
// of the same sheet music — the underlying notation (PDF raster or OSMD re-engraving) never changes.
let labelsHidden = false
toggleLabelsButton.addEventListener('click', () => {
  labelsHidden = !labelsHidden
  appLayout.classList.toggle('hide-labels', labelsHidden)
  toggleLabelsButton.textContent = labelsHidden ? 'ドレミを表示' : 'ドレミを隠す'
  toggleLabelsButton.classList.toggle('active', labelsHidden)
})

refreshHistory()

// Absorbs the ~200ms+ one-time cost of spinning up the browser's audio thread in the background,
// well before the user's first click on the play button — see `warmUpAudioContext`.
warmUpAudioContext()
