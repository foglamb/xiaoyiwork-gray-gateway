export function mergeConfirmed(current, submitted, confirmed) {
  return Object.fromEntries(Object.keys(confirmed).map((key) => [key,
    JSON.stringify(current[key]) === JSON.stringify(submitted[key]) ? confirmed[key] : current[key],
  ]))
}

export function finiteMetric(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
}

export function cacheRate(entry) {
  const prompt = finiteMetric(entry.promptTokens)
  const cached = finiteMetric(entry.cachedTokens)
  return prompt > 0 && cached !== null && cached >= 0 && cached <= prompt ? cached / prompt * 100 : null
}

export function contiguousSegments(points, key) {
  const segments = []
  let current = []
  points.forEach((point, index) => {
    const value = finiteMetric(point[key])
    if (value === null) { if (current.length) segments.push(current); current = [] }
    else current.push({ point, index, value })
  })
  if (current.length) segments.push(current)
  return segments
}

export function modelBadges(model) {
  return {
    upstream: model.upstreamGray === true ? '上游灰度' : model.upstreamGray === false ? '上游正式' : '上游状态未知',
    gateway: model.gatewayPolicy === 'gray-pool' ? '受本地灰度策略限制' : '按流量规则分流',
    availability: model.gatewayAllowed === false ? '本地未开放' : '本地已启用',
    vision: model.vision === true ? '支持视觉' : model.vision === false ? '不支持视觉' : '视觉能力未知',
  }
}
