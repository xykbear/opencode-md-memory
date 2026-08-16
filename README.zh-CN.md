# opencode-md-memory

基于本地 Markdown 文件的轻量记忆系统 — opencode 插件。

无需向量数据库、无需 embedding、无自动清理 —— 每条记忆就是一个 `.md` 文件，你可以直接阅读、编辑、搜索，并用 git 做版本管理。

## 功能特性

- **纯 Markdown 存储** — 每条记忆是 `<项目>/.memory/` 下的一个文件
- **稳定 ID** — 简短 id（`mdm_<n>`）内嵌文件名，无需维护索引
- **按 ID 精确读取** — 直接按 id 读取记忆，无模糊匹配
- **全文搜索** — 基于 `rg`（失败回退 JS 匹配），支持跨 scope
- **模块隔离** — 按模块子目录组织记忆
- **写入门禁** — update/delete 前必须先 read，避免盲目修改
- **永久保留** — 不会自动清理；用 git 管理你的 `.memory/`
- **零依赖** — 无 embedding 模型、无网络、无后台服务

## 安装

### 本地文件

将 `index.ts` 复制到 `~/.config/opencode/plugins/`（全局）或 `.opencode/plugins/`（项目）后重启 opencode，插件自动加载。

### 通过 GitHub

在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": ["opencode-md-memory@git+https://github.com/xykbear/opencode-md-memory.git"]
}
```

然后重启 opencode。

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
        "maxReadSet": 200
      }
    ]
  ]
}
```

| 配置项        | 类型   | 默认值      | 说明                                                                                     |
|---------------|--------|-------------|------------------------------------------------------------------------------------------|
| `storageName` | string | `.memory`   | 项目根目录下的存储目录名。设置了 `storageRoot` 时忽略。                                  |
| `storageRoot` | string | —           | 固定的存储绝对路径，覆盖项目相对路径默认值，例如 `"~/.opencode-memory"`。适合跨项目共享同一份记忆。 |
| `idPrefix`    | string | `mdm_`      | 记忆文件 id 前缀，例如 `"mem_"` → `mem_1`。                                              |
| `maxReadSet`  | number | `200`       | 跟踪为「已读」的最大 id 数；写入门禁（update/delete 需先 read）只记住这么多条。          |

> `storageRoot` 支持 `~`（展开为家目录）。设置后记忆直接存储在指定位置，而非 `<项目>/.memory/`。

## 工具

| 工具       | 描述                                                               |
|------------|--------------------------------------------------------------------|
| `md_create` | 新建一条 Markdown 记忆，返回 id。                                 |
| `md_read`   | 按 id 读取记忆，并标记为已读（update/delete 的前置条件）。         |
| `md_update` | 按 id 更新已有记忆。需先 `md_read` 该 id。                        |
| `md_delete` | 按 id 删除记忆。需先 `md_read` 该 id。                            |
| `md_list`   | 列出记忆文件。                                                     |
| `md_search` | 全文搜索记忆内容。                                                 |

## 核心设计

- **id 化**：简短 id（`mdm_<n>`）内嵌文件名开头，从文件名解析，无需索引映射
- **scope**：省略→根目录；`all-modules`→根+所有模块；`<module>`→该模块一级目录
- **门禁**：`md_update` / `md_delete` 未先 `md_read` 则拒绝执行
- **搜索**：`rg` 优先，失败回退 JS 字符串匹配
- **存储**：`<项目>/.memory/`，atomic 计数器

## 存储结构

```
.memory/
├── meta.json              # 计数器 { "next_id": N }
├── mdm_1-<slug>.md        # 根目录（省略 scope）
└── cell-trace/
    └── mdm_2-<slug>.md    # 模块 scope
```

## 使用示例

```
# 创建记忆（省略 scope → 根目录）
md_create({ name: "energy-density", content: "# Energy density\n..." })
→ created mdm_1

# 指定模块
md_create({ name: "low-temp", content: "...", scope: "cell-trace" })
→ created mdm_2

# 读取（门禁前提）
md_read({ id: "mdm_1" })

# 更新（需先 read）
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
- 无后台服务、无 embedding 模型、无网络请求

## License

MIT
