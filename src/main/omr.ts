import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import type { ConvertPdfError } from '../shared/types'

/** Low-level Audiveris invocation result — the main process wraps this with cache bookkeeping (pdfPath/fromCache) before it becomes the public ConvertPdfResult. */
export type RawConversionResult = { ok: true; musicXmlPath: string; omrPath: string | null } | ConvertPdfError

const VENDOR_DIR = join(__dirname, '..', '..', 'vendor', 'audiveris')

function checkJavaAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('java', ['-version'])
    proc.on('error', () => resolve(false))
    proc.on('exit', (code) => resolve(code === 0))
  })
}

interface AudiverisCommand {
  command: string
  baseArgs: string[]
  /** false when the launcher bundles its own JRE (macOS .app / app-image), true when we invoke a bare jar via system `java`. */
  requiresSystemJava: boolean
}

/** Resolves the Audiveris launcher, checked in order: macOS .app bundle, bin/Audiveris app-image script, bare jar run via `java -jar`. */
function resolveAudiverisCommand(): AudiverisCommand | null {
  if (process.platform === 'darwin') {
    const appBinary = join(VENDOR_DIR, 'Audiveris.app', 'Contents', 'MacOS', 'Audiveris')
    if (existsSync(appBinary)) {
      return { command: appBinary, baseArgs: [], requiresSystemJava: false }
    }
  }

  const scriptName = process.platform === 'win32' ? 'Audiveris.bat' : 'Audiveris'
  const scriptPath = join(VENDOR_DIR, 'bin', scriptName)
  if (existsSync(scriptPath)) {
    return { command: scriptPath, baseArgs: [], requiresSystemJava: false }
  }

  const jarPath = join(VENDOR_DIR, 'audiveris.jar')
  if (existsSync(jarPath)) {
    return { command: 'java', baseArgs: ['-jar', jarPath], requiresSystemJava: true }
  }

  return null
}

const STEP_LABELS: Record<string, string> = {
  LOAD: '画像を読み込み中',
  BINARY: '白黒化',
  SCALE: '五線間隔を計測中',
  GRID: '五線・段組を検出中',
  HEADERS: '調号・拍子を検出中',
  STEM_SEEDS: '符幹を検出中',
  BEAMS: '連桁を検出中',
  LEDGERS: '加線を検出中',
  HEADS: '符頭(音符)を検出中',
  RHYTHM: 'リズムを解析中',
  TEXT: '歌詞・文字を検出中',
  SYMBOLS: '記号を解析中',
  CURVES: 'スラー・タイを検出中',
}

export type OmrProgressListener = (message: string) => void

function parseProgressLine(line: string, state: { totalSheets: number | null; currentSheet: number | null }): string | null {
  const totalMatch = line.match(/(\d+)\s+sheets?\s+in\s+/)
  if (totalMatch) {
    state.totalSheets = Number(totalMatch[1])
  }

  const sheetMatch = line.match(/\[[^\]#]+#(\d+)\]/)
  if (sheetMatch) {
    state.currentSheet = Number(sheetMatch[1])
  }

  const stepMatch = line.match(/StepMonitoring\s+\d+\s+\|\s+(\S+)/)
  if (!stepMatch) return null

  const step = stepMatch[1]
  const label = STEP_LABELS[step] ?? step
  const pageInfo = state.currentSheet ? `ページ ${state.currentSheet}${state.totalSheets ? `/${state.totalSheets}` : ''} - ` : ''
  return `${pageInfo}${label}`
}

function runAudiveris(
  command: string,
  args: string[],
  onProgress?: OmrProgressListener
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args)
    let stderr = ''
    let stdoutBuffer = ''
    let stderrBuffer = ''
    const state = { totalSheets: null as number | null, currentSheet: null as number | null }

    const handleChunk = (buffer: string, chunk: string): string => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const progress = parseProgressLine(line, state)
        if (progress && onProgress) onProgress(progress)
      }
      return buffer
    }

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer = handleChunk(stdoutBuffer, chunk.toString())
    })
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      stderrBuffer = handleChunk(stderrBuffer, text)
    })
    proc.on('error', reject)
    proc.on('exit', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

export async function convertPdfToMusicXml(pdfPath: string, onProgress?: OmrProgressListener): Promise<RawConversionResult> {
  const audiveris = resolveAudiverisCommand()
  if (!audiveris) {
    return {
      ok: false,
      errorCode: 'audiveris-not-found',
      message: 'Audiverisが見つかりません。vendor/audiveris/README.md の手順に従って配置してください。',
    }
  }

  if (audiveris.requiresSystemJava && !(await checkJavaAvailable())) {
    return {
      ok: false,
      errorCode: 'java-not-found',
      message: 'Java (17以上)が見つかりません。Javaをインストールしてから再度お試しください。',
    }
  }

  const outputDir = await mkdtemp(join(tmpdir(), 'music-sheet-omr-'))

  try {
    const { code, stderr } = await runAudiveris(
      audiveris.command,
      [...audiveris.baseArgs, '-batch', '-export', '-save', '-output', outputDir, '--', pdfPath],
      onProgress
    )

    if (code !== 0) {
      return {
        ok: false,
        errorCode: 'omr-failed',
        message: `Audiverisの実行に失敗しました(終了コード: ${code})。\n${stderr.slice(-2000)}`,
      }
    }

    const files = await readdir(outputDir, { recursive: true })
    const musicXmlFile = files.find((f) => f.endsWith('.mxl') || f.endsWith('.musicxml') || f.endsWith('.xml'))
    const omrFile = files.find((f) => f.endsWith('.omr'))

    if (!musicXmlFile) {
      return {
        ok: false,
        errorCode: 'no-output',
        message: 'Audiverisの出力からMusicXMLファイルが見つかりませんでした。',
      }
    }

    return {
      ok: true,
      musicXmlPath: join(outputDir, musicXmlFile),
      omrPath: omrFile ? join(outputDir, omrFile) : null,
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'omr-failed',
      message: `Audiverisの起動に失敗しました: ${(err as Error).message}`,
    }
  }
}

export async function cleanupOmrOutput(musicXmlPath: string): Promise<void> {
  const dir = join(musicXmlPath, '..')
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

export async function readScoreFile(path: string): Promise<Uint8Array> {
  const buffer = await readFile(path)
  return new Uint8Array(buffer)
}

/** Plain MusicXML text, transparently decompressing a .mxl container if needed. */
export async function readMusicXmlText(path: string): Promise<string> {
  if (!path.endsWith('.mxl')) {
    return readFile(path, 'utf-8')
  }
  const zip = new AdmZip(path)
  const entry = zip.getEntries().find((e) => e.entryName.endsWith('.xml') && !e.entryName.startsWith('META-INF/'))
  if (!entry) {
    throw new Error('mxlファイル内にMusicXMLが見つかりませんでした')
  }
  return entry.getData().toString('utf-8')
}

/** Raw XML text of each sheet#N.xml inside the Audiveris .omr book file, ordered by sheet number. */
export async function readOmrSheets(omrPath: string): Promise<string[]> {
  const zip = new AdmZip(omrPath)
  const sheetEntries = zip
    .getEntries()
    .filter((e) => /^sheet#(\d+)\/sheet#\1\.xml$/.test(e.entryName))
    .map((e) => ({
      index: Number(e.entryName.match(/^sheet#(\d+)\//)![1]),
      entry: e,
    }))
    .sort((a, b) => a.index - b.index)

  return sheetEntries.map(({ entry }) => entry.getData().toString('utf-8'))
}
