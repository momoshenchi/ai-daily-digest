---
name: ai-daily-digest
description: "Fetches RSS feeds from a curated list of top Hacker News blogs (curated by Karpathy), uses AI to score and filter articles, and generates a daily digest in Markdown with Chinese-translated titles, category grouping, trend highlights, and visual statistics (Mermaid charts + tag cloud). Use when user mentions 'daily digest', 'RSS digest', 'blog digest', 'AI blogs', 'tech news summary', or asks to run /digest command. Trigger command: /digest."
---

# AI Daily Digest

从 Karpathy 推荐的热门技术博客中抓取最新文章，通过 AI 评分筛选，生成每日精选摘要。

---

## 脚本目录

**重要**: 所有脚本位于此 skill 的 `scripts/` 子目录。

**Agent 执行说明**:
1. 确定此 SKILL.md 文件的目录路径为 `SKILL_DIR`
2. 脚本路径 = `${SKILL_DIR}/scripts/<script-name>.ts`

| 文件 | 用途 |
|------|------|
| `scripts/digest.ts` | API 调用版 - RSS 抓取、AI 评分、生成摘要（需配置 AI API Key） |
| `scripts/digest-skill.ts` | Skill 版 - RSS 抓取后输出任务包，由当前 AI 会话完成评分与摘要 |
| `config/feeds.json` | RSS 订阅源列表（可自由编辑添加/删除源） |

---


## 交互流程

### Step 0: 检查已保存配置

配置文件路径: `~/.hn-daily-digest/config.json`

Agent 在执行前**必须检查**此文件是否存在：
1. 如果存在，读取并解析 JSON
2. 询问用户是否使用已保存配置
3. 执行完成后保存当前配置到此文件

**配置文件结构**:
```json
{
  "GEMINI_API_KEY": "",
  "OPENAI_API_KEY":"",
  "ANTHROPIC_API_KEY":"",
  "timeRange": 48,
  "topN": 15,
  "language": "zh",
  "lastUsed": "2026-02-14T12:00:00Z"
}
```


```bash
cat ~/.hn-daily-digest/config.json 2>/dev/null || echo "NO_CONFIG"
```

如果配置存在且有 `GEMINI_API_KEY`或者`OPENAI_API_KEY`或者`ANTHROPIC_API_KEY`，询问是否复用：

```
question({
  questions: [{
    header: "使用已保存配置",
    question: "检测到上次使用的配置：\n\n• 时间范围: ${config.timeRange}小时\n• 精选数量: ${config.topN} 篇\n• 输出语言: ${config.language === 'zh' ? '中文' : 'English'}\n\n请选择操作：",
    options: [
      { label: "使用上次配置直接运行 (Recommended)", description: "使用所有已保存的参数立即开始" },
      { label: "重新配置", description: "从头开始配置所有参数" }
    ]
  }]
})
```

### Step 1: 收集参数

使用 `question()` 一次性收集：

```
question({
  questions: [
    {
      header: "时间范围",
      question: "抓取多长时间内的文章？",
      options: [
        { label: "24 小时", description: "仅最近一天" },
        { label: "48 小时 (Recommended)", description: "最近两天，覆盖更全" },
        { label: "72 小时", description: "最近三天" },
        { label: "7 天", description: "一周内的文章" }
      ]
    },
    {
      header: "精选数量",
      question: "AI 筛选后保留多少篇？",
      options: [
        { label: "10 篇", description: "精简版" },
        { label: "15 篇 (Recommended)", description: "标准推荐" },
        { label: "20 篇", description: "扩展版" }
      ]
    },
    {
      header: "输出语言",
      question: "摘要使用什么语言？",
      options: [
        { label: "中文 (Recommended)", description: "摘要翻译为中文" },
        { label: "English", description: "保持英文原文" }
      ]
    }
  ]
})
```

### Step 2: 执行脚本

**两个版本选一个运行：**

#### 选项 A — API 调用版（`digest.ts`，推荐有 API Key 时使用）

脚本直接调用外部 AI API 完成评分与摘要，生成完整日报文件。
支持多种 AI 模型调用方式，通过环境变量配置：

| 提供方 | 环境变量 | 说明 |
|--------|----------|------|
| Gemini | `GEMINI_API_KEY` | 免费额度充足，推荐首选 |
| Anthropic | `ANTHROPIC_API_KEY` | 直接调用 Claude API |
| OpenAI 兼容 | `OPENAI_API_KEY` + `OPENAI_API_BASE` | DeepSeek、OpenAI 等 |

**优先级**: `GEMINI_API_KEY` > `ANTHROPIC_API_KEY` > `OPENAI_API_KEY`


```bash
mkdir -p ./output

# 如果 `config.ApiKey` 跳过此步。
# 或使用 Gemini
export GEMINI_API_KEY="<key>"

# 或使用 Anthropic
export ANTHROPIC_API_KEY="<key>"

# 或 OpenAI 兼容兜底（DeepSeek/OpenAI 等）
export OPENAI_API_KEY="<fallback-key>"
export OPENAI_API_BASE="https://api.deepseek.com/v1"
export OPENAI_MODEL="deepseek-chat"
```

配置环境变量完成后, 调用模型

```bash
npx -y bun ${SKILL_DIR}/scripts/digest.ts \
  --hours <timeRange> \
  --top-n <topN> \
  --lang <zh|en> \
  --output ./output/digest-$(date +%Y%m%d).md
```

#### 选项 B — Skill 版（`digest-skill.ts`，无需额外 API Key）

脚本仅负责抓取 RSS 并输出文章数据包；评分、摘要、今日看点由**当前 AI 会话**（即正在执行此 Skill 的模型）直接完成，不调用任何外部 API。

```bash
mkdir -p ./output

npx -y bun ${SKILL_DIR}/scripts/digest-skill.ts \
  --hours <timeRange> \
  --top-n <topN> \
  --lang <zh|en> \
  --output ./output/digest-skill-$(date +%Y%m%d).md
```

文章数据包生成后，AI 按以下步骤处理：

1. **阅读文章数据** — 读取输出的数据包文件，了解所有候选文章（标题、来源、时间、摘要）
2. **评分与分类** — 读取 `${SKILL_DIR}/prompts/scoring.md`，按其中的评分规则对每篇文章从相关性、质量、时效性三个维度打分（1-10），并分配分类标签和关键词，以 JSON 格式输出结果
3. **筛选 Top N** — 按加权总分排序，选出最终精选文章
4. **生成摘要** — 读取 `${SKILL_DIR}/prompts/summary.md`，按其中的模板为每篇精选文章生成中文标题翻译、结构化摘要、推荐理由
5. **生成今日看点** — 读取 `${SKILL_DIR}/prompts/highlights.md`，按其中的模板归纳 2-3 条宏观技术趋势
6. **输出日报** — 按标准日报结构（看点 → Top 3 → 数据概览 → 分类文章列表）输出 Markdown

### Step 3: 保存配置

```bash
mkdir -p ~/.hn-daily-digest
cat > ~/.hn-daily-digest/config.json << 'EOF'
{
  "GEMINI_API_KEY": "<key>",
  "OPENAI_API_KEY":"<key>",
  "ANTHROPIC_API_KEY":"<key>",
  "timeRange": "<hours>",
  "topN": <topN>,
  "language": "<zh|en>",
  "lastUsed": "<ISO timestamp>"
}
EOF
```

### Step 4: 结果展示

**成功时**：
- 📁 报告文件路径
- 📊 简要摘要：扫描源数、抓取文章数、精选文章数
- 🏆 **今日精选 Top 3 预览**：中文标题 + 一句话摘要

**报告结构**（生成的 Markdown 文件包含以下板块）：
1. **📝 今日看点** — AI 归纳的 3-5 句宏观趋势总结
2. **🏆 今日必读 Top 3** — 中英双语标题、摘要、推荐理由、关键词标签
3. **📊 数据概览** — 统计表格 + Mermaid 分类饼图 + 高频关键词柱状图 + ASCII 纯文本图（终端友好） + 话题标签云
4. **分类文章列表** — 按 6 大分类（AI/ML、安全、工程、工具/开源、观点/杂谈、其他）分组展示，每篇含中文标题、相对时间、综合评分、摘要、关键词

**失败时**：
- 显示错误信息
- 常见问题：API Key 无效、网络问题、RSS 源不可用

---

## 参数映射

| 交互选项 | 脚本参数 |
|----------|----------|
| 24 小时 | `--hours 24` |
| 48 小时 | `--hours 48` |
| 72 小时 | `--hours 72` |
| 7 天 | `--hours 168` |
| 10 篇 | `--top-n 10` |
| 15 篇 | `--top-n 15` |
| 20 篇 | `--top-n 20` |
| 中文 | `--lang zh` |
| English | `--lang en` |

---

## 环境要求

- `bun` 运行时（通过 `npx -y bun` 自动安装）
- 至少一个 AI 模型配置（见上方"AI 模型提供方"表格）
- 网络访问（需要能访问 RSS 源和 AI API，CLI 模式下仅需访问 RSS 源）

---

## 自定义 RSS 源

RSS 订阅源列表保存在 `config/feeds.json`，支持自由编辑：

```json
[
  { "name": "simonwillison.net", "xmlUrl": "https://simonwillison.net/atom/everything/", "htmlUrl": "https://simonwillison.net" }
]
```

直接编辑该文件即可增删订阅源，无需修改脚本代码。
**编辑feeds.json文件时, 请询问用户**
---

## Prompt 模板

三个 AI 处理模板存放在 `prompts/` 目录下，AI 会话在处理文章数据时直接读取这些文件。

| 文件 | 用途 |
|------|------|
| `prompts/scoring.md` | 评分模板 — 从相关性、质量、时效性三维度打分，并分配分类标签和关键词 |
| `prompts/summary.md` | 摘要模板 — 生成中文标题翻译、结构化摘要、推荐理由 |
| `prompts/highlights.md` | 今日看点模板 — 归纳 2-3 条宏观技术趋势 |

**编辑该些文件时, 请询问用户**



## 故障排除

### "Missing AI provider"
需要配置至少一种 AI 提供方，见"AI 模型提供方"表格。

### "Gemini 配额超限或请求失败"
脚本会自动降级到 Anthropic 或 OpenAI 兼容接口。

### "Failed to fetch N feeds"
部分 RSS 源可能暂时不可用，脚本会跳过失败的源并继续处理。

### "No articles found in time range"
尝试扩大时间范围（如从 24 小时改为 48 小时）。
