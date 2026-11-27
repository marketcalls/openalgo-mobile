// The system's reduce-motion setting (design 7.x "Feel"): with it on, nothing animates, flashes or
// shimmers. Two forms: a value a screen renders with, and a ref a gesture handler reads.
import { type RefObject, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/** Follows `fn` with the setting: its value now, then each change. */
function useSetting(fn: (on: boolean) => void): void {
  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (live) fn(v)
    })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', fn)
    return () => {
      live = false
      sub.remove()
    }
  }, [fn])
}

/** The setting, read once per screen and followed after: a change re-renders the screen. */
export function useReduceMotion(): boolean {
  const [on, setOn] = useState(false)
  useSetting(setOn)
  return on
}

/** The setting, for handlers: a change re-renders nothing. */
export function useReduceMotionRef(): RefObject<boolean> {
  const on = useRef(false)
  const [set] = useState(() => (v: boolean) => {
    on.current = v
  })
  useSetting(set)
  return on
}
