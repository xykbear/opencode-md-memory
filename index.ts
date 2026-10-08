import { type Plugin, tool } from "@opencode-ai/plugin"
import { promises as fs } from "fs"
import * as path from "path"
import * as os from "os"
import { execFile, spawn } from "child_process"
import { promisify } from "util"
import { fileURLToPath } from "url"

const execFileAsync = promisify(execFile)

/**
 * opencode-md-memory — Lightweight memory system based on local Markdown files.
 *
 * - Storage root: <current project directory>/.memory/ by default, or a fixed path via `storageRoot`
 * - ID-based: short ids (mdm_<n>) embedded at the start of filenames, parsed from filenames — no index mapping
 * - scope: omitted → root; all-modules → root + all modules (list/search only); <module> → that module's directory
 * - Read set: md_update / md_delete require the id to have been loaded via md_read, preventing changes to unseen content
 * - search: rg first, falls back to JS string matching
 * - Semantic injector (optional): embeds id + semantic title (first H1 heading of the content, filename
 *   slug as fallback) of each memory into `.memory/.index/`, and on every user message matches it against
 *   the index via an embedding backend (python or remote), injecting a <memory_reference> block as context
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
  /** Inject matching memory references into chat via the chat.message hook (requires optional deps). Default false */
  injectorEnabled?: boolean
  /** Embedding backend — how the OpenAI-compatible embeddings service is provided:
   *  "builtin" (plugin-managed local service; self-contained model) or
   *  "endpoint" (any external OpenAI-compatible service: llama.cpp / Ollama / TEI / LM Studio / OpenAI).
   *  Default "builtin". */
  embeddingBackend?: "builtin" | "endpoint"
  /** Embedding model id / local model name (default "embeddinggemma-2") */
  embeddingModel?: string
  /** Base URL for an "endpoint" backend, e.g. http://127.0.0.1:8080/v1 or https://api.openai.com/v1 */
  embeddingBaseUrl?: string
  /** API key for an "endpoint" backend. Supports {env:VAR} to read from environment */
  embeddingApiKey?: string
  /** Top-k references injected per message (default 3) */
  injectorTopK?: number
  /** Minimum message length (chars) to trigger injection (default 10) */
  injectorMinLen?: number
  /** Max injections per session, preventing context bloat (default 5) */
  injectorMaxPerSession?: number
}

interface ResolvedConfig {
  storageName: string
  storageRoot?: string
  idPrefix: string
  maxReadSet: number
  injectorEnabled: boolean
  embeddingBackend: "builtin" | "endpoint"
  embeddingModel: string
  embeddingBaseUrl?: string
  embeddingApiKey?: string
  injectorTopK: number
  injectorMinLen: number
  injectorMaxPerSession: number
}

/** Logging signature used by the plugin and the injector */
type LogFn = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void

/** Module-level log forwarder for the embeddings service's stdout; wired to app.log by the server factory */
let clientLog: LogFn | null = null

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
    injectorEnabled: options.injectorEnabled ?? false,
    embeddingBackend: options.embeddingBackend ?? "builtin",
    embeddingModel: options.embeddingModel ?? "embeddinggemma-2",
    embeddingBaseUrl: options.embeddingBaseUrl?.replace(/\/+$/, ""),
    embeddingApiKey: options.embeddingApiKey,
    injectorTopK: options.injectorTopK ?? 3,
    injectorMinLen: options.injectorMinLen ?? 10,
    injectorMaxPerSession: options.injectorMaxPerSession ?? 5,
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

/** Ensure the memory root exists and carries a `.gitignore` that ignores the vector cache (`.index/`). Memory `.md` files stay tracked while the embedding index cache does not. */
async function ensureMemoryRoot(root: string, config: ResolvedConfig): Promise<void> {
  const base = memoryRoot(root, config)
  await fs.mkdir(base, { recursive: true })
  const gitignore = path.join(base, ".gitignore")
  try {
    await fs.access(gitignore)
  } catch {
    await fs.writeFile(gitignore, ".index/\n", "utf-8")
  }
}

/** Write back the counter (atomic: temp file + rename, ensuring the directory exists) */
async function writeMeta(root: string, config: ResolvedConfig, nextId: number): Promise<void> {
  await ensureMemoryRoot(root, config)
  const base = memoryRoot(root, config)
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

// --- Builtin embeddings service (spawn python/embed_server.py, call the OpenAI-compatible /v1 API) ---

interface Embedder {
  embed(text: string): Promise<number[]>
  embedMany(texts: string[]): Promise<number[][]>
  /** Identity of the embedding space (backend + model). Lets the index rebuild when the model
   *  changes — including dimension-preserving swaps (nomic-768 → embeddinggemma-2-768), where a
   *  dim-only check would silently mix vectors from two different spaces. */
  modelKey?: string
}

interface LoadResult {
  ok: true
  embedder: Embedder
  reason?: never
}
interface LoadFailure {
  ok: false
  reason: "deps" | "model" | "endpoint"
}

let embedderState: { key: string; promise: Promise<LoadResult | LoadFailure>; ok: boolean } | null = null
let lastLoadFailAt = 0
let lastLoadFailReason: LoadFailure["reason"] = "model"
const LOAD_FAIL_BACKOFF_MS = 30_000

/** Reset the cached embedder so the next getEmbedder() call re-probes instead of reusing stale state */
function resetEmbedder(): void {
  embedderState = null
}

/**
 * Wrap an embedder so a request failure self-heals: the cached load state is dropped and the
 * backend is rebuilt (builtin: respawn/reuse the local service; endpoint: re-create the client),
 * then the request is retried once. Without this a stale cached embedder keeps POSTing to a
 * dead port and every message of the session fails (2026-08-22 diagnosis).
 */
function makeSelfHealing(rebuild: () => Promise<Embedder>, initialModelKey?: string): Embedder {
  let current: Embedder | null = null
  const get = async (): Promise<Embedder> => {
    if (!current) current = await rebuild()
    return current
  }
  const retryable = async (texts: string[]): Promise<number[][]> => {
    try {
      return await (await get()).embedMany(texts)
    } catch (e) {
      current = null
      resetEmbedder()
      return await (await get()).embedMany(texts)
    }
  }
  return {
    async embed(text: string): Promise<number[]> {
      const [vec] = await retryable([text])
      return vec
    },
    async embedMany(texts: string[]): Promise<number[][]> {
      return retryable(texts)
    },
    get modelKey(): string | undefined {
      return current?.modelKey ?? initialModelKey
    },
  }
}

/** Resolve an apiKey that may be "{env:VAR}" or a plain secret, falling back to env var of the same name. */
function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return undefined
  const m = value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (m) return process.env[m[1]]
  if (value.startsWith("$")) return process.env[value.slice(1)]
  return value
}

// --- Python embed server (local backend: spawn python/embed_server.py, call over HTTP) ---

// 本地回环直连，绕过系统代理：嵌入服务死亡时即刻失败（~8ms ECONNREFUSED），
// 而非经代理等待 ~3s 超时（2026-08-22 诊断：死端口 + 系统代理 = 每条消息 +3s 且注入失效）。
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1"
process.env.NO_PROXY = [process.env.NO_PROXY, LOOPBACK_NO_PROXY].filter(Boolean).join(",")
process.env.no_proxy = [process.env.no_proxy, LOOPBACK_NO_PROXY].filter(Boolean).join(",")

const PYTHON = process.env.PYTHON || "python3"
const EMBED_SERVER_PORT = 48611
const PYTHON_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "python", "embed_server.py")
let pythonServer: ReturnType<typeof spawn> | null = null

/** Probe a running embeddings service's /health; returns its URL + reported model identity (or null). */
async function probeHealth(url: string): Promise<{ url: string; modelKey?: string } | null> {
  try {
    const res = await fetch(`${url}/health`)
    if (!res.ok) return null
    let modelKey: string | undefined
    try {
      const j = (await res.json()) as { model?: string }
      if (j?.model) modelKey = `builtin:${j.model}`
    } catch {
      /* some providers have no /health or a different shape */
    }
    return { url, modelKey }
  } catch {
    return null
  }
}

/** Ensure the bundled local service is running; returns its OpenAI base URL + model identity, or null. */
async function ensureBuiltinService(modelName: string): Promise<{ baseUrl: string; modelKey?: string } | null> {
  const url = `http://127.0.0.1:${EMBED_SERVER_PORT}`
  const running = await probeHealth(url)
  if (running) return { baseUrl: `${url}/v1`, modelKey: running.modelKey }
  pythonServer = spawn(PYTHON, [PYTHON_SCRIPT, "--port", String(EMBED_SERVER_PORT), "--model-name", modelName], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  pythonServer.unref?.() // 插件退出不阻塞；服务靠 idle-timeout 自回收
  pythonServer.stdout?.on("data", (d) => {
    const line = String(d).trim().slice(0, 300)
    if (!line) return
    // 服务 stdout 是正常日志（model loaded/listening/[embed] 计时），走 info 级，不能当错误输出
    try {
      if (clientLog) clientLog("info", `embeddings service: ${line}`)
      else console.log(`[opencode-md-memory] embeddings service: ${line}`)
    } catch {
      /* best-effort */
    }
  })
  pythonServer.stderr?.on("data", (d) => {
    console.error(`[opencode-md-memory] embeddings service stderr: ${String(d).trim().slice(0, 200)}`)
  })
  pythonServer.on("error", (e) => {
    // 端口被占（另一消费者已起服务）等：忽略，靠 health 探测复用
    console.error(`[opencode-md-memory] embeddings service spawn error: ${e.message}`)
  })
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200))
    const ready = await probeHealth(url)
    if (ready) return { baseUrl: `${url}/v1`, modelKey: ready.modelKey }
  }
  pythonServer?.kill()
  pythonServer = null
  return null
}

/**
 * Build an embedder over the OpenAI-compatible `POST {baseUrl}/embeddings` API. This is the ONE
 * client used by every backend (the builtin local service, llama.cpp, Ollama, TEI, LM Studio,
 * OpenAI) — so the plugin only ever depends on the generic interface, never a specific runtime.
 */
function buildOpenAIEmbedder(baseUrl: string, apiKey: string | undefined, model: string, modelKey?: string): Embedder {
  const url = `${baseUrl}/embeddings`
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const request = async (input: string | string[]): Promise<number[][]> => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input }),
    })
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as { data: { embedding: number[] }[] }
    return data.data.map((d) => d.embedding)
  }
  return {
    async embed(text: string): Promise<number[]> {
      const [v] = await request(text)
      return v
    },
    async embedMany(texts: string[]): Promise<number[][]> {
      return request(texts)
    },
    modelKey,
  }
}

/**
 * Lazily load the embedder for the configured backend. Only successful loads are cached; a
 * failure resets the cache so the next call re-probes (instead of caching a dead endpoint,
 * which would poison every message of the session). Self-healing retry is handled by the
 * embedder itself (see makeSelfHealing).
 */
function getEmbedder(config: ResolvedConfig): Promise<LoadResult | LoadFailure> {
  const key =
    config.embeddingBackend === "endpoint"
      ? `endpoint:${config.embeddingBaseUrl}:${config.embeddingModel}`
      : `builtin:${EMBED_SERVER_PORT}`
  if (embedderState && embedderState.key === key && embedderState.ok) return embedderState.promise
  // Backoff: a permanently-dead backend is re-probed at most once per window. Otherwise every
  // qualifying message would re-run the probe (builtin: up to 10s spawn wait; endpoint: a network
  // round-trip), slowing each message and spamming spawn attempts.
  if (Date.now() - lastLoadFailAt < LOAD_FAIL_BACKOFF_MS) {
    return Promise.resolve({ ok: false, reason: lastLoadFailReason })
  }
  const promise = (async (): Promise<LoadResult | LoadFailure> => {
    if (config.embeddingBackend === "endpoint") {
      if (!config.embeddingBaseUrl) return { ok: false, reason: "endpoint" }
      const baseUrl = config.embeddingBaseUrl
      const apiKey = resolveSecret(config.embeddingApiKey)
      const modelKey = `endpoint:${baseUrl}:${config.embeddingModel}`
      try {
        // Eager probe OUTSIDE makeSelfHealing: a single attempt. Running it through the retry
        // wrapper would double the probe work on a permanently-failing endpoint.
        await buildOpenAIEmbedder(baseUrl, apiKey, config.embeddingModel, modelKey).embed("ping")
        const embedder = makeSelfHealing(
          () => Promise.resolve(buildOpenAIEmbedder(baseUrl, apiKey, config.embeddingModel, modelKey)),
          modelKey
        )
        return { ok: true, embedder }
      } catch {
        return { ok: false, reason: "endpoint" }
      }
    }
    try {
      const service = await ensureBuiltinService(config.embeddingModel)
      if (!service) return { ok: false, reason: "model" }
      // 确认复用到的服务确实讲 OpenAI 协议（防旧版 /embed 服务占用端口 → 每条消息 404）
      await buildOpenAIEmbedder(service.baseUrl, undefined, config.embeddingModel, service.modelKey).embed("ping")
      const embedder = makeSelfHealing(async () => {
        const s2 = await ensureBuiltinService(config.embeddingModel)
        if (!s2) throw new Error("embeddings service unavailable")
        return buildOpenAIEmbedder(s2.baseUrl, undefined, config.embeddingModel, s2.modelKey)
      }, service.modelKey)
      return { ok: true, embedder }
    } catch (e) {
      console.error(`[opencode-md-memory] builtin embedder failed: ${(e as Error)?.message?.slice(0, 200)}`)
      return { ok: false, reason: "model" }
    }
  })()
  embedderState = { key, promise, ok: false }
  promise.then((r) => {
    if (r.ok) {
      embedderState = { key, promise, ok: true }
    } else {
      embedderState = null
      lastLoadFailAt = Date.now()
      lastLoadFailReason = r.reason
    }
  })
  return promise
}

/** Cosine similarity between two vectors (both assumed normalized or not; we normalize inline) */
function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
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

// --- Index persistence: `.memory/.index` stores id+title in `index.json` (small) and flat float32 vecs in `vectors.bin` ---

const INDEX_FILE = "index.json"
const VECTORS_FILE = "vectors.bin"

interface IndexEntry {
  id: string
  title: string
  vec: Float32Array
}

interface IndexData {
  dim: number
  /** Embedding-space identity the index was built with (absent on pre-model-switch indexes). */
  model?: string
  entries: IndexEntry[]
}

/** Serialize index read-modify-write so concurrent injections never build the same entries twice */
let indexLock: Promise<unknown> = Promise.resolve()
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = indexLock
  let release: (value?: unknown) => void
  indexLock = new Promise((r) => (release = r))
  return prev.then(fn).finally(() => release())
}

function indexDir(root: string, config: ResolvedConfig): string {
  return path.join(memoryRoot(root, config), ".index")
}

/** In-memory cache of the parsed index, keyed by the index dir, invalidated on mtime change (L1) */
let indexCache: { key: string; sig: string; data: IndexData } | null = null

async function readIndex(root: string, config: ResolvedConfig): Promise<IndexData | null> {
  const dir = indexDir(root, config)
  const metaFile = path.join(dir, INDEX_FILE)
  const vecFile = path.join(dir, VECTORS_FILE)
  try {
    const [mst, vst] = await Promise.all([fs.stat(metaFile), fs.stat(vecFile)])
    const sig = `${mst.mtimeMs}:${vst.mtimeMs}`
    if (indexCache && indexCache.key === dir && indexCache.sig === sig) return indexCache.data

    const meta = JSON.parse(await fs.readFile(metaFile, "utf-8")) as { dim?: number; model?: string; entries?: { id: string; title: string }[] }
    if (typeof meta.dim !== "number" || !Array.isArray(meta.entries)) return null
    const raw = await fs.readFile(vecFile)
    const vecs = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
    if (meta.entries.length * meta.dim !== vecs.length) return null
    const dim = meta.dim
    const entries: IndexEntry[] = meta.entries.map((e, i) => ({
      id: e.id,
      title: e.title,
      vec: vecs.slice(i * dim, (i + 1) * dim),
    }))
    const data: IndexData = { dim, model: typeof meta.model === "string" ? meta.model : undefined, entries }
    indexCache = { key: dir, sig, data }
    return data
  } catch {
    /* no index yet */
  }
  return null
}

/** Write back the index: `index.json` (id+title, small) + `vectors.bin` (flat float32), each atomic via temp file + rename */
async function writeIndex(root: string, config: ResolvedConfig, entries: IndexEntry[], model?: string): Promise<void> {
  await ensureMemoryRoot(root, config)
  const dir = indexDir(root, config)
  await fs.mkdir(dir, { recursive: true })

  const dim = entries.length ? entries[0].vec.length : 0
  const flat = new Float32Array(entries.length * dim)
  entries.forEach((e, i) => {
    if (e.vec.length !== dim) {
      // mixed dimensions would silently corrupt vectors.bin; fail loudly instead
      throw new Error(`index vector dimension mismatch: ${e.vec.length} != ${dim}`)
    }
    flat.set(e.vec, i * dim)
  })

  const meta = { dim, model, entries: entries.map((e) => ({ id: e.id, title: e.title })) }
  const metaFile = path.join(dir, INDEX_FILE)
  const vecFile = path.join(dir, VECTORS_FILE)

  await fs.writeFile(metaFile + ".tmp", JSON.stringify(meta), "utf-8")
  await fs.writeFile(vecFile + ".tmp", Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength))
  await fs.rename(metaFile + ".tmp", metaFile)
  await fs.rename(vecFile + ".tmp", vecFile)

  indexCache = null
}

/** Title from a filename (`id-<slug>.md` → `<slug>`); falls back to the basename when the id prefix doesn't match */
function titleFromFile(name: string, idPrefix: string): string {
  const id = idFromFile(name, idPrefix)
  if (!id) return name.replace(/\.md$/i, "")
  const rest = name.slice(id.length + 1).replace(/\.md$/i, "")
  return rest || name.replace(/\.md$/i, "")
}

/** Semantic title of a memory: the first `# H1` heading of the content, falling back to the filename slug when absent */
function extractTitle(content: string, name: string, idPrefix: string): string {
  let body = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n") // strip BOM, normalize CRLF
  const fm = body.match(/^---\n[\s\S]*?\n---\n?/) // skip a leading YAML frontmatter block
  if (fm) body = body.slice(fm[0].length)
  // `[ \t]` (not `\s`) so the space class can't cross a newline; allows CommonMark's ≤3-space indent
  const m = body.match(/^[ \t]{0,3}#[ \t]+([^\n]+?)[ \t]*#*[ \t]*$/m)
  if (m) {
    const title = m[1].trim()
    if (title) return title
  }
  return titleFromFile(name, idPrefix)
}

/**
 * Bring the persisted index in sync with the current `.memory/` files (incremental):
 * new files are embedded and appended, files that no longer exist are dropped,
 * renamed files (changed title) are re-embedded. Returns the entry map.
 */
let titleCache: { key: string; entries: Map<string, { mtimeMs: number; size: number; title: string }> } | null = null

async function syncIndex(root: string, config: ResolvedConfig, embedder: Embedder): Promise<Map<string, IndexEntry>> {
  return withIndexLock(async () => {
    const files = await collectMd(root, config, "all-modules")
    const cacheKey = `${root}:${config.idPrefix}:${config.storageName ?? ""}`
    const prevTitleCache = titleCache?.key === cacheKey ? titleCache.entries : null
    const current = new Map<string, string>()
    const newTitleCache = new Map<string, { mtimeMs: number; size: number; title: string }>()
    for (const f of files) {
      const id = idFromFile(path.basename(f), config.idPrefix)
      if (!id) continue
      let title = titleFromFile(path.basename(f), config.idPrefix)
      try {
        const st = await fs.stat(f)
        const cached = prevTitleCache?.get(f)
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          title = cached.title
        } else {
          title = extractTitle(await fs.readFile(f, "utf-8"), path.basename(f), config.idPrefix)
        }
        newTitleCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, title })
      } catch {
        /* unreadable → keep the filename-derived fallback */
      }
      current.set(id, title)
    }
    titleCache = { key: cacheKey, entries: newTitleCache }

    const entries = new Map<string, IndexEntry>()
    const prev = await readIndex(root, config)
    if (prev) for (const e of prev.entries) entries.set(e.id, e)
    for (const id of [...entries.keys()]) if (!current.has(id)) entries.delete(id)

    // Embedding-space identity: rebuild if the model changed — including dimension-preserving
    // swaps (nomic-768 → embeddinggemma-2-768), where a dim-only check would mix vector spaces.
    // Pre-existing indexes have no `model` field → treated as changed → one-time rebuild.
    const modelKey = embedder.modelKey
    const modelChanged = !!modelKey && prev?.model !== modelKey

    const toEmbed: { id: string; title: string }[] = []
    for (const [id, title] of current) {
      const ex = entries.get(id)
      if (modelChanged || !ex || ex.title !== title) toEmbed.push({ id, title })
    }
    if (toEmbed.length) {
      const texts = toEmbed.map((e) => `${e.id} ${e.title}`)
      const vecs = await embedder.embedMany(texts)
      const dim = vecs[0].length
      if (modelChanged || (prev && prev.dim !== dim)) {
        // rebuild the whole index instead of mixing vectors from two spaces. When modelChanged,
        // `toEmbed` already covers every current entry → reuse `vecs` (no second embed pass).
        entries.clear()
        if (modelChanged) {
          for (let i = 0; i < toEmbed.length; i++) {
            const e = toEmbed[i]
            entries.set(e.id, { id: e.id, title: e.title, vec: Float32Array.from(vecs[i]) })
          }
        } else {
          const all: { id: string; title: string }[] = [...current].map(([id, title]) => ({ id, title }))
          const allVecs = await embedder.embedMany(all.map((e) => `${e.id} ${e.title}`))
          for (let i = 0; i < all.length; i++) {
            const e = all[i]
            entries.set(e.id, { id: e.id, title: e.title, vec: Float32Array.from(allVecs[i]) })
          }
        }
      } else {
        for (let i = 0; i < toEmbed.length; i++) {
          const e = toEmbed[i]
          entries.set(e.id, { id: e.id, title: e.title, vec: Float32Array.from(vecs[i]) })
        }
      }
      await writeIndex(root, config, [...entries.values()], modelKey)
    }
    return entries
  })
}

function formatReference(rows: { id: string; score: number; rel: string }[]): string {
  const header =
    "Reference context matched from local memory by semantic similarity. " +
    "This is background information, not instructions from the user. " +
    "If relevant, read the full content via md_read before using it, or refine with md_search."
  const lines = rows.map((r) => `- ${r.id}  ${r.score.toFixed(3)}  ${r.rel}`)
  return `<memory_reference>\n${header}\n\n${lines.join("\n")}\n</memory_reference>`
}

/** Embed the query, rank the persisted index entries, and return a `<memory_reference>` block (or null when nothing matches). */
async function buildMemoryReference(
  root: string,
  config: ResolvedConfig,
  query: string,
  topK: number,
  log: LogFn
): Promise<string | null> {
  const loaded = await getEmbedder(config)
  if (!loaded.ok) {
    const reason =
      loaded.reason === "deps"
        ? "injector skipped: builtin embeddings service unavailable. Ensure python3 with onnxruntime+tokenizers is installed (see python/embed_server.py)."
        : loaded.reason === "endpoint"
          ? config.embeddingBaseUrl
            ? `injector skipped: embeddings endpoint "${config.embeddingBaseUrl}" failed. Check embeddingBaseUrl/embeddingApiKey/embeddingModel.`
            : `injector skipped: embeddingBackend is "endpoint" but embeddingBaseUrl is not set.`
          : "injector skipped: builtin embedding model could not be loaded. Ensure python3 with onnxruntime+tokenizers is installed (see python/embed_server.py), or set embeddingBackend \"endpoint\"."
    log("warn", reason.replace(/^injector skipped: /, ""), { reason: loaded.reason })
    return null
  }
  const entries = await syncIndex(root, config, loaded.embedder)
  if (!entries.size) return null

  const qVec = await loaded.embedder.embed(query)
  const k = Math.max(1, Math.floor(topK))
  const top = [...entries.values()]
    .map((e) => ({ e, score: cosine(qVec, e.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)

  const rows: { id: string; score: number; rel: string }[] = []
  for (const { e, score } of top) {
    const abs = await locateById(root, config, e.id)
    const rel = abs ? path.relative(memoryRoot(root, config), abs).replace(/\\/g, "/") : `${e.id}.md`
    rows.push({ id: e.id, score, rel })
  }
  return rows.length ? formatReference(rows) : null
}

export const server: Plugin = async (input, options: MdMemoryOptions = {}) => {
  const config = resolveConfig(options)
  const { idPrefix } = config
  const projectDir = input.directory

  /** Log an event to the opencode log (debug level so routine operations stay quiet), swallowing failures. */
  const log: LogFn = (level, message, extra) => {
    try {
      void input.client.app.log({
        body: { service: "opencode-md-memory", level, message, extra },
      })
    } catch {
      /* logging is best-effort */
    }
  }
  clientLog = log

  /** Per-session injection counter so a session never receives more than injectorMaxPerSession references */
  const injectorCounts = new Map<string, number>()

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
    },
    "chat.message": async (hookInput, hookOutput) => {
      if (!config.injectorEnabled) return
      try {
        const text = hookOutput.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join("\n")
          .trim()
        if (text.length < config.injectorMinLen) return
        const used = injectorCounts.get(hookInput.sessionID) ?? 0
        if (used >= config.injectorMaxPerSession) return
        const reference = await buildMemoryReference(projectDir, config, text, config.injectorTopK, log)
        if (!reference) return
        injectorCounts.set(hookInput.sessionID, used + 1)
        hookOutput.parts.unshift({
          id: `prt-md-memory-${Date.now()}`,
          sessionID: hookInput.sessionID,
          messageID: hookOutput.message.id,
          type: "text",
          text: reference,
          synthetic: true,
        })
      } catch (e) {
        log("error", `chat.message injector failed: ${(e as Error).message}`)
      }
    },
  }
}

export default server
