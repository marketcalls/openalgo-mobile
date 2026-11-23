// THROWAWAY SPIKE. Counts flash animations started, so a flash-on bench result says how much animation work it actually did.
let flashes = 0;

export function noteFlash() {
  flashes++;
}

/** Returns the count since the last call and resets it. */
export function takeFlashes(): number {
  const n = flashes;
  flashes = 0;
  return n;
}
