// Web preview only (dev/preview; Metro picks this file for platform web, never in an android or
// ios bundle): expo-sqlite's web build needs a .wasm asset and cross-origin isolation the preview
// export has neither of, so the web preview keeps the symbol master in memory.
import type { MasterDb } from './db'
import { createMemoryMasterDb } from './memoryDb'

let opened: Promise<MasterDb> | null = null

/** The preview's master: in memory, once for the page's life. */
export function openMasterDb(): Promise<MasterDb> {
  opened ??= Promise.resolve(createMemoryMasterDb())
  return opened
}
