import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const entrypoint = join(root, 'docker/entrypoint.sh')

/**
 * The entrypoint hard-codes the container's /app paths, so each test rewrites
 * them to a temp directory. Only the path prefixes change; the logic is the
 * same code that runs in the image.
 */
async function stage() {
  const dir = await mkdtemp(join(tmpdir(), 'xiaoyi-docker-'))
  await mkdir(join(dir, 'config'), { recursive: true })
  await cp(join(root, 'config/config.example.json'), join(dir, 'config/config.example.json'))
  const source = await readFile(entrypoint, 'utf8')
  const rewritten = source
    .replaceAll('/app/config/config.example.json', join(dir, 'config/config.example.json'))
    .replaceAll('/app/config', join(dir, 'config'))
  const script = join(dir, 'entrypoint.sh')
  await writeFile(script, rewritten, { mode: 0o755 })
  return { dir, script, configPath: join(dir, 'config/config.json') }
}

const run = (script, env, args = ['node', '-e', 'console.log("RAN")']) =>
  spawnSync(script, args, { env: { ...process.env, ...env }, encoding: 'utf8' })

test('entrypoint refuses to start without a config or seed env', async () => {
  const { script, configPath } = await stage()
  const result = run(script, {
    XIAOYI_PROXY_CONFIG: configPath,
    XIAOYI_API_KEY: '',
    XIAOYI_ADMIN_KEY: '',
  })
  assert.equal(result.status, 2, 'must exit non-zero so the restart policy shows it')
  assert.match(result.stderr, /启动失败/)
  assert.doesNotMatch(result.stdout, /RAN/, 'must not exec the server')
})

test('entrypoint renders a valid config from environment variables', async () => {
  const { script, configPath } = await stage()
  const result = run(script, {
    XIAOYI_PROXY_CONFIG: configPath,
    XIAOYI_API_KEY: 'xy_test_key_0123456789',
    XIAOYI_ADMIN_KEY: 'xyadm_test_key_0123456789',
    XIAOYI_GRAY_SALT: 'a'.repeat(64),
    XIAOYI_ACCOUNTS: JSON.stringify([
      { id: 'gray-1', credential: 'cred-abc', uid: '10000000008', deviceId: 'dev-1' },
    ]),
    XIAOYI_ACCOUNT_POOL: 'gray',
    XIAOYI_GRAY_PERCENTAGE: '35',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RAN/, 'server is exec(2)ed after bootstrap')

  const config = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(config.apiKey, 'xy_test_key_0123456789')
  assert.equal(config.adminKey, 'xyadm_test_key_0123456789')
  assert.equal(config.listen, '0.0.0.0')
  assert.equal(config.gray.salt, 'a'.repeat(64))
  assert.equal(config.gray.percentage, 35)
  assert.equal(config.accounts.gray.length, 1)
  assert.equal(config.accounts.gray[0].uid, '10000000008')
  // The example's placeholder accounts must not survive into the real config.
  assert.equal(config.accounts.stable.length, 0)
  assert.doesNotMatch(JSON.stringify(config), /CHANGE_ME|STABLE_BUSINESS_CREDENTIAL/)

  // The real validator must accept what the entrypoint produced.
  const { validateConfig } = await import('../src/canary.mjs')
  assert.doesNotThrow(() => validateConfig(config))
})

test('entrypoint leaves an existing config untouched', async () => {
  const { script, configPath } = await stage()
  const existing = JSON.stringify({ sentinel: true, apiKey: 'keep-me-0123456789', adminKey: 'keep-me-admin-0123456' })
  await writeFile(configPath, existing)

  const result = run(script, {
    XIAOYI_PROXY_CONFIG: configPath,
    XIAOYI_API_KEY: 'xy_other_key_0123456789',
    XIAOYI_ADMIN_KEY: 'xyadm_other_key_0123456789',
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /RAN/)
  assert.equal(await readFile(configPath, 'utf8'), existing, 'must not overwrite user config')
})
