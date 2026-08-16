import { type Plugin, tool } from "@opencode-ai/plugin"
import { promises as fs } from "fs"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

/**
 * md-memory — 基于本地 Markdown 文件的轻量记忆系统。
 *
 * - 存储根：<当前项目目录>/.memory/（context.directory 定位，全局插件可访问任意项目）
 * - id 化：简短 id（mdm_<n>）内嵌文件名开头，从文件名解析，无需索引映射
 * - scope：省略 → 根目录；all-modules → 根+所有模块（仅 list/search）；<module> → 该模块目录
 * - 门禁：md_update / md_delete 必须先 md_read 读取该文件，否则拒绝
 * - search：rg 优先，失败回退 JS 字符串匹配
 */

const readSet = new Set<string>()
const MAX_READ_SET = 200

const META_FILE = "meta.json"
const ID_PREFIX = "mdm_"
const META_NEXT_KEY = "next_id"

/** 当前 .memory/ 根绝对路径 */
function memoryRoot(root: string): string {
  return path.join(root, ".memory")
}

/** 校验 scope：仅允许省略（undefined → 根）或一层模块名；all-modules 是 list/search 专用范围 */
function scopeLabel(scope?: string): string | null {
  if (!scope) return null
  if (scope === "all-modules") return null
  if (scope.includes("/") || scope.includes("\\") || scope.includes(":")) {
    throw new Error(`非法 scope ${scope}：只允许单层模块名，不允许多级路径或特殊字符`)
  }
  return scope
}

/** 解析相对当前 cwd 的 .memory 路径，阻止路径穿越 */
function resolveInMemory(root: string, rel: string): string {
  const base = memoryRoot(root)
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`非法路径 ${rel}：不允许越出 .memory/ 目录`)
  }
  return abs
}

/** 读取计数器（不存在则初始为 1） */
async function readMeta(root: string): Promise<{ nextId: number }> {
  const metaPath = path.join(memoryRoot(root), META_FILE)
  try {
    const raw = await fs.readFile(metaPath, "utf-8")
    const data = JSON.parse(raw)
    return { nextId: typeof data[META_NEXT_KEY] === "number" ? data[META_NEXT_KEY] : 1 }
  } catch {
    return { nextId: 1 }
  }
}

/** 写回计数器（原子写：临时文件 + rename，确保目录存在） */
async function writeMeta(root: string, nextId: number): Promise<void> {
  const base = memoryRoot(root)
  await fs.mkdir(base, { recursive: true })
  const metaPath = path.join(base, META_FILE)
  const tmpPath = metaPath + ".tmp"
  await fs.writeFile(tmpPath, JSON.stringify({ [META_NEXT_KEY]: nextId }, null, 2), "utf-8")
  await fs.rename(tmpPath, metaPath)
}

/** 列出 .memory 下所有一级目录名（模块 scope），不含根；返回规范化名称 */
async function listScopes(root: string): Promise<string[]> {
  const base = memoryRoot(root)
  const out: string[] = []
  try {
    const entries = await fs.readdir(base, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) out.push(e.name)
    }
  } catch {
    /* 目录不存在 */
  }
  return out
}

/** 收集指定 scope 范围下的全部 .md 文件绝对路径（排除 meta.json）。scope 规则见 scopeLabel */
async function collectMd(root: string, scope?: string): Promise<string[]> {
  const base = memoryRoot(root)
  const dirs: string[] = []
  const rootScope = scopeLabel(scope)
  if (rootScope === null) {
    // 根目录（省略或 all-modules 都含根目录）
    dirs.push(base)
  }
  if (scope === "all-modules") {
    // 加所有模块目录
    for (const s of await listScopes(root)) dirs.push(path.join(base, s))
  } else if (rootScope !== null) {
    dirs.push(path.join(base, rootScope))
  }

  const out: string[] = []
  for (const dir of dirs) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(path.join(dir, e.name))
    }
  }
  return out
}

/** 从文件名解析 id（mdm_<n>-<slug>.md → mdm_<n>） */
function idFromFile(name: string): string | null {
  const dash = name.indexOf("-")
  if (dash <= 0) return null
  const prefix = name.slice(0, dash)
  return prefix.startsWith(ID_PREFIX) ? prefix : null
}

/** 全局定位：已知 id，在所有模块目录 + 根目录找 <id>-*.md，返回绝对路径 */
async function locateById(root: string, id: string): Promise<string | null> {
  const base = memoryRoot(root)
  const dirs = [base]
  for (const s of await listScopes(root)) dirs.push(path.join(base, s))
  for (const dir of dirs) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name.startsWith(id + "-") && e.name.toLowerCase().endsWith(".md")) {
        return path.join(dir, e.name)
      }
    }
  }
  return null
}

/** 生成下一个唯一 id，并确保文件名不冲突（计数器被外部重置时递增兜底） */
async function allocateId(root: string, slug: string, scopeDir: string | null): Promise<string> {
  await fs.mkdir(scopeDir ? path.join(memoryRoot(root), scopeDir) : memoryRoot(root), {
    recursive: true,
  })
  const meta = await readMeta(root)
  let n = meta.nextId
  let id = ""
  for (;;) {
    id = `${ID_PREFIX}${n}`
    const target = scopeDir
      ? path.join(memoryRoot(root), scopeDir, `${id}-${slug}.md`)
      : path.join(memoryRoot(root), `${id}-${slug}.md`)
    try {
      await fs.access(target)
      n += 1 // 冲突，继续递增（覆盖计数器被外部重置的场景）
    } catch {
      break
    }
  }
  await writeMeta(root, n + 1)
  return id
}

/** rg 搜索（rg 优先，失败回退 JS 字符串匹配） */
async function runSearch(root: string, scope: string | undefined, query: string): Promise<string[]> {
  const base = memoryRoot(root)
  const files = await collectMd(root, scope)
  if (!files.length) return []

  // 优先 rg（按行号排序，输出 id + 相对路径 + 命中行）
  try {
    const rels = files.map((f) => path.relative(base, f))
    const { stdout } = await execFileAsync(
      "rg",
      ["-i", "-n", "--no-heading", "--color", "never", "--with-filename", "-e", query, ...rels],
      { cwd: base, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    )
    const lines = stdout.split("\n").filter(Boolean)
    const grouped = new Map<string, string[]>()
    for (const line of lines) {
      const i1 = line.indexOf(":")
      const i2 = line.indexOf(":", i1 + 1)
      if (i1 < 0 || i2 < 0) continue
      const rel = line.slice(0, i1)
      const lineno = line.slice(i1 + 1, i2)
      const content = line.slice(i2 + 1)
      if (!grouped.has(rel)) grouped.set(rel, [])
      grouped.get(rel)!.push(`${lineno}: ${content.trim().slice(0, 120)}`)
    }
    const out: string[] = []
    for (const [rel, hits] of grouped) {
      const id = idFromFile(path.basename(rel)) ?? ""
      out.push(`--- ${id} (${rel.replace(/\\/g, "/")}) ---\n${hits.join("\n")}`)
    }
    return out
  } catch {
    /* rg 不可用或失败 → 回退 JS */
  }

  // JS 兜底
  const q = query.toLowerCase()
  const out: string[] = []
  for (const f of files) {
    try {
      const content = await fs.readFile(f, "utf-8")
      if (!content.toLowerCase().includes(q)) continue
      const rel = path.relative(base, f).replace(/\\/g, "/")
      const id = idFromFile(path.basename(f)) ?? ""
      const hits = content
        .split("\n")
        .map((l, i) => (l.toLowerCase().includes(q) ? `${i + 1}: ${l.trim().slice(0, 120)}` : null))
        .filter(Boolean)
      out.push(`--- ${id} (${rel}) ---\n${hits.join("\n")}`)
    } catch {
      /* 忽略不可读 */
    }
  }
  return out
}

export const server: Plugin = async () => {
  return {
    tool: {
      md_create: tool({
        description: "新建一条 Markdown 记忆，返回 id。",
        args: {
          name: tool.schema.string().describe("文件名 slug（不含 / \\ :）"),
          content: tool.schema.string().describe("Markdown 正文"),
          scope: tool.schema.string().optional().describe("all-modules 或模块名（省略默认根目录）"),
        },
        async execute(args, context) {
          try {
            if (args.scope === "all-modules") {
              return `[错误] scope=all-modules 不适用于 md_create（需指定具体模块或省略）。`
            }
            if (args.name.includes("/") || args.name.includes("\\") || args.name.includes(":")) {
              return `[错误] name 不允许包含 / \\ 或 :：${args.name}`
            }
            const scopeDir = scopeLabel(args.scope)
            const id = await allocateId(context.directory, args.name, scopeDir)
            const target = scopeDir
              ? path.join(memoryRoot(context.directory), scopeDir, `${id}-${args.name}.md`)
              : path.join(memoryRoot(context.directory), `${id}-${args.name}.md`)
            await fs.writeFile(target, args.content, "utf-8")
            return `已创建 ${id}（${scopeDir ? scopeDir + "/" : ""}${id}-${args.name}.md）`
          } catch (e) {
            return `[错误] ${(e as Error).message}`
          }
        },
      }),

      md_read: tool({
        description: "按 id 读取记忆，并记录为已读。",
        args: {
          id: tool.schema.string().describe("记忆 id，如 mdm_3"),
        },
        async execute(args, context) {
          try {
            const abs = await locateById(context.directory, args.id)
            if (!abs) return `[错误] 未找到 id=${args.id}`
            const content = await fs.readFile(abs, "utf-8")
            readSet.add(args.id)
            if (readSet.size > MAX_READ_SET) {
              const half = [...readSet].slice(0, Math.floor(readSet.size / 2))
              for (const id of half) readSet.delete(id)
            }
            return content
          } catch (e) {
            return `[错误] ${(e as Error).message}`
          }
        },
      }),

      md_update: tool({
        description: "按 id 更新已有记忆。需先 md_read 该 id。",
        args: {
          id: tool.schema.string().describe("记忆 id，如 mdm_3"),
          content: tool.schema.string().describe("新的 Markdown 正文"),
        },
        async execute(args, context) {
          try {
            if (!readSet.has(args.id)) {
              return `[门禁拒绝] 未先读取 id=${args.id}。请先调用 md_read 读取后再更新。`
            }
            const abs = await locateById(context.directory, args.id)
            if (!abs) return `[错误] 未找到 id=${args.id}`
            await fs.writeFile(abs, args.content, "utf-8")
            return `已更新 ${args.id}`
          } catch (e) {
            return `[错误] ${(e as Error).message}`
          }
        },
      }),

      md_delete: tool({
        description: "按 id 删除记忆。需先 md_read 该 id。",
        args: {
          id: tool.schema.string().describe("记忆 id，如 mdm_3"),
        },
        async execute(args, context) {
          try {
            if (!readSet.has(args.id)) {
              return `[门禁拒绝] 未先读取 id=${args.id}。请先调用 md_read 读取后再删除。`
            }
            const abs = await locateById(context.directory, args.id)
            if (!abs) return `[错误] 未找到 id=${args.id}`
            await fs.unlink(abs)
            readSet.delete(args.id)
            return `已删除 ${args.id}`
          } catch (e) {
            return `[错误] ${(e as Error).message}`
          }
        },
      }),

      md_list: tool({
        description: "列出记忆文件。",
        args: {
          scope: tool.schema.string().optional().describe("all-modules 或模块名（省略默认根目录）"),
        },
        async execute(args, context) {
          try {
            const files = await collectMd(context.directory, args.scope)
            if (!files.length) return "(空)"
            return files
              .map((f) => {
                const id = idFromFile(path.basename(f))
                const rel = path.relative(memoryRoot(context.directory), f).replace(/\\/g, "/")
                return id ? `${id}  ${rel}` : rel
              })
              .join("\n")
          } catch (e) {
            return `[错误] ${(e as Error).message}`
          }
        },
      }),

      md_search: tool({
        description: "全文搜索记忆内容。",
        args: {
          query: tool.schema.string().describe("搜索关键词"),
          scope: tool.schema.string().optional().describe("all-modules 或模块名（省略默认根目录）"),
        },
        async execute(args, context) {
          try {
            const results = await runSearch(context.directory, args.scope, args.query)
            return results.length ? results.join("\n\n") : "(无匹配)"
          } catch (e) {
            return `[错误] ${(e as Error).message}`
          }
        },
      }),
    },
  }
}

export default server