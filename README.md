# opencode-md-memory

基于本地 Markdown 文件的轻量记忆系统 — opencode 插件。

比 opencode-mem 更适合**长期记忆索引**：无 30 天自动清理、grep 全文可搜、按 id 精确读取、scope 模块隔离。

## 安装

### 方式一：npm 安装

```bash
npm install opencode-md-memory
```

`~/.config/opencode/opencode.json` 注册：

```json
{
  "plugin": ["opencode-md-memory"]
}
```

### 方式二：本地文件

复制 `index.ts` 到 `~/.config/opencode/plugins/`，重启 opencode 自动加载。

### 方式三：GitHub

```json
{
  "plugin": ["md-memory-plugin@git+https://github.com/xykbear/md-memory-plugin.git"]
}
```

## 工具

| 工具 | 描述 |
|------|------|
| md_create | 新建一条 Markdown 记忆，返回 id。 |
| md_read | 按 id 读取记忆，并记录为已读。 |
| md_update | 按 id 更新已有记忆。需先 md_read 该 id。 |
| md_delete | 按 id 删除记忆。需先 md_read 该 id。 |
| md_list | 列出记忆文件。 |
| md_search | 全文搜索记忆内容。 |

## 核心设计

- **id 化**：简短 id（`mdm_<n>`）内嵌文件名开头，从文件名解析，无需索引映射
- **scope**：省略→根目录；`all-modules`→根+所有模块；`<module>`→该模块一级目录
- **门禁**：`md_update` / `md_delete` 必须先 `md_read`，否则拒绝
- **搜索**：rg 优先，失败回退 JS 字符串匹配
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
md_create({ name: "能量密度", content: "# 能量密度\n..." })
→ 已创建 mdm_1

# 指定模块
md_create({ name: "低温性能", content: "...", scope: "cell-trace" })
→ 已创建 mdm_2

# 读取（门禁前提）
md_read({ id: "mdm_1" })

# 更新（需先 read）
md_update({ id: "mdm_1", content: "新内容" })

# 搜索（跨模块）
md_search({ query: "能量", scope: "all-modules" })

# 列出
md_list({ scope: "cell-trace" })
```

## 对比 opencode-mem

| | opencode-mem | md-memory |
|---|-------------|-----------|
| 存储 | 向量库（SQLite 分片） | Markdown 文件 |
| 持久性 | 30 天自动清理 | 永久（git 管理） |
| 检索 | 纯向量语义搜索 | grep 全文搜索 |
| 按 ID 精确读 | ❌ 无 | ✅ `md_read` |
| 跨模块 | 无 | scope 模块隔离 |
| 依赖 | 向量库 + embedding 服务 | 零外部依赖 |

## License

MIT