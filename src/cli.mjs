#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyServer } from './server.mjs'
import { validateConfig } from './canary.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
if (has('--help') || has('-h')) {
  console.log('小艺Work 灰度网关\n\n  npm start -- --open [--port 17356] [--lan]\n\n  --open   启动后打开 Web 管理面板\n  --local  仅本机监听（默认）\n  --lan    局域网监听；面板仍需管理密钥\n  --port   指定监听端口\n')
  process.exit(0)
}
const configPath = resolve(process.env.XIAOYI_PROXY_CONFIG || option('--config') || resolve(root, 'config/config.json'))
try {
  await readFile(configPath, 'utf8')
} catch {
  const example = resolve(root, 'config/config.example.json')
  await mkdir(dirname(configPath), { recursive: true })
  await copyFile(example, configPath)
  console.error(`\n首次启动：已生成 ${configPath}\n请填写 apiKey、adminKey、gray.salt 和 stable/gray 账号凭据后重试。\n`)
  process.exit(2)
}
const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')))
if (option('--port')) config.port = Number(option('--port'))
if (has('--lan')) config.listen = '0.0.0.0'
if (has('--local')) config.listen = '127.0.0.1'
validateConfig(config)
const server = createProxyServer(config, { configPath })
server.once('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `[错误] 端口 ${config.port} 已被占用，请用 --port 指定其他端口` : `[错误] ${error.message}`)
  process.exitCode = 1
})
server.listen(config.port, config.listen, () => {
  const url = `http://127.0.0.1:${config.port}`
  console.log(`\n  小艺Work 灰度网关已启动\n  面板    ${url}\n  API     ${url}/v1\n  监听    ${config.listen === '0.0.0.0' ? `局域网 ${config.listen}` : `仅本机 ${config.listen}`}\n  灰度    ${config.gray.enabled ? `${config.gray.percentage}% → ${config.gray.pool}` : '已关闭'}\n`)
  if (has('--open')) openBrowser(url)
})

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd.exe', ['/c', 'start', '', url], () => {})
  else if (process.platform === 'darwin') execFile('open', [url], () => {})
  else execFile('xdg-open', [url], () => {})
}
// Last-resort guards: log the fault but keep the gateway serving. A single bad
// request must not take down every client connection.
let fatalCount = 0
const reportFatal = (kind) => (error) => {
  fatalCount++
  const at = new Date().toISOString()
  console.error(`[fatal] ${at} ${kind} #${fatalCount}: ${error?.stack || error?.message || error}`)
  // Repeated failures usually mean a real bug; exit so a supervisor can restart.
  if (fatalCount >= 50) {
    console.error('[fatal] too many uncaught errors, exiting so the supervisor can restart')
    process.exit(1)
  }
}
process.on('uncaughtException', reportFatal('uncaughtException'))
process.on('unhandledRejection', reportFatal('unhandledRejection'))

let stopping = false
const shutdown = (signal) => {
  if (stopping) return
  stopping = true
  console.log(`\n收到 ${signal || 'SIGTERM'}，正在优雅退出…`)
  // Stop accepting new connections, let in-flight streams finish, then exit.
  server.close(() => process.exit(0))
  setTimeout(() => {
    console.warn('[shutdown] 3 秒内未完成，强制关闭连接')
    server.closeAllConnections?.()
    process.exit(0)
  }, 3000).unref()
}
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
