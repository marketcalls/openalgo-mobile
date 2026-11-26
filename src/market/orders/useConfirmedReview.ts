// A sheet's write behind its own review (design 7.10): the order ticket and the GTT ticket. The
// review reads the server's mode and the book afresh; confirm sends once, inside the submit
// guard, held on its scope for the session until its outcome is known, the check after an
// unknown one included. An Android sheet can always be swiped away mid-send, so every outcome
// shows on the sheet while it is there, else as a toast the session keeps for the next review on
// that scope (on iOS a presented sheet hides the toast). The Orders tab's confirmed writes share
// the same safety through `useConfirmedWrite`; this is the sheet's shell around it.
import { useEffect, useRef, useState } from 'react'
import { toast } from '~/ui/Toast'
import { useTrading } from '../trading'
import type { AnalyzerMode } from './analyzerGate'
import { MODE_LABEL } from './confirmWrite'
import { useSubmitGuard } from './guard'
import {
  holdOrder,
  NEW_ORDER,
  type PendingScope,
  takeUnseenOutcome,
  useOtherOrderOut,
  useUnseenOutcome,
} from './pending'
import { useHoldSheet } from './useHoldSheet'
import { useReviewBook } from './useReviewBook'

/** What the mode read for the review that shows now came to. */
export type ModeRead = { mode: AnalyzerMode } | { error: unknown }

export function useConfirmedReview(o: {
  /** The writes this sheet's waits for, and holds its own on: a new order by default. */
  scope?: PendingScope
  /** The review shows: its book read runs again when another write on the scope is released. */
  onReview: boolean
  /** The write is on its way: the sheet is held open (`useHoldSheet`, with `holdCopy`). */
  sending: boolean
  holdCopy?: string
  /** The toast when the sheet goes while the write is on its way. */
  stillSending: string
  /** `useReviewBook`'s reads of the book's ids, kept stable by the caller. */
  readIds: () => Promise<readonly string[]>
  cachedIds: () => readonly string[]
}) {
  const { scope = NEW_ORDER, onReview, sending, holdCopy, stillSending, readIds, cachedIds } = o
  const trading = useTrading()
  const guard = useSubmitGuard()
  /** This sheet, as the session's writes still out know it. */
  const [me] = useState(() => ({}))
  const otherOut = useOtherOrderOut(trading, me, scope)
  /** Where this sheet's write is: on its way, or being checked after an unknown outcome. */
  const phase = useRef<'idle' | 'sending' | 'checking'>('idle')
  const alive = useRef(true)
  /** The last outcome line this sheet's write sent to the toast, once the sheet had gone. */
  const goneLine = useRef<string | null>(null)
  const still = useRef(stillSending)
  still.current = stillSending
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // The sheet went while the write was on its way: what comes of it shows as a toast.
      if (phase.current === 'sending') toast(still.current)
    }
  }, [])
  useHoldSheet(sending, holdCopy)
  const book = useReviewBook({ owner: me, otherOut, onReview, readIds, cachedIds, scope })
  // An earlier write's outcome on the scope that only the toast carried: the review says it,
  // whether it lands while this review waits or came before.
  const unseen = useUnseenOutcome(trading, scope)
  const [earlierLine, setEarlierLine] = useState<string | null>(null)
  useEffect(() => {
    if (!onReview || unseen === null) return
    const line = takeUnseenOutcome(trading, scope)
    if (line !== null) setEarlierLine(line)
  }, [onReview, unseen, trading, scope])
  /** Each mode read; one for an earlier opening, or before a retry, is dropped. */
  const modeReads = useRef(0)

  /** The outcome's line once the sheet has gone: the toast, kept for the next review. */
  const tell = (line: string) => {
    goneLine.current = line
    toast(line)
  }

  return {
    otherOut,
    book,
    earlierLine,
    guard,

    /** Reads the mode for the review that opens now (or its retry); `land` hears it on the sheet. */
    readMode(land: (r: ModeRead) => void): void {
      const seq = ++modeReads.current
      trading.analyzer.read().then(
        (mode) => {
          if (alive.current && modeReads.current === seq) land({ mode })
        },
        (error: unknown) => {
          if (alive.current && modeReads.current === seq) land({ error })
        },
      )
    },

    /** `onSheet` while the sheet is there; once it has gone, `line` is told instead (`tell`). */
    onSheet(onSheet: () => void, line: string): void {
      if (alive.current) onSheet()
      else tell(line)
    },

    /**
     * The server's mode changed at confirm: nothing was sent. The review (`review`) shows again
     * and reads the new mode's book: the old one's ids say nothing of it, so a check after an
     * unknown outcome would take an entry already in it for the one sent. Confirm waits for it.
     */
    modeChanged(now: AnalyzerMode, review: () => void, notSent: string): void {
      if (alive.current) {
        review()
        book.read()
      } else tell(`The server is now in ${MODE_LABEL[now]} mode. ${notSent}`)
    },

    /** The outcome may hide the write: it is being checked against the book. */
    checking(): void {
      phase.current = 'checking'
    },

    /**
     * One confirm, inside the guard: one at a time, then the cooldown. `ready` decides at once
     * whether it goes (false sends and holds nothing). Then the session holds the write on the
     * scope until `send` ends, its outcome and any check included, so no other sheet sends on it
     * meanwhile, even once this one has gone; an outcome only the toast carried goes to the
     * review that waits for it, or the next.
     */
    confirm(ready: () => boolean, send: () => Promise<void>): void {
      void guard.run(async () => {
        if (!ready()) return
        const release = holdOrder(trading, me, scope)
        goneLine.current = null
        phase.current = 'sending'
        try {
          await send()
        } finally {
          phase.current = 'idle'
          release(goneLine.current)
        }
      })
    },
  }
}
