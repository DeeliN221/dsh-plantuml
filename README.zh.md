# dsh-plantuml

在 DSH 对话里把 ` ```plantuml ` 代码块渲染成图表，支持图片/源码切换、全屏缩放和
SVG/PNG 下载。渲染完全在浏览器内完成：没有 Java、没有 PlantUML 服务端、不发任何
网络请求。

![内联图表与视图切换](docs/inline.png)

## 功能

- 识别 `plantuml`、`puml`、`uml`、`iuml`、`pu`、`wsd` 六种围栏，也能识别没有语言标记但含成对
  `@start…` / `@end…` 的代码块。
- 每个图表自带 **图片 / 代码** 切换，源码可一键复制。
- **全屏查看器**：点图表或「全屏」进入，支持放大/缩小、适应窗口、1:1、拖拽平移、
  ctrl/⌘ + 滚轮缩放，快捷键 `+` `-` `0` `f` `Esc`。
- **导出** SVG（矢量）或 PNG（位图），导出的图片自带背景色，换主题也不会看不清。
- 跟随明暗主题重绘。
- 对话正文、工具结果以及所有由 app 渲染的 Markdown 区域都生效。

## 安装

本仓库是 DSH 插件包，`package.json` 内含 `dsh.bundle.patch`，装进去就是一个标准
bundle：在「设置 → 插件 → 添加插件」里填本仓库地址，或命令行：

```bash
dsh plugin add git+https://gitea.xbugs.site/zzl/dsh-plantuml.git
```

装好后「已安装插件」里会多出 **PlantUML 图表** 一行，可像其他插件一样开关。

> 如果 profile 的 `cordis.patch.yml` 里还留着旧的手工挂载行
> （`- id: dsh-plantuml` / `name: 'dsh-plantuml'`），改用 bundle 前必须删掉，
> 否则同一路由会被挂载两次，插件树在启动时直接失败。

## 结构

| 路径 | 内容 |
| --- | --- |
| `lib/index.js` | Node 侧：把 `vendor/` 里的引擎资源挂到 `/dsh-plantuml` 前缀路由，带路径包含检查与 ETag。 |
| `lib/client.js` | 浏览器侧：在 DOM 层接管 `.md-code-block`，换成图表容器并保留「图片/代码」切换。 |
| `vendor/` | 官方 TeaVM 版 PlantUML 引擎与标准库（8.5 MB，未改动）。 |
| `locale/` | 插件列表里的中文/英文标题与简介。 |
| `icon.svg` | 插件列表图标。 |
| `cordis.patch.yml` | bundle 挂载声明。 |

## 上游与许可

本仓库派生自 [dlutcat/dsh-plantuml](https://github.com/dlutcat/dsh-plantuml)（MIT），
改动仅限打包方式与外观：`dsh.bundle.patch`、`icon.svg`、`locale/`、
`manifestVersion` 与文档。引擎代码来自官方
[plantuml/plantuml-for-github](https://github.com/plantuml/plantuml-for-github)，
版权归 PlantUML 项目（Arnaud Roques），许可见 [NOTICE.md](NOTICE.md)。
