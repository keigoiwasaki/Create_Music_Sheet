import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { OmrEngine } from '../shared/types'

export interface CacheManifest {
  /** Content hash of the source PDF — shared across engines for the same file (see cacheKey). */
  hash: string
  /** The actual cache-directory key. Equal to `hash` for the default Audiveris engine; suffixed
   * for any other engine so the same PDF converted by two engines gets two separate entries. */
  cacheKey: string
  engine: OmrEngine
  originalFileName: string
  convertedAt: string
  pdfFile: string
  musicXmlFile: string
  omrFile: string | null
}

function getCacheDir(): string {
  return join(app.getPath('userData'), 'score-cache')
}

/** Content hash of a PDF — used to recognize "the same file" even if it was moved/renamed. */
export async function hashFile(path: string): Promise<string> {
  const buffer = await readFile(path)
  return createHash('sha256').update(buffer).digest('hex')
}

/** The cache-directory key for a given (content hash, engine) pair — only non-default engines get
 * a suffix, so existing Audiveris cache directories need no migration. */
export function buildCacheKey(hash: string, engine: OmrEngine): string {
  return engine === 'audiveris' ? hash : `${hash}-${engine}`
}

export function resolveCachePath(cacheKey: string, fileName: string): string {
  return join(getCacheDir(), cacheKey, fileName)
}

export async function readCacheEntry(cacheKey: string): Promise<CacheManifest | null> {
  const manifestPath = resolveCachePath(cacheKey, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf-8')) as Partial<CacheManifest> & { hash: string }
    // Manifests written before engine support existed have no `engine`/`cacheKey` fields.
    return {
      ...parsed,
      cacheKey: parsed.cacheKey ?? parsed.hash,
      engine: parsed.engine ?? 'audiveris',
    } as CacheManifest
  } catch {
    return null
  }
}

/** Copies the conversion's output files into the persistent cache directory and writes a manifest. */
export async function writeCacheEntry(
  cacheKey: string,
  hash: string,
  engine: OmrEngine,
  originalFileName: string,
  pdfPath: string,
  musicXmlPath: string,
  omrPath: string | null
): Promise<CacheManifest> {
  const dir = join(getCacheDir(), cacheKey)
  await mkdir(dir, { recursive: true })

  const pdfFile = `source${extname(pdfPath) || '.pdf'}`
  await copyFile(pdfPath, join(dir, pdfFile))

  const musicXmlFile = `score${extname(musicXmlPath) || '.mxl'}`
  await copyFile(musicXmlPath, join(dir, musicXmlFile))

  let omrFile: string | null = null
  if (omrPath) {
    omrFile = 'book.omr'
    await copyFile(omrPath, join(dir, omrFile))
  }

  const manifest: CacheManifest = {
    hash,
    cacheKey,
    engine,
    originalFileName,
    convertedAt: new Date().toISOString(),
    pdfFile,
    musicXmlFile,
    omrFile,
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  return manifest
}

export async function listCacheEntries(): Promise<CacheManifest[]> {
  const dir = getCacheDir()
  if (!existsSync(dir)) return []
  const cacheKeys = await readdir(dir)
  const entries: CacheManifest[] = []
  for (const cacheKey of cacheKeys) {
    const entry = await readCacheEntry(cacheKey)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => b.convertedAt.localeCompare(a.convertedAt))
  return entries
}

export async function deleteCacheEntry(cacheKey: string): Promise<void> {
  await rm(join(getCacheDir(), cacheKey), { recursive: true, force: true }).catch(() => {})
}
