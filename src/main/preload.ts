import { contextBridge, ipcRenderer } from 'electron'
import type { ConvertPdfResponse, HistoryEntry, MusicSheetApi } from '../shared/types'

const api: MusicSheetApi = {
  openPdfDialog: () => ipcRenderer.invoke('open-pdf-dialog'),
  convertPdfToMusicXml: (pdfPath: string): Promise<ConvertPdfResponse> =>
    ipcRenderer.invoke('convert-pdf-to-musicxml', pdfPath),
  readScoreFile: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('read-score-file', path),
  readMusicXmlText: (path: string): Promise<string> => ipcRenderer.invoke('read-musicxml-text', path),
  readOmrSheets: (omrPath: string): Promise<string[]> => ipcRenderer.invoke('read-omr-sheets', omrPath),
  onOmrProgress: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('omr-progress', listener)
    return () => ipcRenderer.removeListener('omr-progress', listener)
  },
  saveFile: (bytes: Uint8Array, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke('save-file', bytes, suggestedName),
  writeTempPdf: (bytes: Uint8Array, suggestedName: string): Promise<string> =>
    ipcRenderer.invoke('write-temp-pdf', bytes, suggestedName),
  listHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke('list-history'),
  deleteHistoryEntry: (cacheKey: string): Promise<void> => ipcRenderer.invoke('delete-history-entry', cacheKey),
  renameHistoryEntry: (cacheKey: string, newName: string): Promise<void> =>
    ipcRenderer.invoke('rename-history-entry', cacheKey, newName),
  checkHomrAvailable: (): Promise<boolean> => ipcRenderer.invoke('check-homr-available'),
  convertPdfToMusicXmlViaHomr: (pdfPath: string, pngPages: Uint8Array[]): Promise<ConvertPdfResponse> =>
    ipcRenderer.invoke('convert-pdf-to-musicxml-via-homr', pdfPath, pngPages),
}

contextBridge.exposeInMainWorld('musicSheet', api)
