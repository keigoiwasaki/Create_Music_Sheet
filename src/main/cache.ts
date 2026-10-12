import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

export interface CacheManifest {
  hash: string
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

export function resolveCachePath(hash: string, fileName: string): string {
  return join(getCacheDir(), hash, fileName)
}

export async function readCacheEntry(hash: string): Promise<CacheManifest | null> {
  const manifestPath = resolveCachePath(hash, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(await readFile(manifestPath, 'utf-8')) as CacheManifest
  } catch {
    return null
  }
}

/** Copies the conversion's output files into the persistent cache directory and writes a manifest. */
export async function writeCacheEntry(
  hash: string,
  originalFileName: string,
  pdfPath: string,
  musicXmlPath: string,
  omrPath: string | null
): Promise<CacheManifest> {
  const dir = join(getCacheDir(), hash)
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
  const hashes = await readdir(dir)
  const entries: CacheManifest[] = []
  for (const hash of hashes) {
    const entry = await readCacheEntry(hash)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => b.convertedAt.localeCompare(a.convertedAt))
  return entries
}

export async function deleteCacheEntry(hash: string): Promise<void> {
  await rm(join(getCacheDir(), hash), { recursive: true, force: true }).catch(() => {})
}
