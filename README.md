# maestro-zcode

> 在 ZCode（智谱 GLM 系 harness）上运行 [Maestro-Flow](https://github.com/catlog22/Maestro-Flow) 工作流编排 —— 一条命令，全流程接入。
>
> Run Maestro-Flow workflow orchestration on ZCode — one command, full pipeline.

把 npm 包 `maestro-flow` 为 Claude Code 设计的资产（命令 / 技能 / agent 角色 / hooks）**自动转换**成 ZCode 插件并完成注册。生成器 + 协议适配层共两个文件，生成产物在本地从你自己的 maestro-flow 安装派生，本仓库不存储任何上游内容（见 [NOTICE](NOTICE.md)）。

## 它给你什么

| 组件 | 数量 | 说明 |
|---|---|---|
| 斜杠命令 | 18 | `/maestro-init`、`/maestro-next`、`/maestro-companion`、`/maestro` 等全生命周期入口 |
| 技能 | 15 | `team-*` 多 agent 工作流、`skill-*` 元技能、`maestro-agents` 派发协议（生成） |
| Agent 角色 | 29 | `assets/agents/*.md` + S/W 分级派发协议（zcode 无自定义 agent 文件机制） |
| Hooks（可选） | 14 | maestro standard 级全量，经 `hook-shim.mjs` 协议适配，fail-open |
| MCP | — | 复用 `maestro-tools`（含代码语义检索），建议裁剪白名单避免与原生工具重复 |

**模型分层（supervisor-worker，可选）**：ZCode 原生支持按 agent 类型覆写模型。在
`~/.zcode/v2/agents-state.json` 把 `Explore` 指向轻量模型（如 GLM-5.3-Flash），
主会话保持强模型 —— 判断型角色（planner/reviewer/verifier）留在主会话，只读检索派发给
轻量子代理。⚠️ 实测：**不要覆写 `general-purpose`**，该键会连主会话一起切到轻量模型；
除非先在模型选择器显式钉住主会话模型并验证。`/maestro-agents` 技能内置了 S/W 分级规则。

## 快速开始

```bash
# 前置：已安装 ZCode、Node ≥ 20、npm 全局安装 maestro-flow
npm install -g maestro-flow

# 1. 克隆本仓库到任意固定位置（升级时原地重跑）
git clone https://github.com/ManicEuphoria/maestro-zcode.git ~/.agents/maestro-zcode

# 2. 生成插件 + 注册（写 ~/.zcode/cli/config.json 的 plugins.dirs）
node ~/.agents/maestro-zcode/generate.mjs

# 3.（可选）一键安装 14 个 hooks（协议适配 + fail-open，幂等）
node ~/.agents/maestro-zcode/generate.mjs --hooks

# 4. 重启 ZCode → Settings → Plugin Management 应出现 maestro 插件
```

MCP（可选但推荐）——在 `~/.zcode/cli/config.json` 注册：

```json
{
  "mcp": {
    "servers": {
      "maestro-tools": {
        "command": "maestro-mcp",
        "args": [],
        "env": { "MAESTRO_ENABLED_TOOLS": "team_msg,store_knowhow,maestro_code_semantic_search" }
      }
    }
  }
}
```

## 转换规则

- **frontmatter**：多行 `allowed-tools` 平铺为单行；工具名映射（`shell→Bash`、
  `delegate_subagent/Task→Agent`、`ask_user→AskUserQuestion`、`track_tasks 等→TodoWrite`）；
  丢弃 ZCode 不识别的字段（`session-mode`、`contract`、`disable-model-invocation`）
- **正文**：`CLAUDE.md→AGENTS.md`、`.claude/commands/x.md→/x`、`Task tool→Agent tool`
- **subagent**：涉 agent 派发的文件自动注入「zcode 运行时适配」注块 + S/W 分级
- **hooks**：`hook-shim.mjs` 做 stdin 双向字段映射（实测 ZCode payload 原生含 Claude
  snake_case 字段）→ 转调 `maestro hooks run`；输出仅 `additionalContext` 单键，
  阻断走退出码 2；任何异常 exit 0 放行（fail-open）
- 每次生成产出 `generation-report.json`（转换命中数 + 需人工复查清单）

## 升级 / 回退

```bash
# maestro 升级后重跑（含 hooks 则加 --hooks）
npm install -g maestro-flow@latest && node ~/.agents/maestro-zcode/generate.mjs

# 软回退：Settings → Plugin Management 关闭 maestro 开关；hooks.enabled 改 false
# 硬回退：从 ~/.zcode/cli/config.json 的 plugins.dirs 移除插件路径
```

## 已知限制（v1）

- `maestro-overlay`、skill-generator 等少数技能引用 `~/.claude/` 路径（maestro 自身资产
  布局），未装 Claude Code 的机器上这些边缘功能需手动改路径；主工作流不受影响
- hooks 的 `additionalContext` 注入与 exit-2 阻断路径依赖 evaluator 真实产出，fail-open
  保护下自动生效
- 在 maestro 项目（含 `.workflow/`）里效果最佳；普通目录下 hooks 空转

## License & Credits

[MIT](LICENSE) · 上游资产归 [catlog22/Maestro-Flow](https://github.com/catlog22/Maestro-Flow)（MIT），
详见 [NOTICE](NOTICE.md)。社区项目，与 catlog22/Maestro-Flow、Z.ai 均无隶属关系。

工作流系统本身请去给上游 star 👏
