// THROWAWAY SPIKE. Scripted watchlist scroll benchmark: identical triangle-wave scroll on every phone so results compare across devices.
import { isBenchRunning, runBench } from '~/core/bench';
import { takeFlashes } from './flashStats';

export const BENCH_MS = 20_000;
export const SWEEP_MS = 5_000; // one full top-to-bottom (or bottom-to-top) pass

/** 0..1..0 over 2 * sweepMs: constant scroll speed, continuous position, no jumps. */
export function triangle(elapsedMs: number, sweepMs: number): number {
  const phase = (elapsedMs % (2 * sweepMs)) / sweepMs; // 0..2
  return phase <= 1 ? phase : 2 - phase;
}

export interface ScrollBenchArgs {
  /** Anything with FlashList's scrollToOffset (kept structural so the row type does not matter). */
  getList: () => { scrollToOffset: (p: { offset: number; animated?: boolean }) => void } | null;
  /** Content height minus viewport height in dp. Read once when measuring starts, after the header banner has settled. */
  getMaxOffset: () => number;
  flash: boolean;
  rows: number;
  rowHeight: number;
}

/**
 * Runs the bench and resolves when the result has been stored.
 * Returns 'busy' without doing anything if another bench is already running.
 */
export async function runWatchlistScrollBench(a: ScrollBenchArgs): Promise<'done' | 'busy'> {
  if (isBenchRunning()) return 'busy';
  a.getList()?.scrollToOffset({ offset: 0, animated: false });

  let driveStart = 0;
  let commands = 0;
  let missingRef = 0;
  let maxOffset = 0;

  try {
    await runBench({
      scenario: `watchlist:scroll:${a.flash ? 'flash-on' : 'flash-off'}`,
      durationMs: BENCH_MS,
      drive: (elapsedMs) => {
        if (driveStart === 0) {
          // The measured window has just begun (runBench settles 1 s first).
          driveStart = performance.now();
          maxOffset = a.getMaxOffset();
          takeFlashes();
        }
        const list = a.getList();
        if (!list) {
          missingRef++;
          return;
        }
        list.scrollToOffset({ offset: triangle(elapsedMs, SWEEP_MS) * maxOffset, animated: false });
        commands++;
      },
      collectExtra: () => {
        const secs = driveStart ? (performance.now() - driveStart) / 1000 : 0;
        const flashes = takeFlashes();
        return {
          watchlist: {
            flash: a.flash,
            rows: a.rows,
            rowHeightDp: a.rowHeight,
            maxOffsetDp: Math.round(maxOffset),
            sweepMs: SWEEP_MS,
            scrollSpeedDpPerSec: Math.round((maxOffset * 1000) / SWEEP_MS),
            // Commands issued from JS, one per JS frame; not a count of frames the UI actually drew.
            scrollCommands: commands,
            scrollCommandsPerSec: secs ? Math.round(commands / secs) : 0,
            missingRef,
            // Flash animations started by rows (includes off-screen cells FlashList keeps mounted for recycling).
            flashesStarted: flashes,
            flashesPerSec: secs ? Math.round(flashes / secs) : 0,
          },
        };
      },
    });
  } finally {
    a.getList()?.scrollToOffset({ offset: 0, animated: false });
  }
  return 'done';
}
