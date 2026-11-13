# Changelog

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
