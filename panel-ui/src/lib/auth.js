export function createAuthLifecycle() {
  let generation = 0
  return {
    capture: () => generation,
    current: (captured) => captured === generation,
    invalidate: () => ++generation,
  }
}
