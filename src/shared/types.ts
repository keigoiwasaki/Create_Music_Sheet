/** Which OMR engine produced a conversion. 'audiveris' is the default, full-featured path (produces
 * pixel-position data for the original-PDF overlay); 'homr' is an experimental, free alternative
 * that only ever produces MusicXML (no position data — always falls back to the OSMD re-engraved
 * display path, see app.ts's loadConvertResult). */
export type OmrEngine = 'audiveris' | 'homr'

export interface ConvertPdfResult {
  ok: true
  /** Path to read the PDF bytes from — the original file, or a cached copy when loaded from history. */
  pdfPath: string
  musicXmlPath: string
  /** Path to the Audiveris .omr book file (per-sheet pixel-accurate symbol positions), when available. */
  omrPath: string | null
  /** True when this result came from the persistent cache instead of a fresh conversion. */
  fromCache: boolean
  engine: OmrEngine
}

export interface ConvertPdfError {
  ok: false
  errorCode: 'java-not-found' | 'audiveris-not-found' | 'omr-failed' | 'no-output' | 'homr-not-found'
  message: string
}

export type ConvertPdfResponse = ConvertPdfResult | ConvertPdfError

/** A previously-converted piece, persisted so it can be reopened without re-running OMR. */
export interface HistoryEntry {
  /** Content hash of the source PDF — the same PDF converted by two different engines shares this
   * value but gets two separate history entries (see cacheKey). */
  hash: string
  /** The actual cache-directory/lookup key — distinct from `hash` once more than one engine can
   * produce results for the same PDF. Use this (not `hash`) for selecting/deleting a history entry. */
  cacheKey: string
  engine: OmrEngine
  originalFileName: string
  /** ISO timestamp of when it was converted. */
  convertedAt: string
  pdfPath: string
  musicXmlPath: string
  omrPath: string | null
}

export interface MusicSheetApi {
  openPdfDialog(): Promise<string | null>
  convertPdfToMusicXml(pdfPath: string): Promise<ConvertPdfResponse>
  /** Raw bytes of a file (PDF, image, etc). */
  readScoreFile(path: string): Promise<Uint8Array>
  /** Plain MusicXML text, decompressing a .mxl container transparently. */
  readMusicXmlText(path: string): Promise<string>
  /** Raw XML text of each sheet inside the Audiveris .omr book file, ordered by sheet/page number. */
  readOmrSheets(omrPath: string): Promise<string[]>
  /** Subscribes to OMR progress messages for the in-flight conversion; returns an unsubscribe function. */
  onOmrProgress(callback: (message: string) => void): () => void
  /** Opens a native save dialog and writes bytes to the chosen path; returns false if canceled. */
  saveFile(bytes: Uint8Array, suggestedName: string): Promise<boolean>
  /**
   * Silently writes bytes to a new temp file (no dialog) and returns its path — used to hand a
   * password-decrypted PDF (rebuilt in the renderer, see pdf-decrypt.ts) to Audiveris, which can
   * only read PDFs from a real file path, not from in-memory bytes.
   */
  writeTempPdf(bytes: Uint8Array, suggestedName: string): Promise<string>
  /** Previously-converted pieces, newest first. */
  listHistory(): Promise<HistoryEntry[]>
  deleteHistoryEntry(cacheKey: string): Promise<void>
  /** Changes a history entry's display name (does not touch the cached PDF/MusicXML files themselves). */
  renameHistoryEntry(cacheKey: string, newName: string): Promise<void>
  /** Whether the experimental homr OMR engine is installed and runnable. */
  checkHomrAvailable(): Promise<boolean>
  /**
   * Converts via homr instead of Audiveris: `pngPages` are pre-rasterized page images (homr only
   * accepts single images, not PDFs — see pdf-rasterize.ts), one per page, in order. `pdfPath` is
   * still needed for hashing/caching and the returned `pdfPath` field.
   */
  convertPdfToMusicXmlViaHomr(pdfPath: string, pngPages: Uint8Array[]): Promise<ConvertPdfResponse>
}

declare global {
  interface Window {
    musicSheet: MusicSheetApi
  }
}
