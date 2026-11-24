/**
 * Dependency-free implementation of the three DeepSeek Tool APIs used by both
 * the DSH plugin (`lib/index.js`) and the standalone CLI (`bin/deepseek-tools.mjs`).
 *
 * This module imports only `node:` builtins (plus the global `fetch`/`FormData`/
 * `Blob` available in the DSH host and Node >= 20). It never logs, stores, or
 * returns credentials: callers pass ready-made request headers per operation.
 *
 * Verified API facts (2026-11-24, DeepSeek Tool APIs, base
 * `https://api.deepseek.com/v1/tools`):
 * - `POST /ocr`   multipart/form-data: `file` + `purpose`; JSON result with `pages`.
 *                 Billing 1.5 CNY / 1000 successful pages; <= 100 MiB, <= 1000 pages.
 * - `POST /search` JSON `{ query, count?, need_content?, ori_question?, localization? }`.
 *                 Billing 5 CNY / 1000 successful (non-empty) requests.
 * - `POST /fetch`  JSON `{ url }`; returns `{ title, content }` where content is Markdown.
 *                 Billing 5 CNY / 1000 successful requests.
 *
 * @module dsh-deepseek-toolbox/core
 */

import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Accepted OCR `purpose` values. */
export const OCR_PURPOSES = Object.freeze(['text_recognition', 'rich_layout_recognition'])

/** OCR upload ceiling in bytes (100 MiB). */
export const OCR_MAX_FILE_BYTES = 100 * 1024 * 1024

/** OCR price in CNY per successful page (1.5 CNY / 1000 pages). */
export const OCR_COST_CNY_PER_PAGE = 0.0015

/** Search price in CNY per successful request (5 CNY / 1000 requests). */
export const SEARCH_COST_CNY_PER_REQUEST = 0.005

/** Fetch price in CNY per successful request (5 CNY / 1000 requests). */
export const FETCH_COST_CNY_PER_REQUEST = 0.005

/** Default base URL of the DeepSeek Tool APIs. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/tools'

/** Default credential reference used for a standalone API key. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Maximum characters of an OCR preview returned inline by default. */
export const DEFAULT_PREVIEW_MAX_CHARS = 12000

/** Default OCR output directory, relative to the session working directory. */
export const DEFAULT_OCR_OUTPUT_DIR = '.dsh/ocr'

/** Maximum characters of fetched page content kept in the result. */
export const FETCH_MAX_CONTENT_CHARS = 120000

/** Per-result cap on `need_content` search content. */
export const SEARCH_CONTENT_MAX_CHARS_PER_RESULT = 12000

/** Total cap on `need_content` search content in one call. */
export const SEARCH_CONTENT_MAX_CHARS_TOTAL = 120000

/** User agent sent with every DeepSeek Tool API request. */
const USER_AGENT = 'dsh-deepseek-toolbox/0.1.0'

/** Extension -> MIME type for the formats the OCR endpoint documents. */
const MIME_BY_EXT = new Map([
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
])

/** Byte count read for magic-byte sniffing (enough for OOXML directory names). */
const SNIFF_BYTES = 64 * 1024

/** Formats the OCR endpoint documents; used for an actionable validation error. */
const OCR_SUPPORTED_FORMATS = 'PDF, DOC, DOCX, PPT, PPTX, PNG, JPEG, WebP, GIF, BMP, TIFF (files without an extension are detected from their content)'

/**
 * MIME type for a local path, derived from its extension.
 * @param {string} filePath local path
 * @returns {string | undefined} mapped MIME type, or `undefined` when the extension is unknown
 */
export function mimeForPath(filePath) {
  return MIME_BY_EXT.get(path.extname(String(filePath)).toLowerCase())
}

/**
 * Detect a supported MIME type from a file header (for extensionless attachments).
 * @param {Uint8Array} bytes first bytes of the file (up to 64 KiB is enough)
 * @returns {string | undefined} detected MIME type, or `undefined` when unknown
 */
export function sniffMimeFromHeader(bytes) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf'
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  if (buffer.length >= 4 && ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))) return 'image/tiff'
  if (buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    const text = Buffer.from(buffer).toString('latin1')
    if (text.includes('word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (text.includes('ppt/')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
  return undefined
}

/**
 * Detect the MIME type of a local file: by extension when known, else by header.
 * @param {string} filePath local file path
 * @returns {Promise<string | undefined>} detected MIME type, or `undefined` when unsupported
 */
export async function detectMimeForFile(filePath) {
  const byExtension = mimeForPath(filePath)
  if (byExtension !== undefined) return byExtension
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
    return sniffMimeFromHeader(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/**
 * Round a CNY amount to 4 decimals (fractions of a fen are not billed).
 * @param {number} pageCount successful pages
 * @returns {number} estimated cost in CNY
 */
export function ocrCostCny(pageCount) {
  return Math.round((Number(pageCount) || 0) * OCR_COST_CNY_PER_PAGE * 10000) / 10000
}

/**
 * Build an actionable error for a non-2xx DeepSeek Tool API response.
 * The returned error carries `status` and `retryable` for {@link withRetries}.
 * @param {number} status HTTP status
 * @param {string} bodyText response body text (never echoed verbatim beyond a short message)
 * @returns {Error} an error whose message names the status, the API message, and a hint
 */
export function httpErrorFor(status, bodyText) {
  const detail = extractApiMessage(bodyText)
  const hint = HTTP_ERROR_HINTS[status] ?? (status >= 500 ? 'The DeepSeek service failed. Retry shortly.' : 'Check the request and retry.')
  const error = new Error(`DeepSeek Tool API error (HTTP ${status})${detail.length > 0 ? `: ${detail}` : ''}\n\n${hint}`)
  error.status = status
  error.retryable = status === 408 || status === 429 || (status >= 500 && status <= 599)
  return error
}

/** Actionable hints appended to API failures, keyed by HTTP status. */
const HTTP_ERROR_HINTS = {
  400: `The request was rejected as invalid. For OCR, check that the file is a supported format (${OCR_SUPPORTED_FORMATS}) and that purpose is text_recognition or rich_layout_recognition.`,
  401: 'Authentication failed. Ask the user to store DEEPSEEK_API_KEY in DSH Models settings (or sign in to DeepSeek), then retry this tool call.',
  402: 'The DeepSeek account has insufficient balance. The user must top up the account before paid tools can run.',
  403: 'This credential is not allowed to use the DeepSeek Tool API. The user may need a different API key or account.',
  408: 'The upload did not finish in time (limit: 120 s total, 30 s idle). Retry, and prefer a smaller file or a faster connection.',
  413: 'The file exceeds the OCR upload limit of 100 MiB. Split the document or downscale the image pages first.',
  429: 'Too many concurrent OCR requests for this account. Wait a moment and retry.',
  500: 'The DeepSeek service failed internally. Retry shortly.',
  503: 'The DeepSeek service is busy. Retry shortly.',
  504: 'The DeepSeek service timed out. Retry shortly.',
}

/**
 * Extract a short, printable API error message from a response body.
 * @param {string} bodyText response body
 * @returns {string} at most 300 characters, or an empty string
 */
function extractApiMessage(bodyText) {
  const text = typeof bodyText === 'string' ? bodyText.trim() : ''
  if (text.length === 0) return ''
  try {
    const payload = JSON.parse(text.trimStart())
    if (payload !== null && typeof payload === 'object') {
      if (typeof payload.error === 'string' && payload.error.length > 0) return truncateDetail(payload.error)
      if (payload.error !== null && typeof payload.error === 'object' && typeof payload.error.message === 'string') return truncateDetail(payload.error.message)
      if (typeof payload.message === 'string' && payload.message.length > 0) return truncateDetail(payload.message)
    }
  } catch {
    // Not JSON: fall through to the bounded plain-text message.
  }
  return truncateDetail(text)
}

/**
 * Collapse whitespace and bound one response detail string.
 * @param {string} value raw detail
 * @returns {string} bounded detail
 */
function truncateDetail(value) {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  return collapsed.length > 300 ? `${collapsed.slice(0, 297)}...` : collapsed
}

/**
 * Throw a caller-facing error when the surrounding tool call was cancelled.
 * @param {AbortSignal | undefined} signal caller signal
 */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError(signal)
}

/**
 * Build the error a cancelled tool call throws (the DSH registry maps caller
 * cancellation itself; this only keeps local control flow honest).
 * @param {AbortSignal | undefined} signal aborted signal
 * @returns {Error} an AbortError
 */
function abortError(signal) {
  const error = new Error('DeepSeek tool request aborted')
  error.name = 'AbortError'
  if (signal?.reason instanceof Error) error.cause = signal.reason
  return error
}

/**
 * Sleep that rejects as soon as the caller's signal aborts.
 * @param {number} ms delay in milliseconds
 * @param {AbortSignal | undefined} signal caller signal
 * @returns {Promise<void>} resolves after the delay
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run one operation with bounded retries and exponential backoff.
 *
 * Only errors whose `retryable` flag is `true` are retried (HTTP 408/429/5xx and
 * transient network failures); every other error is rethrown immediately.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn one attempt
 * @param {object} [options] retry policy
 * @param {number} [options.retries=2] retries after the first attempt
 * @param {AbortSignal} [options.signal] caller signal
 * @param {(event: { attempt: number, error: Error, delayMs: number }) => void} [options.onRetry] retry observer
 * @param {number} [options.baseDelayMs=800] first backoff step
 * @param {number} [options.maxDelayMs=8000] backoff ceiling
 * @returns {Promise<T>} the first successful value
 */
export async function withRetries(fn, options = {}) {
  const { retries = 2, signal, onRetry, baseDelayMs = 800, maxDelayMs = 8000 } = options
  const maxRetries = Number.isInteger(retries) && retries >= 0 ? retries : 2
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal)
    try {
      return await fn(attempt)
    } catch (error) {
      const retryable = error?.retryable === true
      if (!retryable || attempt >= maxRetries) throw error
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.floor(Math.random() * 200)
      onRetry?.({ attempt: attempt + 1, error, delayMs })
      await sleep(delayMs, signal)
    }
  }
}

/**
 * Parse JSON that may be preceded by newline keep-alives, tolerating a prefix.
 * @param {string} text raw response body
 * @returns {unknown} the parsed JSON value
 * @throws {Error} when the body is not JSON
 */
function parseJsonTolerant(text) {
  const trimmed = typeof text === 'string' ? text.trimStart() : ''
  if (trimmed.length === 0) throw invalidResponseError('the response body was empty')
  try {
    return JSON.parse(trimmed)
  } catch {
    // Keep-alive prefixes are documented as whitespace; be extra tolerant of a
    // non-JSON banner before the object without guessing past the JSON itself.
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        // fall through
      }
    }
    throw invalidResponseError('the response body was not valid JSON')
  }
}

/**
 * Build a stable "unexpected upstream payload" error.
 * @param {string} reason what was wrong
 * @returns {Error} actionable error
 */
function invalidResponseError(reason) {
  return new Error(`DeepSeek returned an unreadable response (${reason}). Retry once; if it persists, the service may be degraded.`)
}

/**
 * Resolve an absolute endpoint for one Tool API operation.
 * @param {string} baseURL base such as `https://api.deepseek.com/v1/tools`
 * @param {'ocr'|'search'|'fetch'} operation operation name
 * @returns {string} absolute endpoint
 */
export function toolEndpoint(baseURL, operation) {
  const base = typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL.trim() : DEFAULT_BASE_URL
  return `${base.replace(/\/+$/u, '')}/${operation}`
}

/**
 * POST JSON to one DeepSeek Tool API endpoint and decode the JSON response.
 * @param {object} options request
 * @param {string} options.endpoint absolute endpoint
 * @param {Record<string, string>} options.headers auth headers (no content-type)
 * @param {unknown} options.body JSON request body
 * @param {AbortSignal} [options.signal] caller signal
 * @returns {Promise<unknown>} decoded JSON
 */
async function postJson({ endpoint, headers, body, signal }) {
  const response = await fetchOrThrow(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  if (!response.ok) throw httpErrorFor(response.status, text)
  return parseJsonTolerant(text)
}

/**
 * Run `fetch`, mapping transport failures (including redirect refusal) to an
 * actionable error while letting caller cancellation propagate untouched.
 * @param {string} endpoint absolute URL
 * @param {RequestInit} init fetch options
 * @returns {Promise<Response>} the response
 */
async function fetchOrThrow(endpoint, init) {
  try {
    return await fetch(endpoint, init)
  } catch (error) {
    if (init.signal?.aborted === true || error?.name === 'AbortError') throw error
    const failure = new Error(`DeepSeek Tool API request failed: ${String(error)}\n\nThe request used endpoint ${JSON.stringify(endpoint)}. Check the baseURL configuration and the user's network; only the user should change the endpoint.`)
    failure.retryable = true
    failure.transport = true
    failure.cause = error
    throw failure
  }
}

/**
 * Normalize one page from an OCR response.
 * @param {unknown} page raw page
 * @param {number} fallbackIndex position fallback
 * @returns {{ index: number, text: string, finishReason: string | undefined }} normalized page
 */
function normalizePage(page, fallbackIndex) {
  const record = page !== null && typeof page === 'object' ? page : {}
  return {
    index: Number.isInteger(record.index) ? record.index : fallbackIndex,
    text: typeof record.text === 'string' ? record.text : '',
    finishReason: typeof record.finish_reason === 'string' ? record.finish_reason : undefined,
  }
}

/**
 * Validate and normalize one OCR response payload.
 * @param {unknown} payload decoded response
 * @returns {{ pageCount: number, pages: Array<{ index: number, text: string, finishReason: string | undefined }>, usage: unknown }} parsed result
 */
function normalizeOcrPayload(payload) {
  if (payload !== null && typeof payload === 'object' && payload.error !== undefined) {
    const detail = payload.error !== null && typeof payload.error === 'object' && typeof payload.error.message === 'string'
      ? payload.error.message
      : typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)
    throw new Error(`The OCR service accepted the request but did not finish: ${detail}. Retry with a smaller or simpler file; repeated timeouts are not solved by changing the endpoint.`)
  }
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.pages)) {
    throw invalidResponseError('the OCR result did not contain a pages array')
  }
  const pages = payload.pages.map((page, index) => normalizePage(page, index))
  if (pages.length === 0) throw invalidResponseError('the OCR result contained zero pages')
  return { pageCount: pages.length, pages, usage: payload.usage }
}

/**
 * Build a `Blob` for an upload, streaming from disk when the runtime supports it.
 * @param {string} filePath absolute file path
 * @param {string} mime MIME type
 * @returns {Promise<Blob>} upload body
 */
async function uploadBlob(filePath, mime) {
  const openAsBlob = nodeFs.openAsBlob
  if (typeof openAsBlob === 'function') {
    try {
      return await openAsBlob(filePath, { type: mime })
    } catch {
      // Fall back to a buffered read below.
    }
  }
  const buffer = await readFile(filePath)
  return new Blob([buffer], { type: mime })
}

/**
 * OCR one local file through `POST {baseURL}/ocr`, writing page-marked Markdown.
 *
 * @param {object} options request
 * @param {string} options.filePath local file path (absolute or resolvable)
 * @param {string} [options.purpose='text_recognition'] `text_recognition` or `rich_layout_recognition`
 * @param {string} [options.baseURL] Tool API base URL
 * @param {Record<string, string>} options.headers auth headers (`authorization` or `x-dsh-auth-token`)
 * @param {AbortSignal} [options.signal] caller signal
 * @param {string} [options.outputPath] explicit Markdown output path
 * @param {string} [options.outputDir='.dsh/ocr'] output directory when `outputPath` is absent (relative to cwd)
 * @param {string} [options.cwd=process.cwd()] base directory for a relative output dir
 * @param {number} [options.retries=2] retry budget for retryable failures
 * @param {() => Date} [options.now] clock override
 * @returns {Promise<{ ok: true, file: string, outputPath: string, pageCount: number, purpose: string, costCny: number, pages: Array<{ index: number, text: string, finishReason: string | undefined }>, created: string, usage: unknown }>} OCR result
 */
export async function ocrFile(options) {
  const {
    filePath,
    purpose = 'text_recognition',
    baseURL,
    headers,
    signal,
    outputPath,
    outputDir = DEFAULT_OCR_OUTPUT_DIR,
    cwd = process.cwd(),
    retries = 2,
    now = () => new Date(),
  } = options

  if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new Error('OCR needs a non-empty file path.')
  const resolvedFile = path.resolve(filePath.trim())
  if (!OCR_PURPOSES.includes(purpose)) {
    throw new Error(`purpose must be one of ${OCR_PURPOSES.join(', ')} (got ${JSON.stringify(purpose)}).`)
  }

  let info
  try {
    info = await stat(resolvedFile)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`File not found: ${resolvedFile}`)
    throw new Error(`Cannot read ${resolvedFile}: ${error?.message ?? String(error)}`)
  }
  if (info.isDirectory()) throw new Error(`${resolvedFile} is a directory; OCR needs a file.`)
  if (info.size === 0) throw new Error(`File is empty: ${resolvedFile}`)
  if (info.size > OCR_MAX_FILE_BYTES) {
    throw new Error(`File is too large: ${info.size} bytes (${(info.size / 1024 / 1024).toFixed(1)} MiB); the OCR API accepts at most 104857600 bytes (100 MiB).`)
  }

  const mime = await detectMimeForFile(resolvedFile)
  if (mime === undefined) {
    throw new Error(`Unsupported OCR file type for ${JSON.stringify(path.basename(resolvedFile))}: expected one of ${OCR_SUPPORTED_FORMATS}.`)
  }

  const filename = path.basename(resolvedFile)
  const endpoint = toolEndpoint(baseURL, 'ocr')
  const blob = await uploadBlob(resolvedFile, mime)

  const requestOnce = () => withRetries(async () => {
    try {
      throwIfAborted(signal)
      const form = new FormData()
      form.append('file', blob, filename)
      form.append('purpose', purpose)
      const response = await fetchOrThrow(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...headers,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: form,
        ...(signal === undefined ? {} : { signal }),
      })
      const text = await response.text()
      if (!response.ok) throw httpErrorFor(response.status, text)
      return parseJsonTolerant(text)
    } catch (error) {
      // A transport failure is ambiguous: the service may already have accepted
      // (and billed) the file, so OCR never blind-retries network failures.
      if (error?.transport === true) error.retryable = false
      throw error
    }
  }, { retries, signal })

  // A successful response whose every page carries empty text is an observed
  // transient service outcome (usually followed by a normal result), so retry
  // the whole request once before accepting an all-empty document.
  let normalized
  for (let round = 0; ; round += 1) {
    throwIfAborted(signal)
    normalized = normalizeOcrPayload(await requestOnce())
    throwIfAborted(signal)
    if (normalized.pages.some((page) => page.text.trim().length > 0) || round >= 1) break
  }
  const createdAt = now()
  const costCny = ocrCostCny(normalized.pages.length)
  const targetPath = outputPath !== undefined && String(outputPath).trim().length > 0
    ? path.resolve(String(outputPath).trim())
    : defaultOcrOutputPath({ cwd, outputDir, filePath: resolvedFile, date: createdAt })
  const markdown = formatOcrMarkdown({
    file: resolvedFile,
    purpose,
    created: createdAt,
    pageCount: normalized.pages.length,
    pages: normalized.pages,
    costCny,
  })
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, markdown, 'utf8')
  return {
    ok: true,
    file: resolvedFile,
    outputPath: targetPath,
    pageCount: normalized.pages.length,
    purpose,
    costCny,
    pages: normalized.pages,
    created: createdAt.toISOString(),
    usage: normalized.usage,
  }
}

/**
 * Search the web through `POST {baseURL}/search`.
 *
 * @param {object} options request
 * @param {string} options.query query text (1..128 Unicode characters after trimming)
 * @param {number} [options.count=10] requested result count (1..50)
 * @param {boolean} [options.needContent=false] ask for page content
 * @param {string} [options.baseURL] Tool API base URL
 * @param {Record<string, string>} options.headers auth headers
 * @param {AbortSignal} [options.signal] caller signal
 * @param {number} [options.retries=2] retry budget for retryable failures
 * @returns {Promise<{ ok: true, query: string, results: Array<object> }>} normalized search results
 */
export async function searchWeb(options) {
  const { query, count = 10, needContent = false, baseURL, headers, signal, retries = 2 } = options
  if (typeof query !== 'string' || query.trim().length === 0) throw new Error('query must be a non-empty string.')
  const trimmed = query.trim()
  const queryLength = Array.from(trimmed).length
  if (queryLength > 128) throw new Error(`query must be at most 128 characters (got ${queryLength}).`)
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('count must be an integer between 1 and 50.')

  const endpoint = toolEndpoint(baseURL, 'search')
  const payload = await withRetries(
    () => postJson({ endpoint, headers, body: { query: trimmed, count, need_content: Boolean(needContent) }, signal }),
    { retries, signal },
  )
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.results)) {
    throw invalidResponseError('the search result did not contain a results array')
  }

  const results = []
  let contentBudget = SEARCH_CONTENT_MAX_CHARS_TOTAL
  for (const item of payload.results) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.url !== 'string' || item.url.length === 0) continue
    const result = { url: item.url }
    if (typeof item.title === 'string' && item.title.length > 0) result.title = item.title
    if (typeof item.snippet === 'string' && item.snippet.length > 0) result.snippet = item.snippet
    if (typeof item.summary === 'string' && item.summary.length > 0) result.summary = item.summary
    if (typeof item.date === 'string' && item.date.length > 0) result.date = item.date
    if (typeof item.site_name === 'string' && item.site_name.length > 0) result.site_name = item.site_name
    if (typeof item.authority === 'string' || typeof item.authority === 'number' || typeof item.authority === 'boolean') result.authority = item.authority
    if (typeof item.rerank_score === 'number' && Number.isFinite(item.rerank_score)) result.rerank_score = item.rerank_score
    if (needContent && typeof item.content === 'string' && item.content.length > 0 && contentBudget > 0) {
      const limit = Math.min(SEARCH_CONTENT_MAX_CHARS_PER_RESULT, contentBudget)
      const content = item.content.length > limit
        ? `${item.content.slice(0, limit)}\n\n(Content truncated. Fetch the page with deepseek_fetch for the full text.)`
        : item.content
      result.content = content
      contentBudget -= Math.min(item.content.length, limit)
    }
    results.push(result)
  }
  return { ok: true, query: trimmed, results }
}

/**
 * Fetch one page as Markdown through `POST {baseURL}/fetch`.
 *
 * @param {object} options request
 * @param {string} options.url HTTP(S) URL (<= 8192 characters, host required, no credentials)
 * @param {string} [options.baseURL] Tool API base URL
 * @param {Record<string, string>} options.headers auth headers
 * @param {AbortSignal} [options.signal] caller signal
 * @param {number} [options.retries=2] retry budget for retryable failures
 * @returns {Promise<{ ok: true, url: string, title: string, content: string }>} fetched page
 */
export async function fetchPage(options) {
  const { url, baseURL, headers, signal, retries = 2 } = options
  if (typeof url !== 'string' || url.trim().length === 0) throw new Error('url must be a non-empty HTTP(S) URL.')
  const trimmed = url.trim()
  if (trimmed.length > 8192) throw new Error('url must be at most 8192 characters.')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`url is not a valid absolute URL: ${JSON.stringify(trimmed)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('url must start with http:// or https://')
  if (parsed.hostname.length === 0) throw new Error('url must contain a host name.')
  if (parsed.username.length > 0 || parsed.password.length > 0) throw new Error('url must not contain credentials.')

  const endpoint = toolEndpoint(baseURL, 'fetch')
  const payload = await withRetries(
    () => postJson({ endpoint, headers, body: { url: trimmed }, signal }),
    { retries, signal },
  )
  if (payload === null || typeof payload !== 'object' || typeof payload.content !== 'string') {
    throw invalidResponseError('the fetch result did not contain page content')
  }
  const title = typeof payload.title === 'string' ? payload.title : ''
  const content = payload.content.length > FETCH_MAX_CONTENT_CHARS
    ? `${payload.content.slice(0, FETCH_MAX_CONTENT_CHARS)}\n\n(Content truncated at ${FETCH_MAX_CONTENT_CHARS} characters. Fetch a more specific page or section for the full text.)`
    : payload.content
  return { ok: true, url: trimmed, title, content }
}

/**
 * Resolve the default OCR Markdown output path.
 * @param {object} options path inputs
 * @param {string} options.cwd base directory
 * @param {string} options.outputDir configured output directory (absolute or cwd-relative)
 * @param {string} options.filePath OCR'd source file
 * @param {Date} options.date timestamp for the filename
 * @returns {string} absolute Markdown path
 */
export function defaultOcrOutputPath({ cwd, outputDir, filePath, date }) {
  const directory = path.isAbsolute(outputDir) ? outputDir : path.resolve(cwd ?? process.cwd(), outputDir ?? DEFAULT_OCR_OUTPUT_DIR)
  const stem = sanitizeStem(path.basename(filePath, path.extname(filePath)))
  return path.join(directory, `${stem}-${formatTimestamp(date ?? new Date())}.md`)
}

/**
 * Make a filename-safe stem while keeping CJK characters readable.
 * @param {string} name source name without extension
 * @returns {string} a safe stem
 */
export function sanitizeStem(name) {
  const cleaned = String(name)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.\-]+|[.\-]+$/gu, '')
    .slice(0, 80)
    .replace(/[.\-]+$/u, '')
  return cleaned.length > 0 ? cleaned : 'ocr'
}

/**
 * Format a local timestamp as `YYYYMMDD-HHmmss`.
 * @param {Date} date timestamp
 * @returns {string} filename timestamp
 */
export function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * Build the page-marked Markdown document for one OCR result.
 * Page text is preserved verbatim; only separators and metadata are added.
 *
 * @param {object} options document inputs
 * @param {string} options.file source file path
 * @param {string} options.purpose OCR purpose
 * @param {Date} options.created completion timestamp
 * @param {number} options.pageCount page count
 * @param {Array<{ index: number, text: string, finishReason: string | undefined }>} options.pages OCR pages
 * @param {number} options.costCny estimated cost in CNY
 * @returns {string} Markdown document
 */
export function formatOcrMarkdown({ file, purpose, created, pageCount, pages, costCny }) {
  const source = path.basename(file)
  const header = [
    `# OCR: ${source}`,
    '',
    `- Source: ${file}`,
    `- Purpose: ${purpose}`,
    `- Pages: ${pageCount}`,
    `- Estimated cost: ¥${Number(costCny).toFixed(4)} (¥1.5 / 1000 successful pages)`,
    `- Created: ${created.toISOString()}`,
    '- API: https://api.deepseek.com/v1/tools/ocr',
    '',
    '---',
    '',
  ].join('\n')
  const sections = pages.map((page, position) => {
    const pageNumber = Number.isInteger(page.index) ? page.index + 1 : position + 1
    const body = typeof page.text === 'string' && page.text.length > 0 ? page.text : '_(no text recognized on this page)_'
    const truncationNote = page.finishReason === 'length'
      ? '\n\n> Note: this page was truncated by the OCR service (finish_reason: length). The page text above is what the service returned.'
      : ''
    return `## Page ${pageNumber}\n\n${body}${truncationNote}`
  })
  return `${header}${sections.join('\n\n---\n\n')}\n`
}

/**
 * Parse a 1-based page-range specification into 0-based page indexes.
 *
 * Accepted forms: `1-2` (default), a single page like `3`, or `all`.
 * The end of a range is clamped to the document's last page; the start must be
 * inside the document.
 *
 * @param {string | undefined} spec caller specification
 * @param {number} pageCount document page count
 * @returns {number[]} 0-based page indexes
 */
export function parsePageRange(spec, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('OCR returned no pages to preview.')
  const raw = typeof spec === 'string' ? spec.trim().toLowerCase() : ''
  if (raw.length === 0) return clampRange(1, 2, pageCount)
  if (raw === 'all' || raw === '全部') return Array.from({ length: pageCount }, (_, index) => index)
  const single = /^(\d+)$/u.exec(raw)
  if (single !== null) {
    const page = Number(single[1])
    if (page < 1 || page > pageCount) throw new Error(`preview page ${page} is out of range; the document has ${pageCount} page(s).`)
    return [page - 1]
  }
  const range = /^(\d+)\s*-\s*(\d+)$/u.exec(raw)
  if (range !== null) {
    const start = Number(range[1])
    const end = Number(range[2])
    if (start < 1 || end < 1) throw new Error(`preview range ${JSON.stringify(spec)} must use 1-based page numbers.`)
    if (start > end) throw new Error(`preview range ${JSON.stringify(spec)} is invalid: start must not exceed end.`)
    if (start > pageCount) throw new Error(`preview range starts at page ${start}, but the document has ${pageCount} page(s).`)
    return clampRange(start, end, pageCount)
  }
  throw new Error(`preview must be "1-2" (default), a page number like "3", or "all" (got ${JSON.stringify(spec)}).`)
}

/**
 * Convert an inclusive 1-based range to 0-based indexes, clamping the end.
 * @param {number} start first page (1-based, in range)
 * @param {number} end last page (1-based, may exceed pageCount)
 * @param {number} pageCount page count
 * @returns {number[]} 0-based indexes
 */
function clampRange(start, end, pageCount) {
  const last = Math.min(end, pageCount)
  const indexes = []
  for (let page = start; page <= last; page += 1) indexes.push(page - 1)
  return indexes
}

/**
 * Join selected OCR pages into one bounded inline preview.
 *
 * @param {Array<{ text: string }>} pages OCR pages
 * @param {number[]} indexes 0-based page indexes
 * @param {number} maxChars configured preview character cap
 * @returns {{ preview: string, previewPages: number[], capped: boolean, totalChars: number }} preview data
 */
export function buildPreview(pages, indexes, maxChars) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_PREVIEW_MAX_CHARS
  const selected = []
  for (const index of indexes ?? []) {
    const page = pages?.[index]
    if (page !== undefined) selected.push(page)
  }
  const full = selected.map((page) => (typeof page.text === 'string' ? page.text : '')).join('\n\n')
  const capped = full.length > limit
  return {
    preview: capped ? full.slice(0, limit) : full,
    previewPages: (indexes ?? []).map((index) => index + 1),
    capped,
    totalChars: full.length,
  }
}

/**
 * Resolve a user-supplied local path against a session working directory.
 * Expands a leading `~`; absolute paths pass through.
 * @param {string} cwd base directory
 * @param {string} value caller path
 * @returns {string} absolute normalized path
 */
export function resolveUserPath(cwd, value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('path must be a non-empty file path.')
  let candidate = value.trim()
  const home = homedir()
  if (candidate === '~') candidate = home
  else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) candidate = path.join(home, candidate.slice(2))
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd ?? process.cwd(), candidate)
}

/**
 * Build a `FormData` body for one OCR attempt (exported for tests).
 * @param {Blob} blob file blob
 * @param {string} filename multipart filename
 * @param {string} purpose OCR purpose
 * @returns {FormData} multipart body
 */
export function buildOcrForm(blob, filename, purpose) {
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('purpose', purpose)
  return form
}
