// THROWAWAY SPIKE. In-memory results log shown on the Results tab and copied to
// the clipboard as JSON for pasting back into the design discussion.
import { create } from 'zustand';

export interface BenchResult {
  scenario: string; // e.g. 'watchlist:scroll', 'chain:scroll', 'chart:pan', 'tool:maxpain-open'
  at: string;
  settings: Record<string, unknown>;
  metrics: Record<string, unknown>;
  pass?: boolean;
  notes?: string;
}

interface ResultsState {
  results: BenchResult[];
  add: (r: Omit<BenchResult, 'at'>) => void;
  clear: () => void;
}

export const useResults = create<ResultsState>((set) => ({
  results: [],
  add: (r) => set((s) => ({ results: [...s.results, { ...r, at: new Date().toISOString() }] })),
  clear: () => set({ results: [] }),
}));

/** Pass bars agreed for the spike (see spike/README.md). */
export const PASS = {
  nativeUiFps: 55,
  nativeJsFps: 45,
  nativeSlowPctMax: 5,
  chartFps: 30,
  chartOpenMs: 2500, // native mount of the chart DOM component -> first painted frame with candles
  toolOpenMs: 2500,
  toolMemoryMb: 250,
  coldStartMs: 3500,
};
