import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Harmless to set again if another module already has (same global, same value).
GlobalWorkerOptions.workerSrc = workerUrl

/** How many CSS-pixel-equivalent units per PDF point to render each page at. Matches
 * pdf-decrypt.ts's RENDER_SCALE as a reasonable starting point for an OMR engine's input image. */
const DEFAULT_SCALE = 2.5

/**
 * Rasterizes every page of a PDF to a PNG, in page order — used for experimental OMR engines
 * (e.g. homr) that, unlike Audiveris, only accept a single image per call, never a whole PDF. Same
 * per-page canvas-render technique as pdf-decrypt.ts's `rebuildAsPlainPdf`, but returns raw PNG
 * bytes directly instead of reassembling them into a new PDF.
 */
export async function rasterizePdfPagesToPng(bytes: Uint8Array, scale = DEFAULT_SCALE): Promise<Uint8Array[]> {
  const pdf = await getDocument({ data: bytes.slice() }).promise
  const pages: Uint8Array[] = []

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale })

      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2Dコンテキストを取得できませんでした')
      await page.render({ canvasContext: ctx, viewport, canvas }).promise

      const pngUrl = canvas.toDataURL('image/png')
      pages.push(Uint8Array.from(atob(pngUrl.split(',')[1]), (c) => c.charCodeAt(0)))
    }
  } finally {
    await pdf.loadingTask.destroy()
  }

  return pages
}
