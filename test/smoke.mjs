#!/usr/bin/env node
/**
 * Reproducible smoke test for `dsh-deepseek-toolbox`.
 *
 * Offline (default): verifies package shape, the "no @deepseek-ai imports"
 * rule, syntax-checks every JS file, exercises the pure helpers in
 * `lib/core.js`, and runs `test/host-shape.test.mjs` as a child process.
 *
 * Live (`--live`): additionally runs the real DeepSeek Tool APIs through the
 * CLI — Search and Fetch always, OCR when `--image=<path>` is given (OCR is
 * billed per page, so it is opt-in). The CLI prints only which auth source it
 * used, never the credential.
 *
 * Run:
 *   node test/smoke.mjs
 *   node test/smoke.mjs --live [--image=<path-to-image-or-pdf>]
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  buildPreview,
  formatOcrMarkdown,
  httpErrorFor,
  mimeForPath,
  ocrCostCny,
  parsePageRange,
  sniffMimeFromHeader,
  withRetries,
} from '../lib/core.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
let failures = 0

/**
 * Run one named check.
 * @param {string} label check label
 * @param {() => unknown | Promise<unknown>} fn check body
 */
async function check(label, fn) {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Assert a child command succeeded.
 * @param {string} label diagnostic label
 * @param {string[]} args command and arguments
 * @returns {import('node:child_process').SpawnSyncReturns<string>} result
 */
function checkCommand(label, args) {
  const result = spawnSync(node, args, { cwd: packageRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    failures += 1
    console.error(`FAIL ${label}: exit ${result.status}`)
    if (result.stdout) console.error(result.stdout)
    if (result.stderr) console.error(result.stderr)
  } else {
    console.log(`ok   ${label}`)
  }
  return result
}

/** Files that must never import the runtime's own packages. */
const HOST_SOURCES = ['lib/index.js', 'lib/core.js', 'bin/deepseek-tools.mjs']

await check('package.json declares the bundle patch and file list', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-deepseek-toolbox')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.private, undefined)
  assert.deepEqual(manifest.files, ['lib', 'bin', 'README.md', 'LICENSE', 'cordis.patch.yml'])
  assert.equal(manifest.repository?.url, 'git+https://github.com/zijunyu81-source/dsh-deepseek-toolbox.git')
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh-plugin'))
  assert.ok(existsSync(join(packageRoot, 'cordis.patch.yml')))
  assert.ok(existsSync(join(packageRoot, 'lib', 'index.js')))
  assert.ok(existsSync(join(packageRoot, 'bin', 'deepseek-tools.mjs')))
  assert.ok(existsSync(join(packageRoot, 'README.md')))
  assert.ok(existsSync(join(packageRoot, 'LICENSE')))
})

await check('cordis.patch.yml inserts the toolbox row at the profile root', () => {
  const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/u)
  assert.match(patch, /id: tool-deepseek-toolbox/u)
  assert.match(patch, /name: dsh-deepseek-toolbox/u)
})

await check('no @deepseek-ai imports in plugin, core or CLI sources', () => {
  for (const source of HOST_SOURCES) {
    const text = readFileSync(join(packageRoot, source), 'utf8')
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue
      assert.ok(!/@deepseek-ai\//u.test(line), `${source} must not import @deepseek-ai packages: ${line.trim()}`)
    }
  }
})

for (const source of HOST_SOURCES) checkCommand(`node --check ${source}`, ['--check', join(packageRoot, source)])

await check('pricing helpers match the published rates', () => {
  assert.equal(ocrCostCny(1), 0.0015)
  assert.equal(ocrCostCny(2), 0.003)
  assert.equal(ocrCostCny(1000), 1.5)
})

await check('mimeForPath maps the documented OCR formats', () => {
  assert.equal(mimeForPath('a.pdf'), 'application/pdf')
  assert.equal(mimeForPath('a.PNG'), 'image/png')
  assert.equal(mimeForPath('a.jpeg'), 'image/jpeg')
  assert.equal(mimeForPath('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(mimeForPath('a.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  assert.equal(mimeForPath('no-extension'), undefined)
})

await check('magic-byte sniffing detects extensionless attachments', () => {
  assert.equal(sniffMimeFromHeader(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), 'application/pdf')
  assert.equal(sniffMimeFromHeader(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png')
  assert.equal(sniffMimeFromHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffMimeFromHeader(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
  assert.equal(sniffMimeFromHeader(new Uint8Array([0x49, 0x49, 0x2a, 0x00])), 'image/tiff')
  const webp = new Uint8Array(16)
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  assert.equal(sniffMimeFromHeader(webp), 'image/webp')
  const docx = Buffer.from('PK\x03\x04packageword/document.xml', 'latin1')
  assert.equal(sniffMimeFromHeader(docx), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(sniffMimeFromHeader(Buffer.from('plain text', 'latin1')), undefined)
})

await check('parsePageRange handles ranges, single pages, all and invalid input', () => {
  assert.deepEqual(parsePageRange(undefined, 5), [0, 1])
  assert.deepEqual(parsePageRange('all', 3), [0, 1, 2])
  assert.deepEqual(parsePageRange('3', 5), [2])
  assert.deepEqual(parsePageRange('2-9', 5), [1, 2, 3, 4])
  assert.throws(() => parsePageRange('0-2', 5), /1-based/u)
  assert.throws(() => parsePageRange('6-9', 5), /starts at page 6/u)
  assert.throws(() => parsePageRange('2-1', 5), /start must not exceed end/u)
})

await check('buildPreview caps the joined page text', () => {
  const pages = [{ text: 'a'.repeat(50) }, { text: 'b'.repeat(50) }]
  const built = buildPreview(pages, [0, 1], 60)
  assert.equal(built.capped, true)
  assert.equal(built.preview.length, 60)
  assert.deepEqual(built.previewPages, [1, 2])
  assert.equal(buildPreview(pages, [0], 1000).capped, false)
})

await check('httpErrorFor marks only 408/429/5xx as retryable and includes hints', () => {
  assert.equal(httpErrorFor(429, '{"error":{"message":"busy"}}').retryable, true)
  assert.equal(httpErrorFor(503, '').retryable, true)
  assert.equal(httpErrorFor(401, '').retryable, false)
  assert.equal(httpErrorFor(413, '').retryable, false)
  assert.match(httpErrorFor(401, '').message, /store DEEPSEEK_API_KEY/u)
  assert.match(httpErrorFor(413, '').message, /100 MiB/u)
  assert.match(httpErrorFor(400, 'bad form').message, /HTTP 400/u)
})

await check('withRetries retries retryable failures and rethrows permanent ones', async () => {
  let attempts = 0
  const transient = await withRetries(async () => {
    attempts += 1
    if (attempts < 3) {
      const error = new Error('busy')
      error.retryable = true
      throw error
    }
    return 'ok'
  }, { retries: 2, baseDelayMs: 1, maxDelayMs: 2 })
  assert.equal(transient, 'ok')
  assert.equal(attempts, 3)
  let permanentAttempts = 0
  await assert.rejects(withRetries(async () => {
    permanentAttempts += 1
    throw new Error('bad request')
  }, { retries: 3, baseDelayMs: 1, maxDelayMs: 2 }), /bad request/u)
  assert.equal(permanentAttempts, 1)
})

await check('formatOcrMarkdown writes page markers, metadata and truncation notes', () => {
  const markdown = formatOcrMarkdown({
    file: 'C:/tmp/扫描件.pdf',
    purpose: 'text_recognition',
    created: new Date('2026-11-24T20:00:00.000Z'),
    pageCount: 2,
    pages: [
      { index: 0, text: '第一页内容', finishReason: 'stop' },
      { index: 1, text: 'Second page', finishReason: 'length' },
    ],
    costCny: 0.003,
  })
  assert.match(markdown, /^# OCR: 扫描件\.pdf/mu)
  assert.match(markdown, /- Pages: 2/u)
  assert.match(markdown, /## Page 1\n\n第一页内容/u)
  assert.match(markdown, /## Page 2\n\nSecond page/u)
  assert.match(markdown, /finish_reason: length/u)
  assert.match(markdown, /¥0\.0030/u)
})

await check('CLI prints usage and version without network access', () => {
  const help = spawnSync(node, [join(packageRoot, 'bin', 'deepseek-tools.mjs'), '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /ocr <file>/u)
  const version = spawnSync(node, [join(packageRoot, 'bin', 'deepseek-tools.mjs'), '--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0)
  assert.equal(version.stdout.trim(), '0.1.0')
})

// The host-shape test owns the offline fake-transport execution checks.
checkCommand('test/host-shape.test.mjs passes', [join(packageRoot, 'test', 'host-shape.test.mjs')])

// --------------------------------------------------------------------- live mode
const liveMode = process.argv.includes('--live')
const imageFlag = process.argv.find((argument) => argument.startsWith('--image='))
if (liveMode) {
  console.log('\nLive DeepSeek Tool API smoke (billed: search ≈ ¥0.005, fetch ≈ ¥0.005):')
  checkCommand('live search "DeepSeek OCR API 价格"', [join(packageRoot, 'bin', 'deepseek-tools.mjs'), 'search', 'DeepSeek OCR API 价格', '--count=3'])
  checkCommand('live fetch docs page', [join(packageRoot, 'bin', 'deepseek-tools.mjs'), 'fetch', 'https://api-docs.deepseek.com/zh-cn/guides/ocr/'])
  if (imageFlag !== undefined) {
    const imagePath = imageFlag.slice('--image='.length)
    checkCommand(`live OCR ${imagePath}`, [join(packageRoot, 'bin', 'deepseek-tools.mjs'), 'ocr', imagePath, '--preview=all'])
  } else {
    console.log('skip live OCR (pass --image=<path> to include it; OCR is billed per page)')
  }
} else {
  console.log('\nOffline checks only. For real API coverage:')
  console.log('  node test/smoke.mjs --live [--image=<path>]')
}

console.log(`\n${failures === 0 ? 'smoke passed' : `${failures} smoke check(s) failed`}`)
if (failures > 0) process.exitCode = 1
