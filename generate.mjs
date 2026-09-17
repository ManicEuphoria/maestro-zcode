#!/usr/bin/env node
/**
 * maestro-zcode 平台生成器
 * 从已安装的 maestro-flow 包生成 ZCode 插件（commands / skills / agents 资产）
 * 并注册本地 marketplace。可重复执行：maestro update 后重跑一次即可。
 *
 * 用法: node ~/.agents/maestro-zcode/generate.mjs
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'marketplace')
const PLUGIN = join(OUT, 'plugin')

// ── 定位 maestro-flow 包 ─────────────────────────────
const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
const SRC = join(globalRoot, 'maestro-flow')
if (!existsSync(join(SRC, '.claude'))) {
  console.error(`✗ 未找到 maestro-flow 包（期望 ${SRC}/.claude）`); process.exit(1)
}
const pkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
const VERSION = pkg.version

// ── 工具名词典（open-standard / Claude → zcode）──────
const TOOL_MAP = {
  read_file: 'Read', write_file: 'Write', edit_file: 'Edit', shell: 'Bash',
  find_files: 'Glob', search: 'Grep', delegate_subagent: 'Agent', Task: 'Agent',
  send_message: 'SendMessage', ask_user: 'AskUserQuestion',
  track_tasks: 'TodoWrite', create_task: 'TodoWrite', update_task: 'TodoWrite',
  read_many_files: 'Read',
}
const PASS_THROUGH = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent',
  'SendMessage', 'AskUserQuestion', 'TodoWrite', 'WebSearch', 'WebFetch', 'Skill', 'EnterPlanMode', 'ExitPlanMode'])

// ── 正文术语替换规则（每条记录命中数）───────────────
const BODY_RULES = [
  { name: 'Task tool → Agent tool', re: /\bTask tool\b/g, to: 'Agent tool' },
  { name: 'delegate_subagent → Agent', re: /\bdelegate_subagent\b/g, to: 'Agent' },
  { name: 'CLAUDE.md → AGENTS.md', re: /\bCLAUDE\.md\b/g, to: 'AGENTS.md' },
  { name: '.claude/commands/x.md → /x', re: /\.claude\/commands\/([a-z0-9-]+)\.md/g, to: '/$1' },
]
const stats = Object.fromEntries(BODY_RULES.map(r => [r.name, 0]))
const filesTransformed = []

// ── frontmatter 解析/平铺 ────────────────────────────
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return null
  const lines = m[1].split('\n')
  const kv = []
  for (const line of lines) {
    if (/^  - /.test(line) && kv.length) { kv[kv.length - 1].vals.push(line.slice(4).trim()) ; continue }
    const km = line.match(/^([\w-]+):\s*(.*)$/)
    if (km) kv.push({ key: km[1], val: km[2].trim(), vals: [] })
  }
  return { kv, body: m[2] }
}

function mapTools(tokens) {
  const out = []
  for (let t of tokens) {
    if (!t) continue
    t = t.replace(/[`"']/g, '')
    const mapped = TOOL_MAP[t] ?? t
    if (PASS_THROUGH.has(mapped) && !out.includes(mapped)) out.push(mapped)
  }
  return out
}

function transformMd(text, { isAgent } = {}) {
  const fm = parseFrontmatter(text)
  let body = fm ? fm.body : text
  for (const r of BODY_RULES) {
    body = body.replace(r.re, (...a) => { stats[r.name]++; return r.to.replace('$1', a[1]) })
  }
  if (!fm) return body
  // 重组 frontmatter：只保留 zcode 认识/需要的字段
  const keep = []
  for (const { key, val, vals } of fm.kv) {
    if (key === 'allowed-tools') {
      const tokens = vals.length ? vals : val.split(',').map(s => s.trim())
      const mapped = mapTools(tokens)
      if (mapped.length) keep.push(`allowed-tools: ${mapped.join(', ')}`)
    } else if (['name', 'description', 'argument-hint'].includes(key)) {
      keep.push(`${key}: ${val}`)
    } // disable-model-invocation / session-mode / contract 等丢弃
  }
  return `---\n${keep.join('\n')}\n---\n${body}`
}

// ── subagent 适配注块 ────────────────────────────────
const ADAPT_MARK = '<!-- zcode-adapted -->'
const ADAPT_BLOCK = `
${ADAPT_MARK}
> **zcode 运行时适配**：本插件的 agent 角色定义存放在 \`assets/agents/<name>.md\`
>（位于 \`${PLUGIN}/assets/agents/\`）。
> 需要派发 agent 角色时按分级处理（完整协议见 \`/maestro-agents\` 技能）：
> **判断型角色**（planner/reviewer/verifier/supervisor 等）由主代理自己执行，
> 角色文件作为工作准则；**执行型角色**（executor/researcher/mapper 等）经 Agent 工具
> 派发给子代理（GLM-5.3-Flash），任务说明需自包含、步骤化。
`

function maybeInjectAdaptation(text) {
  if (text.includes(ADAPT_MARK)) return text
  const fm = text.match(/^(---\n[\s\S]*?\n---\n)/)
  const body = fm ? text.slice(fm[1].length) : text
  if (!/subagent|delegate|Agent tool|team-worker|worker agent|supervisor|reviewer agent/i.test(body)) return text
  return (fm ? fm[1] : '') + ADAPT_BLOCK + (fm ? body : text)
}

// ── 生成产物 ─────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true })
mkdirSync(PLUGIN, { recursive: true })

function copyTreeTransformed(srcDir, dstDir, { adapt } = {}) {
  mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, entry.name), d = join(dstDir, entry.name)
    if (entry.isDirectory()) copyTreeTransformed(s, d, { adapt })
    else if (entry.name.endsWith('.md')) {
      let out = transformMd(readFileSync(s, 'utf8'))
      if (adapt) out = maybeInjectAdaptation(out)
      writeFileSync(d, out)
      filesTransformed.push(d.replace(OUT + '/', ''))
    } else cpSync(s, d)
  }
}

// 1) commands（.claude/commands/*.md → commands/）
copyTreeTransformed(join(SRC, '.claude', 'commands'), join(PLUGIN, 'commands'), { adapt: true })
// 2) skills（.claude/skills/ → skills/，含参考文件）
copyTreeTransformed(join(SRC, '.claude', 'skills'), join(PLUGIN, 'skills'), { adapt: true })
// 3) agents（.claude/agents/ → assets/agents/）
copyTreeTransformed(join(SRC, '.claude', 'agents'), join(PLUGIN, 'assets', 'agents'), {})

// 4) maestro-agents 派发协议技能（生成）
const agentDir = join(SRC, '.claude', 'agents')
const agents = readdirSync(agentDir).filter(f => f.endsWith('.md')).map(f => {
  const fm = parseFrontmatter(readFileSync(join(agentDir, f), 'utf8'))
  const name = fm?.kv.find(k => k.key === 'name')?.val ?? f.replace(/\.md$/, '')
  const desc = fm?.kv.find(k => k.key === 'description')?.val ?? ''
  return { file: f, name, desc }
})
const tierOf = (name) =>
  /planner|review|verif|supervis|debug|roadmap|analyz|integrat|author|design|impeccable-agent|planning/i.test(name) ? 'S' : 'W'

mkdirSync(join(PLUGIN, 'skills', 'maestro-agents'), { recursive: true })
writeFileSync(join(PLUGIN, 'skills', 'maestro-agents', 'SKILL.md'), `---
name: maestro-agents
description: Maestro subagent dispatch protocol for zcode — how to load a maestro agent role definition and dispatch it via the Agent tool, with S/W role tiers (judgment roles on the main model, worker roles on Flash). Use when a maestro workflow calls for spawning an agent/role (supervisor, worker, reviewer, executor...).
---

# Subagent 派发协议（zcode 适配）

zcode 无自定义 agent 定义文件机制。maestro 的 ${agents.length} 个角色定义随本插件分发在
\`assets/agents/<name>.md\`，物理路径：\`${PLUGIN}/assets/agents/\`。

## 模型分级（supervisor-worker 架构）

- **主会话 = 强模型（supervisor）**：需求分析、架构、流程规划、review、验收
- **Explore 子代理 = 轻量模型（worker）**：文件检索、批量阅读等只读杂活
  （由 zcode 的 builtInModelOverrides 实现，\`~/.zcode/v2/agents-state.json\`，
  仅覆写 \`Explore\`）

> ⚠️ 实测警告：**不要**把 \`general-purpose\` 也加入 builtInModelOverrides——
> 该键会连主会话一起切到轻量模型（supervisor 被降级）。如需执行型子代理走轻模型，
> 先在模型选择器里显式钉住主会话模型并实测验证。

**派发分级规则（按角色分级）**：

| 级别 | 处理方式 | 判定 |
|---|---|---|
| **S（判断型）** | **主代理自己执行**，角色文件作为工作准则/rubric 内联阅读 | 名称含 planner/review/verif/supervis/debug/roadmap/analyz/integrat/author/design/planning |
| **W（执行型）** | **派发给 Flash 子代理**，角色提示词 + 任务一起下发 | 其余（executor/researcher/mapper/documenter/worker 等） |

## W 级派发方法

1. Read 角色文件，取其正文作为角色提示词
2. 组织任务说明：**自包含、步骤化**（worker 是 Flash，轻量模型——上下文、验收标准、
   边界条件都要显式写清，不要依赖隐式推理）
3. 经 Agent 工具派发：subagent_type 用 general-purpose（全工具）或 Explore（只读检索），
   prompt = 角色提示词 + 任务
4. 并行角色用多次 Agent 调用实现

## 角色清单

| 角色 | 级别 | 文件 | 职责 |
|---|---|---|---|
${agents.map(a => `| ${a.name} | ${tierOf(a.name)} | ${a.file} | ${a.desc.slice(0, 70)} |`).join('\n')}
`)

// 5) plugin.json / marketplace.json
mkdirSync(join(PLUGIN, '.zcode-plugin'))
writeFileSync(join(PLUGIN, '.zcode-plugin', 'plugin.json'), JSON.stringify({
  name: 'maestro',
  version: VERSION,
  description: `Maestro Flow workflow orchestration ported for ZCode (auto-generated from maestro-flow@${VERSION}; rerun ~/.agents/maestro-zcode/generate.mjs after maestro update)`,
  author: { name: 'upstream: catlog22/maestro-flow; port: maestro-zcode generator' },
  license: pkg.license ?? 'MIT',
  commands: 'commands',
  skills: 'skills',
}, null, 2))
writeFileSync(join(OUT, 'marketplace.json'), JSON.stringify({
  name: 'maestro-zcode',
  plugins: [{
    name: 'maestro',
    description: 'Maestro Flow workflow orchestration (skills + commands + agent role assets)',
    version: VERSION,
    source: { source: 'directory', path: 'plugin' },
  }],
}, null, 2))

// 6) 注册：plugins.dirs 内联目录（defaultEnabled: true，无需 marketplace 安装流程）
//    同时清理早期版本的 marketplace/cache 注册残留
const zcodeCli = join(homedir(), '.zcode', 'cli')
const cfgPath = join(zcodeCli, 'config.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const PLUGIN_ABS = join(OUT, 'plugin')
cfg.plugins = cfg.plugins ?? {}
cfg.plugins.dirs = cfg.plugins.dirs ?? []
if (!cfg.plugins.dirs.includes(PLUGIN_ABS)) cfg.plugins.dirs.push(PLUGIN_ABS)
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

// 清理早期 marketplace 注册残留（known_marketplaces 条目 + cache 目录）
const kmPath = join(zcodeCli, 'plugins', 'known_marketplaces.json')
if (existsSync(kmPath)) {
  const km = JSON.parse(readFileSync(kmPath, 'utf8'))
  const before = km.marketplaces.length
  km.marketplaces = km.marketplaces.filter(m => m.id !== 'maestro-zcode')
  if (km.marketplaces.length !== before) writeFileSync(kmPath, JSON.stringify(km, null, 2))
}
rmSync(join(zcodeCli, 'plugins', 'cache', 'maestro-zcode'), { recursive: true, force: true })

// 6b) 可选：--hooks 一键安装 14 个 standard 级 hook（经 shim 适配，幂等合并）
if (process.argv.includes('--hooks')) {
  const SHIM = join(HERE, 'hook-shim.mjs')
  const cmd = (name, msg) => ({
    type: 'command',
    command: `node ${SHIM} ${name}`,
    timeout: 30,
    ...(msg ? { statusMessage: msg } : {}),
  })
  const OURS = {
    SessionStart: [
      { matcher: 'startup|resume', hooks: [cmd('session-context', 'Loading maestro workflow context')] },
      { matcher: 'startup', hooks: [cmd('kg-auto-init'), cmd('search-daemon-start')] },
    ],
    UserPromptSubmit: [{ hooks: [cmd('skill-context'), cmd('keyword-spec-injector'), cmd('kg-sync')] }],
    PreToolUse: [
      { matcher: 'Agent', hooks: [cmd('spec-injector')] },
      { matcher: 'Bash|Write|Edit|Agent', hooks: [cmd('preflight-guard')] },
      { matcher: 'Write', hooks: [cmd('spec-validator')] },
    ],
    PostToolUse: [
      { matcher: 'Bash|Agent', hooks: [cmd('delegate-monitor')] },
      { matcher: 'Write|Edit', hooks: [cmd('search-cache-invalidator')] },
    ],
    Stop: [{ hooks: [cmd('team-monitor'), cmd('telemetry'), cmd('coordinator-tracker')] }],
  }
  // 幂等合并：只移除引用本 shim 的旧条目，保留用户自己的其他 hooks
  const isOurs = (h) => typeof h.command === 'string' && h.command.includes(join('maestro-zcode', 'hook-shim.mjs'))
  const hooks = cfg.hooks ?? {}
  hooks.enabled = true
  const events = { ...(hooks.events ?? {}) }
  for (const ev of Object.keys(events)) {
    events[ev] = (events[ev] || []).filter((g) => !(g.hooks || []).some(isOurs))
  }
  for (const [ev, groups] of Object.entries(OURS)) events[ev] = [...(events[ev] || []), ...groups]
  hooks.events = events
  cfg.hooks = hooks
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  console.log('  hooks: 14 个已安装（--hooks，幂等合并，其他 hooks 保留）')
}

// 7) 生成报告
const now = new Date().toISOString()
const remaining = filesTransformed.filter(f => {
  const t = readFileSync(join(OUT, f), 'utf8')
  return /\.claude\/|CLAUDE\.md|\bTask tool\b/.test(t)
})
const report = {
  generatedAt: now, sourceVersion: VERSION, sourcePath: SRC,
  counts: {
    commands: readdirSync(join(PLUGIN, 'commands')).length,
    skills: readdirSync(join(PLUGIN, 'skills')).length,
    agents: readdirSync(join(PLUGIN, 'assets', 'agents')).length,
    pluginDir: PLUGIN_ABS,
  },
  bodyRuleHits: stats,
  needsManualReview: remaining,
}
writeFileSync(join(HERE, 'generation-report.json'), JSON.stringify(report, null, 2))

console.log(`✓ maestro-zcode 生成完毕 (源: maestro-flow@${VERSION})`)
console.log(`  commands: ${report.counts.commands} | skills: ${report.counts.skills}（含生成的 maestro-agents）| agents: ${report.counts.agents}`)
console.log(`  正文替换: ${Object.entries(stats).map(([k, v]) => `${k}×${v}`).join('，')}`)
console.log(`  注册: plugins.dirs += ${PLUGIN_ABS}`)
if (remaining.length) console.log(`  ⚠ ${remaining.length} 个文件仍有 Claude 引用，见 generation-report.json`)
