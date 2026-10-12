import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { basename, extname, join } from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { cleanupOmrOutput, convertPdfToMusicXml, readMusicXmlText, readOmrSheets, readScoreFile } from './omr'
import { deleteCacheEntry, hashFile, listCacheEntries, readCacheEntry, resolveCachePath, writeCacheEntry } from './cache'
import type { ConvertPdfResponse, HistoryEntry } from '../shared/types'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

ipcMain.handle('open-pdf-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('convert-pdf-to-musicxml', async (event, pdfPath: string): Promise<ConvertPdfResponse> => {
  const hash = await hashFile(pdfPath)
  const cached = await readCacheEntry(hash)
  if (cached) {
    event.sender.send('omr-progress', 'キャッシュから読み込みました')
    return {
      ok: true,
      pdfPath: resolveCachePath(hash, cached.pdfFile),
      musicXmlPath: resolveCachePath(hash, cached.musicXmlFile),
      omrPath: cached.omrFile ? resolveCachePath(hash, cached.omrFile) : null,
      fromCache: true,
    }
  }

  const result = await convertPdfToMusicXml(pdfPath, (message) => {
    event.sender.send('omr-progress', message)
  })
  if (!result.ok) return result

  const manifest = await writeCacheEntry(hash, basename(pdfPath), pdfPath, result.musicXmlPath, result.omrPath)
  await cleanupOmrOutput(result.musicXmlPath)

  return {
    ok: true,
    pdfPath: resolveCachePath(hash, manifest.pdfFile),
    musicXmlPath: resolveCachePath(hash, manifest.musicXmlFile),
    omrPath: manifest.omrFile ? resolveCachePath(hash, manifest.omrFile) : null,
    fromCache: false,
  }
})

ipcMain.handle('list-history', async (): Promise<HistoryEntry[]> => {
  const entries = await listCacheEntries()
  return entries.map((entry) => ({
    hash: entry.hash,
    originalFileName: entry.originalFileName,
    convertedAt: entry.convertedAt,
    pdfPath: resolveCachePath(entry.hash, entry.pdfFile),
    musicXmlPath: resolveCachePath(entry.hash, entry.musicXmlFile),
    omrPath: entry.omrFile ? resolveCachePath(entry.hash, entry.omrFile) : null,
  }))
})

ipcMain.handle('delete-history-entry', async (_event, hash: string) => {
  await deleteCacheEntry(hash)
})

ipcMain.handle('read-score-file', async (_event, path: string) => {
  return readScoreFile(path)
})

ipcMain.handle('read-musicxml-text', async (_event, path: string) => {
  return readMusicXmlText(path)
})

ipcMain.handle('read-omr-sheets', async (_event, omrPath: string) => {
  return readOmrSheets(omrPath)
})

const SAVE_FILTER_NAMES: Record<string, string> = {
  '.pdf': 'PDF',
  '.webm': 'WebM動画',
}

ipcMain.handle('save-file', async (_event, bytes: Uint8Array, suggestedName: string) => {
  const ext = extname(suggestedName).replace(/^\./, '') || 'dat'
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: SAVE_FILTER_NAMES[extname(suggestedName)] ?? ext.toUpperCase(), extensions: [ext] }],
  })
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, bytes)
  return true
})

// No dialog — used to hand a password-decrypted PDF (rebuilt in the renderer from pdf.js-rendered
// pages, since Audiveris/pdf-lib can't decrypt one themselves) to Audiveris, which needs a real
// file path, not in-memory bytes.
ipcMain.handle('write-temp-pdf', async (_event, bytes: Uint8Array, suggestedName: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'music-sheet-decrypted-'))
  const path = join(dir, suggestedName || 'decrypted.pdf')
  await writeFile(path, bytes)
  return path
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
