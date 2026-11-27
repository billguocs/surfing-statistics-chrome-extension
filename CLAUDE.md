# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 Chrome 扩展（Manifest V3），用于统计用户在浏览器中访问不同网站的实际停留时长，提供日/周/月报表、场景模式、专注管理和 LLM 增强功能。

## 开发命令

项目是纯静态扩展，无构建步骤：

```bash
# 加载扩展到 Chrome
# 1. 打开 chrome://extensions/
# 2. 启用"开发者模式"
# 3. 点击"加载已解压的扩展程序"，选择本项目目录

# 打包发布（自动化通过 GitHub Actions）
# 推送到 main 分支会自动触发打包和发布
```

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension (MV3)                    │
├─────────────────────────────────────────────────────────────┤
│ background.js   - Service Worker，核心追踪逻辑              │
│   ├─ Session 管理：追踪当前活跃标签页的浏览时长              │
│   ├─ 数据持久化：chrome.storage.local 存储 daily/weekly     │
│   ├─ 行为规则：目标达成通知、分心提醒、专注模式              │
│   └─ 事件监听：tabs.onActivated/onUpdated/Removed,          │
│                windows.onFocusChanged, runtime.onMessage     │
├─────────────────────────────────────────────────────────────┤
│ content.js      - 内容脚本，注入所有页面                     │
│   └─ 监听 visibilitychange/pagehide/pageshow 事件           │
│      向 background 发送 PAGE_VISIBLE/PAGE_HIDDEN 消息       │
├─────────────────────────────────────────────────────────────┤
│ llm.js          - LLM 客户端封装（IIFE，暴露 window.LLMUtils）│
│   ├─ 默认 openai/deepseek/gemini，均走 OpenAI 兼容 /chat/     │
│   │   completions；另支持自定义 endpoint（provider 仅决定     │
│   │   默认 base URL，无协议分派）                             │
│   ├─ 按 config.privacyMode 决定是否把 title/url 放进 prompt  │
│   ├─ requestCategorySuggestions() - 批量分类建议            │
│   └─ requestSmartSummary() - 智能总结生成                   │
│   ※ 隐私边界见 llm-privacy.md                              │
├─────────────────────────────────────────────────────────────┤
│ popup.js        - 弹窗 UI，报告渲染                          │
│   ├─ 日/周/月报告视图切换                                   │
│   ├─ 站点视图 vs 分类视图                                   │
│   ├─ ECharts 图表渲染                                       │
│   └─ LLM 增强的智能总结（可选）                              │
├─────────────────────────────────────────────────────────────┤
│ options.js      - 设置页面                                   │
│   ├─ 站点分类管理                                           │
│   ├─ 场景模式切换（工作/学习/轻松）                         │
│   ├─ 行为规则配置（目标、分心提醒、专注模式）               │
│   ├─ LLM 配置管理                                           │
│   └─ 自动分类建议（本地规则 + LLM 增强）                    │
└─────────────────────────────────────────────────────────────┘
```

## 场景模式的工作方式

场景（工作/学习/轻松）**没有独立的存储概念**，background.js 完全不读 `sceneConfig`：

- 三个场景预设 `SCENE_PRESETS` 在 `popup.js` 和 `options.js` **各复制了一份**（含各自不同的 goalConfig/focusConfig 组合），修改一处必须同步另一处。
- 切换场景 = popup/options 把该预设的 `goalConfig` + `focusConfig` 整体 `storageSet` 覆盖写入对应键。
- background 通过 `chrome.storage.onChanged` 监听这三个配置键（`goalConfig`/`focusConfig`/`categoryConfig`）的变更来重新跑行为规则，因此"场景"对后台透明，无需改动 background。
- `sceneConfig` 仅在 popup/options 里用于记住当前激活的场景 id（默认 `work`），popup 用它渲染按钮高亮、场景名称和总结提示文案。

## 行为规则：1 分钟轮询而非事件触发

目标达成、专注模式、分心提醒都依赖一个 **`behavior-check` alarm（periodInMinutes: 1）** 定时评估，而不是实时累计触发。每次评估读取 stats + 配置，用 `behaviorRuntime`（local）记录"已发过的通知"来去重；key 会按日期（目标通知）或 session 前缀（`tabId:url:startedAt`，专注/分心通知）裁剪清理，避免同一提醒反复弹出。服务 worker 被杀后 alarm 仍在后台注册。

同一个 **`behavior-check`** alarm 每分钟结算一次当前会话，并按 `presenceConfig` 检查空闲状态（默认开启，阈值 3 分钟）。系统空闲且前台页面（包括 iframe）没有播放音视频时，会话先结算再标记为空闲暂停。页面及 iframe 可见时，content.js 将点击、滚轮、键盘和触摸交互节流为 `PAGE_ACTIVE` 消息，间隔至少 15 秒。后台确认消息来自当前聚焦且因空闲暂停的标签页后，从交互时刻重新开始计时。只有顶层文档的可见性消息能暂停或恢复整页会话。

若距离上次结算点超过 **2 分钟**，stats.js 跳过整段未确认区间并推进 checkpoint，避免电脑休眠期间虚增时长；弹窗实时叠加使用同一规则。该保守策略在 Chrome 长时间卡顿时也可能少计。ISO 周历史修复、iframe 消息汇总和验证步骤见 `docs/2026-11-26-tracking-reliability.md`。

## 报表是派生视图

统计数据以本地日期和 ISO 周为单位存入 IndexedDB。popup.js 只读取当前报表需要的桶，再聚合月报、分类视图、趋势和变化分析。报表与目标提醒都会计入尚未结算的当前会话时长。

## 存储键

| 存储位置 | 键名 | 用途 |
|---------|------|------|
| IndexedDB | `browsing-statistics` | 日桶、周桶、共享站点元数据和结算标记。升级时从 `statsV2` 等旧键迁移 |
| local | `categoryConfig` | 分类列表和站点分类映射 |
| local | `goalConfig` | 每日目标配置 |
| local | `focusConfig` | 专注模式配置 |
| local | `presenceConfig` | 空闲暂停计时配置（默认开、阈值 3 分钟，独立于场景） |
| local | `sceneConfig` | 当前激活的场景 id，仅 popup/options 读写（background 不读），默认 `work` |
| local | `llmConfig` | LLM 配置（API Key、模型等） |
| local | `llmFeatureFlags` | LLM 功能开关 |
| local | `behaviorRuntime` | 行为规则运行时状态（已发送通知记录） |
| session | `activeSession` | 当前活跃浏览会话（MV3：service worker 会休眠/被杀，活跃态放 session 区以便重启后重建） |

## 关键数据流

1. **时长追踪**由 content.js 报告页面状态，background.js 串行切换会话，stats.js 把时长按日期和 ISO 周写入 IndexedDB。
2. **行为规则**：`behavior-check` alarm 每分钟评估目标/专注/分心 → `behaviorRuntime` 去重 → 发通知（详见上文）
3. **场景切换**：popup/options 把预设 goalConfig+focusConfig 覆盖写入 → storage.onChanged 触发 background 重新评估
4. **分类建议**：options.js 先运行本地关键词规则，未命中时可选调用 LLM 批量建议
5. **智能总结**：popup.js 先生成本地总结，LLM 开启时可选增强

## LLM 隐私模式

- `hostname_only`：仅发送 hostname 给 LLM
- `full_context`：发送 hostname + title + url
- 隐私边界与数据流向详见 **llm-privacy.md**

## 代码风格

- 纯 JavaScript（无 TypeScript）
- IIFE 封装模块（llm.js）
- 使用 `chrome.storage` API 进行持久化
- 事件驱动架构（background.js 监听浏览器事件）

## 相关文档

- `roadmap.md`：产品方向与版本规划总览
- `vX.Y-spec.md` / `vX.Y-backlog.md`：各版本需求规格与未决事项
- `vX.Y-manual-test.md`：各版本手动测试清单
- `llm-privacy.md`：LLM 数据隐私说明（随 `manifest.json` 版本号同步，发布时需保持一致）
