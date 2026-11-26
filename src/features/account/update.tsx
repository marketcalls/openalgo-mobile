import Constants from 'expo-constants'
import { useEffect, useState } from 'react'
import { Linking } from 'react-native'
import { usePrefs } from '~/core/config/prefs'
import { log } from '~/core/log/logger'
import { defaultDeps } from '~/core/services/deps'
import {
  checkForUpdate,
  dismissUpdate,
  noticeFor,
  readUpdateState,
  type UpdateNotice,
} from '~/core/update/check'
import { SessionBanner } from '~/market/components/SessionBanners'

const appVersion = () => Constants.expoConfig?.version ?? '0.0.0'

/** One check at a time, however many mounts ask. */
let inFlight: Promise<UpdateNotice | null> | null = null

function runCheck(): Promise<UpdateNotice | null> {
  if (!inFlight) {
    inFlight = checkForUpdate({
      fetch: defaultDeps.fetch,
      kv: defaultDeps.kv,
      now: defaultDeps.now,
      appVersion: appVersion(),
      enabled: usePrefs.getState().updateCheck,
    }).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/** For tests: forget a check that never settled. */
export function resetUpdateCheck() {
  inFlight = null
}

/**
 * The tabs layout's check. It waits for the saved prefs, since the default is "on" and a saved
 * "off" must win before anything is sent.
 */
export function useUpdateNotice(): { notice: UpdateNotice | null; dismiss: () => void } {
  const updateCheck = usePrefs((p) => p.updateCheck)
  const [notice, setNotice] = useState<UpdateNotice | null>(null)

  useEffect(() => {
    let live = true
    const run = () => {
      runCheck()
        .then((n) => live && setNotice(n))
        .catch(() => {})
    }
    if (!updateCheck) {
      setNotice(null)
      return
    }
    if (usePrefs.persist.hasHydrated()) {
      run()
      return () => {
        live = false
      }
    }
    const off = usePrefs.persist.onFinishHydration(run)
    return () => {
      live = false
      off()
    }
  }, [updateCheck])

  const dismiss = () => {
    if (!notice) return
    const v = notice.version
    setNotice(null)
    dismissUpdate(defaultDeps.kv, v).catch((e) => log.warn('update', 'could not dismiss', e))
  }
  return { notice, dismiss }
}

/** The stored result, for the Account screen (it never starts a check). */
export function useStoredUpdate(): UpdateNotice | null {
  const [notice, setNotice] = useState<UpdateNotice | null>(null)
  useEffect(() => {
    let live = true
    readUpdateState(defaultDeps.kv).then((s) => live && setNotice(noticeFor(s, appVersion())))
    return () => {
      live = false
    }
  }, [])
  return notice
}

export function UpdateBanner({
  notice,
  onDismiss,
}: {
  notice: UpdateNotice
  onDismiss: () => void
}) {
  return (
    <SessionBanner
      testID="update-banner"
      tone="neutral"
      text={`Version ${notice.version} is available`}
      actions={[
        {
          testID: 'update-view',
          label: 'View',
          onPress: () =>
            Linking.openURL(notice.url).catch((e) => log.warn('update', 'could not open', e)),
        },
        { testID: 'update-dismiss', label: 'Dismiss', onPress: onDismiss },
      ]}
    />
  )
}
