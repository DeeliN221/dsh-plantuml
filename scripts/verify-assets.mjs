#!/usr/bin/env node
/**
 * Self-contained verification script for dsh-plantuml HTTP asset serving.
 * Uses only Node standard library modules and exits non-zero on any failure.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { apply } from '../lib/index.js'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function hasVaryEncoding(headerValue) {
  if (typeof headerValue !== 'string') return false
  return headerValue
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes('accept-encoding')
}

function rawHttpGet(url, headers = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolvePromise({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        })
      })
      res.on('error', rejectPromise)
    })
    req.on('error', rejectPromise)
  })
}

async function main() {
  const pkg = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8'))
  const rawPlantuml = await readFile(resolve(REPO_ROOT, 'vendor/plantuml.js'))
  const rawPlantumlSha = sha256(rawPlantuml)
  const rawThemes = await readFile(resolve(REPO_ROOT, 'vendor/stdlib/themes.js'))
  const rawThemesSha = sha256(rawThemes)

  let registered
  apply({
    effect(fn) {
      fn()
    },
    webServer: {
      register(entry) {
        registered = entry
        return () => {}
      }
    }
  })

  assert.ok(registered, 'plugin did not register a webServer route')
  assert.equal(registered.kind, 'prefix')
  assert.equal(registered.path, '/dsh-plantuml')
  assert.equal(typeof registered.handler, 'function')

  const server = http.createServer(registered.handler)
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}/dsh-plantuml`

    // 1. Manifest: headers, payload size < 1 KB, fields, HEAD, 304
    const manifestRes = await fetch(`${base}/engine.json`)
    assert.equal(manifestRes.status, 200)
    assert.match(manifestRes.headers.get('content-type') ?? '', /^application\/json/i)
    assert.equal(manifestRes.headers.get('cache-control'), 'no-cache')
    assert.equal(manifestRes.headers.get('x-content-type-options'), 'nosniff')
    const manifestEtag = manifestRes.headers.get('etag')
    assert.ok(manifestEtag && /^"[^"]+"$/.test(manifestEtag), `unexpected manifest etag: ${manifestEtag}`)
    const manifestBuf = Buffer.from(await manifestRes.arrayBuffer())
    assert.ok(manifestBuf.length > 0 && manifestBuf.length < 1024, `manifest size ${manifestBuf.length} must be < 1024`)
    const manifest = JSON.parse(manifestBuf.toString('utf8'))
    assert.equal(manifest.version, pkg.version)
    assert.match(manifest.hash, /^[0-9a-f]{16}$/)
    assert.equal(manifest.url, `/dsh-plantuml/${manifest.hash}/plantuml.js`)
    assert.equal(manifest.stdlibBase, `/dsh-plantuml/${manifest.hash}/stdlib/`)

    const manifest304 = await fetch(`${base}/engine.json`, {
      headers: { 'if-none-match': manifestEtag }
    })
    assert.equal(manifest304.status, 304)
    assert.equal(manifest304.headers.get('cache-control'), 'no-cache')
    assert.equal(manifest304.headers.get('etag'), manifestEtag)
    assert.equal((await manifest304.arrayBuffer()).byteLength, 0)

    const manifestHead = await fetch(`${base}/engine.json`, { method: 'HEAD' })
    assert.equal(manifestHead.status, 200)
    assert.equal(manifestHead.headers.get('content-length'), String(manifestBuf.length))
    assert.equal(manifestHead.headers.get('etag'), manifestEtag)
    assert.equal((await manifestHead.arrayBuffer()).byteLength, 0)

    // 1b. Shared render core: package-owned code on a revalidated URL.
    const coreRes = await fetch(`${base}/core.js`)
    assert.equal(coreRes.status, 200)
    assert.match(coreRes.headers.get('content-type') ?? '', /^text\/javascript/i)
    assert.equal(coreRes.headers.get('cache-control'), 'no-cache')
    assert.equal(coreRes.headers.get('x-content-type-options'), 'nosniff')
    const coreBody = await coreRes.text()
    assert.ok(coreBody.includes('createCore'), 'core.js must export createCore')

    const engineUrl = `http://127.0.0.1:${address.port}${manifest.url}`
    const stdlibThemesUrl = `http://127.0.0.1:${address.port}${manifest.stdlibBase}themes.js`

    // 2. Immutable URL + gzip compression (< 1.2 MB)
    const gzipRes = await fetch(engineUrl, { headers: { 'accept-encoding': 'gzip' } })
    assert.equal(gzipRes.status, 200)
    assert.equal(gzipRes.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.match(gzipRes.headers.get('content-type') ?? '', /^text\/javascript/i)
    assert.equal(gzipRes.headers.get('content-encoding'), 'gzip')
    assert.ok(hasVaryEncoding(gzipRes.headers.get('vary')), 'Vary must include Accept-Encoding')
    assert.equal(gzipRes.headers.get('accept-ranges'), 'bytes')
    assert.equal(gzipRes.headers.get('x-content-type-options'), 'nosniff')
    const gzipEtag = gzipRes.headers.get('etag')
    assert.ok(gzipEtag && /^"[^"]+-gzip"$/.test(gzipEtag), `unexpected gzip etag: ${gzipEtag}`)
    const gzipContentLength = Number(gzipRes.headers.get('content-length'))
    assert.ok(gzipContentLength > 0 && gzipContentLength < 1200000, `gzip size ${gzipContentLength} must be < 1.2 MB`)
    const gzipDecoded = Buffer.from(await gzipRes.arrayBuffer())
    assert.equal(gzipDecoded.length, rawPlantuml.length)
    assert.equal(sha256(gzipDecoded), rawPlantumlSha)

    const gzipWire = await rawHttpGet(engineUrl, { 'accept-encoding': 'gzip' })
    assert.equal(gzipWire.status, 200)
    assert.equal(gzipWire.body.length, gzipContentLength)
    assert.equal(sha256(gunzipSync(gzipWire.body)), rawPlantumlSha)

    // 3. Immutable URL + brotli compression (< 1.2 MB)
    const brRes = await fetch(engineUrl, { headers: { 'accept-encoding': 'br, gzip' } })
    assert.equal(brRes.status, 200)
    assert.equal(brRes.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(brRes.headers.get('content-encoding'), 'br')
    assert.ok(hasVaryEncoding(brRes.headers.get('vary')))
    const brEtag = brRes.headers.get('etag')
    assert.ok(brEtag && /^"[^"]+-br"$/.test(brEtag), `unexpected br etag: ${brEtag}`)
    assert.notEqual(brEtag, gzipEtag)
    const brContentLength = Number(brRes.headers.get('content-length'))
    assert.ok(brContentLength > 0 && brContentLength < 1200000, `br size ${brContentLength} must be < 1.2 MB`)
    const brDecoded = Buffer.from(await brRes.arrayBuffer())
    assert.equal(brDecoded.length, rawPlantuml.length)
    assert.equal(sha256(brDecoded), rawPlantumlSha)

    const brWire = await rawHttpGet(engineUrl, { 'accept-encoding': 'br' })
    assert.equal(brWire.status, 200)
    assert.equal(brWire.body.length, brContentLength)
    assert.equal(sha256(brotliDecompressSync(brWire.body)), rawPlantumlSha)

    // 4. Identity representation & Accept-Encoding quality negotiation
    const idRes = await fetch(engineUrl, { headers: { 'accept-encoding': 'identity' } })
    assert.equal(idRes.status, 200)
    assert.equal(idRes.headers.get('content-encoding'), null)
    assert.ok(hasVaryEncoding(idRes.headers.get('vary')))
    assert.equal(idRes.headers.get('content-length'), String(rawPlantuml.length))
    const identityEtag = idRes.headers.get('etag')
    assert.ok(identityEtag && /^"[^"]+"$/.test(identityEtag))
    assert.notEqual(identityEtag, gzipEtag)
    assert.notEqual(identityEtag, brEtag)
    const idBuf = Buffer.from(await idRes.arrayBuffer())
    assert.equal(sha256(idBuf), rawPlantumlSha)

    const preferGzipByQ = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'br;q=0.4, gzip;q=0.9' }
    })
    assert.equal(preferGzipByQ.status, 200)
    assert.equal(preferGzipByQ.headers.get('content-encoding'), 'gzip')
    await preferGzipByQ.body?.cancel()

    const disableBrByQ0 = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'br;q=0, gzip;q=0.8' }
    })
    assert.equal(disableBrByQ0.status, 200)
    assert.equal(disableBrByQ0.headers.get('content-encoding'), 'gzip')
    await disableBrByQ0.body?.cancel()

    const disableBothByQ0 = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'br;q=0, gzip;q=0' }
    })
    assert.equal(disableBothByQ0.status, 200)
    assert.equal(disableBothByQ0.headers.get('content-encoding'), null)
    await disableBothByQ0.body?.cancel()

    // 5. Conditional 304 (encoding-aware, multi-tag, weak comparison & wildcard)
    const gzip304 = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': gzipEtag }
    })
    assert.equal(gzip304.status, 304)
    assert.equal(gzip304.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(gzip304.headers.get('etag'), gzipEtag)
    assert.ok(hasVaryEncoding(gzip304.headers.get('vary')))
    assert.equal((await gzip304.arrayBuffer()).byteLength, 0)

    const multiTag304 = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': `"stale", W/${gzipEtag}` }
    })
    assert.equal(multiTag304.status, 304)
    assert.equal((await multiTag304.arrayBuffer()).byteLength, 0)

    const crossEncoding200 = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'br', 'if-none-match': gzipEtag }
    })
    assert.equal(crossEncoding200.status, 200)
    assert.equal(crossEncoding200.headers.get('content-encoding'), 'br')
    assert.equal(crossEncoding200.headers.get('etag'), brEtag)
    await crossEncoding200.body?.cancel()

    const id304 = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'identity', 'if-none-match': identityEtag }
    })
    assert.equal(id304.status, 304)
    assert.equal(id304.headers.get('etag'), identityEtag)
    assert.equal((await id304.arrayBuffer()).byteLength, 0)

    const star304 = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': '*' }
    })
    assert.equal(star304.status, 304)

    // 6. HEAD (compressed and identity, zero body)
    const headGzip = await fetch(engineUrl, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'gzip' }
    })
    assert.equal(headGzip.status, 200)
    assert.equal(headGzip.headers.get('content-encoding'), 'gzip')
    assert.equal(headGzip.headers.get('content-length'), String(gzipContentLength))
    assert.equal(headGzip.headers.get('etag'), gzipEtag)
    assert.equal(headGzip.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal((await headGzip.arrayBuffer()).byteLength, 0)

    const headId = await fetch(engineUrl, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'identity' }
    })
    assert.equal(headId.status, 200)
    assert.equal(headId.headers.get('content-encoding'), null)
    assert.equal(headId.headers.get('content-length'), String(rawPlantuml.length))
    assert.equal(headId.headers.get('etag'), identityEtag)
    assert.equal((await headId.arrayBuffer()).byteLength, 0)

    // 7. Range (206) and out-of-bounds Range (416); compression disabled on Range
    const rangeStart = await fetch(engineUrl, {
      headers: { 'accept-encoding': 'gzip, br', range: 'bytes=0-1023' }
    })
    assert.equal(rangeStart.status, 206)
    assert.equal(rangeStart.headers.get('content-encoding'), null)
    assert.equal(rangeStart.headers.get('content-range'), `bytes 0-1023/${rawPlantuml.length}`)
    assert.equal(rangeStart.headers.get('content-length'), '1024')
    assert.equal(rangeStart.headers.get('etag'), identityEtag)
    assert.ok(hasVaryEncoding(rangeStart.headers.get('vary')))
    const rangeStartBuf = Buffer.from(await rangeStart.arrayBuffer())
    assert.deepEqual(rangeStartBuf, rawPlantuml.subarray(0, 1024))

    const rangeSuffix = await fetch(engineUrl, {
      headers: { range: 'bytes=-256' }
    })
    assert.equal(rangeSuffix.status, 206)
    assert.equal(
      rangeSuffix.headers.get('content-range'),
      `bytes ${rawPlantuml.length - 256}-${rawPlantuml.length - 1}/${rawPlantuml.length}`
    )
    assert.equal(rangeSuffix.headers.get('content-length'), '256')
    assert.deepEqual(Buffer.from(await rangeSuffix.arrayBuffer()), rawPlantuml.subarray(rawPlantuml.length - 256))

    const rangeClamped = await fetch(engineUrl, {
      headers: { range: `bytes=${rawPlantuml.length - 16}-${rawPlantuml.length + 500}` }
    })
    assert.equal(rangeClamped.status, 206)
    assert.equal(
      rangeClamped.headers.get('content-range'),
      `bytes ${rawPlantuml.length - 16}-${rawPlantuml.length - 1}/${rawPlantuml.length}`
    )
    assert.equal(rangeClamped.headers.get('content-length'), '16')
    assert.deepEqual(Buffer.from(await rangeClamped.arrayBuffer()), rawPlantuml.subarray(rawPlantuml.length - 16))

    const headRange = await fetch(engineUrl, {
      method: 'HEAD',
      headers: { range: 'bytes=0-1023' }
    })
    assert.equal(headRange.status, 206)
    assert.equal(headRange.headers.get('content-range'), `bytes 0-1023/${rawPlantuml.length}`)
    assert.equal(headRange.headers.get('content-length'), '1024')
    assert.equal((await headRange.arrayBuffer()).byteLength, 0)

    const range416Edge = await fetch(engineUrl, {
      headers: { range: `bytes=${rawPlantuml.length}-` }
    })
    assert.equal(range416Edge.status, 416)
    assert.equal(range416Edge.headers.get('content-range'), `bytes */${rawPlantuml.length}`)
    assert.equal((await range416Edge.arrayBuffer()).byteLength, 0)

    const range416Far = await fetch(engineUrl, {
      headers: { range: 'bytes=99999999-100000000' }
    })
    assert.equal(range416Far.status, 416)
    assert.equal(range416Far.headers.get('content-range'), `bytes */${rawPlantuml.length}`)

    const head416 = await fetch(engineUrl, {
      method: 'HEAD',
      headers: { range: 'bytes=99999999-' }
    })
    assert.equal(head416.status, 416)
    assert.equal(head416.headers.get('content-range'), `bytes */${rawPlantuml.length}`)
    assert.equal((await head416.arrayBuffer()).byteLength, 0)

    const ifRangeMatch = await fetch(engineUrl, {
      headers: { range: 'bytes=0-31', 'if-range': identityEtag }
    })
    assert.equal(ifRangeMatch.status, 206)
    assert.deepEqual(Buffer.from(await ifRangeMatch.arrayBuffer()), rawPlantuml.subarray(0, 32))

    const ifRangeMismatch = await fetch(engineUrl, {
      headers: { range: 'bytes=0-31', 'if-range': '"mismatch"' }
    })
    assert.equal(ifRangeMismatch.status, 200)
    assert.equal(ifRangeMismatch.headers.get('content-length'), String(rawPlantuml.length))
    assert.equal((await ifRangeMismatch.arrayBuffer()).byteLength, rawPlantuml.length)

    // 8. Immutable stdlib route
    const stdlibRes = await fetch(stdlibThemesUrl, { headers: { 'accept-encoding': 'gzip' } })
    assert.equal(stdlibRes.status, 200)
    assert.equal(stdlibRes.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(stdlibRes.headers.get('content-encoding'), 'gzip')
    assert.equal(sha256(Buffer.from(await stdlibRes.arrayBuffer())), rawThemesSha)

    // 9. Legacy unversioned compatibility routes (no-cache + ETag + 304)
    const legacyRes = await fetch(`${base}/plantuml.js`, { headers: { 'accept-encoding': 'gzip' } })
    assert.equal(legacyRes.status, 200)
    assert.equal(legacyRes.headers.get('cache-control'), 'no-cache')
    assert.equal(legacyRes.headers.get('content-encoding'), 'gzip')
    assert.equal(legacyRes.headers.get('etag'), gzipEtag)
    assert.ok(hasVaryEncoding(legacyRes.headers.get('vary')))
    assert.equal(sha256(Buffer.from(await legacyRes.arrayBuffer())), rawPlantumlSha)

    const legacy304 = await fetch(`${base}/plantuml.js`, {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': gzipEtag }
    })
    assert.equal(legacy304.status, 304)
    assert.equal(legacy304.headers.get('cache-control'), 'no-cache')

    const legacyStdlibRes = await fetch(`${base}/stdlib/themes.js`, { headers: { 'accept-encoding': 'gzip' } })
    assert.equal(legacyStdlibRes.status, 200)
    assert.equal(legacyStdlibRes.headers.get('cache-control'), 'no-cache')
    assert.equal(sha256(Buffer.from(await legacyStdlibRes.arrayBuffer())), rawThemesSha)

    // 10. Negative / security / method guards
    const staleHash404 = await fetch(`${base}/0000000000000000/plantuml.js`)
    assert.equal(staleHash404.status, 404)

    const hashedManifest404 = await fetch(`${base}/${manifest.hash}/engine.json`)
    assert.equal(hashedManifest404.status, 404)

    const traversal404 = await fetch(`${base}/%2e%2e/package.json`)
    assert.equal(traversal404.status, 404)

    const hashedTraversal404 = await fetch(`${base}/${manifest.hash}/%2e%2e/package.json`)
    assert.equal(hashedTraversal404.status, 404)

    const post405 = await fetch(`${base}/engine.json`, { method: 'POST' })
    assert.equal(post405.status, 405)
    assert.equal(post405.headers.get('allow'), 'GET, HEAD')

    console.log(
      JSON.stringify(
        {
          ok: true,
          version: manifest.version,
          hash: manifest.hash,
          manifestBytes: manifestBuf.length,
          plantumlRawBytes: rawPlantuml.length,
          plantumlGzipBytes: gzipContentLength,
          plantumlBrotliBytes: brContentLength,
          gzipRatio: Number((gzipContentLength / rawPlantuml.length).toFixed(4)),
          brotliRatio: Number((brContentLength / rawPlantuml.length).toFixed(4))
        },
        null,
        2
      )
    )
  } finally {
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
