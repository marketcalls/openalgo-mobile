// THROWAWAY SPIKE. Stand-in for '@/lib/trading/customIndicators' inside the chart DOM
// bundle. The real loader does import(/* @vite-ignore */ urlOf(mod)) on URLs from
// /custom-indicators/index.json; Metro refuses a non-literal import() at build time
// ("Invalid call at line 332"), and inside the WebView there is no OpenAlgo origin or
// session to fetch the index from anyway. Built-in indicators are unaffected: they come
// from 'openalgo-charts/indicators', which OpenAlgoChart imports itself.
export interface CustomIndicatorLoad {
  loaded: string[];
  errors: { file: string; message: string }[];
}

type ProblemReporter = (message: string) => void;

export async function loadCustomIndicators(_opts: { onProblem?: ProblemReporter } = {}): Promise<CustomIndicatorLoad> {
  return { loaded: [], errors: [] };
}

export async function ensureCustomIndicators(
  _ids: readonly string[],
  _opts: { onProblem?: ProblemReporter } = {},
): Promise<CustomIndicatorLoad> {
  return { loaded: [], errors: [] };
}
