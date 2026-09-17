#!/usr/bin/env node
/**
 * maestro hook 适配 shim（zcode ⇄ Claude Code hook 协议）
 * 用法: node hook-shim.mjs <maestro-hook-name>
 *
 * 设计原则:
 *  - fail-open: 任何异常一律 exit 0 放行，绝不打断会话
 *  - 输出最小暴露面: 只发 {"additionalContext": "..."} 单键; 阻断走退出码 2
 *  - stdin 双向兼容: 同时接受 snake_case / camelCase 字段, 输出 canonical Claude 格式
 *  - 调试: 原始 stdin 与转换结果记入 hooks-debug.log（首 200 次触发）
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEBUG_LOG = join(HERE, 'hooks-debug.log')
const DEBUG_MAX_BYTES = 512 * 1024
const HOOK = process.argv[2]

if (!HOOK) process.exit(0)

function debug(obj) {
  try {
    if (statSync(DEBUG_LOG).size > DEBUG_MAX_BYTES) return
  } catch { /* 文件不存在则记录 */ }
  try { appendFileSync(DEBUG_LOG, JSON.stringify(obj) + '\n') } catch { /* 日志失败不影响主流程 */ }
}

// ── 读 stdin ────────────────────────────────────────
let raw = ''
try {
  raw = readFileSync(0, 'utf8')
} catch { process.exit(0) }

let input = {}
try { input = JSON.parse(raw) } catch { debug({ t: 'unparseable-stdin', hook: HOOK, raw: raw.slice(0, 2000) }); process.exit(0) }
debug({ t: 'stdin', hook: HOOK, input })

// ── 字段规范化: zcode(未知命名) → Claude snake_case ──
const pick = (...keys) => { for (const k of keys) if (input[k] !== undefined) return input[k] }
const claude = {
  hook_event_name: pick('hook_event_name', 'hookEventName', 'event'),
  session_id: pick('session_id', 'sessionId'),
  transcript_path: pick('transcript_path', 'transcriptPath'),
  cwd: pick('cwd', 'workspacePath', 'workspace', 'projectPath'),
  tool_name: pick('tool_name', 'toolName', 'tool'),
  tool_input: pick('tool_input', 'toolInput', 'input', 'payload'),
  tool_response: pick('tool_response', 'toolResponse', 'response'),
  prompt: pick('prompt', 'userPrompt', 'message'),
  matcher: pick('matcher', 'source'),
  stop_hook_active: pick('stop_hook_active', 'stopHookActive'),
}

// ── 调用 maestro evaluator ──────────────────────────
let result
try {
  result = spawnSync('maestro', ['hooks', 'run', HOOK], {
    input: JSON.stringify(claude),
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
  })
} catch (e) {
  debug({ t: 'spawn-error', hook: HOOK, error: String(e) })
  process.exit(0)
}
if (result.error) { debug({ t: 'maestro-error', hook: HOOK, error: String(result.error) }); process.exit(0) }

const out = (result.stdout || '').trim()
const err = (result.stderr || '').trim()
const code = result.status ?? 0
debug({ t: 'maestro-out', hook: HOOK, code, out: out.slice(0, 1500), err: err.slice(0, 500) })

// evaluator 自身非零且无 stdout JSON → 原样透传退出码语义（2=block）
if (!out) {
  if (code === 2 && err) process.stderr.write(err)
  process.exit(code === 2 ? 2 : 0)
}

// ── 输出转换: Claude JSON → zcode 最小暴露面 ────────
let parsed
try { parsed = JSON.parse(out) } catch { process.exit(0) } // 无法解析则放行

// 阻断决策 → 退出码 2（不经 JSON 严格校验）
const decision = parsed.decision
if (decision === 'block') {
  const reason = parsed.reason || `blocked by maestro hook ${HOOK}`
  try { process.stderr.write(reason) } catch { /* ignore */ }
  process.exit(2)
}

// 上下文注入 → 仅 additionalContext 单键
const ctx = parsed.additionalContext
if (typeof ctx === 'string' && ctx.trim()) {
  process.stdout.write(JSON.stringify({ additionalContext: ctx }))
}
process.exit(0)
