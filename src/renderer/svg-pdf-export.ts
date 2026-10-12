import { PDFDocument } from 'pdf-lib'
import { drawPlacementsOnCanvas, type PlacedLabel } from './label-layout'

const RASTER_SCALE = 2
/** OSMD lays out pages at 96dpi CSS pixels; PDF page size is in 72dpi points. */
const PX_TO_PT = 72 / 96

async function loadSvgAsImage(svg: SVGElement): Promise<HTMLImageElement> {
  const serialized = new XMLSerializer().serializeToString(svg)
  const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('楽譜の画像化に失敗しました'))
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Rasterizes every OSMD page SVG found in `container` into its own PDF page (sized to true A4/etc.
 * physical dimensions when the view was constructed with a `pageFormat`, or one page per SVG
 * otherwise), baking in `placements` (ドレミ labels, in the same container-relative coordinate
 * space `ScoreView.getPlacements()` returns) at the correct position on whichever page each one
 * falls on.
 */
export async function exportOsmdAsPdf(container: HTMLElement, placements: PlacedLabel[] = []): Promise<Uint8Array> {
  const svgs = Array.from(container.querySelectorAll('svg'))
  if (svgs.length === 0) throw new Error('楽譜が描画されていません')

  const containerRect = container.getBoundingClientRect()
  const doc = await PDFDocument.create()

  for (const svg of svgs) {
    const width = Number(svg.getAttribute('width'))
    const height = Number(svg.getAttribute('height'))
    if (!width || !height) continue

    const svgRect = svg.getBoundingClientRect()
    const pageTop = svgRect.top - containerRect.top
    const pageBottom = pageTop + height

    const image = await loadSvgAsImage(svg)
    const canvas = document.createElement('canvas')
    canvas.width = width * RASTER_SCALE
    canvas.height = height * RASTER_SCALE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2Dコンテキストを取得できませんでした')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(RASTER_SCALE, RASTER_SCALE)
    ctx.drawImage(image, 0, 0, width, height)

    const pagePlacements = placements.filter((p) => p.bottom > pageTop && p.top < pageBottom)
    drawPlacementsOnCanvas(ctx, pagePlacements, pageTop)

    const dataUrl = canvas.toDataURL('image/png')
    const pngBytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0))
    const pngImage = await doc.embedPng(pngBytes)
    const widthPt = width * PX_TO_PT
    const heightPt = height * PX_TO_PT
    const pdfPage = doc.addPage([widthPt, heightPt])
    pdfPage.drawImage(pngImage, { x: 0, y: 0, width: widthPt, height: heightPt })
  }

  return doc.save()
}
