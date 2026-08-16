# opencode-md-memory

A lightweight, local-first memory system for opencode, backed by plain Markdown files.

No vector database, no embeddings, no auto-cleanup — memories are just `.md` files you can read, edit, grep, and version with git.

## Features

- **Plain Markdown storage** — each memory is a file under `<project>/.memory/`
- **Stable ids** — short ids (`mdm_<n>`) embedded in filenames, no index to maintain
- **Exact read by id** — read a memory directly by its id, no fuzzy matching
- **Full-text search** — `rg`-powered (falls back to JS matching), across scopes
- **Semantic search** (optional) — `md_search_similar` recalls by meaning, complementing exact matches
- **Module scoping** — organize memories into per-module subdirectories
- **Read set** — update/delete require the id to be read first, preventing changes to content never seen
- **Permanent by design** — nothing is auto-deleted; version your `.memory/` with git
- **Zero dependencies** — no embedding model, no network, no background service

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
        "semanticSearch": false,
        "semanticModel": "Xenova/all-MiniLM-L6-v2",
        "semanticTopK": 5
      }
    ]
  ]
}
```

| Option          | Type   | Default                     | Description                                                                 |
|-----------------|--------|-----------------------------|-----------------------------------------------------------------------------|
| `storageName`   | string | `.memory`                   | Directory name under the project root. Ignored when `storageRoot` is set.   |
| `storageRoot`   | string | —                           | Fixed absolute path for storage, e.g. `"~/.opencode-memory"`. When set, memories are stored there directly, independent of the project directory. Useful to share one memory store across projects. |
| `idPrefix`      | string | `mdm_`                      | Prefix for memory file ids, e.g. `"mem_"` → `mem_1`.                         |
| `maxReadSet`    | number | `200`                       | Max ids the read set remembers; older read records are evicted beyond this. |
| `semanticSearch`| boolean| `false`                     | Enable semantic search (`md_search_similar`). Requires optional embedding deps. |
| `semanticModel` | string | `Xenova/all-MiniLM-L6-v2`   | Embedding model id for semantic search.                                     |
| `semanticTopK`  | number | `5`                         | Max results returned by `md_search_similar`.                                |

> `storageRoot` accepts `~` (expanded to the home directory). When set, memories are stored there directly instead of under `<project>/.memory/`.

### Semantic search

`md_search_similar` finds memories related in *meaning* to a query, complementing the exact-match `md_search`. It is **disabled by default** and only registered when `semanticSearch: true`.

To enable it, install the optional dependencies in your opencode config directory:

```bash
cd ~/.config/opencode && npm install @huggingface/transformers onnxruntime-node
```

The embedding model (default `Xenova/all-MiniLM-L6-v2`) is downloaded on first use and cached locally. If the deps or model are unavailable, `md_search_similar` returns a warning instead of failing the session.

> **Token window**: only the first ~512 tokens of each memory are embedded (MiniLM context limit). Semantic search won't find content past that window; `md_search` (full-text) still will. Doc vectors are cached in memory by file mtime and recomputed only when files change.

## Tools

| Tool       | Description                                                                 |
|------------|-----------------------------------------------------------------------------|
| `md_create` | Create a new Markdown memory; returns its id.                               |
| `md_read`   | Read a memory by id; loads it into the read set.                              |
| `md_update` | Overwrite a memory by id with new content. Requires the id to be in the read set. |
| `md_delete` | Delete a memory by id. Requires the id to be in the read set.                 |
| `md_list`   | List memory files.                                                           |
| `md_search` | Full-text search across memory content.                                      |
| `md_search_similar` | Semantic search across memory content. Registered only when `semanticSearch: true`. |

## Core design

- **Id-based**: short id (`mdm_<n>`) embedded at the start of the filename, parsed from the filename — no index mapping needed.
- **Scope**: omitted → root; `all-modules` → root + all modules; `<module>` → that module's first-level directory.
- **Read set**: `md_update` / `md_delete` require the id to have been loaded via `md_read` first; this guards against modifying or removing content the agent never saw.
- **Search**: `rg` first, falls back to JS string matching; optional semantic search via `md_search_similar`.
- **Storage**: `<project>/.memory/` with an atomic counter.

## Storage layout

```
.memory/
├── meta.json              # counter { "next_id": N }
├── mdm_1-<slug>.md        # root scope (scope omitted)
└── cell-trace/
    └── mdm_2-<slug>.md    # module scope
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
- No background service, no embedding model, no network round-trips.

## License

MIT
