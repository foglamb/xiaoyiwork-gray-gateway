// Schema/request compatibility adapted from the MIT-licensed reference:
// https://github.com/xuediner-source/magpie-xiaoyiwork-auth
// Keep local cycle/depth budgets and preserve non-Kimi request semantics.

/* ========================================================================== */
/* 工具 Schema 归一化（补全 Kimi 要求的 type）                                  */
/* ========================================================================== */

const SCHEMA_MAP_KEYS = ['properties', '$defs', 'definitions', 'dependentSchemas', 'patternProperties']
const SCHEMA_CHILD_KEYS = [
  'items',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
]
const SCHEMA_NOTE_KEYS = new Set(['$ref', 'description', 'title', 'default', 'examples', '$comment'])
const ALL_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']

const hasOwn = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
const isSchemaObj = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v))

function schemaKeywordType(s) {
  const hasAny = (keys) => keys.some((k) => hasOwn(s, k) && s[k] !== undefined)
  if (
    hasAny([
      'properties',
      'required',
      'additionalProperties',
      'patternProperties',
      'minProperties',
      'maxProperties',
      'propertyNames',
      'dependentRequired',
      'dependentSchemas',
      'unevaluatedProperties',
    ])
  ) {
    return 'object'
  }
  if (hasAny(['items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'unevaluatedItems'])) {
    return 'array'
  }
  if (hasAny(['minLength', 'maxLength', 'pattern', 'format', 'contentEncoding', 'contentMediaType'])) {
    return 'string'
  }
  if (hasAny(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])) {
    return 'number'
  }
  return ''
}

function scalarJsonType(v) {
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number' && Number.isFinite(v)) return Number.isInteger(v) ? 'integer' : 'number'
  return ''
}

function inferEnumType(vals) {
  if (!Array.isArray(vals) || vals.length === 0) return null
  let hasNull = false
  let baseType = ''
  for (const v of vals) {
    if (v === null) {
      hasNull = true
      continue
    }
    const vt = scalarJsonType(v)
    if (!vt) return null
    if (!baseType || baseType === vt) baseType = vt
    else if ((baseType === 'integer' && vt === 'number') || (baseType === 'number' && vt === 'integer')) {
      baseType = 'number'
    } else return null
  }
  if (!baseType) return hasNull ? 'null' : null
  return hasNull ? [baseType, 'null'] : baseType
}

function fillUntypedEnums(node, inSchema) {
  if (Array.isArray(node)) {
    for (const item of node) fillUntypedEnums(item, inSchema)
    return
  }
  if (!isSchemaObj(node)) return

  if (inSchema && !hasOwn(node, 'type')) {
    const vals = Array.isArray(node.enum) ? node.enum : hasOwn(node, 'const') ? [node.const] : null
    if (vals) {
      const kt = schemaKeywordType(node)
      if (kt === 'object' || kt === 'array') {
        node.type = kt
      } else {
        const inferred = inferEnumType(vals)
        if (inferred) node.type = inferred
      }
    }
  }

  if (!inSchema) {
    if (hasOwn(node, 'parameters')) fillUntypedEnums(node.parameters, true)
    if (hasOwn(node, 'input_schema')) fillUntypedEnums(node.input_schema, true)
    if (hasOwn(node, 'function')) fillUntypedEnums(node.function, false)
    return
  }

  for (const k of SCHEMA_MAP_KEYS) {
    const m = node[k]
    if (isSchemaObj(m)) {
      for (const sub of Object.values(m)) fillUntypedEnums(sub, true)
    }
  }
  for (const k of SCHEMA_CHILD_KEYS) {
    const child = node[k]
    if (child && typeof child === 'object') fillUntypedEnums(child, true)
  }
}

function walkSchema(node, fn) {
  if (Array.isArray(node)) {
    for (const item of node) walkSchema(item, fn)
    return
  }
  if (!isSchemaObj(node)) return
  fn(node)
  for (const k of SCHEMA_MAP_KEYS) {
    const m = node[k]
    if (isSchemaObj(m)) {
      for (const sub of Object.values(m)) walkSchema(sub, fn)
    }
  }
  for (const k of SCHEMA_CHILD_KEYS) {
    const child = node[k]
    if (child && typeof child === 'object') walkSchema(child, fn)
  }
}

function resolveRefTarget(root, ref) {
  if (typeof ref !== 'string') return null
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return null
  let cur = root
  for (let tok of ref.slice(2).split('/')) {
    tok = tok.replace(/~1/g, '/').replace(/~0/g, '~')
    try {
      tok = decodeURIComponent(tok)
    } catch {
      /* keep raw token */
    }
    if (!cur || typeof cur !== 'object') return null
    if (Array.isArray(cur)) {
      const idx = Number(tok)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return null
      cur = cur[idx]
    } else if (hasOwn(cur, tok)) {
      cur = cur[tok]
    } else {
      return null
    }
  }
  return cur && typeof cur === 'object' ? cur : null
}

function needsRefTargetType(s) {
  if (!isSchemaObj(s) || hasOwn(s, 'type') || hasOwn(s, 'anyOf')) return false
  const keys = Object.keys(s)
  if (keys.length === 0) return false
  const onlyNotes = keys.every((k) => SCHEMA_NOTE_KEYS.has(k))
  return !(onlyNotes && typeof s.$ref === 'string')
}

function collectSchemaTypes(root, s, depth = 0) {
  if (depth > 16 || !isSchemaObj(s)) return null
  const ts = new Set()
  if (hasOwn(s, 'type')) {
    const arr = Array.isArray(s.type) ? s.type : typeof s.type === 'string' ? [s.type] : []
    for (const t of arr) if (typeof t === 'string' && t) ts.add(t)
    return ts
  }
  if (typeof s.$ref === 'string') {
    const target = resolveRefTarget(root, s.$ref)
    return target ? collectSchemaTypes(root, target, depth + 1) : null
  }
  if (Array.isArray(s.enum) || hasOwn(s, 'const')) {
    const vals = Array.isArray(s.enum) ? s.enum : [s.const]
    for (const v of vals) {
      if (v === null) ts.add('null')
      else if (Array.isArray(v)) ts.add('array')
      else if (typeof v === 'object') ts.add('object')
      else {
        const vt = scalarJsonType(v)
        if (vt) ts.add(vt)
      }
    }
    return ts
  }
  for (const k of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(s[k])) continue
    let known = false
    for (const branch of s[k]) {
      const bt = collectSchemaTypes(root, branch, depth + 1)
      if (!bt || bt.size === 0) {
        if (k !== 'allOf') return null
        continue
      }
      for (const t of bt) {
        ts.add(t)
        known = true
      }
    }
    if (known) return ts
  }
  const kt = schemaKeywordType(s)
  if (!kt) return null
  ts.add(kt)
  return ts
}

function inferRefTargetType(root, s) {
  const kt = schemaKeywordType(s)
  if (kt === 'object' || kt === 'array') return kt
  if (Array.isArray(s.enum)) return inferEnumType(s.enum)
  if (hasOwn(s, 'const')) return inferEnumType([s.const])
  const ts = collectSchemaTypes(root, s, 0)
  if (!ts || ts.size === 0) return ALL_SCHEMA_TYPES
  if (ts.has('integer') && ts.has('number')) ts.delete('integer')
  const ordered = ALL_SCHEMA_TYPES.filter((t) => ts.has(t))
  if (ordered.length === 0) return ALL_SCHEMA_TYPES
  return ordered.length === 1 ? ordered[0] : ordered
}

function cloneJson(v) {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v
}

function inlineLocalRefs(root) {
  let unresolved = false
  const budget = { left: 1000 }

  const expand = (node, seen, depth) => {
    if (Array.isArray(node)) {
      return node.map((item) => expand(item, seen, depth))
    }
    if (!isSchemaObj(node)) return node

    if (typeof node.$ref === 'string') {
      const ref = node.$ref
      const target = resolveRefTarget(root, ref)
      if (!target) {
        unresolved = true
        return node
      }
      const { $ref: _drop, ...siblings } = node
      if (seen.has(ref) || depth > 24 || budget.left <= 0) {
        const kt = schemaKeywordType(target)
        const fallback = hasOwn(siblings, 'type') ? siblings : { type: kt || 'object', ...siblings }
        return expand(fallback, seen, depth + 1)
      }
      budget.left -= 1
      const nextSeen = new Set(seen)
      nextSeen.add(ref)
      const expandedTarget = expand(cloneJson(target), nextSeen, depth + 1)
      const expandedSiblings = {}
      for (const [k, v] of Object.entries(siblings)) {
        expandedSiblings[k] = expand(v, seen, depth + 1)
      }
      return isSchemaObj(expandedTarget) ? { ...expandedTarget, ...expandedSiblings } : expandedSiblings
    }

    for (const k of SCHEMA_MAP_KEYS) {
      if (k === '$defs' || k === 'definitions') continue
      const m = node[k]
      if (isSchemaObj(m)) {
        for (const [prop, sub] of Object.entries(m)) {
          m[prop] = expand(sub, seen, depth + 1)
        }
      }
    }
    for (const k of SCHEMA_CHILD_KEYS) {
      if (hasOwn(node, k) && node[k] && typeof node[k] === 'object') {
        node[k] = expand(node[k], seen, depth + 1)
      }
    }
    return node
  }

  expand(root, new Set(), 0)
  if (!unresolved) {
    delete root.$defs
    delete root.definitions
  }
}

function fillUntypedRefs(root) {
  walkSchema(root, (node) => {
    if (typeof node.$ref !== 'string') return
    let target = resolveRefTarget(root, node.$ref)
    for (let i = 0; target && typeof target.$ref === 'string'; i += 1) {
      if (i > 16) return
      target = resolveRefTarget(root, target.$ref)
    }
    if (!target || !needsRefTargetType(target)) return
    const inferred = inferRefTargetType(root, target)
    if (inferred) target.type = inferred
  })
}

/** Kimi/小艺Work 拒绝无 type 的 enum/const 及 $ref，转发前内联 $ref 并补全 type */
export function normalizeToolSchemas(bodyObj) {
  if (!bodyObj || typeof bodyObj !== 'object') return bodyObj
  const fixRoot = (root) => {
    if (!isSchemaObj(root)) return
    inlineLocalRefs(root)
    fillUntypedEnums(root, true)
    fillUntypedRefs(root)
  }
  if (Array.isArray(bodyObj.tools)) {
    for (const tool of bodyObj.tools) {
      if (!isSchemaObj(tool)) continue
      fixRoot(tool.function?.parameters)
      fixRoot(tool.parameters)
      fixRoot(tool.input_schema)
    }
  }
  if (Array.isArray(bodyObj.functions)) {
    for (const fn of bodyObj.functions) {
      if (isSchemaObj(fn)) fixRoot(fn.parameters)
    }
  }
  return bodyObj
}

/**
 * 请求体归一化：
 * 1. Schema 归一化（补全 type，内联 $ref）。
 * 2. Kimi / 推理模型上游网关兼容性修正：
 *    - temperature：Kimi 推理后端只支持 temperature=1（或缺省）；
 *      若传其它值（如 Qoder/Codex 生成标题或确定性任务传 0）会触发 11115 / server inner (502)。
 *    - tool_choice：Kimi 推理后端只支持 'auto' / 'none' / 'required'（或缺省）；
 *      若传对象（如 { type: 'function', function: { name: '...' } }）会触发 11115 / server inner，
 *      转为 'required' 以保留强制调用工具意图且避免网关报错。
 */
export function normalizeRequestBody(bodyObj, { kimi = true, schemas = true } = {}) {
  if (!bodyObj || typeof bodyObj !== 'object') return bodyObj
  if (schemas) normalizeToolSchemas(bodyObj)

  if (kimi && bodyObj.model && /kimi/i.test(bodyObj.model)) {
    if (bodyObj.temperature !== undefined && bodyObj.temperature !== 1) {
      delete bodyObj.temperature
    }
    if (typeof bodyObj.tool_choice === 'object' && bodyObj.tool_choice !== null) {
      bodyObj.tool_choice = 'required'
    }
  }

  return bodyObj
}

