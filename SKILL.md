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

### Step 1b: AI 模型配置

根据运行环境选择合适的 AI 提供方：

**选项 A — 使用当前 Claude Code 会话模型（推荐，无需额外 API Key）**

在 Claude Code / codex 环境中，可直接复用当前模型会话，无需配置额外 Key：

```bash
export AI_CLI_CMD="claude"
```

**选项 B — Gemini API Key 或者 Anthropic API Key 或者 openAI API Key**

```bash
export ANTHROPIC_API_KEY="your-anthropic-key"
export ANTHROPIC_MODEL="claude-3-5-haiku-20241022"  # 可选
```

如果 `config.ApiKey` 或 `AI_CLI_CMD` 已存在，跳过此步。

### Step 2: 执行脚本

**两个版本选一个运行：**

#### 选项 A — API 调用版（`digest.ts`，推荐有 API Key 时使用）

脚本直接调用外部 AI API 完成评分与摘要，生成完整日报文件。

```bash
mkdir -p ./output

# 使用 Claude Code 会话（在 Claude Code 环境中推荐）
export AI_CLI_CMD="claude"

# 或使用 Gemini
export GEMINI_API_KEY="<key>"

# 或使用 Anthropic
export ANTHROPIC_API_KEY="<key>"

# 或 OpenAI 兼容兜底（DeepSeek/OpenAI 等）
export OPENAI_API_KEY="<fallback-key>"
export OPENAI_API_BASE="https://api.deepseek.com/v1"
export OPENAI_MODEL="deepseek-chat"

npx -y bun ${SKILL_DIR}/scripts/digest.ts \
  --hours <timeRange> \
  --top-n <topN> \
  --lang <zh|en> \
  --output ./output/digest-$(date +%Y%m%d).md
```

#### 选项 B — Skill 版（`digest-skill.ts`，无需额外 API Key）

脚本仅负责抓取 RSS 并输出任务包文件；评分、摘要、今日看点由**当前 AI 会话**（即正在执行此 Skill 的模型）直接完成，不调用任何外部 API。

```bash
mkdir -p ./output

npx -y bun ${SKILL_DIR}/scripts/digest-skill.ts \
  --hours <timeRange> \
  --top-n <topN> \
  --lang <zh|en> \
  --output ./output/digest-skill-$(date +%Y%m%d).md
```

任务包生成后，AI 按以下流程处理：

1. **阅读文章数据** — 任务包中包含所有候选文章（标题、来源、时间、摘要）
2. **评分与分类** — 使用内嵌的"评分 Prompt 模板"，对每篇文章从相关性、质量、时效性三个维度打分（1-10），并分配分类标签和关键词
3. **筛选 Top N** — 按加权总分排序，选出最终精选文章
4. **生成摘要** — 使用内嵌的"摘要 Prompt 模板"，为每篇精选文章生成中文标题、结构化摘要、推荐理由
5. **生成今日看点** — 使用内嵌的"今日看点 Prompt 模板"，归纳 2-3 条宏观技术趋势
6. **输出日报** — 按标准日报结构（看点 → Top 3 → 数据概览 → 分类文章列表）输出 Markdown
### Step 2b: 保存配置

```bash
mkdir -p ~/.hn-daily-digest
cat > ~/.hn-daily-digest/config.json << 'EOF'
{
  "ApiKey": "<key>",
  "timeRange": <hours>,
  "topN": <topN>,
  "language": "<zh|en>",
  "lastUsed": "<ISO timestamp>"
}
EOF
```

### Step 3: 结果展示

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

## AI 模型提供方

脚本支持多种 AI 模型调用方式，通过环境变量配置：

| 提供方 | 环境变量 | 说明 |
|--------|----------|------|
| Claude Code 会话 | `AI_CLI_CMD=claude` | 复用当前 Claude Code 会话，无需独立 API Key |
| Gemini | `GEMINI_API_KEY` | 免费额度充足，推荐首选 |
| Anthropic | `ANTHROPIC_API_KEY` | 直接调用 Claude API |
| OpenAI 兼容 | `OPENAI_API_KEY` + `OPENAI_API_BASE` | DeepSeek、OpenAI 等 |

**优先级**: `AI_CLI_CMD` > `GEMINI_API_KEY` > `ANTHROPIC_API_KEY` > `OPENAI_API_KEY`

**在 Claude Code / Cursor / Copilot 等 AI 编码工具中使用时**，可将 `AI_CLI_CMD` 设置为对应工具的 CLI 命令，直接复用当前会话的模型能力，无需配置额外 API Key：

```bash
# Claude Code
export AI_CLI_CMD="claude"

# llm（Simon Willison 的通用 LLM CLI 工具）
export AI_CLI_CMD="llm"
```

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

---

## Prompt 模板（Skill 版内嵌）

Skill 版的三个 AI 处理模板已直接内嵌于 `scripts/digest-skill.ts`，无需外部文件。以下为完整模板内容，供查阅与自定义参考。修改后需同步更新 `digest-skill.ts` 中对应的常量。

占位符说明：`{{ARTICLES_LIST}}` 会替换为实际文章数据，`{{LANG_INSTRUCTION}}` / `{{LANG_NOTE}}` 会替换为语言指令。

---

### 评分模板（SCORING_TEMPLATE）

用于对候选文章进行相关性、质量、时效性三维度打分，并分配分类标签和关键词。

```
你是一个技术内容策展人，正在为一份面向技术爱好者的每日精选摘要筛选文章。

请对以下文章进行三个维度的评分（1-10 整数，10 分最高），并为每篇文章分配一个分类标签和提取 2-4 个关键词。

## 评分维度

### 1. 相关性 (relevance) - 对技术/编程/AI/互联网从业者的价值
- 10: 所有技术人都应该知道的重大事件/突破
- 7-9: 对大部分技术从业者有价值
- 4-6: 对特定技术领域有价值
- 1-3: 与技术行业关联不大

### 2. 质量 (quality) - 文章本身的深度和写作质量
- 10: 深度分析，原创洞见，引用丰富
- 7-9: 有深度，观点独到
- 4-6: 信息准确，表达清晰
- 1-3: 浅尝辄止或纯转述

### 3. 时效性 (timeliness) - 当前是否值得阅读
- 10: 正在发生的重大事件/刚发布的重要工具
- 7-9: 近期热点相关
- 4-6: 常青内容，不过时
- 1-3: 过时或无时效价值

## 分类标签（必须从以下选一个）
- ai-ml: AI、机器学习、LLM、深度学习相关
- security: 安全、隐私、漏洞、加密相关
- engineering: 软件工程、架构、编程语言、系统设计
- tools: 开发工具、开源项目、新发布的库/框架
- opinion: 行业观点、个人思考、职业发展、文化评论
- other: 以上都不太适合的

## 关键词提取
提取 2-4 个最能代表文章主题的关键词（用英文，简短，如 "Rust", "LLM", "database", "performance"）

## 待评分文章

{{ARTICLES_LIST}}

请严格按 JSON 格式返回，不要包含 markdown 代码块或其他文字：
{
  "results": [
    {
      "index": 0,
      "relevance": 8,
      "quality": 7,
      "timeliness": 9,
      "category": "engineering",
      "keywords": ["Rust", "compiler", "performance"]
    }
  ]
}
```

---

### 摘要模板（SUMMARY_TEMPLATE）

用于为筛选后的 Top N 文章生成中文标题翻译、结构化摘要和推荐理由。

```
你是一个技术内容摘要专家。请为以下文章完成三件事：

1. **中文标题** (titleZh): 将英文标题翻译成自然的中文。如果原标题已经是中文则保持不变。
2. **摘要** (summary): 4-6 句话的结构化摘要，让读者不点进原文也能了解核心内容。包含：
   - 文章讨论的核心问题或主题（1 句）
   - 关键论点、技术方案或发现（2-3 句）
   - 结论或作者的核心观点（1 句）
3. **推荐理由** (reason): 1 句话说明"为什么值得读"，区别于摘要（摘要说"是什么"，推荐理由说"为什么"）。

{{LANG_INSTRUCTION}}

摘要要求：
- 直接说重点，不要用"本文讨论了..."、"这篇文章介绍了..."这种开头
- 包含具体的技术名词、数据、方案名称或观点
- 保留关键数字和指标（如性能提升百分比、用户数、版本号等）
- 如果文章涉及对比或选型，要点出比较对象和结论
- 目标：读者花 30 秒读完摘要，就能决定是否值得花 10 分钟读原文

## 待摘要文章

{{ARTICLES_LIST}}

请严格按 JSON 格式返回：
{
  "results": [
    {
      "index": 0,
      "titleZh": "中文翻译的标题",
      "summary": "摘要内容...",
      "reason": "推荐理由..."
    }
  ]
}
```

---

### 今日看点模板（HIGHLIGHTS_TEMPLATE）

用于基于精选文章归纳 2-3 条宏观技术趋势，生成日报开头的"今日看点"段落。

```
根据以下今日精选技术文章列表，写一段 3-5 句话的"今日看点"总结。
要求：
- 提炼出今天技术圈的 2-3 个主要趋势或话题
- 不要逐篇列举，要做宏观归纳
- 风格简洁有力，像新闻导语
{{LANG_NOTE}}

文章列表：
{{ARTICLES_LIST}}

直接返回纯文本总结，不要 JSON，不要 markdown 格式。
```


## 故障排除

### "Missing AI provider"
需要配置至少一种 AI 提供方，见"AI 模型提供方"表格。

### "Gemini 配额超限或请求失败"
脚本会自动降级到 Anthropic 或 OpenAI 兼容接口。

### "CLI command failed"
检查 `AI_CLI_CMD` 对应的命令是否已安装且在 PATH 中可用。

### "Failed to fetch N feeds"
部分 RSS 源可能暂时不可用，脚本会跳过失败的源并继续处理。

### "No articles found in time range"
尝试扩大时间范围（如从 24 小时改为 48 小时）。
