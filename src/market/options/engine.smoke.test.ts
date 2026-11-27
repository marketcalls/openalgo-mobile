// jest resolves @/ into the pinned frontend (openalgo/frontend/src), so the native project runs
// the web's own Black-76 engine.
test("jest loads the web's Black-76 engine", () =>
  expect(require('@/lib/optionGreeks').normCdf(0)).toBeCloseTo(0.5, 15))
