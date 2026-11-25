export const cloneSettings = (value) => ({ ...value, grayModelIds: [...(value.grayModelIds || [])] })

export function settingsFromState(state) {
  const s = state?.settings || {}
  return {
    requestTimeoutMs: state?.requestTimeoutMs ?? 120000,
    maxBodyBytes: s.maxBodyBytes ?? 10485760,
    accountProbeMinutes: s.accountProbeMinutes ?? 0,
    streamHeartbeatMs: s.streamHeartbeatMs ?? 15000,
    logMaxEntries: s.logMaxEntries ?? 1000,
    allowPanelFromLan: Boolean(s.allowPanelFromLan),
    grayModelIds: [...(s.grayModelIds || [])],
    modelCatalogMinutes: s.modelCatalogMinutes ?? 15,
    kimiCompatibility: s.kimiCompatibility !== false,
    normalizeToolSchemas: s.normalizeToolSchemas !== false,
    upstreamErrorFastFail: s.upstreamErrorFastFail !== false,
    upstreamBodyLimitBytes: s.upstreamBodyLimitBytes ?? 4718592,
  }
}

export function settingsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function settingsSync(draft, baseline, state, saving) {
  if (!state?.settings || saving || !settingsEqual(draft, baseline)) return null
  return settingsFromState(state)
}

export function settingsPayload(draft) {
  const { grayModelIds, ...rest } = cloneSettings(draft)
  return { ...rest, grayModels: grayModelIds }
}

// Receives the submitted snapshot, never a poll response or a later edit.
export function savedSettings(draft, submitted) {
  return { baseline: cloneSettings(submitted), draft: cloneSettings(draft) }
}
