# opencode-md-memory

基于本地 Markdown 文件的轻量记忆系统 — opencode 插件。

无需向量数据库、无自动清理 — 每条记忆就是一个 `.md` 文件，你可以直接阅读、编辑、搜索，并用 git 做版本管理。

## 功能特性

- **纯 Markdown 存储** — 每条记忆是 `<项目>/.memory/` 下的一个文件
- **稳定 ID** — 简短 id（`mdm_<n>`）内嵌文件名，无需维护索引
- **按 ID 精确读取** — 直接按 id 读取记忆，无模糊匹配
- **全文搜索** — 基于 `rg`（失败回退 JS 匹配），支持跨 scope
- **语义参考注入**（可选）— 通过 `chat.message` hook 嵌入每条记忆的 `id + title`，将相关条目以 `<memory_reference>` 块注入上下文
- **模块隔离** — 按模块子目录组织记忆
- **已读集合** — update/delete 需先 read，避免修改从未看过的内容
- **永久保留** — 不会自动清理；用 git 管理你的 `.memory/`
- **零必需依赖** — 嵌入器是可选的；核心功能无依赖、无网络

## 安装

### 从 npm 安装（推荐）

在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": ["opencode-md-memory"]
}
```

然后重启 opencode。opencode 会自动从 npm 解析包。

### 本地文件

将 `index.ts` 复制到 `~/.config/opencode/plugins/`（全局）或 `.opencode/plugins/`（项目）后重启 opencode，插件自动加载。

### 通过 GitHub

```json
{
  "plugin": ["opencode-md-memory@git+https://github.com/xykbear/opencode-md-memory.git"]
}
```

## 配置项

所有配置项均为可选，以下为默认值：

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

| 配置项                  | 类型   | 默认值                        | 说明                                                                                             |
|-------------------------|--------|-------------------------------|--------------------------------------------------------------------------------------------------|
| `storageName`           | string | `.memory`                     | 项目根目录下的存储目录名。设置了 `storageRoot` 时忽略。                                          |
| `storageRoot`           | string | —                             | 固定的存储绝对路径，例如 `"~/.opencode-memory"`。设置后记忆直接存于此路径，与项目目录无关，适合跨项目共享同一份记忆。 |
| `idPrefix`              | string | `mdm_`                        | 记忆文件 id 前缀，例如 `"mem_"` → `mem_1`。                                                      |
| `maxReadSet`            | number | `200`                         | 已读集合记住的 id 上限；超出后最早的已读记录会被清除。                                            |
| `injectorEnabled`       | boolean| `false`                       | 通过 `chat.message` hook 将记忆参考注入聊天。需要一个嵌入后端。                                   |
| `embeddingBackend`      | string | `builtin`                     | `"builtin"`（插件自管本地服务，模型自包含）或 `"endpoint"`（任意外部 OpenAI 兼容服务：llama.cpp / Ollama / TEI / LM Studio / OpenAI）。 |
| `embeddingBaseUrl`      | string | —                             | `"endpoint"` 后端的 Base URL，例如 `http://127.0.0.1:8080/v1`（llama.cpp）或 `https://api.openai.com/v1`。 |
| `embeddingApiKey`       | string | —                             | `"endpoint"` 后端的 API 密钥。支持 `{env:VAR}` 或 `$VAR` 从环境变量读取。                         |
| `embeddingModel`        | string | `embeddinggemma-2`            | 嵌入模型 id：传给端点；`builtin` 时作为本地模型目录名（`~/.opencode-md-memory/models/<model>/onnx`）。 |
| `injectorTopK`          | number | `3`                           | 每次触发注入的最大参考条目数。                                                                   |
| `injectorMinLen`        | number | `10`                          | 触发注入的最小消息长度（字符）；更短的消息跳过。                                                 |
| `injectorMaxPerSession` | number | `5`                           | 每个会话的最大注入次数，防止上下文膨胀。                                                          |

> `storageRoot` 支持 `~`（展开为用户主目录）。设置后记忆直接存储在指定位置，与项目目录无关，而非 `<项目>/.memory/`。

### 语义参考注入

当 `injectorEnabled: true` 时，插件挂载 `chat.message` hook。对每条符合条件的用户消息：

1. 嵌入消息，并在持久化索引（每条记忆按 `id + title` 索引）上排序。
2. 在消息前插入 `<memory_reference>` 块，列出 top-k 匹配条目（`id + title + 路径`），并明确标注这是**参考上下文，而非用户指令**。
3. 由 Agent 决定是否用 `md_read` / `md_search` 跟进读取原文；语义匹配**只做触发，不做最终检索**。

**默认关闭**。

**统一接口** —— 所有后端都讲 OpenAI 兼容的 `POST {base}/embeddings`（`{model, input}` → `{data:[{embedding}]}`），与 llama.cpp / Ollama / TEI / LM Studio / OpenAI 同一协议。插件不依赖任何特定运行时或共享模型路径。

**`builtin`**（默认）：零配置本地嵌入。插件启动随包分发的 `python/embed_server.py`，本地提供上述 API，并在首次使用时**自动下载**模型到 `~/.opencode-md-memory/models/<model>/onnx`。需要：

```bash
pip install onnxruntime tokenizers numpy
```

用 `MDM_EMBED_MODEL_DIR`（或 `EMBED_MODEL_DIR`）覆盖模型位置；`MDM_EMBED_AUTO_FETCH=0` 关闭自动下载；`PYTHON` 指定解释器；`HF_ENDPOINT` 指定下载镜像。

**`endpoint`**：指向你已有的任意 OpenAI 兼容嵌入服务——例如用 **llama.cpp** 托管 EmbeddingGemma-2：

```jsonc
{ "embeddingBackend": "endpoint", "embeddingBaseUrl": "http://127.0.0.1:8080/v1", "embeddingModel": "embeddinggemma-2" }
```

（同样适用于 Ollama `/v1`、TEI、LM Studio、OpenAI。）`embeddingApiKey` 支持 `{env:VAR}` 或 `$VAR`。

若后端不可用，注入器记录警告并跳过，不中断会话。

> **索引持久化**：仅将每条记忆的 `id + 语义标题` 嵌入并存储为 `.memory/.index/index.json` 中的元数据，向量存于扁平二进制文件 `.memory/.index/vectors.bin`。语义标题取正文首个 `# H1` 标题（文件无 H1 时回退用文件名 slug）。会话首次注入时，索引会与当前文件做增量同步——新文件嵌入追加、已删除文件移除、语义标题发生变化的文件重新嵌入。正文编辑若未改动 H1 则不会使索引失效，因此常规编辑无需重嵌入。索引同时记录其**嵌入空间标识**：若模型发生变化（包括**同维度**的更换，如 nomic→EmbeddingGemma-2），下次会话会整体重建索引，避免混用两个空间的向量。索引是缓存，通过自动写入的 `.memory/.gitignore` 排除在 git 之外。

## 工具

| 工具       | 描述                                                               |
|------------|--------------------------------------------------------------------|
| `md_create` | 新建一条 Markdown 记忆，返回 id。                                 |
| `md_read`   | 按 id 读取记忆，并载入已读集合。                                  |
| `md_update` | 用新内容覆盖指定 id 的记忆。需该 id 在已读集合中。                |
| `md_delete` | 删除指定 id 的记忆。需该 id 在已读集合中。                        |
| `md_list`   | 列出记忆文件。                                                     |
| `md_search` | 全文搜索记忆内容。                                                 |

## 核心设计

- **id 化**：简短 id（`mdm_<n>`）内嵌文件名开头，从文件名解析，无需索引映射
- **scope**：省略→根目录；`all-modules`→根+所有模块；`<module>`→该模块一级目录
- **已读集合**：`md_update` / `md_delete` 需该 id 已通过 `md_read` 载入，防止修改或删除从未看过的内容
- **搜索**：`rg` 优先，失败回退 JS 字符串匹配
- **存储**：`<项目>/.memory/`，atomic 计数器；语义索引在 `.memory/.index/`（git 忽略）

## 存储结构

```
.memory/
├── .gitignore           # 自动写入：忽略 ".index/"
├── .index/              # 语义索引缓存（git 忽略）
│   └── index.json       # { dim, entries: [{ id, title }] }（仅 id+title）
│   └── vectors.bin      # 扁平 float32 向量，每条记录一行
├── meta.json            # 计数器 { "next_id": N }
├── mdm_1-<slug>.md      # 根目录（省略 scope）
└── cell-trace/
    └── mdm_2-<slug>.md  # 模块 scope
```

## 使用示例

```
# 创建记忆（省略 scope → 根目录）
md_create({ name: "energy-density", content: "# Energy density\n..." })
→ created mdm_1

# 指定模块
md_create({ name: "low-temp", content: "...", scope: "cell-trace" })
→ created mdm_2

# 读取（载入已读集合）
md_read({ id: "mdm_1" })

# 更新（id 需在已读集合中）
md_update({ id: "mdm_1", content: "new content" })

# 搜索（跨模块）
md_search({ query: "energy", scope: "all-modules" })

# 列出
md_list({ scope: "cell-trace" })
```

## 为什么用 Markdown 文件？

- 人类可读，可在 opencode 之外直接编辑
- 对 git 友好：diff、历史、协作开箱即用
- 用标准工具即可全文搜索（`rg`、`grep`、你的编辑器）
- 无后台服务、无网络请求（核心功能）；嵌入（可选）仅注入器运行时才会执行

## License

MIT
