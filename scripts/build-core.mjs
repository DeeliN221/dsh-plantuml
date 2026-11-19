#!/usr/bin/env node
/**
 * Copy the workspace's shared render core into the published package.
 *
 * The browser bundle imports it from `/dsh-plantuml/core.js`, i.e. from the
 * package's own asset route, so the file has to exist inside the tarball.
 * Keeping the copy out of git makes `packages/core` the single source.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '../../core/src/core.js')
const target = resolve(here, '../core/core.js')

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
console.log(`core: ${source} -> ${target}`)
