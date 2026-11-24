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
