import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

const FEED_FETCH_TIMEOUT_MS = 15_000;
const FEED_CONCURRENCY = 10;
const SCRIPT_DIR = import.meta.dir;
const MAX_DESCRIPTION_LENGTH = 500;
const CANDIDATE_MULTIPLIER = 4;
const MIN_CANDIDATE_COUNT = 60;

// ---------------------------------------------------------------------------
// Prompt templates (inlined — Skill mode requires no external file dependency)
// ---------------------------------------------------------------------------

const SCORING_TEMPLATE = `你是一个技术内容策展人，正在为一份面向技术爱好者的每日精选摘要筛选文章。

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
}`;

const SUMMARY_TEMPLATE = `你是一个技术内容摘要专家。请为以下文章完成三件事：

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
}`;

const HIGHLIGHTS_TEMPLATE = `根据以下今日精选技术文章列表，写一段 3-5 句话的"今日看点"总结。
要求：
- 提炼出今天技术圈的 2-3 个主要趋势或话题
- 不要逐篇列举，要做宏观归纳
- 风格简洁有力，像新闻导语
{{LANG_NOTE}}

文章列表：
{{ARTICLES_LIST}}

直接返回纯文本总结，不要 JSON，不要 markdown 格式。`;

interface FeedConfig {
  name: string;
  xmlUrl: string;
  htmlUrl: string;
}

interface Article {
  title: string;
  link: string;
  pubDate: Date;
  description: string;
  sourceName: string;
  sourceUrl: string;
}

interface RawRSSItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCDATA(text: string): string {
  const cdataMatch = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdataMatch ? cdataMatch[1] : text;
}

function getTagContent(xml: string, tagName: string): string {
  const patterns = [
    new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'),
    new RegExp(`<${tagName}[^>]*/>`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match?.[1]) {
      return extractCDATA(match[1]).trim();
    }
  }
  return '';
}

function getAttrValue(xml: string, tagName: string, attrName: string, mustContain?: string): string {
  const extra = mustContain ? `(?=[^>]*${mustContain})` : '';
  const pattern = new RegExp(`<${tagName}${extra}[^>]*\\s${attrName}=["']([^"']*)["'][^>]*/?>`, 'i');
  const match = xml.match(pattern);
  return match?.[1] || '';
}

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;
  return null;
}

function parseRSSItems(xml: string): RawRSSItem[] {
  const items: RawRSSItem[] = [];
  const isAtom = /<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(xml);

  if (isAtom) {
    const entryPattern = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    let entryMatch;
    while ((entryMatch = entryPattern.exec(xml)) !== null) {
      const entryXml = entryMatch[1];
      const title = stripHtml(getTagContent(entryXml, 'title'));
      let link = getAttrValue(entryXml, 'link', 'href', `rel=["']alternate["']`);
      if (!link) link = getAttrValue(entryXml, 'link', 'href');
      const pubDate = getTagContent(entryXml, 'published') || getTagContent(entryXml, 'updated');
      const description = stripHtml(getTagContent(entryXml, 'summary') || getTagContent(entryXml, 'content'));
      if (title || link) items.push({ title, link, pubDate, description: description.slice(0, MAX_DESCRIPTION_LENGTH) });
    }
  } else {
    const itemPattern = /<item[\s>]([\s\S]*?)<\/item>/gi;
    let itemMatch;
    while ((itemMatch = itemPattern.exec(xml)) !== null) {
      const itemXml = itemMatch[1];
      const title = stripHtml(getTagContent(itemXml, 'title'));
      const link = getTagContent(itemXml, 'link') || getTagContent(itemXml, 'guid');
      const pubDate = getTagContent(itemXml, 'pubDate') || getTagContent(itemXml, 'dc:date') || getTagContent(itemXml, 'date');
      const description = stripHtml(getTagContent(itemXml, 'description') || getTagContent(itemXml, 'content:encoded'));
      if (title || link) items.push({ title, link, pubDate, description: description.slice(0, MAX_DESCRIPTION_LENGTH) });
    }
  }

  return items;
}

async function loadFeeds(): Promise<FeedConfig[]> {
  const feedsPath = join(SCRIPT_DIR, '..', 'config', 'feeds.json');
  const data = await readFile(feedsPath, 'utf-8');
  return JSON.parse(data) as FeedConfig[];
}

async function fetchFeed(feed: FeedConfig): Promise<Article[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
    const response = await fetch(feed.xmlUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AI-Daily-Digest/1.0 (RSS Reader)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const items = parseRSSItems(xml);

    return items.map(item => ({
      title: item.title,
      link: item.link,
      pubDate: parseDate(item.pubDate) || new Date(0),
      description: item.description,
      sourceName: feed.name,
      sourceUrl: feed.htmlUrl,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes('abort')) {
      console.warn(`[digest-skill] ✗ ${feed.name}: ${msg}`);
    } else {
      console.warn(`[digest-skill] ✗ ${feed.name}: timeout`);
    }
    return [];
  }
}

async function fetchAllFeeds(feeds: FeedConfig[]): Promise<Article[]> {
  const allArticles: Article[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < feeds.length; i += FEED_CONCURRENCY) {
    const batch = feeds.slice(i, i + FEED_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(fetchFeed));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        allArticles.push(...result.value);
        successCount++;
      } else {
        failCount++;
      }
    }

    const progress = Math.min(i + FEED_CONCURRENCY, feeds.length);
    console.log(`[digest-skill] Progress: ${progress}/${feeds.length} feeds processed (${successCount} ok, ${failCount} failed)`);
  }

  console.log(`[digest-skill] Fetched ${allArticles.length} articles from ${successCount} feeds (${failCount} failed)`);
  return allArticles;
}

function buildSkillPackage(params: {
  lang: 'zh' | 'en';
  topN: number;
  hours: number;
  recentArticles: Article[];
  scoringTemplate: string;
  summaryTemplate: string;
  highlightsTemplate: string;
}): string {
  const { lang, topN, hours, recentArticles, scoringTemplate, summaryTemplate, highlightsTemplate } = params;
  const langNote = lang === 'zh' ? '中文' : 'English';
  const candidateCount = Math.min(Math.max(topN * CANDIDATE_MULTIPLIER, MIN_CANDIDATE_COUNT), recentArticles.length);
  const candidates = recentArticles.slice(0, candidateCount);

  const articleData = candidates
    .map((a, idx) => [
      `Index ${idx}`,
      `Title: ${a.title}`,
      `Source: ${a.sourceName}`,
      `PublishedAt: ${a.pubDate.toISOString()}`,
      `URL: ${a.link}`,
      `Description: ${a.description}`,
    ].join('\n'))
    .join('\n\n---\n\n');

  const scoringPrompt = scoringTemplate.replace('{{ARTICLES_LIST}}', articleData);
  const summaryLangInstruction = lang === 'zh'
    ? '请用中文撰写摘要和推荐理由。如果原文是英文，请翻译为中文。标题翻译也用中文。'
    : 'Write summaries, reasons, and title translations in English.';
  const summaryPrompt = summaryTemplate
    .replace('{{LANG_INSTRUCTION}}', summaryLangInstruction)
    .replace('{{ARTICLES_LIST}}', articleData);

  return `# AI Daily Digest · Skill Task Package

> 此文件用于 **AI 客户端 Skill 模式**。脚本仅负责抓取和整理文章数据，后续评分、摘要、看点由当前会话中的 AI 直接处理（不走外部 API 调用）。

## 任务目标

- 时间窗口：最近 ${hours} 小时
- 候选文章：${candidateCount} 篇（按时间倒序）
- 输出语言：${langNote}
- 最终精选：Top ${topN}

## 执行步骤（给 AI）

1. 阅读下方“文章数据”。
2. 使用“评分 Prompt 模板”对每篇文章打分与分类，输出 JSON（字段与模板一致）。
3. 按总分排序，选出 Top ${topN}。
4. 使用“摘要 Prompt 模板”对 Top ${topN} 生成标题翻译、摘要、推荐理由。
5. 使用“今日看点 Prompt 模板”基于 Top ${topN} 生成 2-3 条宏观趋势看点。
6. 最终按现有日报结构输出 Markdown 报告。

## 文章数据

${articleData}

## 评分 Prompt 模板

\`\`\`md
${scoringPrompt}
\`\`\`

## 摘要 Prompt 模板

\`\`\`md
${summaryPrompt}
\`\`\`

## 今日看点 Prompt 模板

\`\`\`md
${highlightsTemplate}
\`\`\`
`;
}

function printUsage(): void {
  console.log(`AI Daily Digest (Skill Mode) - Generate article package for AI client processing

Usage:
  bun scripts/digest-skill.ts [options]

Options:
  --hours <n>       Time range in hours (default: 48)
  --top-n <n>       Number of top articles AI should keep (default: 15)
  --lang <lang>     Output language hint: zh or en (default: zh)
  --output <path>   Output task package path (default: ./digest-skill-YYYYMMDD.md)
  --help            Show this help
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage();

  let hours = 48;
  let topN = 15;
  let lang: 'zh' | 'en' = 'zh';
  let outputPath = '';

  const readNextValue = (index: number, flag: string): string => {
    const next = args[index + 1];
    if (!next) {
      console.error(`[digest-skill] Error: ${flag} requires a value.`);
      process.exit(1);
    }
    return next;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--hours') {
      const raw = readNextValue(i, '--hours');
      const value = parseInt(raw, 10);
      if (Number.isNaN(value) || value <= 0) {
        console.error('[digest-skill] Error: --hours must be a positive integer.');
        process.exit(1);
      }
      hours = value;
      i++;
    } else if (arg === '--top-n') {
      const raw = readNextValue(i, '--top-n');
      const value = parseInt(raw, 10);
      if (Number.isNaN(value) || value <= 0) {
        console.error('[digest-skill] Error: --top-n must be a positive integer.');
        process.exit(1);
      }
      topN = value;
      i++;
    } else if (arg === '--lang') {
      const value = readNextValue(i, '--lang');
      if (value !== 'zh' && value !== 'en') {
        console.error('[digest-skill] Error: --lang must be "zh" or "en".');
        process.exit(1);
      }
      lang = value;
      i++;
    } else if (arg === '--output') {
      outputPath = readNextValue(i, '--output');
      i++;
    }
  }

  if (!outputPath) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    outputPath = `./digest-skill-${dateStr}.md`;
  }

  console.log(`[digest-skill] Loading feeds config...`);
  const feeds = await loadFeeds();
  console.log(`[digest-skill] Fetching ${feeds.length} RSS feeds...`);
  const allArticles = await fetchAllFeeds(feeds);
  if (allArticles.length === 0) {
    console.error('[digest-skill] Error: No articles fetched from any feed.');
    process.exit(1);
  }

  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const recentArticles = allArticles
    .filter(a => a.pubDate.getTime() > cutoffTime.getTime())
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  if (recentArticles.length === 0) {
    console.error(`[digest-skill] Error: No articles found within the last ${hours} hours.`);
    process.exit(1);
  }

  console.log(`[digest-skill] Building task package...`);
  const taskPackage = buildSkillPackage({
    lang,
    topN,
    hours,
    recentArticles,
    scoringTemplate: SCORING_TEMPLATE,
    summaryTemplate: SUMMARY_TEMPLATE,
    highlightsTemplate: HIGHLIGHTS_TEMPLATE,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, taskPackage);

  console.log(`[digest-skill] ✅ Done!`);
  console.log(`[digest-skill] 📁 Task package: ${outputPath}`);
  console.log(`[digest-skill] 📊 Stats: ${allArticles.length} fetched → ${recentArticles.length} recent`);
}

await main().catch((err) => {
  console.error(`[digest-skill] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
