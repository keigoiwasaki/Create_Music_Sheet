import { getDocument, GlobalWorkerOptions, PasswordException } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument } from 'pdf-lib'

// Harmless to set again if pdf-overlay-view.ts already has (same global, same value) — this file
// shouldn't depend on another module happening to be imported first.
GlobalWorkerOptions.workerSrc = workerUrl

/** How many CSS-pixel-equivalent units per PDF point to render each page at — higher than the
 * score panel's own on-screen rendering since this becomes the actual file OMR reads from. */
const RENDER_SCALE = 2.5
/** pdf.js lays out pages in 96dpi CSS pixels; PDF page size is in 72dpi points. */
const PX_TO_PT = 72 / 96

/**
 * Returns `bytes` unchanged if the PDF isn't password-protected. Otherwise calls `promptForPassword`
 * (expected to show a UI prompt and resolve with the typed password, or `null` if the user cancels)
 * in a loop — once for the first attempt, again for each wrong guess — until either a correct
 * password is given or the user cancels (in which case this returns `null`).
 *
 * Neither Audiveris nor pdf-lib can open a password-protected PDF themselves (Audiveris's CLI has
 * no password option at all; pdf-lib's `ignoreEncryption` only bypasses owner-only restrictions,
 * it can't actually decrypt real user-password content). So once the right password unlocks the
 * document in pdf.js (which fully supports this), every page is rendered to an image and
 * reassembled into a brand new, completely unencrypted PDF — the same rasterize-and-rebuild
 * technique this app already uses for its own annotated-PDF export — so everything downstream
 * (Audiveris, our own PDF-overlay renderer) can treat it exactly like any other plain file.
 */
export async function decryptPdfIfNeeded(
  bytes: Uint8Array,
  promptForPassword: (attemptFailed: boolean) => Promise<string | null>
): Promise<Uint8Array | null> {
  try {
    const pdf = await getDocument({ data: bytes.slice() }).promise
    await pdf.loadingTask.destroy()
    return bytes // not password-protected — nothing to do
  } catch (err) {
    if (!(err instanceof PasswordException)) throw err
  }

  let attemptFailed = false
  for (;;) {
    const password = await promptForPassword(attemptFailed)
    if (password === null) return null

    try {
      const pdf = await getDocument({ data: bytes.slice(), password }).promise
      const rebuilt = await rebuildAsPlainPdf(pdf)
      await pdf.loadingTask.destroy()
      return rebuilt
    } catch (err) {
      if (err instanceof PasswordException) {
        attemptFailed = true
        continue
      }
      throw err
    }
  }
}

async function rebuildAsPlainPdf(pdf: Awaited<ReturnType<typeof getDocument>['promise']>): Promise<Uint8Array> {
  const doc = await PDFDocument.create()

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const unscaledViewport = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: RENDER_SCALE })

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2Dコンテキストを取得できませんでした')
    await page.render({ canvasContext: ctx, viewport, canvas }).promise

    const pngUrl = canvas.toDataURL('image/png')
    const pngBytes = Uint8Array.from(atob(pngUrl.split(',')[1]), (c) => c.charCodeAt(0))
    const pngImage = await doc.embedPng(pngBytes)
    const widthPt = unscaledViewport.width * PX_TO_PT
    const heightPt = unscaledViewport.height * PX_TO_PT
    const pdfPage = doc.addPage([widthPt, heightPt])
    pdfPage.drawImage(pngImage, { x: 0, y: 0, width: widthPt, height: heightPt })
  }

  return doc.save()
}
