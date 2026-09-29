# Md2Obsidian

一个 Zotero 插件，把 [LLM for Zotero](https://github.com/yilewang/llm-for-zotero) 调用 MinerU 解析 PDF 后生成的 Markdown 和引用图片，按所选 collection 单向同步到本地 Obsidian 仓库。它连接的是 **Zotero 中的论文解析结果** 与 **Obsidian 中的原始资料目录**，适合用作 [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 工作流的论文输入。

```text
Zotero 中的 PDF
    ↓ LLM for Zotero 调用 MinerU 解析
Zotero 本地 MinerU 缓存（full.md + 图片）
    ↓ 本插件按 collection 同步
Obsidian 仓库的 raw/papers/ 和 raw/assets/mineru/
    ↓ 按自己的 LLM Wiki 流程摄入
Obsidian 中的 wiki 页面
```

本插件读取已有缓存，不运行 MinerU 或 OCR，也不生成 wiki 摘要、概念页、索引，或将 Obsidian 的修改回写 Zotero。每条同步规则可选择多个 collection、是否包含子 collection，以及一个目标仓库；可保存多条规则。

## 使用前准备

1. **在 Zotero 中配置 LLM for Zotero 的 MinerU。** 安装 LLM for Zotero，在其首选项的 MinerU 设置中启用解析，配置可用的云端 API 或本地 MinerU 服务，并确认目标 PDF 已解析完成。可在 MinerU 的文件管理界面检查缓存；本插件需要对应附件的本地 `full.md`。具体设置以 [LLM for Zotero 的 MinerU 说明](https://github.com/yilewang/llm-for-zotero#mineru-pdf-parsing) 为准。
2. **在 Obsidian 中准备 Karpathy LLM Wiki 仓库。** 按 [Karpathy 的原始说明](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 建立自己的原始资料层、wiki 层和指导 LLM 摄入资料的规则。把该文件夹作为 Obsidian 仓库打开，并确定论文原文应进入哪个 `raw` 子目录。本插件默认写到 `raw/papers/`，图片写到 `raw/assets/mineru/`；如果你的目录结构不同，可在同步设置中修改。LLM Wiki 是一种工作流，并非本插件会自动安装或运行的 Obsidian 扩展。

插件直接读写上述本地文件夹，无需 Obsidian API。同步完成后，仍需使用你配置的 LLM Wiki 流程处理新加入的论文原文。

## 安装与第一次同步

1. 从 [GitHub Releases](https://github.com/fenghsu2019/zotero-mineru-obsidian/releases/latest) 的 **Assets** 下载 `mineru-obsidian-sync-0.2.7.xpi`。已安装旧版时，从文件安装新版即可升级；已有同步配置保留。
2. 在 Zotero 中打开 **工具 → 插件**，点击齿轮，选择 **从文件安装插件**，选中该 XPI。
3. 打开 **Zotero → 设置 → Md2Obsidian**（macOS；Windows/Linux 在 **编辑 → 设置**）。工具菜单和 collection 右键菜单也能直达该设置面板。
4. 在表格中勾选一个或多个 collection，再选择已存在的 Obsidian 仓库根目录。默认 Markdown 子目录为 `raw/papers`，图片子目录为 `raw/assets/mineru`，可以修改。
5. MinerU 缓存根目录留空时，使用 Zotero 数据目录中的 `llm-for-zotero-mineru`；如果实际缓存另存他处，选择对应根目录。
6. 点击 **预览同步**，查看新增、更新、缺文件、冲突和失败条目。预览不写入导出文件、状态或报告。
7. 确认设置后点击 **立即同步**。需要以后复用时点击 **保存配置**。

点击 **新建** 可以配置另一组 collection 与仓库映射。**移除配置** 只移除规则，保留已导出的文件。手动同步使用面板当前设置，不会替代“保存配置”。

## Collection 勾选表格

表格按行列出 collection 名称、完整路径和所属文献库，用行首复选框选择。可按名称、完整路径或文献库搜索；搜索和 **只看已选** 仅过滤显示，不会清除已选项。**全选当前结果** 只勾选当前可见的行；表头复选框可勾选或取消当前结果，**清空已选** 会清除全部选择。上方显示已选数量和当前显示数量。

勾选 **包含所选 collection 的子分类** 后，会汇总所有选中 collection 及其子分类。即使同时选择父分类和子分类，或同一篇文献属于多个已选 collection，每个 PDF 附件在一次同步中也只处理一次。不同文献库中同名或同 key 的 collection 按各自身份区分。

旧版单 collection 配置会在表格中显示为一个已勾选项；保存后转换为多选配置，保留原任务 ID。至少需要勾选一个 collection。如果已选 collection 被删除或无法找到，同步会明确报错，不静默忽略该选择。

## 自动同步与更新规则

默认手动同步。勾选 **Zotero 运行时自动同步** 并保存后，可选每隔 1–1440 分钟、每天指定本地时间，或每隔 1–365 天在指定本地时间运行。旧配置继续使用默认的 10 分钟间隔。首次保存定时配置后，第一次执行安排在下一个指定时间；之后按所选天数重复。实际运行时间最多可能比设定时间晚约一分钟。手动同步会重新计算分钟间隔，但不改变每天或每 N 天的固定时刻。Zotero 关闭期间若错过了计划时间，下次启动后补执行一次，不会把错过的多次任务逐个补跑。关闭 Zotero 后不再执行，插件不会注册系统后台任务。

默认的 **以 Zotero 缓存覆盖更新** 模式会更新本插件已经管理的 Markdown 和图片，包含你对这些导出文件做过的修改。自己的阅读笔记请另建文件并链接到导出文献；需要直接编辑导出文件时，可选 **保留手动编辑，报告冲突**。后一模式将目标文件与上次导出的基准副本比较，发现本地修改时跳过该附件并报告冲突。

首次遇到已有同名文件时，内容不同会报告冲突，不因选择覆盖模式就接管或覆盖既有原稿。内容相同的生成文件可以由插件接管。移出 collection、删除规则、源缓存不再引用某张图片，都不会触发目标文件删除。

## 文件布局和身份

默认导出示例：

```text
<vault>/
├── raw/
│   ├── papers/
│   │   └── PDF filename--1-ABCD1234.md
│   └── assets/mineru/
│       └── 1-ABCD1234/images/
│           └── figure.jpg
└── .zotero-mineru-sync/
    ├── state.json
    ├── last-report.json
    └── baselines/
        └── 1-ABCD1234/
            └── <generation>/...
```

Markdown 文件名为 `<PDF stem>--<libraryID>-<attachmentKey>.md`。文件名中的不安全字符会被替换，过长文件名会截短；附加 Zotero 身份可以区分同名 PDF。已经建立映射后，PDF 重命名不会自动移动原有 Markdown，以保持现有 Obsidian 链接。更改输出子目录也不会自动迁移已有正文。

缓存目录使用的是 **PDF 附件的数字 ID**：

```text
<zotero-data-dir>/llm-for-zotero-mineru/<attachment_item_id>/full.md
```

这个数字 ID 与父级文献条目 ID 不同；目标文件后缀使用的附件 key 也不是该数字 ID。插件通过 Zotero 实际集合成员和附件关系读取缓存，不靠文章标题猜测匹配。

每个 PDF 附件对应一个导出 Markdown。正文带有标题、作者、年份、DOI、Zotero 身份和打开原条目的链接等 YAML 属性；本地图片引用改为相对路径。插件不会生成 Wiki 来源摘要、概念页或修改知识库索引。

`.zotero-mineru-sync` 保存文件归属、比较基准和最近一次实际同步报告。基准保存正文和图片的副本；未变化图片可以复用旧基准，有变化的内容会留下新一代副本。目前不自动清理旧基准，频繁更新的大型文献库会增加磁盘占用，可能累计多份历史内容。保留此目录才能继续识别托管文件和保护手动编辑；不要把它当成无用缓存直接删除。

## 图片与失败处理

仅复制 Markdown 中实际引用的本地图片，支持常用 Markdown 图片、引用式图片和 HTML `img`。不会盲目复制缓存 `images/` 里的全部文件。远程图片链接保留，插件不会下载这些图片。

较新缓存如果缺少图片标记，可根据 `manifest.json` 中可验证的图片位置恢复。来源文件名不匹配、位置不兼容、歧义、低置信度、只缺一部分图片标记等情况会拒绝该附件的导出。缺少被引用的图片也会拒绝该附件，避免生成带有已知断图的正文；其他附件仍可继续处理。关闭自动恢复并不会允许静默忽略 manifest 中已知缺失的图片。

图片恢复依赖现有 manifest 的文件名、字符长度、位置和置信度校验。这能发现多种过时或不匹配缓存，但不能证明 MinerU 识别出的内容与原 PDF 完全一致，恢复结果仍值得抽查。插件保持 Zotero 缓存原样。

运行结果可在面板查看；实际同步结束后尝试写入 `.zotero-mineru-sync/last-report.json`。报告不列出未变化的附件及其数量。`missing` 表示缓存或图片缺失，`conflict` 表示目标内容冲突，`failed` 表示路径、manifest、状态文件或写入等其他错误。查看具体条目的错误原因后处理，再运行预览。

插件在本机读写文件，不向外部服务上传论文或调用云端接口。仓库若已经启用 Obsidian Sync、iCloud 或其他同步服务，仍受这些服务的现有设置影响。用于比较的方式是正文和文件字节与基准副本直接比较。

## 兼容性与验证范围

manifest 允许 Zotero 7.0 至 10.0.* 安装。本机 macOS、Zotero 10.0.2 已完成源码加载和集合、附件读取 API 的实际执行验证；Zotero 7–9、Windows、Linux 和群组库尚未运行验证。允许安装不等于这些环境已经测试通过。

0.1.1 已用 Zotero 10.0.4 的实际 AddonManager 读取 XPI 验证：`error: 0`、`isCompatible: true`、`appDisabled: false`，更新安全检查保持开启。此检查不执行安装，也不替代安装后启动与同步验证。

多 collection 版本新增 11 项适配器测试，连同原有测试共 51 项通过，覆盖旧配置兼容、重叠分类去重、跨库选择及失效 collection。0.2.1 已在本机 Zotero 10.0.4 升级安装并验证原生窗口中的表格滚动布局、多选、搜索保留选择、只看已选、批量选择和清空选择。插件资源按版本加载，修复热升级时复用旧样式的问题。详细记录见 [TESTING.md](TESTING.md)。

当前为手动分发版本，没有在线更新服务器。为满足 Zotero 必填且必须安全的 `update_url` 要求，声明了 HTTPS 保留域名 `https://mineru-obsidian-sync.invalid/updates.json`；它不提供在线更新。Zotero 检查本插件更新时可能提示连接失败，升级需手动安装新 XPI。正式发布时应换成作者控制的真实 HTTPS 更新清单地址。

安装、真实写入和完整界面交互的验证进度见 [TESTING.md](TESTING.md)。本说明中的操作步骤是使用方法；只有验证记录中明确列出的安装或同步操作才视为已执行。

开发环境需要 Node.js 20 或更新版本运行测试，以及 Python 3 打包；安装后的 Zotero 插件不需要 Node.js、Python 或 npm 依赖。

在本项目目录运行：

```sh
npm test
python3 scripts/build.py
```

打包输出位于 `dist/`。重新构建会更新同版本 XPI。

## 官方参考

- [Zotero 10 插件开发要求](https://www.zotero.org/support/dev/zotero_10_for_developers)
- [Zotero 9 插件开发要求](https://www.zotero.org/support/dev/zotero_9_for_developers)
- [Zotero 7 插件开发文档](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [Zotero 8 插件开发文档](https://www.zotero.org/support/dev/zotero_8_for_developers)
- [Zotero 官方 Make It Red 示例插件](https://github.com/zotero/make-it-red)
- [Mozilla IOUtils 文件接口](https://raw.githubusercontent.com/mozilla/gecko-dev/master/dom/chrome-webidl/IOUtils.webidl)
- [Mozilla PathUtils 路径接口](https://raw.githubusercontent.com/mozilla/gecko-dev/master/dom/chrome-webidl/PathUtils.webidl)
