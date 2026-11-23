import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createProxyServer } from './server.mjs'

const config = JSON.parse(await readFile(resolve(process.env.XIAOYI_PROXY_CONFIG || 'config/config.json'), 'utf8'))
const server = createProxyServer(config, { configPath: resolve(process.env.XIAOYI_PROXY_CONFIG || 'config/config.json') })
server.listen(config.port, config.listen, () => console.log(`[xiaoyi-proxy] http://${config.listen}:${config.port}`))
