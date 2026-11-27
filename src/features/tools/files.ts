// The one native edge of a tool's file: a WebView cannot save one, so the tearsheet and a page's
// own save (a Sector Rotation PNG, a CSV) are written to the cache folder and handed to the share
// sheet, as a backup is (features/backup/io.ts).
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import type { SavedFile } from '~/dom/gateway/toolRoutes'

/** Writes `f` to the cache folder and opens the share sheet (save to Files, Drive, mail). */
export async function writeAndShare(f: SavedFile): Promise<void> {
  const file = new File(Paths.cache, f.name)
  file.create({ overwrite: true })
  if ('text' in f) await file.write(f.text)
  else await file.write(f.base64, { encoding: 'base64' })
  await Sharing.shareAsync(file.uri, { mimeType: f.mime, dialogTitle: 'Save file' })
}
