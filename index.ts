import { type Plugin, tool } from "@opencode-ai/plugin"
import { promises as fs } from "fs"
import * as path from "path"
import * as os from "os"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

/**
 * opencode-md-memory — Lightweight memory system based on local Markdown files.
 *
 * - Storage root: <current project directory>/.memory/ by default, or a fixed path via `storageRoot`
 * - ID-based: short ids (mdm_<n>) embedded at the start of filenames, parsed from filenames — no index mapping
 * - scope: omitted → root; all-modules → root + all modules (list/search only); <module> → that module's directory
 * - Read set: md_update / md_delete require the id to have been loaded via md_read, preventing changes to unseen content
 * - search: rg first, falls back to JS string matching
 */

/** Plugin options — set via ["opencode-md-memory", { ... }] in opencode.json */
interface MdMemoryOptions {
  /** Directory name under the project root (default ".memory") */
  storageName?: string
  /** Fixed absolute path for storage. When set, overrides the project-relative default */
  storageRoot?: string
  /** Id prefix for memory files (default "mdm_") */
  idPrefix?: string
  /** Max entries in the read-set (default 200) */
  maxReadSet?: number
  /** Enable semantic search via md_search_similar (requires optional deps). Default false */
  semanticSearch?: boolean
  /** Embedding model id for semantic search. Default cached all-MiniLM-L6-v2 */
  semanticModel?: string
  /** Top-k results for semantic search (default 5) */
  semanticTopK?: number
}

interface ResolvedConfig {
  storageName: string
  storageRoot?: string
  idPrefix: string
  maxReadSet: number
  semanticSearch: boolean
  semanticModel: string
  semanticTopK: number
}

const readSet = new Set<string>()

/** Add an id to the read set, evicting the oldest half when it exceeds the configured cap */
function addToReadSet(id: string, max: number): void {
  readSet.add(id)
  if (readSet.size > max) {
    const half = [...readSet].slice(0, Math.floor(readSet.size / 2))
    for (const old of half) readSet.delete(old)
  }
}

/** Serialize counter read-modify-write so concurrent md_create calls never read the same next id */
let idLock: Promise<unknown> = Promise.resolve()
function withIdLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = idLock
  let release: (value?: unknown) => void
  idLock = new Promise((r) => (release = r))
  return prev.then(fn).finally(() => release())
}

const META_FILE = "meta.json"
const META_NEXT_KEY = "next_id"

function resolveConfig(options: MdMemoryOptions): ResolvedConfig {
  const storageName = options.storageName?.replace(/[\\/]+$/, "") ?? ".memory"
  if (!storageName) throw new Error("[config] storageName must not be empty")
  let storageRoot = options.storageRoot
  if (storageRoot && storageRoot.startsWith("~/")) {
    storageRoot = path.join(os.homedir(), storageRoot.slice(2))
  }
  return {
    storageName,
    storageRoot,
    idPrefix: options.idPrefix ?? "mdm_",
    maxReadSet: options.maxReadSet ?? 200,
    semanticSearch: options.semanticSearch ?? false,
    semanticModel: options.semanticModel ?? "Xenova/all-MiniLM-L6-v2",
    semanticTopK: options.semanticTopK ?? 5,
  }
}

/** Absolute path of the memory root (fixed path if configured, else under project root) */
function memoryRoot(root: string, config: ResolvedConfig): string {
  return config.storageRoot ?? path.join(root, config.storageName)
}

/** Validate scope: only omitted (undefined → root) or a single-level module name; all-modules is list/search only */
function scopeLabel(scope?: string): string | null {
  if (!scope) return null
  if (scope === "all-modules") return null
  if (scope.includes("/") || scope.includes("\\") || scope.includes(":")) {
    throw new Error(`invalid scope ${scope}: only a single-level module name is allowed`)
  }
  return scope
}

/** Read the counter (initialized to 1 if missing) */
async function readMeta(root: string, config: ResolvedConfig): Promise<{ nextId: number }> {
  const metaPath = path.join(memoryRoot(root, config), META_FILE)
  try {
    const raw = await fs.readFile(metaPath, "utf-8")
    const data = JSON.parse(raw)
    return { nextId: typeof data[META_NEXT_KEY] === "number" ? data[META_NEXT_KEY] : 1 }
  } catch {
    return { nextId: 1 }
  }
}

/** Write back the counter (atomic: temp file + rename, ensuring the directory exists) */
async function writeMeta(root: string, config: ResolvedConfig, nextId: number): Promise<void> {
  const base = memoryRoot(root, config)
  await fs.mkdir(base, { recursive: true })
  const metaPath = path.join(base, META_FILE)
  const tmpPath = metaPath + ".tmp"
  await fs.writeFile(tmpPath, JSON.stringify({ [META_NEXT_KEY]: nextId }, null, 2), "utf-8")
  await fs.rename(tmpPath, metaPath)
}

/** List all first-level directory names (module scopes) under the memory root, excluding the root itself */
async function listScopes(root: string, config: ResolvedConfig): Promise<string[]> {
  const base = memoryRoot(root, config)
  const out: string[] = []
  try {
    const entries = await fs.readdir(base, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) out.push(e.name)
    }
  } catch {
    /* directory does not exist */
  }
  return out
}

/** Collect all .md file paths under the given scope (excluding meta.json). See scopeLabel */
async function collectMd(root: string, config: ResolvedConfig, scope?: string): Promise<string[]> {
  const base = memoryRoot(root, config)
  const dirs: string[] = []
  const rootScope = scopeLabel(scope)
  if (rootScope === null) {
    // root (omitted or all-modules both include root)
    dirs.push(base)
  }
  if (scope === "all-modules") {
    // add all module directories
    for (const s of await listScopes(root, config)) dirs.push(path.join(base, s))
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

/** Parse an id from a filename (mdm_<n>-<slug>.md → mdm_<n>) */
function idFromFile(name: string, idPrefix: string): string | null {
  const dash = name.indexOf("-")
  if (dash <= 0) return null
  const prefix = name.slice(0, dash)
  return prefix.startsWith(idPrefix) ? prefix : null
}

/** Global lookup: given an id, find <id>-*.md across root and all module dirs */
async function locateById(root: string, config: ResolvedConfig, id: string): Promise<string | null> {
  const base = memoryRoot(root, config)
  const dirs = [base]
  for (const s of await listScopes(root, config)) dirs.push(path.join(base, s))
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

/** Generate the next unique id, incrementing on filename conflicts (covers externally reset counters). Serialized via idLock to stay safe under concurrent md_create calls. */
function allocateId(root: string, config: ResolvedConfig, slug: string, scopeDir: string | null): Promise<string> {
  return withIdLock(async () => {
    await fs.mkdir(scopeDir ? path.join(memoryRoot(root, config), scopeDir) : memoryRoot(root, config), {
      recursive: true,
    })
    const meta = await readMeta(root, config)
    let n = meta.nextId
    let id = ""
    for (;;) {
      id = `${config.idPrefix}${n}`
      const target = scopeDir
        ? path.join(memoryRoot(root, config), scopeDir, `${id}-${slug}.md`)
        : path.join(memoryRoot(root, config), `${id}-${slug}.md`)
      try {
        await fs.access(target)
        n += 1 // conflict, keep incrementing (covers externally reset counter)
      } catch {
        break
      }
    }
    await writeMeta(root, config, n + 1)
    return id
  })
}

/** rg search (rg first, falls back to JS string matching) */
async function runSearch(root: string, config: ResolvedConfig, scope: string | undefined, query: string): Promise<string[]> {
  const base = memoryRoot(root, config)
  const files = await collectMd(root, config, scope)
  if (!files.length) return []

  // prefer rg (-F literal matching, matching the JS fallback semantics below)
  try {
    const rels = files.map((f) => path.relative(base, f))
    const { stdout } = await execFileAsync(
      "rg",
      ["-i", "-n", "-F", "--no-heading", "--color", "never", "--with-filename", "-e", query, ...rels],
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
      const id = idFromFile(path.basename(rel), config.idPrefix) ?? ""
      out.push(`--- ${id} (${rel.replace(/\\/g, "/")}) ---\n${hits.join("\n")}`)
    }
    return out
  } catch {
    /* rg unavailable or failed → fall back to JS */
  }

  // JS fallback
  const q = query.toLowerCase()
  const out: string[] = []
  for (const f of files) {
    try {
      const content = await fs.readFile(f, "utf-8")
      if (!content.toLowerCase().includes(q)) continue
      const rel = path.relative(base, f).replace(/\\/g, "/")
      const id = idFromFile(path.basename(f), config.idPrefix) ?? ""
      const hits = content
        .split("\n")
        .map((l, i) => (l.toLowerCase().includes(q) ? `${i + 1}: ${l.trim().slice(0, 120)}` : null))
        .filter(Boolean)
      out.push(`--- ${id} (${rel}) ---\n${hits.join("\n")}`)
    } catch {
      /* ignore unreadable files */
    }
  }
  return out
}

// --- Semantic search (optional, requires @huggingface/transformers + onnxruntime-node) ---

interface Embedder {
  embed(text: string): Promise<number[]>
  embedMany(texts: string[]): Promise<number[][]>
}

interface LoadResult {
  ok: true
  embedder: Embedder
  reason?: never
}
interface LoadFailure {
  ok: false
  reason: "deps" | "model"
}

let embedderState: { modelId: string; promise: Promise<LoadResult | LoadFailure> } | null = null

/** Lazily load the embedding pipeline. Distinguishes missing deps from model-load failures; failures are not cached so later calls retry. */
function getEmbedder(modelId: string): Promise<LoadResult | LoadFailure> {
  if (embedderState && embedderState.modelId === modelId) return embedderState.promise
  const promise = (async (): Promise<LoadResult | LoadFailure> => {
    try {
      const { pipeline, env } = await import("@huggingface/transformers")
      env.allowRemoteModels = true
      const pipe = await pipeline("feature-extraction", modelId)
      return {
        ok: true,
        embedder: {
          async embed(text: string): Promise<number[]> {
            const out = await pipe(text, { pooling: "mean", normalize: true })
            return Array.from(out.data as Float32Array)
          },
          async embedMany(texts: string[]): Promise<number[][]> {
            const out = await pipe(texts, { pooling: "mean", normalize: true })
            const data = out.data as Float32Array
            const dims = (out.dims as number[])[out.dims.length - 1]
            const result: number[][] = []
            for (let i = 0; i < texts.length; i++) {
              result.push(Array.from(data.subarray(i * dims, (i + 1) * dims)))
            }
            return result
          },
        },
      }
    } catch (e) {
      // Missing import => deps not installed; any other throw (fetch, model parse) => model unavailable.
      const code = (e as { code?: string })?.code
      return { ok: false, reason: code === "ERR_MODULE_NOT_FOUND" ? "deps" : "model" }
    }
  })()
  embedderState = { modelId, promise }
  return promise
}

/** Cosine similarity between two vectors (both assumed normalized or not; we normalize inline) */
function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** In-memory doc-vector cache keyed by file path + mtime, avoiding re-embedding unchanged files. */
const semanticCache = new Map<string, number[]>()

/** Embed all docs (batched), caching by path+mtime. Content beyond the model's token window (MiniLM: 512 tokens) is not represented. */
async function embedDocs(
  embedder: Embedder,
  files: { path: string; mtimeMs: number; content: string }[]
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  const byKey = new Map<string, { path: string; content: string }>()
  const todoKeys: string[] = []
  for (const f of files) {
    const key = `${f.path}:${f.mtimeMs}`
    const cached = semanticCache.get(key)
    if (cached) {
      out.set(f.path, cached)
    } else {
      byKey.set(key, { path: f.path, content: f.content })
      todoKeys.push(key)
    }
  }
  if (todoKeys.length) {
    const todo = todoKeys.map((k) => byKey.get(k)!.content)
    const vecs = await embedder.embedMany(todo)
    for (let i = 0; i < vecs.length; i++) {
      const key = todoKeys[i]
      const entry = byKey.get(key)!
      semanticCache.set(key, vecs[i])
      out.set(entry.path, vecs[i])
    }
    if (semanticCache.size > 5000) semanticCache.clear()
  }
  return out
}

/** Semantic search across memories; returns top-k scored entries. Returns a hint string when embedding deps are unavailable. */
async function runSemanticSearch(
  root: string,
  config: ResolvedConfig,
  scope: string | undefined,
  query: string,
  topK: number,
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void
): Promise<string[] | string> {
  const files = await collectMd(root, config, scope)
  if (!files.length) return []
  const loaded = await getEmbedder(config.semanticModel)
  if (!loaded.ok) {
    const message =
      loaded.reason === "deps"
        ? "[warning] semantic search unavailable: @huggingface/transformers not installed. Run: npm i @huggingface/transformers onnxruntime-node"
        : `[warning] semantic search unavailable: embedding model "${config.semanticModel}" could not be loaded. Check network or configure semanticModel.`
    log("warn", message.replace(/^\[warning\] /, ""), { reason: loaded.reason })
    return message
  }
  const embedder = loaded.embedder

  const docs: { path: string; mtimeMs: number; content: string }[] = []
  for (const f of files) {
    try {
      const st = await fs.stat(f)
      const content = await fs.readFile(f, "utf-8")
      docs.push({ path: f, mtimeMs: st.mtimeMs, content: content.slice(0, 8000) })
    } catch {
      /* skip unreadable */
    }
  }
  if (!docs.length) return []

  const k = Math.max(1, Math.floor(topK))
  const qVec = await embedder.embed(query)
  const docVecs = await embedDocs(embedder, docs)
  const scored: { id: string; rel: string; score: number }[] = []
  for (const d of docs) {
    const vec = docVecs.get(d.path)
    if (!vec) continue
    const score = cosine(qVec, vec)
    const id = idFromFile(path.basename(d.path), config.idPrefix) ?? ""
    const rel = path.relative(memoryRoot(root, config), d.path).replace(/\\/g, "/")
    scored.push({ id, rel, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map((s) => `${s.id}  ${s.rel}  (${s.score.toFixed(3)})`)
}

export const server: Plugin = async (input, options: MdMemoryOptions = {}) => {
  const config = resolveConfig(options)
  const { idPrefix } = config

  /** Log an event to the opencode log (debug level so routine operations stay quiet), swallowing failures. */
  const log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    try {
      void input.client.app.log({
        body: { service: "opencode-md-memory", level, message, extra },
      })
    } catch {
      /* logging is best-effort */
    }
  }

  return {
    tool: {
      md_create: tool({
        description: "Create a new Markdown memory and return its id.",
        args: {
          name: tool.schema.string().describe("Filename slug (no / \\ :)"),
          content: tool.schema.string().describe("Markdown body"),
          scope: tool.schema.string().optional().describe("all-modules or a module name (omit for root)"),
        },
        async execute(args, context) {
          try {
            if (args.scope === "all-modules") {
              return `[error] scope=all-modules does not apply to md_create (specify a concrete module or omit).`
            }
            if (args.name.includes("/") || args.name.includes("\\") || args.name.includes(":")) {
              return `[error] name must not contain / \\ or :${args.name}`
            }
            if (!args.name.trim()) {
              return `[error] name must not be empty.`
            }
            const scopeDir = scopeLabel(args.scope)
            const id = await allocateId(context.directory, config, args.name, scopeDir)
            const target = scopeDir
              ? path.join(memoryRoot(context.directory, config), scopeDir, `${id}-${args.name}.md`)
              : path.join(memoryRoot(context.directory, config), `${id}-${args.name}.md`)
            await fs.writeFile(target, args.content, "utf-8")
            addToReadSet(id, config.maxReadSet)
            return `created ${id} (${scopeDir ? scopeDir + "/" : ""}${id}-${args.name}.md)`
          } catch (e) {
            return `[error] ${(e as Error).message}`
          }
        },
      }),

      md_read: tool({
        description: "Read a memory by id.",
        args: {
          id: tool.schema.string().describe("Memory id, e.g. mdm_3"),
        },
        async execute(args, context) {
          try {
            const abs = await locateById(context.directory, config, args.id)
            if (!abs) return `[error] id=${args.id} not found`
            const content = await fs.readFile(abs, "utf-8")
            addToReadSet(args.id, config.maxReadSet)
            return content
          } catch (e) {
            return `[error] ${(e as Error).message}`
          }
        },
      }),

      md_update: tool({
        description: "Overwrite a memory by id with new content.",
        args: {
          id: tool.schema.string().describe("Memory id, e.g. mdm_3"),
          content: tool.schema.string().describe("New Markdown body"),
        },
        async execute(args, context) {
          try {
            if (!readSet.has(args.id)) {
              log("warn", `md_update gate denied for ${args.id} (not in read set)`)
              return `[gate] id=${args.id} is not in the read set. Use md_read first to load it, then update.`
            }
            const abs = await locateById(context.directory, config, args.id)
            if (!abs) return `[error] id=${args.id} not found`
            await fs.writeFile(abs, args.content, "utf-8")
            return `updated ${args.id}`
          } catch (e) {
            log("error", `md_update failed: ${(e as Error).message}`)
            return `[error] ${(e as Error).message}`
          }
        },
      }),

      md_delete: tool({
        description: "Delete a memory by id.",
        args: {
          id: tool.schema.string().describe("Memory id, e.g. mdm_3"),
        },
        async execute(args, context) {
          try {
            if (!readSet.has(args.id)) {
              log("warn", `md_delete gate denied for ${args.id} (not in read set)`)
              return `[gate] id=${args.id} is not in the read set. Use md_read first to load it, then delete.`
            }
            const abs = await locateById(context.directory, config, args.id)
            if (!abs) return `[error] id=${args.id} not found`
            await fs.unlink(abs)
            readSet.delete(args.id)
            return `deleted ${args.id}`
          } catch (e) {
            log("error", `md_delete failed: ${(e as Error).message}`)
            return `[error] ${(e as Error).message}`
          }
        },
      }),

      md_list: tool({
        description: "List memory files.",
        args: {
          scope: tool.schema.string().optional().describe("all-modules or a module name (omit for root)"),
        },
        async execute(args, context) {
          try {
            const files = await collectMd(context.directory, config, args.scope)
            if (!files.length) return "(empty)"
            return files
              .map((f) => {
                const id = idFromFile(path.basename(f), idPrefix)
                const rel = path.relative(memoryRoot(context.directory, config), f).replace(/\\/g, "/")
                return id ? `${id}  ${rel}` : rel
              })
              .join("\n")
          } catch (e) {
            return `[error] ${(e as Error).message}`
          }
        },
      }),

      md_search: tool({
        description: "Full-text search across memory content.",
        args: {
          query: tool.schema.string().describe("Search keyword"),
          scope: tool.schema.string().optional().describe("all-modules or a module name (omit for root)"),
        },
        async execute(args, context) {
          try {
            const results = await runSearch(context.directory, config, args.scope, args.query)
            return results.length ? results.join("\n\n") : "(no match)"
          } catch (e) {
            return `[error] ${(e as Error).message}`
          }
        },
      }),

      ...(config.semanticSearch
        ? {
            md_search_similar: tool({
              description:
                "Semantic search across memory content. Finds memories related in meaning to the query. Requires optional embedding deps; returns a message if unavailable.",
              args: {
                query: tool.schema.string().describe("Semantic query"),
                scope: tool.schema.string().optional().describe("all-modules or a module name (omit for root)"),
                topK: tool.schema.number().optional().describe("Results count (default from config)"),
              },
              async execute(args, context) {
                try {
                  const topK = args.topK ?? config.semanticTopK
                  const results = await runSemanticSearch(context.directory, config, args.scope, args.query, topK, log)
                  if (typeof results === "string") return results
                  if (!results.length) return "(no match)"
                  return results.join("\n")
                } catch (e) {
                  log("error", `md_search_similar failed: ${(e as Error).message}`)
                  return `[error] ${(e as Error).message}`
                }
              },
            }),
          }
        : {}),
    },
  }
}

export default server