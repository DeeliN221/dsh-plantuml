/**
 * dsh-plantuml — node half.
 *
 * The rendering itself happens entirely in the browser (the official
 * TeaVM-compiled PlantUML engine, vendored under `vendor/`), so this half has
 * one job: serve those engine assets to the page over the composition's
 * `webServer` with content-addressed immutable caching, manifest discovery,
 * gzip/brotli transfer compression, conditional revalidation, and byte-range
 * responses.
 *
 * Why a route at all: the client bundle may only `require()` platform seed
 * words or boot-graph rows, and the engine is a 4 MB ESM module plus a lazily
 * loaded standard-library directory. Serving it from the plugin's own
 * directory keeps the bundle small, keeps the engine out of the boot graph,
 * and lets the browser cache it independently.
 *
 * The route is deliberately unfenced, matching the existing `/plugins` asset
 * route (`@deepseek-ai/dsh-client-modules`) that serves every client bundle:
 * a fence that demands an `Origin` header would reject plain same-origin
 * script/ESM GETs. What is exposed here is only the PlantUML engine this
 * package ships — no workspace file is ever reachable, and path containment
 * below is enforced before any read.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, relative as relativePath, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib'

/** Cordis function-plugin name. */
export const name = 'plantuml'

/** The only service this half needs: the HTTP carrier that serves the page. */
export const inject = ['webServer']

/** Public mount point. The client half hardcodes the same prefix. */
const ASSET_PREFIX = '/dsh-plantuml'

/** Absolute directory the route is confined to. */
const ASSET_ROOT = resolve(fileURLToPath(new URL('../vendor/', import.meta.url)))

/** Package metadata used to surface the plugin version in the engine manifest. */
const PACKAGE_JSON_PATH = resolve(fileURLToPath(new URL('../package.json', import.meta.url)))

/** Relative URL of the small revalidated discovery manifest. */
const MANIFEST_PATH = 'engine.json'

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const REVALIDATE_CACHE_CONTROL = 'no-cache'

/** Minimum payload size before applying gzip/brotli compression. */
const COMPRESS_MIN_BYTES = 256
const GZIP_LEVEL = 9
const BROTLI_QUALITY = 6

const gzipAsync = promisify(gzip)
const brotliCompressAsync = promisify(brotliCompress)

/** Extensions the engine ships; anything else is refused rather than guessed. */
const CONTENT_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png']
])

/** Text-like formats that benefit from transfer compression. */
const COMPRESSIBLE_EXTS = new Set(['.js', '.mjs', '.json', '.css', '.map', '.txt', '.svg'])

/** Cached manifest `{ signature, data }` so steady-state reads avoid re-hashing vendor/. */
let manifestCache
/** Deduplicates concurrent manifest recomputations on cold start or upgrade. */
let pendingManifest
/** Per-file digest & compressed representation cache, keyed by absolute file path. */
const fileCache = new Map()

/**
 * Recursively collect servable files under `dir` in deterministic path order.
 * @param dir - Directory to scan.
 * @returns Array of `{ full, rel, size, mtimeMs }` entries.
 */
async function collectVendorFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const files = []
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectVendorFiles(full)))
    } else if (entry.isFile() && CONTENT_TYPES.has(extname(entry.name).toLowerCase())) {
      const info = await stat(full)
      files.push({
        full,
        rel: relativePath(ASSET_ROOT, full).split(sep).join('/'),
        size: info.size,
        mtimeMs: info.mtimeMs
      })
    }
  }
  return files
}

/**
 * Build or return the cached engine manifest (`version`, content `hash`, and
 * immutable URLs). Recomputes only when `package.json` or a vendored file's
 * `(size, mtimeMs)` signature changes.
 *
 * @returns `{ version, hash, body, etag }`.
 */
async function computeManifestIfNeeded() {
  const [pkgInfo, files] = await Promise.all([stat(PACKAGE_JSON_PATH), collectVendorFiles(ASSET_ROOT)])
  const signature = `${pkgInfo.size}:${pkgInfo.mtimeMs}|${files.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}`).join('|')}`

  if (manifestCache !== undefined && manifestCache.signature === signature) {
    return manifestCache.data
  }

  let version = '0.0.0'
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))
    if (typeof pkg?.version === 'string' && pkg.version !== '') version = pkg.version
  } catch {
    /* keep fallback version if package.json is temporarily unreadable */
  }

  const vendorDigest = createHash('sha256')
  for (const file of files) {
    vendorDigest.update(file.rel)
    vendorDigest.update('\0')
    vendorDigest.update(await readFile(file.full))
    vendorDigest.update('\0')
  }
  const hash = vendorDigest.digest('hex').slice(0, 16)

  const body = Buffer.from(
    JSON.stringify({
      version,
      hash,
      url: `${ASSET_PREFIX}/${hash}/plantuml.js`,
      stdlibBase: `${ASSET_PREFIX}/${hash}/stdlib/`
    }),
    'utf8'
  )
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 24)}"`

  const data = { version, hash, body, etag }
  manifestCache = { signature, data }
  return data
}

/** Deduplicated wrapper around {@link computeManifestIfNeeded}. */
function getManifest() {
  if (pendingManifest !== undefined) return pendingManifest
  pendingManifest = computeManifestIfNeeded().finally(() => {
    pendingManifest = undefined
  })
  return pendingManifest
}

/**
 * Map a request URL onto either the manifest or a file inside {@link ASSET_ROOT}.
 *
 * Containment is decided on the resolved absolute path as well as rejected dot
 * segments, so `..`, encoded separators, and absolute fragments cannot escape
 * the vendored directory.
 *
 * @param url - The raw request URL.
 * @param hash - Current vendor content fingerprint from the manifest.
 * @returns Route descriptor or `undefined` when invalid/outside mount point.
 */
function resolveRoute(url, hash) {
  let pathname
  try {
    pathname = new URL(String(url), 'http://127.0.0.1').pathname
  } catch {
    return undefined
  }
  if (pathname !== ASSET_PREFIX && !pathname.startsWith(`${ASSET_PREFIX}/`)) return undefined

  let relative
  try {
    relative = decodeURIComponent(pathname.slice(ASSET_PREFIX.length))
  } catch {
    return undefined
  }
  relative = relative.replace(/^\/+/, '')
  if (relative === '' || relative.includes('\0')) return undefined

  const segments = relative.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined
  }

  if (segments.length === 1 && segments[0] === MANIFEST_PATH) {
    return { kind: 'manifest' }
  }

  let immutable = false
  let assetRel = relative
  if (segments.length >= 2 && segments[0] === hash) {
    immutable = true
    assetRel = segments.slice(1).join('/')
  }

  const target = resolve(ASSET_ROOT, assetRel)
  if (target !== ASSET_ROOT && !target.startsWith(ASSET_ROOT + sep)) return undefined
  const ext = extname(target).toLowerCase()
  const contentType = CONTENT_TYPES.get(ext)
  if (contentType === undefined) return undefined

  return {
    kind: 'asset',
    target,
    ext,
    contentType,
    cacheControl: immutable ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL
  }
}

/**
 * Choose the best supported content encoding for an `Accept-Encoding` header.
 * @param header - Raw `accept-encoding` request header.
 * @returns `'br'`, `'gzip'`, or `'identity'`.
 */
function negotiateEncoding(header) {
  if (typeof header !== 'string' || header.trim() === '') return 'identity'

  let brQ
  let gzipQ
  let starQ

  for (const part of header.split(',')) {
    const tokens = part.trim().split(';')
    const coding = tokens[0]?.trim().toLowerCase()
    if (!coding) continue

    let q = 1
    let validQ = true
    for (let i = 1; i < tokens.length; i += 1) {
      const match = /^q\s*=\s*([0-9]+(?:\.[0-9]+)?)$/i.exec(tokens[i].trim())
      if (match === null) continue
      const parsed = Number(match[1])
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        validQ = false
        break
      }
      q = parsed
    }
    if (!validQ) continue

    if (coding === 'br') brQ = q
    else if (coding === 'gzip' || coding === 'x-gzip') gzipQ = q
    else if (coding === '*') starQ = q
  }

  const effectiveBr = brQ ?? starQ ?? 0
  const effectiveGzip = gzipQ ?? starQ ?? 0

  if (effectiveBr <= 0 && effectiveGzip <= 0) return 'identity'
  // Prefer `br` on ties since it achieves smaller wire payloads for JS/SVG/JSON.
  return effectiveBr >= effectiveGzip ? 'br' : 'gzip'
}

/**
 * Check whether `If-None-Match` matches the selected representation's ETag.
 * Uses RFC 9110 weak comparison, as specified for GET/HEAD conditional requests.
 *
 * @param header - Raw `if-none-match` request header.
 * @param currentEtag - Strong ETag string of the selected representation.
 * @returns True if the client's validator matches.
 */
function matchesIfNoneMatch(header, currentEtag) {
  const raw = Array.isArray(header) ? header.join(', ') : header
  if (typeof raw !== 'string' || raw.trim() === '') return false

  const targetOpaque = currentEtag.startsWith('W/') ? currentEtag.slice(2) : currentEtag
  const tags = raw.match(/(?:W\/)?"[^"]*"|\*/g)
  if (tags === null) return false

  for (const tag of tags) {
    if (tag === '*') return true
    const opaque = tag.startsWith('W/') ? tag.slice(2) : tag
    if (opaque === targetOpaque) return true
  }
  return false
}

/**
 * Parse a single HTTP byte-range specifier (`Range: bytes=...`).
 *
 * @param header - Raw `range` request header.
 * @param totalSize - Total length of the uncompressed representation in bytes.
 * @returns `{ kind: 'single', start, end }`, `{ kind: 'unsatisfiable' }`, or `{ kind: 'ignore' }`.
 */
function parseRange(header, totalSize) {
  if (typeof header !== 'string') return { kind: 'ignore' }
  const trimmed = header.trim()
  if (!/^bytes=/i.test(trimmed)) return { kind: 'ignore' }
  const spec = trimmed.slice(6).trim()
  // Multi-range responses (multipart/byteranges) are not emitted; ignore per RFC 9110.
  if (spec === '' || spec.includes(',')) return { kind: 'ignore' }

  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null) return { kind: 'ignore' }

  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') return { kind: 'ignore' }
  if (totalSize === 0) return { kind: 'unsatisfiable' }

  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { kind: 'unsatisfiable' }
    return { kind: 'single', start: Math.max(0, totalSize - suffix), end: totalSize - 1 }
  }

  const start = Number(startRaw)
  if (!Number.isSafeInteger(start) || start >= totalSize) return { kind: 'unsatisfiable' }

  if (endRaw === '') {
    return { kind: 'single', start, end: totalSize - 1 }
  }

  const end = Number(endRaw)
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'ignore' }

  return { kind: 'single', start, end: Math.min(end, totalSize - 1) }
}

/** Retrieve or reset the per-file cache entry when `(size, mtimeMs)` changes. */
function getFileEntry(target, info) {
  const existing = fileCache.get(target)
  if (existing !== undefined && existing.size === info.size && existing.mtimeMs === info.mtimeMs) {
    return existing
  }
  const entry = {
    size: info.size,
    mtimeMs: info.mtimeMs,
    digestPromise: undefined,
    compressedPromises: new Map()
  }
  fileCache.set(target, entry)
  return entry
}

/** Compute and cache the file's SHA-256 content digest without retaining raw bytes. */
function ensureDigest(target, entry) {
  if (entry.digestPromise === undefined) {
    entry.digestPromise = (async () => {
      const hash = createHash('sha256')
      const stream = createReadStream(target)
      for await (const chunk of stream) hash.update(chunk)
      return hash.digest('hex').slice(0, 24)
    })().catch((error) => {
      entry.digestPromise = undefined
      throw error
    })
  }
  return entry.digestPromise
}

/** Compute and cache the compressed `Buffer` for `'gzip'` or `'br'`. */
function ensureCompressed(target, entry, encoding) {
  let promise = entry.compressedPromises.get(encoding)
  if (promise === undefined) {
    promise = (async () => {
      const raw = await readFile(target)
      if (entry.digestPromise === undefined) {
        entry.digestPromise = Promise.resolve(createHash('sha256').update(raw).digest('hex').slice(0, 24))
      }
      return encoding === 'br'
        ? await brotliCompressAsync(raw, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length
            }
          })
        : await gzipAsync(raw, { level: GZIP_LEVEL })
    })().catch((error) => {
      entry.compressedPromises.delete(encoding)
      throw error
    })
    entry.compressedPromises.set(encoding, promise)
  }
  return promise
}

/**
 * Stream a file (or byte slice) to `res` and tear down the stream on premature close.
 * @param res - HTTP response (headers already committed).
 * @param target - Absolute file path.
 * @param range - Optional inclusive `{ start, end }` bounds.
 */
function streamFile(res, target, range) {
  const stream = createReadStream(target, range ? { start: range.start, end: range.end } : undefined)
  const onClose = () => {
    if (!stream.destroyed) stream.destroy()
  }
  res.once('close', onClose)
  stream.once('end', () => res.off('close', onClose))
  stream.on('error', () => {
    res.off('close', onClose)
    // Headers are already committed; destroy the socket so the client does not hang.
    res.destroy()
  })
  stream.pipe(res)
}

/**
 * Send the HTTP response body (or omit it for HEAD) from either a Buffer or a file stream.
 */
function sendBody(req, res, { buffer, target, range }) {
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  if (buffer !== undefined) {
    res.end(range ? buffer.subarray(range.start, range.end + 1) : buffer)
    return
  }
  streamFile(res, target, range)
}

/**
 * Emit a complete HTTP response for either an in-memory buffer or a file asset,
 * handling `If-None-Match` (304), `Range` (206/416), `Content-Encoding`, and `HEAD`.
 */
function sendRepresentation(req, res, spec) {
  const { contentType, cacheControl, varyEncoding, encoding, etag, length, buffer, target } = spec

  res.setHeader('content-type', contentType)
  res.setHeader('cache-control', cacheControl)
  res.setHeader('etag', etag)
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('accept-ranges', 'bytes')
  if (varyEncoding) res.setHeader('vary', 'Accept-Encoding')

  if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
    res.statusCode = 304
    res.end()
    return
  }

  const rawRange = req.headers.range
  let applyRange = typeof rawRange === 'string' && rawRange.trim() !== ''
  if (applyRange && typeof req.headers['if-range'] === 'string') {
    const ifRange = req.headers['if-range'].trim()
    if (ifRange.startsWith('W/') || ifRange !== etag) applyRange = false
  }

  if (applyRange) {
    const parsed = parseRange(rawRange, length)
    if (parsed.kind === 'unsatisfiable') {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${length}`)
      res.end()
      return
    }
    if (parsed.kind === 'single') {
      const { start, end } = parsed
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${length}`)
      res.setHeader('content-length', String(end - start + 1))
      sendBody(req, res, { buffer, target, range: { start, end } })
      return
    }
  }

  if (encoding !== 'identity') res.setHeader('content-encoding', encoding)
  res.setHeader('content-length', String(length))
  res.statusCode = 200
  sendBody(req, res, { buffer, target })
}

/**
 * Serve the engine manifest or one vendored engine asset.
 * @param req - The incoming request.
 * @param res - The response this handler owns.
 */
async function handleAssetRequest(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      res.end()
      return
    }

    const manifest = await getManifest()
    const route = resolveRoute(req.url, manifest.hash)
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }

    if (route.kind === 'manifest') {
      sendRepresentation(req, res, {
        contentType: CONTENT_TYPES.get('.json'),
        cacheControl: REVALIDATE_CACHE_CONTROL,
        varyEncoding: false,
        encoding: 'identity',
        etag: manifest.etag,
        length: manifest.body.length,
        buffer: manifest.body
      })
      return
    }

    let info
    try {
      info = await stat(route.target)
    } catch {
      res.statusCode = 404
      res.end()
      return
    }
    if (!info.isFile()) {
      res.statusCode = 404
      res.end()
      return
    }

    const entry = getFileEntry(route.target, info)
    const varyEncoding = COMPRESSIBLE_EXTS.has(route.ext) && info.size >= COMPRESS_MIN_BYTES
    const hasRangeHeader = typeof req.headers.range === 'string' && req.headers.range.trim() !== ''

    // Disable transfer compression when `Range` is requested so byte slices
    // always refer directly to the uncompressed asset bytes.
    const requestedEncoding = varyEncoding && !hasRangeHeader ? negotiateEncoding(req.headers['accept-encoding']) : 'identity'

    if (requestedEncoding !== 'identity') {
      const compressed = await ensureCompressed(route.target, entry, requestedEncoding)
      const digest = await ensureDigest(route.target, entry)
      if (compressed.length < info.size) {
        sendRepresentation(req, res, {
          contentType: route.contentType,
          cacheControl: route.cacheControl,
          varyEncoding,
          encoding: requestedEncoding,
          etag: `"${digest}-${requestedEncoding}"`,
          length: compressed.length,
          buffer: compressed
        })
        return
      }
    }

    const digest = await ensureDigest(route.target, entry)
    sendRepresentation(req, res, {
      contentType: route.contentType,
      cacheControl: route.cacheControl,
      varyEncoding,
      encoding: 'identity',
      etag: `"${digest}"`,
      length: info.size,
      target: route.target
    })
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = error?.code === 'ENOENT' ? 404 : 500
      res.end()
    } else {
      res.destroy()
    }
  }
}

/**
 * Register the engine asset route.
 * @param ctx - Host root context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ASSET_PREFIX,
        handler: handleAssetRequest
      }),
    `dsh-plantuml: GET ${ASSET_PREFIX}/**`
  )
}
