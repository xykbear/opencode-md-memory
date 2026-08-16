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

### Local file

Copy `index.ts` into `~/.config/opencode/plugins/` (global) or `.opencode/plugins/` (project) and restart opencode. The plugin is auto-loaded.

### From GitHub

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-md-memory@git+https://github.com/xykbear/opencode-md-memory.git"]
}
```

Then restart opencode.

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
        "semanticModel": "Xenova/all-MiniLM-L6-v2",
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
| `injectorEnabled`     | boolean| `false`                     | Inject memory references into chat via the `chat.message` hook. Requires optional embedding deps. |
| `semanticModel`       | string | `Xenova/all-MiniLM-L6-v2`   | Embedding model id used by the injector.                                     |
| `injectorTopK`        | number | `3`                         | Max references injected per triggering message.                              |
| `injectorMinLen`      | number | `10`                        | Min message length (chars) that triggers injection; shorter messages are skipped. |
| `injectorMaxPerSession` | number | `5`                       | Max injections per session, preventing context bloat.                        |

> `storageRoot` accepts `~` (expanded to the home directory). When set, memories are stored there directly instead of under `<project>/.memory/`.

### Semantic reference injection

When `injectorEnabled: true`, the plugin hooks `chat.message`. For each qualifying user message it:

1. Embeds the message with MiniLM and ranks the persisted index (each memory indexed by `id + title`).
2. Prepends a `<memory_reference>` block listing the top-k matching entries (`id + title + path`) as *reference context* — explicitly **not** an instruction from the user.
3. Lets the agent decide whether to follow up with `md_read` / `md_search`; semantic matching is **trigger only**, never a substitute for reading the actual content.

It is **disabled by default**. To enable it, install the optional dependencies in your opencode config directory:

```bash
cd ~/.config/opencode && npm install @huggingface/transformers onnxruntime-node
```

The embedding model (default `Xenova/all-MiniLM-L6-v2`) is downloaded on first use and cached locally. If the deps or model are unavailable, the injector logs a warning and skips instead of failing the session.

> **Index persistence**: only each memory's `id + title` (parsed from the filename) is embedded and stored in `.memory/.index/index.json`. On the first injection of a session the index is brought in sync with the current files incrementally — new files are embedded, deleted files are dropped, renamed files are re-embedded. Content changes never invalidate the index, so there is no re-embedding cost per edit. The index is a cache and is excluded from git via an auto-written `.memory/.gitignore`.

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
│   └── index.json       # { entries: [{ id, title, vec }] }
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
