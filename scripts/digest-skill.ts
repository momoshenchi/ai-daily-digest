import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

const FEED_FETCH_TIMEOUT_MS = 15_000;
const FEED_CONCURRENCY = 10;
const SCRIPT_DIR = import.meta.dir;

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

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
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

function getAttrValue(xml: string, tagName: string, attrName: string): string {
  const pattern = new RegExp(`<${tagName}[^>]*\\s${attrName}=["']([^"']*)["'][^>]*/?>`, 'i');
  const match = xml.match(pattern);
  return match?.[1] || '';
}

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;
  return null;
}

function parseRSSItems(xml: string): Array<{ title: string; link: string; pubDate: string; description: string }> {
  const items: Array<{ title: string; link: string; pubDate: string; description: string }> = [];
  const isAtom = (xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"')) || xml.includes('<feed ');

  if (isAtom) {
    const entryPattern = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    let entryMatch;
    while ((entryMatch = entryPattern.exec(xml)) !== null) {
      const entryXml = entryMatch[1];
      const title = stripHtml(getTagContent(entryXml, 'title'));
      let link = getAttrValue(entryXml, 'link[^>]*rel="alternate"', 'href');
      if (!link) link = getAttrValue(entryXml, 'link', 'href');
      const pubDate = getTagContent(entryXml, 'published') || getTagContent(entryXml, 'updated');
      const description = stripHtml(getTagContent(entryXml, 'summary') || getTagContent(entryXml, 'content'));
      if (title || link) items.push({ title, link, pubDate, description: description.slice(0, 500) });
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
      if (title || link) items.push({ title, link, pubDate, description: description.slice(0, 500) });
    }
  }

  return items;
}

async function loadFeeds(): Promise<FeedConfig[]> {
  const feedsPath = join(SCRIPT_DIR, '..', 'config', 'feeds.json');
  const data = await readFile(feedsPath, 'utf-8');
  return JSON.parse(data) as FeedConfig[];
}

async function loadPromptTemplate(name: string): Promise<string> {
  const promptPath = join(SCRIPT_DIR, '..', 'prompts', `${name}.md`);
  return readFile(promptPath, 'utf-8');
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
  const candidateCount = Math.min(Math.max(topN * 4, 60), recentArticles.length);
  const candidates = recentArticles.slice(0, candidateCount);

  const articleData = candidates
    .map((a, idx) => [
      `Index ${idx}`,
      `Title: ${a.title}`,
      `Source: ${a.sourceName}`,
      `PublishedAt: ${a.pubDate.toISOString()}`,
      `URL: ${a.link}`,
      `Description: ${a.description.slice(0, 500)}`,
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

function printUsage(): never {
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--hours' && args[i + 1]) {
      hours = parseInt(args[++i]!, 10);
    } else if (arg === '--top-n' && args[i + 1]) {
      topN = parseInt(args[++i]!, 10);
    } else if (arg === '--lang' && args[i + 1]) {
      lang = args[++i] as 'zh' | 'en';
    } else if (arg === '--output' && args[i + 1]) {
      outputPath = args[++i]!;
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

  console.log(`[digest-skill] Loading prompt templates...`);
  const [scoringTemplate, summaryTemplate, highlightsTemplate] = await Promise.all([
    loadPromptTemplate('scoring'),
    loadPromptTemplate('summary'),
    loadPromptTemplate('highlights'),
  ]);

  const taskPackage = buildSkillPackage({
    lang,
    topN,
    hours,
    recentArticles,
    scoringTemplate,
    summaryTemplate,
    highlightsTemplate,
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
