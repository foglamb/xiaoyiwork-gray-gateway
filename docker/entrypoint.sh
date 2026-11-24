#!/bin/sh
# Bootstrap a config on first run.
#
# Two modes:
#   1. A config file already exists (bind mount / volume) - leave it alone.
#   2. No file, but XIAOYI_API_KEY and XIAOYI_ADMIN_KEY are set - render one
#      from the example so the container can start without manual editing.
#
# Without either, print what is missing and exit non-zero. A crash loop here is
# intentional: it is visible in `docker logs` and in the restart counter, which
# is far easier to notice than a silently idle container.
set -eu

config="${XIAOYI_PROXY_CONFIG:-/app/config/config.json}"

if [ -f "$config" ]; then
  exec "$@"
fi

if [ -z "${XIAOYI_API_KEY:-}" ] || [ -z "${XIAOYI_ADMIN_KEY:-}" ]; then
  cat >&2 <<'MSG'
[启动失败] 没有找到配置文件，也没有提供初始化环境变量。

请选择一种方式：
  A. 挂载已有配置
     -v /path/to/config:/app/config

  B. 用环境变量首次生成
     -e XIAOYI_API_KEY=xy_...            # 客户端调用密钥，≥16 字符
     -e XIAOYI_ADMIN_KEY=xyadm_...       # 面板管理密钥，≥16 字符，且不能与上面相同
     -e XIAOYI_ACCOUNTS='[{"id":"a1","credential":"...","uid":"...","deviceId":"..."}]'
     -e XIAOYI_GRAY_SALT=$(openssl rand -hex 32)

提示：也可以在面板里用「华为登录」授权添加账号，无需在此写死凭据。
MSG
  exit 2
fi

node --input-type=module - "$config" <<'NODE'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const target = resolve(process.argv[2])
const examplePath = resolve('/app/config/config.example.json')
const config = JSON.parse(await readFile(examplePath, 'utf8'))
const env = process.env

config.apiKey = env.XIAOYI_API_KEY
config.adminKey = env.XIAOYI_ADMIN_KEY
config.port = Number(env.PORT || 17356)
config.listen = '0.0.0.0'
config.allowPanelFromLan = env.XIAOYI_ALLOW_PANEL_LAN !== '0'
config.gray.salt = env.XIAOYI_GRAY_SALT || randomBytes(32).toString('hex')

const accounts = env.XIAOYI_ACCOUNTS ? JSON.parse(env.XIAOYI_ACCOUNTS) : []
if (!Array.isArray(accounts)) throw new Error('XIAOYI_ACCOUNTS 必须是 JSON 数组')
const shape = (account, pool, index) => ({
  id: account.id || `${pool}-${index + 1}`,
  credential: account.credential || '',
  uid: String(account.uid || ''),
  deviceId: account.deviceId || '',
  ...(account.refreshToken ? { refreshToken: account.refreshToken } : {}),
  ...(account.validTimeSec ? { validTimeSec: Number(account.validTimeSec) } : {}),
})
const pool = env.XIAOYI_ACCOUNT_POOL === 'stable' ? 'stable' : 'gray'
config.accounts = { stable: [], gray: [] }
config.accounts[pool] = accounts.map((account, index) => shape(account, pool, index))
// The example ships placeholder accounts; drop them so validation sees real input.
config.accounts.stable = config.accounts.stable.filter((a) => a.credential && a.uid)
config.accounts.gray = config.accounts.gray.filter((a) => a.credential && a.uid)
if (env.XIAOYI_GRAY_PERCENTAGE !== undefined) {
  config.gray.percentage = Number(env.XIAOYI_GRAY_PERCENTAGE)
}

await mkdir(dirname(target), { recursive: true })
await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
console.error(`[init] 已根据环境变量生成 ${target}`)
NODE

exec "$@"
