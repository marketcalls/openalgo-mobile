// The two native edges of backup: the share sheet and the file picker. Everything else is pure
// (format.ts), so only this file touches expo-file-system, expo-sharing and expo-document-picker.
import * as DocumentPicker from 'expo-document-picker'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { MAX_BACKUP_BYTES } from './format'

/** Writes the backup to the cache folder and opens the share sheet (save to Files, Drive, mail). */
export async function shareBackup(text: string, name: string): Promise<void> {
  const file = new File(Paths.cache, name)
  file.create({ overwrite: true })
  await file.write(text)
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/json',
    UTI: 'public.json',
    dialogTitle: 'Save backup',
  })
}

/** Longer than the limit, so `parseBackup` answers "too large" without the file being read. */
const OVERSIZE = ' '.repeat(MAX_BACKUP_BYTES + 1)

/** The text of the file the user picked, or null when they cancelled. */
export async function pickBackup(): Promise<string | null> {
  const r = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/plain'],
    copyToCacheDirectory: true,
  })
  const asset = r.canceled ? null : r.assets[0]
  if (!asset) return null
  if (asset.size !== undefined && asset.size > MAX_BACKUP_BYTES) return OVERSIZE
  return new File(asset.uri).text()
}
