#!/usr/bin/env node
/**
 * Host-shape test for `dsh-deepseek-toolbox`.
 *
 * Loads `lib/index.js` directly in plain Node (it must import cleanly with zero
 * external dependencies), registers the tools through a fake `ctx`, and asserts
 * that every registry-ready definition matches the shape the DSH 0.2.x tool
 * registry accepts. It also executes the three tools against a monkey-patched
 * global `fetch` (no network, no real credentials) to cover the shared
 * implementation and output-contract validation.
 *
 * Run: node test/host-shape.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'

/** JSON Schema types the DSH tool registry accepts. */
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** Keywords the DSH tool registry accepts (annotations included). */
const ALLOWED_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])

let checks = 0
let failures = 0

/**
 * Run one named check, collecting instead of aborting on failure.
 * @param {string} label check label
 * @param {() => unknown | Promise<unknown>} fn check body
 */
async function check(label, fn) {
  checks += 1
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Assert one raw schema (and every nested schema) fits the registry subset.
 * @param {unknown} schema schema node
 * @param {string} path diagnostic path
 */
function assertSchemaShape(schema, path) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), `${path} must be a schema object`)
  for (const key of Object.keys(schema)) assert.ok(ALLOWED_KEYWORDS.has(key), `${path}.${key} is not an allowed keyword`)
  if (Object.hasOwn(schema, 'description')) assert.equal(typeof schema.description, 'string', `${path}.description must be a string`)
  if (Object.hasOwn(schema, 'oneOf')) {
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, `${path}.oneOf must have at least two branches`)
    for (let index = 0; index < schema.oneOf.length; index += 1) assertSchemaShape(schema.oneOf[index], `${path}.oneOf[${index}]`)
    return
  }
  assert.ok(ALLOWED_TYPES.has(schema.type), `${path}.type must be one of ${[...ALLOWED_TYPES].join('/')} (got ${JSON.stringify(schema.type)})`)
  if (schema.type === 'object') {
    assert.equal(typeof schema.additionalProperties, 'boolean', `${path}.additionalProperties must be a boolean`)
    const properties = schema.properties ?? {}
    assert.equal(typeof properties, 'object', `${path}.properties must be an object`)
    if (Object.hasOwn(schema, 'required')) {
      assert.ok(Array.isArray(schema.required), `${path}.required must be an array of strings`)
      for (const required of schema.required) {
        assert.equal(typeof required, 'string', `${path}.required entries must be strings`)
        assert.ok(Object.hasOwn(properties, required), `${path}.required names ${JSON.stringify(required)} which is not declared`)
      }
    }
    for (const [key, child] of Object.entries(properties)) assertSchemaShape(child, `${path}.properties.${key}`)
  } else if (schema.type === 'array') {
    assert.ok(Object.hasOwn(schema, 'items'), `${path}.items is required for array schemas`)
    assertSchemaShape(schema.items, `${path}.items`)
  }
  if (Object.hasOwn(schema, 'enum')) assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0, `${path}.enum must be a non-empty array`)
}

/**
 * Validate one value against the enforced schema subset (test-local mirror).
 * @param {any} schema schema node
 * @param {unknown} value candidate value
 * @param {string} path diagnostic path
 * @param {string[]} errors collected errors
 * @returns {string[]} collected errors
 */
function validateValue(schema, value, path = 'value', errors = []) {
  if (Object.hasOwn(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((branch) => validateValue(branch, value, path, []).length === 0)
    if (matches.length !== 1) errors.push(`${path} must match exactly one oneOf branch (matched ${matches.length})`)
    return errors
  }
  const matchesType = schema.type === 'object'
    ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : schema.type === 'array'
      ? Array.isArray(value)
      : schema.type === 'string'
        ? typeof value === 'string'
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : schema.type === 'integer'
            ? typeof value === 'number' && Number.isInteger(value)
            : schema.type === 'boolean'
              ? typeof value === 'boolean'
              : schema.type === 'null'
                ? value === null
                : false
  if (!matchesType) {
    errors.push(`${path} must be ${schema.type} (got ${value === null ? 'null' : typeof value})`)
    return errors
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
  if (schema.type === 'object') {
    const properties = schema.properties ?? {}
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`)
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateValue(properties[key], child, `${path}.${key}`, errors)
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a declared property`)
    }
  }
  if (schema.type === 'array') value.forEach((entry, index) => validateValue(schema.items, entry, `${path}[${index}]`, errors))
  return errors
}

/**
 * Install a fake fetch for one test and restore it afterwards.
 * @param {(url: string, init: object) => Promise<Response>} handler fake transport
 * @returns {{ restore: () => void, calls: Array<{ url: string, init: object }> }} control handle
 */
function fakeFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return await handler(String(url), init)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/**
 * Build a JSON `Response`.
 * @param {unknown} payload JSON payload
 * @param {number} [status=200] HTTP status
 * @returns {Response} response
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A fake Cordis context capturing registrations.
 * @param {(service: string) => unknown} [getService] optional service resolver
 * @returns {{ tools: { register: (definition: object) => void }, get: (service: string) => unknown, definitions: object[] }} fake context
 */
function fakeContext(getService = () => undefined) {
  const definitions = []
  return {
    definitions,
    tools: {
      register(definition) {
        definitions.push(definition)
      },
    },
    get(service) {
      return getService(service)
    },
  }
}

/**
 * A fake tool execution context.
 * @returns {{ agent: undefined, signal: AbortSignal }} exec
 */
function fakeExec() {
  return { agent: undefined, signal: new AbortController().signal }
}

/** Temporary working directory, removed at the end. */
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-deepseek-toolbox-'))
const originalCwd = process.cwd()
const originalApiKey = process.env.DEEPSEEK_API_KEY
let fake = undefined

try {
  await check('lib/index.js imports with zero external dependencies', async () => {
    assert.equal(name, 'dsh-deepseek-toolbox')
    assert.deepEqual(inject, ['tools'])
    assert.equal(typeof apply, 'function')
  })

  const ctx = fakeContext()
  apply(ctx, {})

  await check('apply registers exactly the three model-facing tools in the host plane', async () => {
    assert.equal(ctx.definitions.length, 3)
    assert.deepEqual(ctx.definitions.map((definition) => definition.name).sort(), ['deepseek_fetch', 'deepseek_search', 'ocr'])
  })

  for (const definition of ctx.definitions) {
    await check(`${definition.name}: registry-ready definition shape`, async () => {
      assert.equal(typeof definition.name, 'string')
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 40, 'a tool description must actually explain the tool')
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.output, 'object')
      assert.equal(typeof definition.output.render, 'function')
      assertSchemaShape(definition.parameters, `${definition.name}.parameters`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(definition.parameters.additionalProperties, false)
      assert.ok(Array.isArray(definition.parameters.required) && definition.parameters.required.length > 0)
      assertSchemaShape(definition.output.schema, `${definition.name}.output.schema`)
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(definition.output.schema.additionalProperties, false)
      if (definition.presentCall !== undefined) {
        const args = definition.name === 'ocr'
          ? { path: 'shot.png' }
          : definition.name === 'deepseek_search'
            ? { query: 'test' }
            : { url: 'https://example.com' }
        const presentation = definition.presentCall(args)
        assert.equal(presentation.card, 'generic')
        assert.equal(typeof presentation.title, 'string')
        assert.equal(typeof presentation.kind, 'string')
        assert.equal(typeof presentation.rawInput, 'string')
      }
    })
  }

  // ---------------------------------------------------------------- offline execution
  process.chdir(temporaryRoot)
  process.env.DEEPSEEK_API_KEY = 'offline-test-key-not-a-real-secret'
  const definitions = Object.fromEntries(ctx.definitions.map((definition) => [definition.name, definition]))
  await mkdir(join(temporaryRoot, '.dsh'), { recursive: true })
  await writeFile(join(temporaryRoot, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))

  const ocrPayload = {
    id: 'ocr-test',
    object: 'ocr.result',
    created: 1764000000,
    purpose: 'text_recognition',
    page_count: 2,
    pages: [
      { index: 0, text: 'Hello 世界', finish_reason: 'stop' },
      { index: 1, text: 'Page two text', finish_reason: 'length' },
    ],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  }
  fake = fakeFetch(async (url) => {
    if (url.endsWith('/ocr')) return jsonResponse(ocrPayload)
    throw new Error(`unexpected fake request ${url}`)
  })

  await check('ocr: execute sends multipart + Bearer and returns a schema-valid value', async () => {
    const result = await definitions.ocr.execute({ path: 'shot.png', preview: 'all' }, fakeExec())
    assert.equal(result.ok, true)
    assert.equal(result.pageCount, 2)
    assert.equal(result.purpose, 'text_recognition')
    assert.equal(result.costCny, 0.003)
    assert.deepEqual(result.previewPages, [1, 2])
    assert.match(result.preview, /Hello 世界/u)
    assert.equal(result.truncated, true, 'a finish_reason=length page makes truncated true')
    assert.deepEqual(validateValue(definitions.ocr.output.schema, result), [])
    const call = fake.calls.at(-1)
    assert.ok(call.url.endsWith('/v1/tools/ocr'), `unexpected OCR endpoint ${call.url}`)
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.headers.authorization, 'Bearer offline-test-key-not-a-real-secret')
    assert.equal(call.init.headers['x-dsh-auth-token'], undefined)
    assert.notEqual(typeof call.init.body?.append, 'undefined', 'OCR body must be a FormData body')
    const markdown = await readFile(result.outputPath, 'utf8')
    assert.match(markdown, /^# OCR: shot\.png/mu)
    assert.match(markdown, /## Page 1/u)
    assert.match(markdown, /Hello 世界/u)
    assert.match(markdown, /finish_reason: length/u)
    assert.ok(result.outputPath.includes('.dsh'), 'default output lives under .dsh/ocr')
    const rendered = definitions.ocr.output.render({ path: 'shot.png' }, result)
    assert.equal(rendered.length, 1)
    assert.match(rendered[0].text, /OCR shot\.png: 2 page\(s\)/u)
    assert.match(rendered[0].text, /Full text: /u)
  })

  await check('ocr: rich layout purpose and custom out path', async () => {
    const result = await definitions.ocr.execute({ path: 'shot.png', purpose: 'rich_layout_recognition', preview: '2', out: 'custom/out.md' }, fakeExec())
    assert.equal(result.purpose, 'rich_layout_recognition')
    assert.deepEqual(result.previewPages, [2])
    assert.equal(result.outputPath, join(process.cwd(), 'custom', 'out.md'))
  })

  await check('ocr: rejects bad purpose, preview, unknown args and a missing file', async () => {
    await assert.rejects(definitions.ocr.execute({ path: 'shot.png', purpose: 'nope' }, fakeExec()), /purpose must be one of/u)
    await assert.rejects(definitions.ocr.execute({ path: 'shot.png', preview: '9-2' }, fakeExec()), /invalid: start must not exceed end/u)
    await assert.rejects(definitions.ocr.execute({ path: 'shot.png', bogus: 1 }, fakeExec()), /unknown argument/u)
    await assert.rejects(definitions.ocr.execute({ path: 'does-not-exist.png' }, fakeExec()), /File not found/u)
    await assert.rejects(definitions.ocr.execute({}, fakeExec()), /path must be a non-empty file path/u)
  })

  fake.restore()
  fake = fakeFetch(async (url) => {
    if (url.endsWith('/search')) {
      return jsonResponse({
        results: [
          { rerank_score: 0.91, title: 'DeepSeek OCR', url: 'https://example.com/ocr', snippet: 'OCR docs', summary: 'Summary text', site_name: 'example.com', date: '2026-11-24', authority: 0.8, content: 'Full page content' },
          { title: 'no url', snippet: 'dropped' },
        ],
      })
    }
    if (url.endsWith('/fetch')) return jsonResponse({ title: 'Example page', content: '# Example\n\nBody text' })
    throw new Error(`unexpected fake request ${url}`)
  })

  await check('deepseek_search: execute returns normalized, schema-valid results', async () => {
    const result = await definitions.deepseek_search.execute({ query: '  DeepSeek OCR 价格  ', count: 3, need_content: true }, fakeExec())
    assert.equal(result.ok, true)
    assert.equal(result.query, 'DeepSeek OCR 价格')
    assert.equal(result.results.length, 1, 'an entry without a url is dropped')
    assert.equal(result.results[0].url, 'https://example.com/ocr')
    assert.equal(result.results[0].authority, 0.8)
    assert.equal(result.results[0].rerank_score, 0.91)
    assert.equal(result.results[0].content, 'Full page content')
    assert.deepEqual(validateValue(definitions.deepseek_search.output.schema, result), [])
    const call = fake.calls.at(-1)
    assert.ok(call.url.endsWith('/v1/tools/search'))
    assert.deepEqual(JSON.parse(call.init.body), { query: 'DeepSeek OCR 价格', count: 3, need_content: true })
    const rendered = definitions.deepseek_search.output.render({ query: 'DeepSeek OCR 价格' }, result)
    assert.match(rendered[0].text, /\[DeepSeek OCR\]\(https:\/\/example\.com\/ocr\)/u)
  })

  await check('deepseek_search: rejects invalid arguments', async () => {
    await assert.rejects(definitions.deepseek_search.execute({ query: '' }, fakeExec()), /query must be a non-empty string/u)
    await assert.rejects(definitions.deepseek_search.execute({ query: 'x'.repeat(129) }, fakeExec()), /at most 128 characters/u)
    await assert.rejects(definitions.deepseek_search.execute({ query: 'x', count: 51 }, fakeExec()), /count must be an integer between 1 and 50/u)
    await assert.rejects(definitions.deepseek_search.execute({ query: 'x', need_content: 'yes' }, fakeExec()), /need_content must be a boolean/u)
  })

  await check('deepseek_fetch: execute returns schema-valid content and renders it', async () => {
    const result = await definitions.deepseek_fetch.execute({ url: ' https://example.com/page ' }, fakeExec())
    assert.deepEqual(validateValue(definitions.deepseek_fetch.output.schema, result), [])
    assert.equal(result.url, 'https://example.com/page')
    assert.equal(result.title, 'Example page')
    assert.match(result.content, /Body text/u)
    const call = fake.calls.at(-1)
    assert.ok(call.url.endsWith('/v1/tools/fetch'))
    assert.deepEqual(JSON.parse(call.init.body), { url: 'https://example.com/page' })
    const rendered = definitions.deepseek_fetch.output.render({ url: result.url }, result)
    assert.match(rendered[0].text, /Fetched https:\/\/example\.com\/page/u)
    assert.match(rendered[0].text, /Body text/u)
  })

  await check('deepseek_fetch: rejects invalid URLs before any request', async () => {
    await assert.rejects(definitions.deepseek_fetch.execute({ url: 'ftp://example.com' }, fakeExec()), /must start with http/u)
    await assert.rejects(definitions.deepseek_fetch.execute({ url: 'not a url' }, fakeExec()), /not a valid absolute URL/u)
    await assert.rejects(definitions.deepseek_fetch.execute({}, fakeExec()), /url must be a non-empty HTTP\(S\) URL/u)
  })

  fake.restore()
  fake = undefined

  // ------------------------------------------------------- auth-source coverage (offline)
  const endpointCalls = []
  const accountCtx = fakeContext((service) => {
    if (service === 'agents') return { currentInitiator: () => ({ session: { requestContext: () => ({ provider: 'deepseek-account' }) } }) }
    if (service === 'deepseekAccount') {
      return {
        async resolveToken(endpoint) {
          endpointCalls.push(endpoint)
          return `account-token-for:${endpoint}`
        },
      }
    }
    return undefined
  })
  apply(accountCtx, {})
  const accountDefinitions = Object.fromEntries(accountCtx.definitions.map((definition) => [definition.name, definition]))
  fake = fakeFetch(async (url) => {
    if (url.endsWith('/search')) return jsonResponse({ results: [] })
    if (url.endsWith('/fetch')) return jsonResponse({ title: '', content: 'Fetched via credentials service' })
    throw new Error(`unexpected fake request ${url}`)
  })
  const savedKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY

  await check('account-routed sessions use x-dsh-auth-token scoped to the operation endpoint', async () => {
    await accountDefinitions.deepseek_search.execute({ query: 'account auth' }, fakeExec())
    const call = fake.calls.at(-1)
    assert.equal(call.init.headers['x-dsh-auth-token'], `account-token-for:${call.url}`)
    assert.equal(call.init.headers.authorization, undefined)
    assert.ok(endpointCalls.at(-1).endsWith('/search'))
  })

  await check('credentials service API key becomes a Bearer header', async () => {
    const credentialCtx = fakeContext((service) => service === 'credentials'
      ? { async resolve(reference) { assert.equal(reference, 'DEEPSEEK_API_KEY'); return { value: 'credential-service-key' } } }
      : undefined)
    apply(credentialCtx, {})
    const credentialDefinitions = Object.fromEntries(credentialCtx.definitions.map((definition) => [definition.name, definition]))
    await credentialDefinitions.deepseek_fetch.execute({ url: 'https://example.com' }, fakeExec())
    const call = fake.calls.at(-1)
    assert.equal(call.init.headers.authorization, 'Bearer credential-service-key')
    assert.equal(call.init.headers['x-dsh-auth-token'], undefined)
  })

  if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = savedKey
  fake.restore()
  fake = undefined

  await check('missing credential produces an actionable, secret-free error', async () => {
    const bareCtx = fakeContext()
    apply(bareCtx, {})
    const bareDefinitions = Object.fromEntries(bareCtx.definitions.map((definition) => [definition.name, definition]))
    const saved = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(temporaryRoot, 'empty-home')
    try {
      await assert.rejects(bareDefinitions.deepseek_search.execute({ query: 'no credential' }, fakeExec()), /store DEEPSEEK_API_KEY in DSH Models settings/u)
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = saved
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
} finally {
  if (fake !== undefined) fake.restore()
  process.chdir(originalCwd)
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = originalApiKey
  await rm(temporaryRoot, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exitCode = 1
}
