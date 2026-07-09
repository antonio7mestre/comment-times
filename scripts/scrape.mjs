import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dataDir = path.join(root, "data");
const timeZone = "America/New_York";
const userAgent =
  "The Comment Times/0.1 personal reader scraper; polite low-concurrency fetches";
const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const nytSource = {
  id: "nytimes",
  name: "The New York Times",
  domain: "nytimes.com",
};
const wsjSource = {
  id: "wsj",
  name: "The Wall Street Journal",
  domain: "wsj.com",
};
const wapoSource = {
  id: "wapo",
  name: "The Washington Post",
  domain: "washingtonpost.com",
};

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

await loadDotEnv(path.join(root, ".env"));

const args = new Set(process.argv.slice(2));
const past24Hours = args.has("--past-24h") || args.has("--rolling-24h") || process.env.SCRAPE_PAST_24H === "1";
const deepScrape = args.has("--deep") || args.has("--all") || process.env.SCRAPE_DEEP === "1";
const todayOnly = args.has("--today-only") || process.env.SCRAPE_TODAY_ONLY === "1";
const windowHours = clampNumber(process.env.SCRAPE_WINDOW_HOURS, 24, 1, 168);
const windowEnd = new Date();
const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
const scanAllCandidates = past24Hours || deepScrape;
const nytCookie = (process.env.NYT_COOKIE || "").trim();
const wsjCookie = (process.env.WSJ_COOKIE || "").trim();
const articleTarget = clampNumber(process.env.SCRAPE_ARTICLE_TARGET, deepScrape ? 250 : 100, 1, 250);
const nytArticleTarget = clampNumber(process.env.NYT_ARTICLE_TARGET, articleTarget, 1, 250);
const wsjArticleTarget = clampNumber(process.env.WSJ_ARTICLE_TARGET, deepScrape ? 300 : 40, 1, 300);
const wsjCandidateLimit = clampNumber(process.env.WSJ_CANDIDATE_LIMIT, deepScrape ? 800 : 220, 20, 800);
const wsjConcurrency = clampNumber(process.env.WSJ_CONCURRENCY, 8, 1, 12);
const wsjSpotId = (process.env.WSJ_OPENWEB_SPOT_ID || "sp_92LbaOI5").trim();
const wapoArticleTarget = clampNumber(process.env.WAPO_ARTICLE_TARGET, deepScrape ? 300 : 40, 1, 300);
const wapoCandidateLimit = clampNumber(process.env.WAPO_CANDIDATE_LIMIT, deepScrape ? 800 : 220, 20, 800);
const wapoConcurrency = clampNumber(process.env.WAPO_CONCURRENCY, 8, 1, 12);
const wapoMetadataConcurrency = clampNumber(process.env.WAPO_METADATA_CONCURRENCY, 6, 1, 8);
const commentConcurrency = clampNumber(process.env.COMMENT_CONCURRENCY, 12, 1, 15);
const oembedConcurrency = clampNumber(process.env.OEMBED_CONCURRENCY, 6, 1, 6);
const thumbnailBuffer = clampNumber(process.env.THUMBNAIL_BUFFER, 20, 0, 80);
const commentCollectionTarget = nytArticleTarget + thumbnailBuffer;
const commentLimit = clampNumber(process.env.COMMENT_LIMIT, deepScrape ? 8 : 3, 1, 25);
const commentsToStore = clampNumber(process.env.COMMENTS_TO_STORE, deepScrape ? commentLimit : 2, 1, 25);
const authEmptyScanLimit = 60;
const forceScrape = args.has("--force") || process.env.FORCE_SCRAPE === "1";

if (!nytCookie) {
  fail(
    "NYT_COOKIE is missing. Copy the full Cookie header from nytimes.com while logged in, add it to .env, then rerun npm run scrape.",
  );
}

if (!nytCookie.includes("NYT-S=")) {
  console.warn("Warning: NYT_COOKIE does not appear to contain NYT-S. The community API may reject it.");
}

await mkdir(dataDir, { recursive: true });

const today = dateInTimeZone(new Date(), timeZone);
const yesterday = addDays(today, -1);
const days = past24Hours ? datesInTimeZoneRange(windowStart, windowEnd, timeZone) : todayOnly ? [today] : [yesterday, today];
const outputPath = path.join(dataDir, `${today}.json`);
const latestPath = path.join(dataDir, "latest.json");

if ((await exists(outputPath)) && !forceScrape) {
  await copyFile(outputPath, latestPath);
  console.log(`data/${today}.json already exists; copied it to data/latest.json and skipped refetching.`);
  console.log("Use npm run scrape -- --force to rebuild today's file.");
  process.exit(0);
}

const nytStats = {
  sitemapFailures: 0,
  candidates: 0,
  articlesScanned: 0,
  commentedArticles: 0,
  commentsCollected: 0,
  commentFailures: 0,
  oembedFailures: 0,
  metadataFailures: 0,
  outsideWindow: 0,
  droppedNoThumbnail: 0,
};
const wsjStats = {
  sitemapFailures: 0,
  candidates: 0,
  articlesScanned: 0,
  commentedArticles: 0,
  commentsCollected: 0,
  commentFailures: 0,
  articleFailures: 0,
  outsideWindow: 0,
  skippedNoCookie: 0,
};
const wapoStats = {
  sitemapFailures: 0,
  candidates: 0,
  articlesScanned: 0,
  commentedArticles: 0,
  commentsCollected: 0,
  commentFailures: 0,
  metadataFailures: 0,
  outsideWindow: 0,
  droppedNoThumbnail: 0,
};

const nytArticles = await scrapeNytArticles(days);
const wsjArticles = await scrapeWsjArticles(days);
const wapoArticles = await scrapeWapoArticles(days);
const articles = [...nytArticles, ...wsjArticles, ...wapoArticles];

if (articles.length === 0) {
  fail("No articles with comments were collected. Nothing was written.");
}

const payload = {
  generatedAt: new Date().toISOString(),
  days,
  mode: {
    deep: deepScrape,
    past24Hours,
    scanAllCandidates,
    todayOnly,
    commentLimit,
    commentsToStore,
    windowEnd: past24Hours ? windowEnd.toISOString() : null,
    windowHours: past24Hours ? windowHours : null,
    windowStart: past24Hours ? windowStart.toISOString() : null,
  },
  sources: [nytSource, wsjSource, wapoSource],
  articles: articles.sort((a, b) => b.totalComments - a.totalComments),
};

await writeJsonAtomic(outputPath, payload);
await copyFile(outputPath, latestPath);

console.log("");
console.log("Scrape summary");
console.log(`- NYT candidate articles: ${nytStats.candidates}`);
console.log(`- NYT articles scanned by comments API: ${nytStats.articlesScanned}`);
console.log(`- NYT commented articles kept before thumbnails: ${nytStats.commentedArticles}`);
console.log(`- NYT final articles with thumbnails: ${nytArticles.length}`);
console.log(`- NYT comments collected: ${nytStats.commentsCollected}`);
console.log(`- NYT comment API failures: ${nytStats.commentFailures}`);
console.log(`- NYT oEmbed failures: ${nytStats.oembedFailures}`);
console.log(`- NYT metadata failures: ${nytStats.metadataFailures}`);
console.log(`- NYT skipped outside window: ${nytStats.outsideWindow}`);
console.log(`- NYT dropped without thumbnail: ${nytStats.droppedNoThumbnail}`);
console.log(`- WSJ candidate articles: ${wsjStats.candidates}`);
console.log(`- WSJ articles scanned: ${wsjStats.articlesScanned}`);
console.log(`- WSJ final articles with comments: ${wsjArticles.length}`);
console.log(`- WSJ comments collected: ${wsjStats.commentsCollected}`);
console.log(`- WSJ article metadata failures: ${wsjStats.articleFailures}`);
console.log(`- WSJ OpenWeb failures: ${wsjStats.commentFailures}`);
console.log(`- WSJ skipped outside window: ${wsjStats.outsideWindow}`);
console.log(`- WaPo candidate articles: ${wapoStats.candidates}`);
console.log(`- WaPo articles scanned: ${wapoStats.articlesScanned}`);
console.log(`- WaPo final articles with comments: ${wapoArticles.length}`);
console.log(`- WaPo comments collected: ${wapoStats.commentsCollected}`);
console.log(`- WaPo comment API failures: ${wapoStats.commentFailures}`);
console.log(`- WaPo metadata failures: ${wapoStats.metadataFailures}`);
console.log(`- WaPo skipped outside window: ${wapoStats.outsideWindow}`);
console.log(`- WaPo dropped without thumbnail: ${wapoStats.droppedNoThumbnail}`);
console.log(`- Wrote data/${today}.json and data/latest.json`);

async function scrapeNytArticles(targetDays) {
  console.log(`Discovering NYT article URLs for ${targetDays.join(" and ")} (${timeZone}).`);
  const sitemapResults = await Promise.allSettled(targetDays.map(fetchSitemapDay));
  const candidateUrls = unique(
    sitemapResults.flatMap((result) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      nytStats.sitemapFailures += 1;
      console.warn(`NYT sitemap fetch failed: ${result.reason.message}`);
      return [];
    }),
  );

  nytStats.candidates = candidateUrls.length;
  console.log(`Found ${candidateUrls.length} NYT candidate article URLs after filtering.`);

  if (candidateUrls.length === 0) {
    throw new Error("No NYT article URLs were discovered from the date sitemaps.");
  }

  const commentedArticles = await collectCommentedArticles(
    prioritizeCandidates(candidateUrls, candidateSearchText, { shuffleGroups: true }),
  );

  if (commentedArticles.length < nytArticleTarget) {
    console.warn(
      `Warning: found ${commentedArticles.length} NYT commented articles, below the target of ${nytArticleTarget}. Proceeding with what exists.`,
    );
  }

  console.log(`Fetching NYT oEmbed metadata and thumbnails for ${commentedArticles.length} articles.`);
  const enrichedArticles = await enrichArticles(commentedArticles);

  if (enrichedArticles.length < nytArticleTarget) {
    console.warn(
      `Warning: ${enrichedArticles.length} NYT articles with thumbnails remained, below the target of ${nytArticleTarget}.`,
    );
  }

  return scanAllCandidates ? enrichedArticles : enrichedArticles.slice(0, nytArticleTarget);
}

async function collectCommentedArticles(urls) {
  const kept = [];

  for (
    let offset = 0;
    offset < urls.length && (scanAllCandidates || kept.length < commentCollectionTarget);
    offset += commentConcurrency
  ) {
    const batch = urls.slice(offset, offset + commentConcurrency);
    const settled = await Promise.allSettled(batch.map((url) => fetchReaderPicks(url)));

    for (const result of settled) {
      nytStats.articlesScanned += 1;

      if (result.status === "rejected") {
        if (result.reason instanceof AuthError) {
          throw result.reason;
        }
        nytStats.commentFailures += 1;
        console.warn(`Comments request failed: ${result.reason.message}`);
        continue;
      }

      if (result.value.comments.length === 0) {
        continue;
      }

      kept.push(result.value);
      nytStats.commentedArticles = kept.length;
      nytStats.commentsCollected += result.value.comments.length;
    }

    if (nytStats.articlesScanned >= authEmptyScanLimit && kept.length === 0) {
      throw new AuthError(
        `Scanned ${nytStats.articlesScanned} articles and received zero reader comments. Your NYT_COOKIE is probably expired or missing subscriber access. Refresh the cookie and rerun npm run scrape.`,
      );
    }

    console.log(
      `Scanned ${nytStats.articlesScanned}/${urls.length}; kept ${kept.length} NYT commented articles.`,
    );

    if (!scanAllCandidates && kept.length >= commentCollectionTarget) {
      break;
    }

    await sleep(randomInt(80, 240));
  }

  if (kept.length === 0) {
    throw new AuthError(
      "The comments API returned no comments for every scanned article. Refresh NYT_COOKIE and try again.",
    );
  }

  return kept;
}

async function enrichArticles(commentedArticles) {
  const enriched = [];

  for (let offset = 0; offset < commentedArticles.length; offset += oembedConcurrency) {
    const batch = commentedArticles.slice(offset, offset + oembedConcurrency);
    const settled = await Promise.allSettled(
      batch.map(async (article) => {
        const metadata = await fetchOEmbed(article.url);
        if (!metadata) {
          return null;
        }

        const timeMetadata = {};
        const publishedAt = timeMetadata.publishedAt || "";
        const modifiedAt = timeMetadata.modifiedAt || "";

        if (past24Hours && publishedAt && !isWithinWindow(publishedAt)) {
          nytStats.outsideWindow += 1;
          return null;
        }

        return { ...article, ...metadata, modifiedAt, publishedAt: publishedAt || metadata.publishedAt || "" };
      }),
    );

    for (const result of settled) {
      if (result.status === "rejected") {
        nytStats.oembedFailures += 1;
        console.warn(`oEmbed request failed: ${result.reason.message}`);
        continue;
      }

      if (!result.value) {
        nytStats.droppedNoThumbnail += 1;
        continue;
      }

      enriched.push(result.value);
    }

    console.log(`Enriched ${Math.min(offset + batch.length, commentedArticles.length)}/${commentedArticles.length}.`);
    await sleep(150);
  }

  return enriched;
}

async function fetchNytArticleTimes(articleUrl) {
  try {
    const html = await fetchText(
      articleUrl,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: nytCookie,
          "User-Agent": browserUserAgent,
        },
      },
      { label: `NYT article metadata for ${articleUrl}`, retries: 1, timeoutMs: 15000 },
    );

    return {
      modifiedAt: articleTimestampFromHtml(html, ["dateModified", "article:modified_time", "article.modified"]),
      publishedAt: articleTimestampFromHtml(html, ["datePublished", "article:published_time", "article.published"]),
    };
  } catch (error) {
    nytStats.metadataFailures += 1;
    console.warn(`NYT article metadata request failed: ${error.message}`);
    return {};
  }
}

function articleTimestampFromHtml(html, names) {
  for (const name of names) {
    const value = metaProperty(html, name) || metaContent(html, name) || jsonLdDate(html, name);
    if (value) {
      return value;
    }
  }

  return "";
}

function jsonLdDate(html, name) {
  const key = name.includes(":") || name.includes(".") ? "" : name;
  if (!key) {
    return "";
  }

  const match = html.match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]+)"`, "i"));
  return cleanText(match?.[1] || "");
}

async function fetchSitemapDay(isoDate) {
  const [year, month, day] = isoDate.split("-");
  const url = `https://www.nytimes.com/sitemap/${year}/${month}/${day}/`;
  const html = await fetchText(url, {}, { label: `sitemap ${isoDate}`, retries: 1, timeoutMs: 15000 });
  const urls = extractArticleUrls(html);
  console.log(`- ${isoDate}: ${urls.length} candidate articles`);
  return urls;
}

function extractArticleUrls(html) {
  const articleUrlPattern = /https:\/\/www\.nytimes\.com\/\d{4}\/\d{2}\/\d{2}\/[^"'<\s]+?\.html/g;
  const excluded = ["/crosswords/", "/games/", "/podcasts/", "/video/", "/interactive/", "/espanol/"];

  return unique(Array.from(html.matchAll(articleUrlPattern), (match) => match[0]))
    .map((url) => url.replace(/&amp;/g, "&"))
    .filter((url) => !excluded.some((segment) => url.includes(segment)));
}

async function fetchReaderPicks(articleUrl) {
  const requestUrl = new URL("https://www.nytimes.com/svc/community/V3/requestHandler");
  const params = {
    method: "get",
    cmd: past24Hours ? "GetCommentsAll" : "GetCommentsReadersPicks",
    offset: "0",
    limit: String(commentLimit),
    url: articleUrl,
  };

  if (past24Hours) {
    params.sort = "newest";
  }

  requestUrl.search = new URLSearchParams(params).toString();

  const json = await fetchJson(
    requestUrl,
    {
      headers: {
        Accept: "application/json",
        Cookie: nytCookie,
        "User-Agent": userAgent,
      },
    },
    { label: `comments for ${articleUrl}`, retries: 1, timeoutMs: 18000 },
  );

  if (json.status !== "OK") {
    throw new AuthError(
      `NYT community API returned status ${JSON.stringify(json.status)} for ${articleUrl}. Refresh NYT_COOKIE and try again.`,
    );
  }

  const results = json.results || {};
  const comments = Array.isArray(results.comments) ? results.comments : [];
  const normalizedComments = comments.map(normalizeComment);
  const storedComments = (past24Hours
    ? normalizedComments.filter((comment) => isWithinWindow(comment.timestamp))
    : normalizedComments
  ).slice(0, commentsToStore);

  return {
    source: nytSource,
    url: articleUrl,
    totalComments: toNumber(results.totalCommentsFound),
    comments: storedComments,
  };
}

async function fetchOEmbed(articleUrl) {
  const requestUrl = new URL("https://www.nytimes.com/svc/oembed/json/");
  requestUrl.search = new URLSearchParams({ url: articleUrl }).toString();

  const json = await fetchJson(
    requestUrl,
    { headers: { Accept: "application/json", "User-Agent": userAgent } },
    { label: `oEmbed for ${articleUrl}`, retries: 1, timeoutMs: 15000 },
  );

  const thumbnail = String(json.thumbnail_url || "").trim();
  if (!thumbnail) {
    return null;
  }

  const parsedTitle = parseTitle(String(json.title || "").trim());

  return {
    title: parsedTitle.title || titleFromUrl(articleUrl),
    byline: stripLeadingBy(String(json.author_name || "").trim()),
    publishedAt: cleanText(String(json.publication_date || "")),
    summary: cleanText(String(json.summary || "")),
    section: parsedTitle.section || sectionFromUrl(articleUrl),
    thumbnail,
  };
}

async function scrapeWsjArticles(targetDays) {
  if (!wsjCookie) {
    wsjStats.skippedNoCookie = 1;
    console.warn("WSJ_COOKIE is missing; skipping WSJ. Add a logged-in wsj.com Cookie header to .env to include WSJ in the same scrape.");
    return [];
  }

  console.log(`Discovering WSJ article URLs for ${targetDays.join(" and ")} (${timeZone}).`);
  const candidates = await discoverWsjCandidates(targetDays);
  wsjStats.candidates = candidates.length;
  console.log(`Found ${candidates.length} WSJ candidate article URLs after filtering.`);

  if (candidates.length === 0) {
    return [];
  }

  const kept = [];

  for (
    let offset = 0;
    offset < candidates.length && (scanAllCandidates || kept.length < wsjArticleTarget);
    offset += wsjConcurrency
  ) {
    const batch = candidates.slice(offset, offset + wsjConcurrency);
    const settled = await Promise.allSettled(batch.map((candidate) => fetchWsjArticleWithComments(candidate)));

    for (const result of settled) {
      wsjStats.articlesScanned += 1;

      if (result.status === "rejected") {
        wsjStats.articleFailures += 1;
        console.warn(`WSJ article scan failed: ${result.reason.message}`);
        continue;
      }

      if (!result.value) {
        continue;
      }

      kept.push(result.value);
      wsjStats.commentedArticles = kept.length;
      wsjStats.commentsCollected += result.value.comments.length;
    }

    console.log(`Scanned ${wsjStats.articlesScanned}/${candidates.length}; kept ${kept.length} WSJ commented articles.`);
    await sleep(randomInt(120, 360));
  }

  if (kept.length < wsjArticleTarget) {
    console.warn(`Warning: found ${kept.length} WSJ articles with comments, below the target of ${wsjArticleTarget}.`);
  }

  return scanAllCandidates ? kept : kept.slice(0, wsjArticleTarget);
}

async function discoverWsjCandidates(targetDays) {
  const daySet = new Set(targetDays);
  const months = unique(targetDays.map((day) => day.slice(0, 7)));
  const settled = await Promise.allSettled(months.map(fetchWsjSitemapMonth));
  const candidates = settled.flatMap((result) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    wsjStats.sitemapFailures += 1;
    console.warn(`WSJ sitemap fetch failed: ${result.reason.message}`);
    return [];
  });

  const byUrl = new Map();
  for (const candidate of candidates) {
    const lastmodDay = candidate.lastmod.slice(0, 10);
    if (past24Hours ? !isWithinWindow(candidate.lastmod) : lastmodDay && !daySet.has(lastmodDay)) {
      continue;
    }
    if (!isLikelyWsjArticleUrl(candidate.url)) {
      continue;
    }
    byUrl.set(candidate.url, candidate);
  }

  const sortedCandidates = Array.from(byUrl.values())
    .sort((a, b) => {
      const opinionDelta = Number(!a.url.includes("/opinion/")) - Number(!b.url.includes("/opinion/"));
      if (opinionDelta !== 0) {
        return opinionDelta;
      }
      return String(b.lastmod).localeCompare(String(a.lastmod));
    });

  const prioritizedCandidates = prioritizeCandidates(sortedCandidates, candidateSearchText, { shuffleGroups: false });
  return scanAllCandidates ? prioritizedCandidates : prioritizedCandidates.slice(0, wsjCandidateLimit);
}

async function fetchWsjSitemapMonth(yearMonth) {
  const [year, month] = yearMonth.split("-");
  const url = `https://www.wsj.com/sitemaps/web/wsj/en/sitemap_wsj_en_m${Number(month)}_${year}.xml`;
  const xml = await fetchText(
    url,
    { headers: { Accept: "application/xml,text/xml,*/*", "User-Agent": userAgent } },
    { label: `WSJ sitemap ${yearMonth}`, retries: 1, timeoutMs: 15000 },
  );
  const entries = parseWsjSitemapEntries(xml);
  console.log(`- WSJ ${yearMonth}: ${entries.length} sitemap articles`);
  return entries;
}

function parseWsjSitemapEntries(xml) {
  return Array.from(xml.matchAll(/<url>([\s\S]*?)<\/url>/g), (match) => {
    const block = match[1];
    return {
      url: decodeEntities(matchXmlTag(block, "loc")),
      lastmod: cleanText(matchXmlTag(block, "lastmod")),
      thumbnail: decodeEntities(matchXmlTag(block, "image:loc")),
    };
  }).filter((entry) => entry.url);
}

function isLikelyWsjArticleUrl(articleUrl) {
  try {
    const parsed = new URL(articleUrl);
    const pathname = parsed.pathname;
    const excluded = ["/news/collection/", "/video/", "/podcasts/", "/market-data/", "/rankings/"];
    return parsed.hostname === "www.wsj.com"
      && /-[a-f0-9]{8,}$/.test(pathname)
      && !excluded.some((segment) => pathname.includes(segment));
  } catch {
    return false;
  }
}

async function fetchWsjArticleWithComments(candidate) {
  const metadata = await fetchWsjArticleMetadata(candidate);
  if (!metadata.articleId || metadata.commenting !== "enabled" || metadata.coral !== "true") {
    return null;
  }

  const windowTimestamp = metadata.publishedAt || metadata.modifiedAt || candidate.lastmod;
  if (past24Hours && windowTimestamp && !isWithinWindow(windowTimestamp)) {
    wsjStats.outsideWindow += 1;
    return null;
  }

  const discussion = await fetchWsjOpenWebComments(metadata.articleId);
  if (discussion.comments.length === 0) {
    return null;
  }

  const thumbnail = metadata.thumbnail || candidate.thumbnail;
  if (!thumbnail) {
    return null;
  }

  return {
    source: wsjSource,
    url: metadata.url,
    title: metadata.title,
    byline: metadata.byline,
    summary: metadata.summary,
    section: metadata.section,
    thumbnail,
    modifiedAt: metadata.modifiedAt || candidate.lastmod,
    publishedAt: metadata.publishedAt || "",
    totalComments: discussion.totalComments,
    comments: discussion.comments,
  };
}

async function fetchWsjArticleMetadata(candidate) {
  const html = await fetchText(
    candidate.url,
    {
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Cookie: wsjCookie,
        Pragma: "no-cache",
        Priority: "u=0, i",
        Referer: "https://www.wsj.com/",
        "Sec-CH-UA": '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": browserUserAgent,
      },
    },
    {
      authMessage: "WSJ article metadata was rejected. Refresh WSJ_COOKIE from a logged-in wsj.com session and rerun npm run scrape.",
      label: `WSJ article metadata for ${candidate.url}`,
      retries: 1,
      timeoutMs: 18000,
    },
  );

  if (/captcha-delivery\.com|geo\.captcha/i.test(html)) {
    throw new AuthError("WSJ returned a captcha page. Refresh WSJ_COOKIE from your logged-in browser session.");
  }

  const title = metaContent(html, "article.headline") || metaProperty(html, "og:title") || titleFromUrl(candidate.url);
  const summary = metaContent(html, "article.summary") || metaContent(html, "description");

  return {
    articleId: metaContent(html, "article.id") || metaContent(html, "parsely-post-id") || metaContent(html, "cXenseParse:articleid"),
    byline: parseWsjByline(html),
    commenting: metaContent(html, "cXenseParse:wsj-commenting"),
    coral: metaContent(html, "cXenseParse:wsj-coral"),
    modifiedAt: articleTimestampFromHtml(html, ["dateModified", "article:modified_time", "article.modified"]),
    publishedAt: articleTimestampFromHtml(html, ["datePublished", "article:published_time", "article.published"]),
    section: metaContent(html, "article.section") || sectionFromWsjUrl(candidate.url),
    summary: cleanText(summary),
    thumbnail: metaProperty(html, "og:image") || metaContent(html, "twitter:image") || candidate.thumbnail,
    title: cleanText(title.replace(/\s+-\s+WSJ$/i, "")),
    url: canonicalUrl(html) || candidate.url,
  };
}

async function fetchWsjOpenWebComments(articleId) {
  const baseUrl = "https://api-2-0.spot.im";
  const deviceId = await fetchWsjOpenWebDeviceId(baseUrl);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://www.wsj.com",
    Referer: "https://www.wsj.com/",
    "User-Agent": browserUserAgent,
    "x-host-auth-version": "3",
    "x-post-id": articleId,
    "x-spot-id": wsjSpotId,
    "x-spotim-device-uuid": deviceId,
  };

  const guest = await fetchJson(
    `${baseUrl}/v1.0.0/guests/token`,
    { body: "{}", headers, method: "POST" },
    {
      authMessage: "OpenWeb guest-token request was rejected for WSJ.",
      label: `WSJ OpenWeb guest token for ${articleId}`,
      retries: 1,
      timeoutMs: 15000,
    },
  );

  const accessToken = String(guest.accessToken || "").trim();
  if (!accessToken) {
    throw new Error(`WSJ OpenWeb guest token for ${articleId} was empty.`);
  }

  const json = await fetchJson(
    `${baseUrl}/v1.0.0/conversation/read`,
    {
      body: JSON.stringify({
        child_count: 1,
        count: commentLimit,
        depth: 1,
        offset: 0,
        sort_by: past24Hours ? "newest" : "best",
      }),
      headers: { ...headers, "x-access-token": accessToken },
      method: "POST",
    },
    {
      authMessage: "OpenWeb comments request was rejected for WSJ.",
      label: `WSJ OpenWeb comments for ${articleId}`,
      retries: 1,
      timeoutMs: 15000,
    },
  );

  const conversation = json.conversation || {};
  const users = conversation.users || {};
  const comments = Array.isArray(conversation.comments) ? conversation.comments : [];
  const normalizedComments = comments
    .filter((comment) => comment && comment.depth === 0 && comment.status === "approved")
    .map((comment) => normalizeWsjComment(comment, users));

  return {
    totalComments: toNumber(conversation.messages_count || conversation.comments_count),
    comments: (past24Hours
      ? normalizedComments.filter((comment) => isWithinWindow(comment.timestamp))
      : normalizedComments
    ).slice(0, commentsToStore),
  };
}

async function fetchWsjOpenWebDeviceId(baseUrl) {
  if (fetchWsjOpenWebDeviceId.cached) {
    return fetchWsjOpenWebDeviceId.cached;
  }
  if (fetchWsjOpenWebDeviceId.promise) {
    return fetchWsjOpenWebDeviceId.promise;
  }

  fetchWsjOpenWebDeviceId.promise = fetchText(
    `${baseUrl}/v1.0.0/device-load`,
    {
      headers: {
        Accept: "text/plain,*/*",
        Origin: "https://www.wsj.com",
        Referer: "https://www.wsj.com/",
        "User-Agent": browserUserAgent,
      },
    },
    {
      authMessage: "OpenWeb device-id request was rejected for WSJ.",
      label: "WSJ OpenWeb device id",
      retries: 1,
      timeoutMs: 12000,
    },
  ).then((deviceId) => {
    fetchWsjOpenWebDeviceId.cached = cleanText(deviceId);
    return fetchWsjOpenWebDeviceId.cached;
  }).finally(() => {
    fetchWsjOpenWebDeviceId.promise = null;
  });

  return fetchWsjOpenWebDeviceId.promise;
}

function normalizeWsjComment(comment, users) {
  const user = users[comment.user_id] || {};
  const body = normalizeCommentBody(
    Array.isArray(comment.content)
      ? comment.content.map((part) => part?.text || "").join("\n\n")
      : comment.content || "",
  );

  return {
    name: cleanText(user.display_name || comment.user_display_name || "WSJ reader"),
    location: cleanText(user.location || ""),
    body,
    recommendations: toNumber(comment.rank?.ranks_up),
    replyCount: toNumber(comment.total_replies_count || comment.replies_count),
    timestamp: toNumber(comment.written_at || comment.time),
    timesPick: Boolean(comment.featured || comment.top_featured),
  };
}

async function scrapeWapoArticles(targetDays) {
  console.log(`Discovering WaPo article URLs for ${targetDays.join(" and ")} (${timeZone}).`);
  const candidates = await discoverWapoCandidates(targetDays);
  wapoStats.candidates = candidates.length;
  console.log(`Found ${candidates.length} WaPo candidate article URLs after filtering.`);

  if (candidates.length === 0) {
    return [];
  }

  const commentedArticles = [];

  for (
    let offset = 0;
    offset < candidates.length && (scanAllCandidates || commentedArticles.length < wapoArticleTarget);
    offset += wapoConcurrency
  ) {
    const batch = candidates.slice(offset, offset + wapoConcurrency);
    const settled = await Promise.allSettled(batch.map((candidate) => fetchWapoArticleWithComments(candidate)));

    for (const result of settled) {
      wapoStats.articlesScanned += 1;

      if (result.status === "rejected") {
        wapoStats.commentFailures += 1;
        console.warn(`WaPo article scan failed: ${result.reason.message}`);
        continue;
      }

      if (!result.value) {
        continue;
      }

      commentedArticles.push(result.value);
      wapoStats.commentedArticles = commentedArticles.length;
      wapoStats.commentsCollected += result.value.comments.length;
    }

    console.log(`Scanned ${wapoStats.articlesScanned}/${candidates.length}; kept ${commentedArticles.length} WaPo commented articles.`);
    await sleep(randomInt(120, 360));
  }

  if (commentedArticles.length < wapoArticleTarget) {
    console.warn(`Warning: found ${commentedArticles.length} WaPo articles with comments, below the target of ${wapoArticleTarget}.`);
  }

  console.log(`Fetching WaPo metadata and thumbnails for ${commentedArticles.length} articles.`);
  const enrichedArticles = await enrichWapoArticles(commentedArticles);

  if (enrichedArticles.length < Math.min(commentedArticles.length, wapoArticleTarget)) {
    console.warn(`Warning: ${enrichedArticles.length} WaPo articles with thumbnails remained.`);
  }

  return scanAllCandidates ? enrichedArticles : enrichedArticles.slice(0, wapoArticleTarget);
}

async function discoverWapoCandidates(targetDays) {
  const daySet = new Set(targetDays);

  try {
    const entries = await fetchWapoNewsSitemap(targetDays);
    const byUrl = new Map();

    for (const entry of entries) {
      const publishedDay = entry.published.slice(0, 10) || entry.lastmod.slice(0, 10);
      if (past24Hours ? !isWithinWindow(entry.published || entry.lastmod) : publishedDay && !daySet.has(publishedDay)) {
        continue;
      }
      if (!isLikelyWapoArticleUrl(entry.url)) {
        continue;
      }
      byUrl.set(entry.url, entry);
    }

    const sortedCandidates = Array.from(byUrl.values())
      .sort((a, b) => String(b.published || b.lastmod).localeCompare(String(a.published || a.lastmod)));

    const prioritizedCandidates = prioritizeCandidates(sortedCandidates, candidateSearchText, { shuffleGroups: false });
    return scanAllCandidates ? prioritizedCandidates : prioritizedCandidates.slice(0, wapoCandidateLimit);
  } catch (error) {
    wapoStats.sitemapFailures += 1;
    console.warn(`WaPo sitemap fetch failed: ${error.message}`);
    return [];
  }
}

async function fetchWapoNewsSitemap(targetDays) {
  try {
    const entries = await fetchWapoSitemapEntries(
      "https://www.washingtonpost.com/sitemaps/news-sitemap.xml.gz",
      "WaPo news sitemap",
    );

    if (entries.length > 0) {
      return entries;
    }

    console.warn("WaPo news sitemap returned no article URLs; trying monthly sitemap fallback.");
  } catch (error) {
    console.warn(`WaPo news sitemap failed: ${error.message}; trying monthly sitemap fallback.`);
  }

  const indexXml = await fetchWapoSitemapText(
    "https://www.washingtonpost.com/sitemaps/sitemap.xml.gz",
    "WaPo sitemap index",
  );
  const targetMonths = new Set(targetDays.map((day) => day.slice(0, 7)));
  const monthlyUrls = parseSitemapIndexUrls(indexXml).filter((url) => {
    const month = url.match(/sitemap-(\d{4}-\d{2})\.xml(?:\.gz)?$/)?.[1] || "";
    return targetMonths.has(month);
  });

  if (monthlyUrls.length === 0) {
    throw new Error("WaPo sitemap index did not include any target-month article sitemaps.");
  }

  const settled = await Promise.allSettled(
    monthlyUrls.map((url) => fetchWapoSitemapEntries(url, `WaPo monthly sitemap ${url.split("/").pop()}`)),
  );
  const entries = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      entries.push(...result.value);
    } else {
      console.warn(`WaPo monthly sitemap fetch failed: ${result.reason.message}`);
    }
  }

  if (entries.length === 0) {
    throw new Error("WaPo monthly sitemap fallback returned no article URLs.");
  }

  console.log(`- WaPo monthly sitemap fallback: ${entries.length} articles`);
  return entries;
}

async function fetchWapoSitemapEntries(url, label) {
  const xml = await fetchWapoSitemapText(url, label);
  const entries = parseWapoSitemapEntries(xml);
  console.log(`- ${label}: ${entries.length} articles`);
  return entries;
}

async function fetchWapoSitemapText(url, label) {
  return fetchText(
    url,
    {
      headers: {
        Accept: "application/xml,text/xml,*/*",
        "User-Agent": browserUserAgent,
      },
    },
    { label, retries: 3, timeoutMs: 45000 },
  );
}

function parseWapoSitemapEntries(xml) {
  return Array.from(xml.matchAll(/<url>([\s\S]*?)<\/url>/g), (match) => {
    const block = match[1];
    return {
      lastmod: cleanText(matchXmlTag(block, "lastmod")),
      published: cleanText(matchXmlTag(block, "news:publication_date")),
      title: cleanText(decodeEntities(matchXmlTag(block, "news:title"))),
      url: decodeEntities(matchXmlTag(block, "loc")),
    };
  }).filter((entry) => entry.url);
}

function parseSitemapIndexUrls(xml) {
  return unique(
    Array.from(xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g), (match) => decodeEntities(match[1]).trim())
      .filter(Boolean),
  );
}

function isLikelyWapoArticleUrl(articleUrl) {
  try {
    const parsed = new URL(articleUrl);
    const pathname = parsed.pathname;
    const excluded = ["/video/", "/games/", "/crosswords/", "/recipes/", "/podcasts/"];
    return parsed.hostname === "www.washingtonpost.com"
      && /\/\d{4}\/\d{2}\/\d{2}\//.test(pathname)
      && !excluded.some((segment) => pathname.includes(segment));
  } catch {
    return false;
  }
}

async function fetchWapoArticleWithComments(candidate) {
  if (past24Hours && !isWithinWindow(candidate.published || candidate.lastmod)) {
    wapoStats.outsideWindow += 1;
    return null;
  }

  const discussion = await fetchWapoCoralComments(candidate.url);
  if (discussion.comments.length === 0) {
    return null;
  }

  return {
    source: wapoSource,
    url: discussion.url || candidate.url,
    title: candidate.title || titleFromUrl(candidate.url),
    byline: "",
    summary: "",
    section: sectionFromWapoUrl(candidate.url),
    thumbnail: "",
    modifiedAt: candidate.lastmod || "",
    publishedAt: candidate.published || "",
    totalComments: discussion.totalComments,
    comments: discussion.comments,
  };
}

async function fetchWapoCoralComments(articleUrl) {
  const query = `
    query WapoComments($url: String!, $first: Int!, $orderBy: COMMENT_SORT!) {
      story(url: $url) {
        id
        url
        commentsDisabled
        isClosed
        commentCounts {
          totalPublished
        }
        comments(first: $first, orderBy: $orderBy, topLevelOnly: true) {
          nodes {
            id
            body
            createdAt
            status
            depth
            replyCount
            author {
              username
            }
            actionCounts {
              reaction {
                total
              }
              allSentiments {
                total
              }
              sentimentUpVote {
                total
              }
            }
            tags {
              code
            }
          }
        }
      }
    }
  `;

  const json = await fetchJson(
    "https://talk.washingtonpost.com/api/graphql",
    {
      body: JSON.stringify({
        query,
        variables: {
          first: commentLimit,
          orderBy: past24Hours ? "CREATED_AT_DESC" : "RANK_DESC",
          url: articleUrl,
        },
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://talk.washingtonpost.com",
        Referer: "https://talk.washingtonpost.com/",
        "User-Agent": browserUserAgent,
      },
      method: "POST",
    },
    {
      authMessage: "WaPo Coral comments request was rejected.",
      label: `WaPo Coral comments for ${articleUrl}`,
      retries: 1,
      timeoutMs: 15000,
    },
  );

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(`WaPo Coral returned GraphQL errors for ${articleUrl}: ${json.errors.map((error) => error.message).join("; ")}`);
  }

  const story = json.data?.story;
  if (!story || story.commentsDisabled || toNumber(story.commentCounts?.totalPublished) === 0) {
    return { totalComments: 0, comments: [] };
  }

  const comments = Array.isArray(story.comments?.nodes) ? story.comments.nodes : [];
  const normalizedComments = comments
    .filter((comment) => comment && comment.status === "APPROVED" && comment.depth === 0 && comment.body)
    .map(normalizeWapoComment);

  return {
    totalComments: toNumber(story.commentCounts?.totalPublished),
    url: story.url || articleUrl,
    comments: (past24Hours
      ? normalizedComments.filter((comment) => isWithinWindow(comment.timestamp))
      : normalizedComments
    ).slice(0, commentsToStore),
  };
}

async function enrichWapoArticles(commentedArticles) {
  const enriched = [];

  for (let offset = 0; offset < commentedArticles.length; offset += wapoMetadataConcurrency) {
    const batch = commentedArticles.slice(offset, offset + wapoMetadataConcurrency);
    const settled = await Promise.allSettled(
      batch.map(async (article) => {
        const metadata = await fetchWapoArticleMetadata(article);
        return metadata ? { ...article, ...metadata } : null;
      }),
    );

    for (const result of settled) {
      if (result.status === "rejected") {
        wapoStats.metadataFailures += 1;
        console.warn(`WaPo metadata request failed: ${result.reason.message}`);
        continue;
      }

      if (!result.value) {
        wapoStats.droppedNoThumbnail += 1;
        continue;
      }

      enriched.push(result.value);
    }

    console.log(`Enriched ${Math.min(offset + batch.length, commentedArticles.length)}/${commentedArticles.length} WaPo articles.`);
    await sleep(150);
  }

  return enriched;
}

async function fetchWapoArticleMetadata(article) {
  const html = await fetchText(
    article.url,
    {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": browserUserAgent,
      },
    },
    {
      label: `WaPo metadata for ${article.url}`,
      retries: 1,
      timeoutMs: 18000,
    },
  );

  const thumbnail = metaProperty(html, "og:image") || metaProperty(html, "og_image") || metaContent(html, "twitter:image");
  if (!thumbnail) {
    return null;
  }

  return {
    byline: stripLeadingBy(metaContent(html, "og_author") || metaProperty(html, "article:author")),
    modifiedAt: metaProperty(html, "article:modified_time") || metaContent(html, "dateModified") || article.modifiedAt || "",
    publishedAt: metaProperty(html, "article:published_time") || metaContent(html, "datePublished") || article.publishedAt || "",
    section: metaProperty(html, "article:section") || metaProperty(html, "article_section") || article.section,
    summary: metaContent(html, "description") || metaProperty(html, "og:description") || article.summary,
    thumbnail,
    title: metaProperty(html, "og:title") || metaContent(html, "twitter:title") || article.title,
    url: canonicalUrl(html) || article.url,
  };
}

function normalizeWapoComment(comment) {
  const tags = Array.isArray(comment.tags) ? comment.tags : [];
  return {
    name: cleanText(comment.author?.username || "WaPo reader"),
    location: "",
    body: normalizeCommentBody(comment.body || ""),
    recommendations: toNumber(
      comment.actionCounts?.allSentiments?.total
        || comment.actionCounts?.sentimentUpVote?.total
        || comment.actionCounts?.reaction?.total,
    ),
    replyCount: toNumber(comment.replyCount),
    timestamp: timestampSeconds(comment.createdAt),
    timesPick: tags.some((tag) => /FEATURED|STAFF/i.test(String(tag?.code || ""))),
  };
}

async function fetchJson(url, options, settings) {
  const text = await fetchWithRetry(url, options, settings);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${settings.label} returned invalid JSON: ${error.message}`);
  }
}

async function fetchText(url, options, settings) {
  return fetchWithRetry(url, options, settings);
}

async function fetchWithRetry(url, options = {}, settings = {}) {
  const label = settings.label || "request";
  const retries = settings.retries ?? 1;
  const timeoutMs = settings.timeoutMs ?? 15000;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });

      if (response.status === 401 || response.status === 403) {
        const authMessage = settings.authMessage || "Refresh NYT_COOKIE and rerun npm run scrape.";
        throw new AuthError(`${label} returned HTTP ${response.status}. ${authMessage}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${label} returned HTTP ${response.status}: ${body.slice(0, 180)}`);
      }

      const body = await response.text();
      clearTimeout(timeout);
      return body;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (error instanceof AuthError || attempt === retries) {
        throw error;
      }

      await sleep(500 * 2 ** attempt + randomInt(75, 300));
    }
  }

  throw lastError;
}

function normalizeComment(comment) {
  return {
    name: cleanText(comment.userDisplayName || "NYT reader"),
    location: cleanText(comment.userLocation || ""),
    body: normalizeCommentBody(comment.commentBody || ""),
    recommendations: toNumber(comment.recommendations),
    replyCount: toNumber(comment.replyCount),
    timestamp: toNumber(comment.approveDate),
    timesPick: Boolean(comment.editorsSelection),
  };
}

function normalizeCommentBody(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p>/gi, "\n\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseTitle(title) {
  const opinionPrefix = /^Opinion\s+\|\s+/i;
  if (opinionPrefix.test(title)) {
    return { section: "opinion", title: title.replace(opinionPrefix, "").trim() };
  }
  return { section: "", title };
}

function stripLeadingBy(byline) {
  return byline.replace(/^By\s+/i, "").trim();
}

function parseWsjByline(html) {
  const byline = metaContent(html, "author") || metaProperty(html, "article:author");
  if (!byline) {
    return "";
  }

  if (/^https?:\/\//i.test(byline)) {
    try {
      const slug = new URL(byline).pathname.split("/").filter(Boolean).pop() || "";
      return titleCase(slug.replace(/-/g, " "));
    } catch {
      return "";
    }
  }

  return stripLeadingBy(byline);
}

function sectionFromUrl(articleUrl) {
  try {
    const pathname = new URL(articleUrl).pathname;
    const parts = pathname.split("/").filter(Boolean);
    return cleanText(parts[3] || "");
  } catch {
    return "";
  }
}

function sectionFromWsjUrl(articleUrl) {
  try {
    const pathname = new URL(articleUrl).pathname;
    const parts = pathname.split("/").filter(Boolean);
    return cleanText(parts[0] || "");
  } catch {
    return "";
  }
}

function sectionFromWapoUrl(articleUrl) {
  try {
    const pathname = new URL(articleUrl).pathname;
    const parts = pathname.split("/").filter(Boolean);
    return titleCase((parts[0] || "").replace(/-/g, " "));
  } catch {
    return "";
  }
}

function titleFromUrl(articleUrl) {
  try {
    const filename = new URL(articleUrl).pathname.split("/").pop() || "";
    return filename.replace(/\.html$/, "").replace(/-/g, " ");
  } catch {
    return "Untitled article";
  }
}

function canonicalUrl(html) {
  const link = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
  return decodeEntities(link || metaProperty(html, "og:url") || "");
}

function metaContent(html, name) {
  return cleanText(metaAttribute(html, "name", name));
}

function metaProperty(html, property) {
  return cleanText(metaAttribute(html, "property", property));
}

function metaAttribute(html, attrName, attrValue) {
  const escapedName = escapeRegExp(attrName);
  const escapedValue = escapeRegExp(attrValue);
  const metaPattern = new RegExp(`<meta\\b(?=[^>]*\\b${escapedName}=["']${escapedValue}["'])(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*>`, "i");
  return decodeEntities(metaPattern.exec(html)?.[1] || "");
}

function matchXmlTag(block, tagName) {
  const escaped = escapeRegExp(tagName);
  return block.match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "i"))?.[1] || "";
}

function titleCase(value) {
  return cleanText(value).replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function timestampSeconds(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number > 1_000_000_000_000 ? Math.floor(number / 1000) : Math.floor(number);
  }

  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function timestampMillis(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return number > 1_000_000_000_000 ? Math.floor(number) : Math.floor(number * 1000);
  }

  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isWithinWindow(value) {
  const timestamp = timestampMillis(value);
  return timestamp >= windowStart.getTime() && timestamp <= windowEnd.getTime();
}

function cleanText(value) {
  return decodeEntities(String(value).replace(/\s+/g, " ")).trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    const lower = code.toLowerCase();

    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }

    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }

    return Object.hasOwn(named, lower) ? named[lower] : entity;
  });
}

function dateInTimeZone(date, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: zone,
    year: "numeric",
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function datesInTimeZoneRange(startDate, endDate, zone) {
  const dates = [];
  let current = dateInTimeZone(startDate, zone);
  const final = dateInTimeZone(endDate, zone);

  while (current <= final) {
    dates.push(current);
    current = addDays(current, 1);
  }

  return dates;
}

function addDays(isoDate, daysToAdd) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return date.toISOString().slice(0, 10);
}

async function loadDotEnv(filePath) {
  let contents = "";

  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsAt = line.indexOf("=");
    if (equalsAt === -1) {
      continue;
    }

    const key = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rename(tempPath, filePath);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return Array.from(new Set(values));
}

function prioritizeCandidates(values, textForValue = candidateSearchText, options = {}) {
  const { shuffleGroups = false } = options;
  const focused = [];
  const general = [];

  for (const value of values) {
    if (isFocusCandidate(textForValue(value))) {
      focused.push(value);
    } else {
      general.push(value);
    }
  }

  const focusQueue = shuffleGroups ? shuffle(focused) : focused.slice();
  const generalQueue = shuffleGroups ? shuffle(general) : general.slice();
  const output = [];

  while (focusQueue.length > 0 || generalQueue.length > 0) {
    for (let count = 0; count < 2 && focusQueue.length > 0; count += 1) {
      output.push(focusQueue.shift());
    }

    if (generalQueue.length > 0) {
      output.push(generalQueue.shift());
    }
  }

  console.log(`Prioritized ${focused.length} arts/tech/style candidates and ${general.length} general candidates.`);
  return output;
}

function isFocusCandidate(text) {
  return /(arts?|culture|books|theater|music|movies|television|style|fashion|design|t-magazine|tech|technology|personal-tech|openai|artificial-intelligence|ai-|chips?|semiconductor|software)/i.test(
    text,
  );
}

function candidateSearchText(candidate) {
  if (typeof candidate === "string") {
    return candidate;
  }
  return `${candidate.url || ""} ${candidate.title || ""} ${candidate.section || ""}`;
}

function shuffle(values) {
  const output = values.slice();
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapWith = randomInt(0, index);
    [output[index], output[swapWith]] = [output[swapWith], output[index]];
  }
  return output;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
