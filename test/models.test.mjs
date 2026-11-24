import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelCatalog } from '../src/models.mjs'

const config = { grayModels: ['Configured_Model'], gray: { models: ['Gray_Only'] } }

test('model catalogue uses upstream names and IDs when discovery succeeds', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (String(url).endsWith('/chat/')) {
      return new Response('<html></html>', {
        status: 200,
        headers: { 'set-cookie': 'xy_csrf_token=test-csrf; path=/; secure' },
      })
    }
    return Response.json({
      operationResult: JSON.stringify({
        contents: [{ modelList: [
          { modelName: 'Upstream Kimi', modelValue: 'Kimi_From_Upstream', aiPointConsumptionRatio: '0' },
          { modelName: 'Upstream DeepSeek', modelValue: 'DeepSeek_From_Upstream' },
        ] }],
      }),
    })
  }
  const catalog = new ModelCatalog({ fetchImpl })
  const status = await catalog.refresh({ force: true })
  assert.equal(status.ok, true)
  const models = catalog.list(config, ['Observed_Model'])
  assert.equal(models.find((m) => m.id === 'Kimi_From_Upstream').name, 'Upstream Kimi')
  assert.equal(models.find((m) => m.id === 'Kimi_From_Upstream').source, 'upstream')
  assert.equal(models.find((m) => m.id === 'Observed_Model').source, 'observed')
  assert.equal(models.find((m) => m.id === 'Configured_Model').source, 'config')
  assert.equal(models.every((m) => m.rate === 0), true)
  const modelCall = calls.find((call) => String(call.url).includes('getWorkModelList'))
  assert.equal(modelCall.init.headers['x-csrf-token'], 'test-csrf')
  assert.match(modelCall.init.headers.cookie, /xy_csrf_token=test-csrf/)
})

test('model discovery failure is explicit and keeps observed/config models', async () => {
  const catalog = new ModelCatalog({ fetchImpl: async () => new Response('missing', { status: 404 }) })
  const status = await catalog.refresh({ force: true })
  assert.equal(status.ok, false)
  assert.match(status.message, /404/)
  const models = catalog.list(config, ['Real_Request_Model'])
  assert.deepEqual(models.map((m) => m.id).sort(), ['Configured_Model', 'Gray_Only', 'Real_Request_Model'].sort())
  assert.equal(models.find((m) => m.id === 'Real_Request_Model').source, 'observed')
})

test('web model session persists privately, restores cache and redacts cookie', async () => {
  const { mkdtemp, readFile, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'xiaoyi-model-session-'))
  const configPath = join(dir, 'config.json')
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (String(url).endsWith('/chat/')) return new Response('<html></html>', { status: 200 })
    return Response.json({ operationResult: JSON.stringify({ contents: [{ modelList: [{ modelName: 'Real Kimi', modelValue: 'Real_Kimi' }] }] }) })
  }
  const catalog = new ModelCatalog({ configPath, fetchImpl })
  const status = await catalog.importSession({ cookies: [
    { name: 'xy_csrf_token', value: 'private-csrf' },
    { name: 'web_login', value: 'private-web-cookie' },
  ] })
  assert.equal(status.ok, true)
  assert.equal(status.sessionConfigured, true)
  assert.equal(JSON.stringify(status).includes('private-web-cookie'), false)
  assert.equal(catalog.list(config).find((model) => model.id === 'Real_Kimi').source, 'upstream')
  const savedPath = join(dir, 'model-catalog-session.json')
  assert.equal((await stat(savedPath)).mode & 0o777, 0o600)
  const saved = await readFile(savedPath, 'utf8')
  assert.match(saved, /private-web-cookie/)
  assert.match(saved, /Real_Kimi/)
  const modelCall = calls.find((call) => String(call.url).includes('getWorkModelList'))
  assert.match(modelCall.init.headers.cookie, /web_login=private-web-cookie/)
  assert.equal(modelCall.init.headers['x-csrf-token'], 'private-csrf')

  const restored = new ModelCatalog({ configPath, fetchImpl })
  assert.equal(restored.publicStatus().source, 'upstream-cache')
  assert.equal(restored.list(config).find((model) => model.id === 'Real_Kimi').name, 'Real Kimi')
  restored.clearSession()
  assert.equal(restored.publicStatus().sessionConfigured, false)
  assert.equal(restored.publicStatus().source, 'upstream-cache')
  assert.doesNotMatch(restored.publicStatus().message, /过期/)
  assert.equal((await readFile(savedPath, 'utf8')).includes('private-web-cookie'), false)
  assert.equal(restored.list(config).some((model) => model.id === 'Real_Kimi'), true)
})

test('disabled Work web agent reports the real feature gate instead of cookie expiry', async () => {
  const calls = []
  const html = `<script type="application/json" id="common">${JSON.stringify({ config: { webAgents: [{ type: 'claw', enableAgent: false, enableFeature: false }] } })}</script>`
  const catalog = new ModelCatalog({ fetchImpl: async (url) => {
    calls.push(String(url))
    return new Response(html, { status: 200, headers: { 'set-cookie': 'xy_csrf_token=csrf; path=/' } })
  } })
  await catalog.importSession({ cookie: 'xy_csrf_token=csrf; web_login=valid-login' })
  assert.match(catalog.publicStatus().message, /enableAgent=false/)
  assert.doesNotMatch(catalog.publicStatus().message, /过期/)
  assert.equal(calls.some((url) => url.includes('getWorkModelList')), false)
})

test('HAG catalogue uses businessCredential and real upstream model metadata', async () => {
  const calls = []
  const catalog = new ModelCatalog({ fetchImpl: async (url, init = {}) => {
    calls.push({ url, init })
    return Response.json({ contents: [{ modelList: [
      { modelValue: 'Kimi_Real', modelName: 'Kimi Real', modelDescription: '复杂任务', gray: true, aiPointConsumptionRatio: '消耗13x' },
      { modelValue: 'Auto-Model', modelName: 'Auto-Model', gray: false },
    ] }] })
  } })
  const status = await catalog.refresh({ force: true, account: { credential: 'business-secret', uid: '123456', deviceId: 'device-123456' } })
  assert.equal(status.ok, true)
  assert.equal(calls.length, 1, 'HAG succeeds without the web cookie fallback')
  assert.match(calls[0].url, /user-ability-gallery\/v1\/agent\/user\/query/)
  assert.equal(calls[0].init.headers.businessCredential, 'business-secret')
  assert.equal(calls[0].init.headers['x-prd-pkg-name'], 'com.huawei.hmos.vassistant')
  assert.equal(JSON.parse(calls[0].init.body).type, 'CELIA_CLAW_USER_MODEL_QUERY')
  const models = catalog.list(config)
  assert.equal(models.find((m) => m.id === 'Kimi_Real').name, 'Kimi Real')
  assert.equal(models.find((m) => m.id === 'Kimi_Real').gray, true)
  assert.equal(models.find((m) => m.id === 'Kimi_Real').upstreamRate, '消耗13x')
  assert.equal(models.find((m) => m.id === 'Kimi_Real').rate, 0)
  assert.equal(models.find((m) => m.id === 'Kimi_Real').description, '复杂任务')
})
