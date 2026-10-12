export interface ConvertPdfResult {
  ok: true
  /** Path to read the PDF bytes from — the original file, or a cached copy when loaded from history. */
  pdfPath: string
  musicXmlPath: string
  /** Path to the Audiveris .omr book file (per-sheet pixel-accurate symbol positions), when available. */
  omrPath: string | null
  /** True when this result came from the persistent cache instead of a fresh Audiveris run. */
  fromCache: boolean
}

export interface ConvertPdfError {
  ok: false
  errorCode: 'java-not-found' | 'audiveris-not-found' | 'omr-failed' | 'no-output'
  message: string
}

export type ConvertPdfResponse = ConvertPdfResult | ConvertPdfError

/** A previously-converted piece, persisted so it can be reopened without re-running Audiveris. */
export interface HistoryEntry {
  hash: string
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
  deleteHistoryEntry(hash: string): Promise<void>
}

declare global {
  interface Window {
    musicSheet: MusicSheetApi
  }
}
