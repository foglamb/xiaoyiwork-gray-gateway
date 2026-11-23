import { networkInterfaces } from 'node:os'

export function isLoopbackAddress(address = '') {
  const normalized = String(address).replace(/^::ffff:/, '')
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
}

export function lanUrls(port) {
  const addresses = new Set()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      const address = entry.address
      if (entry.internal || entry.family !== 'IPv4' || !isPrivateIpv4(address)) continue
      addresses.add(`http://${address}:${port}/v1`)
    }
  }
  return [...addresses]
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

export function panelAuthorized(request, config) {
  if (config.allowPanelFromLan === true) return true
  // Proxy headers are intentionally ignored. Source address, not a spoofable XFF,
  // controls access to the administrative data plane.
  return isLoopbackAddress(request.socket?.remoteAddress)
}
