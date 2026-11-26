import { usePreventScreenCapture } from 'expo-screen-capture'

/** Blocks screenshots and recording while the calling screen (one that shows the key) is mounted. */
export function useSecureScreen(): void {
  usePreventScreenCapture('oa-key')
}
