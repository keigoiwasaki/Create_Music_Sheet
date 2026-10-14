import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { OmrProgressListener, RawConversionResult } from './omr'
import { mergePageXmlTexts } from './musicxml-merge'

/** Override point for a venv/non-PATH install — homr is typically installed into an isolated venv
 * (see vendor/homr/README.md), which a GUI-launched Electron app may not inherit on its PATH. */
function homrCommand(): string {
  return process.env.HOMR_BIN ?? 'homr'
}

export function checkHomrAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(homrCommand(), ['--help'])
    proc.on('error', () => resolve(false))
    proc.on('exit', (code) => resolve(code === 0))
  })
}

const HEARTBEAT_INTERVAL_MS = 20_000

function runHomrOnImage(imagePath: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    // homr takes a single image (despite some docs suggesting multi-image/PDF support, the
    // installed CLI's own --help only accepts one `image` positional and rejects PDFs outright —
    // confirmed by actually running it) and writes `<image-basename>.musicxml` into the SAME
    // directory as the input image (no -o/--output flag exists).
    const proc = spawn(homrCommand(), [imagePath])
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('exit', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

/**
 * Converts pre-rasterized page images (see pdf-rasterize.ts — homr accepts only single images,
 * never a PDF, despite its own README's claims) via the experimental homr OMR engine, one page at
 * a time (no verified batch mode), merging the resulting per-page MusicXML into one piece via
 * `mergePageXmlTexts`. Always returns `omrPath: null` — this integration doesn't yet parse the
 * `imgpos` position comments homr can optionally emit, so results use the OSMD re-engraved display
 * fallback, same as every other non-Audiveris path.
 */
export async function convertPagesToMusicXmlViaHomr(
  pngPages: Uint8Array[],
  onProgress?: OmrProgressListener
): Promise<RawConversionResult> {
  if (!(await checkHomrAvailable())) {
    return {
      ok: false,
      errorCode: 'homr-not-found',
      message: 'homrが見つかりません。vendor/homr/README.md の手順でインストールしてください。',
    }
  }

  const workDir = await mkdtemp(join(tmpdir(), 'music-sheet-homr-'))

  try {
    const pageXmlTexts: string[] = []

    for (let i = 0; i < pngPages.length; i++) {
      const pageNumber = i + 1
      const pagePadded = String(pageNumber).padStart(3, '0')
      const pngPath = join(workDir, `page-${pagePadded}.png`)
      await writeFile(pngPath, pngPages[i])

      onProgress?.(`ページ ${pageNumber}/${pngPages.length} をhomrで認識中です(数分かかります)...`)
      const startedAt = Date.now()
      const heartbeat = setInterval(() => {
        const elapsedMin = Math.round((Date.now() - startedAt) / 60_000)
        onProgress?.(`ページ ${pageNumber}/${pngPages.length} をhomrで認識中です(経過約${elapsedMin}分)...`)
      }, HEARTBEAT_INTERVAL_MS)

      let result: { code: number; stderr: string }
      try {
        result = await runHomrOnImage(pngPath)
      } finally {
        clearInterval(heartbeat)
      }

      if (result.code !== 0) {
        return {
          ok: false,
          errorCode: 'omr-failed',
          message: `homrの実行に失敗しました(ページ${pageNumber}、終了コード: ${result.code})。\n${result.stderr.slice(-2000)}`,
        }
      }

      const xmlPath = join(workDir, `${basename(pngPath, '.png')}.musicxml`)
      try {
        pageXmlTexts.push(await readFile(xmlPath, 'utf-8'))
      } catch {
        return {
          ok: false,
          errorCode: 'no-output',
          message: `homrの出力からMusicXMLファイルが見つかりませんでした(ページ${pageNumber})。`,
        }
      }
    }

    const mergedXml = mergePageXmlTexts(pageXmlTexts)
    const mergedPath = join(workDir, 'merged.musicxml')
    await writeFile(mergedPath, mergedXml, 'utf-8')

    return { ok: true, musicXmlPath: mergedPath, omrPath: null }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'omr-failed',
      message: `homrの起動に失敗しました: ${(err as Error).message}`,
    }
  }
}

export async function cleanupHomrOutput(musicXmlPath: string): Promise<void> {
  const dir = join(musicXmlPath, '..')
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
