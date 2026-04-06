import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

const FEED_FETCH_TIMEOUT_MS = 15_000;
const FEED_CONCURRENCY = 10;
const SCRIPT_DIR = import.meta.dir;
const MAX_DESCRIPTION_LENGTH = 500;
const CANDIDATE_MULTIPLIER = 4;
const MIN_CANDIDATE_COUNT = 60;

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
}): string {
  const { lang, topN, hours, recentArticles } = params;
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

  return `# AI Daily Digest · 文章数据包

> 此文件由 \`digest-skill.ts\` 生成，仅包含抓取到的文章数据。
> 评分、摘要、今日看点的处理逻辑请参阅 \`prompts/\` 目录下的对应文件。

## 任务参数

- 时间窗口：最近 ${hours} 小时
- 候选文章：${candidateCount} 篇（按时间倒序）
- 输出语言：${langNote}
- 最终精选：Top ${topN}

## 文章数据

${articleData}
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
