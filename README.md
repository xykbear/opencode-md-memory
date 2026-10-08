# opencode-md-memory

A lightweight, local-first memory system for opencode, backed by plain Markdown files.

No vector database, no auto-cleanup — memories are just `.md` files you can read, edit, grep, and version with git.

## Features

- **Plain Markdown storage** — each memory is a file under `<project>/.memory/`
- **Stable ids** — short ids (`mdm_<n>`) embedded in filenames, no index to maintain
- **Exact read by id** — read a memory directly by its id, no fuzzy matching
- **Full-text search** — `rg`-powered (falls back to JS matching), across scopes
- **Semantic reference injection** (optional) — the `chat.message` hook embeds each memory's `id + title` and injects a `<memory_reference>` block of related entries as context
- **Module scoping** — organize memories into per-module subdirectories
- **Read set** — update/delete require the id to be read first, preventing changes to content never seen
- **Permanent by design** — nothing is auto-deleted; version your `.memory/` with git
- **Zero required dependencies** — the embedder is optional; the core works with no dependencies, no network

## Installation

### From npm (recommended)

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-md-memory"]
}
```

Then restart opencode. opencode resolves the package from npm automatically.

### Local file

Copy `index.ts` into `~/.config/opencode/plugins/` (global) or `.opencode/plugins/` (project) and restart opencode. The plugin is auto-loaded.

### From GitHub

```json
{
  "plugin": ["opencode-md-memory@git+https://github.com/xykbear/opencode-md-memory.git"]
}
```

## Configuration

All options are optional; defaults are shown.

```json
{
  "plugin": [
    [
      "opencode-md-memory",
      {
        "storageName": ".memory",
        "storageRoot": null,
        "idPrefix": "mdm_",
        "maxReadSet": 200,
        "injectorEnabled": false,
        "embeddingBackend": "endpoint",
        "embeddingBaseUrl": "https://api.openai.com/v1",
        "embeddingApiKey": "{env:OPENAI_API_KEY}",
        "embeddingModel": "embeddinggemma-2",
        "injectorTopK": 3,
        "injectorMinLen": 10,
        "injectorMaxPerSession": 5
      }
    ]
  ]
}
```

| Option                | Type   | Default                     | Description                                                                 |
|-----------------------|--------|-----------------------------|-----------------------------------------------------------------------------|
| `storageName`         | string | `.memory`                   | Directory name under the project root. Ignored when `storageRoot` is set.   |
| `storageRoot`         | string | —                           | Fixed absolute path for storage, e.g. `"~/.opencode-memory"`. When set, memories are stored there directly, independent of the project directory. Useful to share one memory store across projects. |
| `idPrefix`            | string | `mdm_`                      | Prefix for memory file ids, e.g. `"mem_"` → `mem_1`.                         |
| `maxReadSet`          | number | `200`                       | Max ids the read set remembers; older read records are evicted beyond this. |
| `injectorEnabled`     | boolean| `false`                     | Inject memory references into chat via the `chat.message` hook. Requires an embeddings backend. |
| `embeddingBackend`    | string | `builtin`                   | `"builtin"` (plugin-managed local service; self-contained model) or `"endpoint"` (any external OpenAI-compatible service: llama.cpp / Ollama / TEI / LM Studio / OpenAI). |
| `embeddingBaseUrl`    | string | —                           | Base URL for an `"endpoint"` backend, e.g. `http://127.0.0.1:8080/v1` (llama.cpp) or `https://api.openai.com/v1`. |
| `embeddingApiKey`     | string | —                           | API key for an `"endpoint"` backend. Supports `{env:VAR}` or `$VAR` to read from environment. |
| `embeddingModel`      | string | `embeddinggemma-2`          | Embedding model id — passed to the endpoint; for `builtin` it names the local model dir (`~/.opencode-md-memory/models/<model>/onnx`). |
| `injectorTopK`        | number | `3`                         | Max references injected per triggering message.                              |
| `injectorMinLen`      | number | `10`                        | Min message length (chars) that triggers injection; shorter messages are skipped. |
| `injectorMaxPerSession` | number | `5`                       | Max injections per session, preventing context bloat.                        |

> `storageRoot` accepts `~` (expanded to the home directory). When set, memories are stored there directly instead of under `<project>/.memory/`.

### Semantic reference injection

When `injectorEnabled: true`, the plugin hooks `chat.message`. For each qualifying user message it:

1. Embeds the message and ranks the persisted index (each memory indexed by `id + title`).
2. Prepends a `<memory_reference>` block listing the top-k matching entries (`id + title + path`) as *reference context* — explicitly **not** an instruction from the user.
3. Lets the agent decide whether to follow up with `md_read` / `md_search`; semantic matching is **trigger only**, never a substitute for reading the actual content.

It is **disabled by default**.

**Unified interface** — every backend speaks the OpenAI-compatible `POST {base}/embeddings` API (`{model, input}` → `{data:[{embedding}]}`) — the same protocol as llama.cpp / Ollama / TEI / LM Studio / OpenAI. The plugin never depends on a specific runtime or a shared model path.

**`builtin`** (default): zero-config local embeddings. The plugin spawns the bundled `python/embed_server.py`, which serves that API locally and **auto-downloads** the model on first use into `~/.opencode-md-memory/models/<model>/onnx`. Requires the Python deps:

```bash
pip install onnxruntime tokenizers numpy
```

Override the model location with `MDM_EMBED_MODEL_DIR` (or `EMBED_MODEL_DIR`); disable auto-download with `MDM_EMBED_AUTO_FETCH=0`; use `PYTHON` to pick an interpreter; set `HF_ENDPOINT` for a download mirror.

**`endpoint`**: point at any OpenAI-compatible embeddings service you already run — e.g. a **llama.cpp** server hosting EmbeddingGemma-2:

```jsonc
{ "embeddingBackend": "endpoint", "embeddingBaseUrl": "http://127.0.0.1:8080/v1", "embeddingModel": "embeddinggemma-2" }
```

(also works with Ollama `/v1`, TEI, LM Studio, OpenAI). `embeddingApiKey` accepts `{env:VAR}` or `$VAR`.

If the backend is unavailable, the injector logs a warning and skips instead of failing the session.

> **Index persistence**: only each memory's `id + semantic title` is embedded and stored as metadata in `.memory/.index/index.json`, with the vectors in a flat binary file `.memory/.index/vectors.bin`. The semantic title is the first `# H1` heading of the content (the filename slug is used only as a fallback when the file has no H1). On the first injection of a session the index is brought in sync with the current files incrementally — new files are embedded, deleted files are dropped, files whose semantic title changed are re-embedded. Body edits that keep the H1 unchanged never invalidate the index, so routine edits cost no re-embedding. The index also records its **embedding-space identity**: if the model changes (including a dimension-preserving swap, e.g. nomic→EmbeddingGemma-2), the whole index is rebuilt on the next session instead of mixing vectors from two spaces. The index is a cache and is excluded from git via an auto-written `.memory/.gitignore`.

## Tools

| Tool       | Description                                                                 |
|------------|-----------------------------------------------------------------------------|
| `md_create` | Create a new Markdown memory; returns its id.                               |
| `md_read`   | Read a memory by id; loads it into the read set.                              |
| `md_update` | Overwrite a memory by id with new content. Requires the id to be in the read set. |
| `md_delete` | Delete a memory by id. Requires the id to be in the read set.                 |
| `md_list`   | List memory files.                                                           |
| `md_search` | Full-text search across memory content.                                      |

## Core design

- **Id-based**: short id (`mdm_<n>`) embedded at the start of the filename, parsed from the filename — no index mapping needed.
- **Scope**: omitted → root; `all-modules` → root + all modules; `<module>` → that module's first-level directory.
- **Read set**: `md_update` / `md_delete` require the id to have been loaded via `md_read` first; this guards against modifying or removing content the agent never saw.
- **Search**: `rg` first, falls back to JS string matching.
- **Storage**: `<project>/.memory/` with an atomic counter; the semantic index lives in `.memory/.index/` (git-ignored).

## Storage layout

```
.memory/
├── .gitignore           # auto-written: ignores ".index/"
├── .index/              # semantic index cache (git-ignored)
│   └── index.json       # { dim, entries: [{ id, title }] } (id+title only)
│   └── vectors.bin      # flat float32 vectors, one row per entry
├── meta.json            # counter { "next_id": N }
├── mdm_1-<slug>.md      # root scope (scope omitted)
└── cell-trace/
    └── mdm_2-<slug>.md  # module scope
```

## Usage

```
# Create a memory (scope omitted → root)
md_create({ name: "energy-density", content: "# Energy density\n..." })
→ created mdm_1

# Create within a module
md_create({ name: "low-temp", content: "...", scope: "cell-trace" })
→ created mdm_2

# Read (loads into the read set)
md_read({ id: "mdm_1" })

# Update (id must be in the read set)
md_update({ id: "mdm_1", content: "new content" })

# Search across modules
md_search({ query: "energy", scope: "all-modules" })

# List
md_list({ scope: "cell-trace" })
```

## Why Markdown files?

- Human-readable and editable outside of opencode.
- `git`-friendly: diffs, history, and collaboration work out of the box.
- Fully searchable with standard tools (`rg`, `grep`, your editor).
- No background service and no network round-trips for the core; embeddings (optional) only run for the injector.

## License

MIT
