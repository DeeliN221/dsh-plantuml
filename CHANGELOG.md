# Changelog

## 1.3.2 — 2026-11-22

Release automation only: nothing in the rendering pipeline changed.

### Changed

- `.github/workflows/publish.yml` (tag-triggered `npm publish`, always failed
  without an `NPM_TOKEN`) is replaced by `.github/workflows/release.yml`. A
  `v<major>.<minor>.<patch>` tag now verifies that `package.json` matches the
  tag, runs `npm run verify`, packs the tarball with `npm pack`, and attaches
  `dsh-plantuml-1.3.2.tgz` plus `SHA256SUMS` to a GitHub Release.
- The workflow only needs `contents: write`: no registry step, no `NPM_TOKEN`,
  no `id-token` permission.

### Unchanged

- Runtime code, engine, standard library, HTTP routes, exports and the
  `/dsh-plantuml/**` contract are the same as 1.3.1.

## 1.3.0 — 2026-11-19

The rendering pipeline moved into the shared `plantuml-core` package; this
plugin now keeps only its DSH-specific half.

### Changed

- Normalization, engine serialization, the bounded SVG cache and SVG
  sanitizing come from `/dsh-plantuml/core.js` (served by this package,
  revalidated like `engine.json`). `lib/client.js` keeps fence discovery, the
  DOM sandbox, the theme/locale wiring and every viewer/export control.
- `packages/core` is the single source; `prepack` copies it into `core/core.js`
  so the published tarball stays self-contained.

### Unchanged

- Rendering semantics, engine and standard library, route prefixes and the
  public `/dsh-plantuml/**` contract.

## 1.2.0 — 2026-11-18

Content-addressed immutable engine caching, discovery manifest, transfer compression, and byte-range serving.

### Added

- Discovery manifest at `/dsh-plantuml/engine.json` (150 bytes; `Cache-Control: no-cache` + strong `ETag`, `304` on `If-None-Match`) returning `version`, `hash`, `url`, and `stdlibBase`.
- Versioned immutable asset routes `/dsh-plantuml/<hash>/plantuml.js` and `/dsh-plantuml/<hash>/stdlib/*` with `Cache-Control: public, max-age=31536000, immutable`, where `<hash>` is the 16-hex-char SHA-256 prefix of `vendor/` contents.
- `Accept-Encoding` negotiation supporting `br` (Brotli quality 6) and `gzip` (level 9) for text/script/JSON/SVG assets >= 256 bytes, emitting `Content-Encoding`, `Vary: Accept-Encoding`, and encoding-specific strong `ETag` values (`vendor/plantuml.js`: 4,013,244 B raw -> 1,106,930 B gzip / 999,823 B br).
- `HEAD`, `If-None-Match` (`304`), and single-range `Range` (`206` + `Content-Range`, `416` when out of bounds) support. Transfer compression is disabled when `Range` is requested so byte slices always address the uncompressed asset.
- `scripts/verify-assets.mjs` (Node stdlib only) and `npm run verify` to test manifest headers, immutable headers, `304`, `206`, `416`, `HEAD`, compression sizes, compatibility paths, and path guards.

### Changed

- `lib/client.js` now fetches `/dsh-plantuml/engine.json` (`cache: 'no-cache'`) before lazy-importing the fingerprinted `plantuml.js` and setting `PLANTUML_STDLIB_BASE` to the fingerprinted `stdlib/` prefix, falling back to `/dsh-plantuml/plantuml.js` only on `404`.
- Legacy `/dsh-plantuml/plantuml.js` and `/dsh-plantuml/stdlib/*` paths remain available with `Cache-Control: no-cache`, strong `ETag`, compression, and `Range` support for backwards compatibility.

### Unchanged

- `vendor/` engine and standard library files, PlantUML rendering semantics, and runtime dependencies (zero new dependencies).

## 1.1.0 — 2026-11-13

Repackaged as a standard DSH bundle (zzl redistribution of upstream 1.0.0).

### Added

- `dsh.bundle.patch` and `dsh.manifestVersion`: the package installs through the
  Web 插件 page or `dsh plugin add`, lands in `dsh.profile.bundles`, and shows up
  in 已安装插件 with its own enable switch.
- `icon.svg`: plugin-list icon.
- `locale/zh.json`, `locale/en.json`: plugin-list title and description, exposed as
  `./locale/*.json` and `./icon` subpaths so the loader can read them.
- `README.zh.md`, install notes and the double-mount warning.

### Changed

- `package.json` gains `icon`, `files`, `engines`, repository links and a
  descriptive `description`; `private` is dropped so the package can be
  installed from this repository.

### Unchanged

- `lib/`, `vendor/` and the rendering behaviour are byte-identical to upstream
  1.0.0.

## 1.0.0

- Upstream release by [dlutcat](https://github.com/dlutcat/dsh-plantuml):
  in-chat PlantUML rendering with diagram/source switch, fullscreen viewer and
  SVG/PNG export.
