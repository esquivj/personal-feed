"use client";

import { useEffect, useState, useCallback, useRef, useMemo, type FormEvent } from "react";

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  category: Category;
  summary: string;
}

type FeedType = "rss" | "html";
type FeedParserKey = "ournetwork" | "vitalik";

interface FeedSourceDefinition {
  id: string;
  url: string;
  source: string;
  type: FeedType;
  category: Category;
  filter?: RegExp;
  parserKey?: FeedParserKey;
}

interface FeedSource extends FeedSourceDefinition {
  enabled: boolean;
  builtIn: boolean;
}

interface CustomFeedSource {
  id: string;
  url: string;
  source: string;
  category: Category;
  enabled: boolean;
  createdAt: string;
}

const CATEGORIES = ["Crypto", "Marketing"] as const;
type Category = (typeof CATEGORIES)[number];

interface AISummary {
  tldr: string;
  bullets: string[];
  loading: boolean;
  error?: string;
}

interface FeedFetchIssue {
  feedId: string;
  source: string;
  category: Category;
  url: string;
  message: string;
}

type SourceHealthStatus = "idle" | "healthy" | "error" | "disabled";

interface SourceHealth {
  status: SourceHealthStatus;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  failureCount: number;
  lastItemsCount: number;
  latencyMs?: number;
}

interface SourceProfile {
  about: string;
  pulling: string;
  scrapedFrom: string;
  scrapedAt: string;
}

type TriageBucket = "inbox" | "later" | "archive";
type ReadingMode = "headline" | "expanded";

interface ItemTriageState {
  bucket: TriageBucket;
  read: boolean;
  updatedAt: string;
}

interface SavedSourceView {
  id: string;
  category: Category;
  source: string;
}

interface ScrollIndicator {
  visible: boolean;
  top: number;
  height: number;
}

const FEED_TIMEOUT_MS = 12000;
const FEED_RETRIES = 1;
const MIN_SCROLL_THUMB_HEIGHT = 28;
const SCROLL_TRACK_VERTICAL_PADDING = 6;
const MAX_ITEMS_PER_FEED = 30;
const MAX_TOTAL_ITEMS = 500;
const SETTINGS_STORAGE_KEYS = {
  enabledById: "personal-feed:enabledById:v1",
  customFeeds: "personal-feed:customFeeds:v1",
  globalEnabled: "personal-feed:globalEnabled:v1",
  triageByLink: "personal-feed:triageByLink:v1",
  savedViews: "personal-feed:savedViews:v1",
  readingMode: "personal-feed:readingMode:v1",
} as const;
const FEED_DISCOVERY_PATHS = [
  "/feed",
  "/feed.xml",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/blog/feed",
  "/newsletter/feed",
] as const;

// Source colors for visual distinction
const SOURCE_COLORS: Record<string, string> = {
  "Decentralised.co": "#10b981",
  OurNetwork: "#8b5cf6",
  Shoal: "#f59e0b",
  Artemis: "#ec4899",
};

function hashStringToHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

function getSourceColor(source: string): string {
  if (SOURCE_COLORS[source]) return SOURCE_COLORS[source];
  const hue = hashStringToHue(source);
  return `hsl(${hue}, 70%, 60%)`;
}

// Custom parser for OurNetwork homepage
function parseOurNetwork(html: string, source: string, category: Category): FeedItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  const cardLinks = doc.querySelectorAll('a[href*="/p/on-"]');

  cardLinks.forEach((card) => {
    const href = card.getAttribute("href");
    if (!href || seen.has(href)) return;

    const match = href.match(/\/p\/(on-\d+-[\w-]+)/);
    if (!match) return;

    seen.add(href);

    const slug = match[1];
    const parts = slug.match(/on-(\d+)-(.+)/);
    if (!parts) return;

    const issueNum = parts[1];
    const titleSlug = parts[2].replace(/-/g, " ");
    const title = `ON-${issueNum}: ${titleSlug.charAt(0).toUpperCase() + titleSlug.slice(1)}`;

    let pubDate = new Date().toISOString();
    const timeEl = card.querySelector("time");

    if (timeEl?.textContent) {
      const dateText = timeEl.textContent.trim();
      const [month, day, year] = dateText.split("/");
      if (month && day && year) {
        pubDate = new Date(
          `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
        ).toISOString();
      }
    } else {
      const cardText = card.textContent || "";
      const dateMatch = cardText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (dateMatch) {
        const [, month, day, year] = dateMatch;
        pubDate = new Date(
          `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
        ).toISOString();
      }
    }

    items.push({
      title,
      link: `https://www.ournetwork.xyz${href}`,
      pubDate,
      source,
      category,
      summary: "",
    });
  });

  return items
    .sort(
      (a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
    )
    .slice(0, 20);
}

function parseVitalikHomepage(
  html: string,
  source: string,
  category: Category
): FeedItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  const links = doc.querySelectorAll("a.post-link");

  links.forEach((linkEl) => {
    const href = linkEl.getAttribute("href");
    if (!href) return;

    const link = new URL(href, "https://vitalik.eth.limo/").toString();
    if (seen.has(link)) return;
    seen.add(link);

    const title = linkEl.textContent?.trim() || "Untitled";
    const parentItem = linkEl.closest("li");
    const dateText = parentItem?.querySelector(".post-meta")?.textContent?.trim();
    let pubDate = new Date().toISOString();

    if (dateText) {
      const parsedDate = new Date(`${dateText} UTC`);
      if (!Number.isNaN(parsedDate.getTime())) {
        pubDate = parsedDate.toISOString();
      }
    }

    items.push({
      title,
      link,
      pubDate,
      source,
      category,
      summary: "",
    });
  });

  return items
    .sort(
      (a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
    )
    .slice(0, 40);
}

const HTML_FEED_PARSERS: Record<
  FeedParserKey,
  (html: string, source: string, category: Category) => FeedItem[]
> = {
  ournetwork: parseOurNetwork,
  vitalik: parseVitalikHomepage,
};

const DEFAULT_FEEDS: FeedSourceDefinition[] = [
  {
    id: "decentralised",
    url: "https://www.decentralised.co/feed",
    source: "Decentralised.co",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "ournetwork",
    url: "https://www.ournetwork.xyz/",
    source: "OurNetwork",
    type: "html",
    category: "Crypto",
    parserKey: "ournetwork",
  },
  {
    id: "shoal",
    url: "https://www.shoal.gg/feed",
    source: "Shoal",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "artemis",
    url: "https://research.artemisanalytics.com/feed",
    source: "Artemis",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "ethereum-foundation",
    url: "https://blog.ethereum.org/feed.xml",
    source: "Ethereum Foundation",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "celestia",
    url: "https://blog.celestia.org/rss/",
    source: "Celestia",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "arbitrum-foundation",
    url: "https://blog.arbitrum.foundation/rss/",
    source: "Arbitrum Foundation",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "arbitrum-tech",
    url: "https://blog.arbitrum.io/rss/",
    source: "Arbitrum Tech",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "starkware",
    url: "https://medium.com/feed/starkware",
    source: "StarkWare",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "aave",
    url: "https://medium.com/feed/aave",
    source: "Aave",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "compound",
    url: "https://medium.com/feed/compound-finance",
    source: "Compound",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "1inch",
    url: "https://medium.com/feed/1inch-network",
    source: "1inch",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "chainlink",
    url: "https://blog.chain.link/rss/",
    source: "Chainlink",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "flashbots",
    url: "https://medium.com/feed/flashbots",
    source: "Flashbots",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "blockworks",
    url: "https://blockworks.co/feed",
    source: "Blockworks",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "coindesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    source: "CoinDesk",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "unchained",
    url: "https://unchainedcrypto.com/feed/",
    source: "Unchained",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "vitalik",
    url: "https://vitalik.eth.limo/feed.xml",
    source: "Vitalik",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "castle-labs",
    url: "https://castlelabs.substack.com/feed",
    source: "Castle Labs",
    type: "rss",
    category: "Crypto",
  },
  {
    id: "april-dunford",
    url: "https://aprildunford.substack.com/feed",
    source: "April Dunford",
    type: "rss",
    category: "Marketing",
  },
  {
    id: "mkt1",
    url: "https://newsletter.mkt1.co/feed",
    source: "MKT1",
    type: "rss",
    category: "Marketing",
  },
];

function stripHtmlToText(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").trim();
}

function parseRSSItems(
  items: Element[],
  source: string,
  category: Category,
  filter?: RegExp
): FeedItem[] {
  return items
    .map((item) => {
      const title = item.querySelector("title")?.textContent || "Untitled";
      const link = item.querySelector("link")?.textContent || "";
      const pubDate =
        item.querySelector("pubDate")?.textContent || new Date().toISOString();
      const description =
        item.querySelector("description")?.textContent ||
        item.querySelector("content\\:encoded")?.textContent ||
        "";

      const summary = stripHtmlToText(description).slice(0, 200);
      return { title, link, pubDate, source, category, summary };
    })
    .filter((item) => !filter || filter.test(item.link));
}

function parseAtomEntries(
  entries: Element[],
  source: string,
  category: Category,
  filter?: RegExp
): FeedItem[] {
  return entries
    .map((entry) => {
      const title = entry.querySelector("title")?.textContent || "Untitled";
      const linkEl =
        entry.querySelector("link[rel='alternate']") || entry.querySelector("link");
      const link = linkEl?.getAttribute("href") || linkEl?.textContent || "";
      const pubDate =
        entry.querySelector("published")?.textContent ||
        entry.querySelector("updated")?.textContent ||
        new Date().toISOString();
      const description =
        entry.querySelector("summary")?.textContent ||
        entry.querySelector("content")?.textContent ||
        "";

      const summary = stripHtmlToText(description).slice(0, 200);
      return { title, link, pubDate, source, category, summary };
    })
    .filter((item) => !filter || filter.test(item.link));
}

function parseFeed(xml: string, source: string, category: Category, filter?: RegExp): FeedItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid XML response");
  }

  const items = Array.from(doc.querySelectorAll("item"));
  if (items.length > 0) {
    return parseRSSItems(items, source, category, filter);
  }

  const entries = Array.from(doc.querySelectorAll("entry"));
  if (entries.length > 0) {
    return parseAtomEntries(entries, source, category, filter);
  }

  return [];
}

function toOneLineSummary(value: string, fallback: string, maxLength = 180): string {
  const cleaned = stripHtmlToText(value)
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function looksGenericFeedCopy(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    !normalized ||
    /\b(rss|atom)\s+feed\b/.test(normalized) ||
    /\blatest posts\b/.test(normalized) ||
    /\bthis is a substack\b/.test(normalized) ||
    /\bfeed for\b/.test(normalized)
  );
}

function inferPublicationType(seed: string): string {
  const normalized = seed.toLowerCase();
  if (/\b(research|analysis|analytics|insights?)\b/.test(normalized)) {
    return "research publication";
  }
  if (/\b(newsletter|substack)\b/.test(normalized)) {
    return "newsletter";
  }
  if (/\b(blog|journal|updates?)\b/.test(normalized)) {
    return "blog";
  }
  return "publication";
}

function cleanEntityName(value: string): string {
  return value
    .replace(/\b(rss|atom|feed)\b/gi, "")
    .replace(/\s*\|.*$/, "")
    .replace(/\s*-\s*.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickEntityName(feed: FeedSource, candidates: string[]): string {
  for (const candidate of candidates) {
    const cleaned = cleanEntityName(candidate);
    if (!cleaned) continue;
    if (/^untitled$/i.test(cleaned)) continue;
    if (/^[^a-zA-Z]*$/.test(cleaned)) continue;
    return cleaned;
  }
  return feed.source || sourceNameFromUrl(feed.url);
}

function formatEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname}${path}`;
  } catch {
    return url;
  }
}

function buildPullingSummary(feed: FeedSource): string {
  if (feed.type === "html") {
    const parserLabel =
      feed.parserKey === "ournetwork"
        ? "homepage issue cards"
        : feed.parserKey === "vitalik"
          ? "homepage post links"
          : "homepage updates";
    return `Pulling ${parserLabel} from ${formatEndpoint(feed.url)}`;
  }
  return `Pulling RSS/Atom entries from ${formatEndpoint(feed.url)}`;
}

async function scrapeSiteMeta(url: string, source: string): Promise<{
  description: string;
  entity: string;
  scrapedFrom: string;
}> {
  try {
    const siteUrl = new URL(url);
    const html = await withTimeout(fetchWithTauri(siteUrl.origin), 6000, source);
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const description =
      doc.querySelector("meta[name='description']")?.getAttribute("content") ||
      doc.querySelector("meta[property='og:description']")?.getAttribute("content") ||
      "";
    const entity =
      doc.querySelector("meta[property='og:site_name']")?.getAttribute("content") ||
      doc.querySelector("meta[name='application-name']")?.getAttribute("content") ||
      doc.title ||
      "";
    return { description, entity, scrapedFrom: siteUrl.origin };
  } catch {
    return { description: "", entity: "", scrapedFrom: url };
  }
}

function buildAboutSummary(
  entity: string,
  publicationType: string,
  description: string
): string {
  const trimmed = toOneLineSummary(description, "", 140);
  if (!trimmed || looksGenericFeedCopy(trimmed)) {
    return `${entity} ${publicationType}`;
  }
  if (normalizeForCompare(trimmed).includes(normalizeForCompare(entity))) {
    return toOneLineSummary(trimmed, `${entity} ${publicationType}`, 170);
  }
  return toOneLineSummary(
    `${entity} ${publicationType}: ${trimmed}`,
    `${entity} ${publicationType}`,
    170
  );
}

function buildFallbackSourceProfile(feed: FeedSource): SourceProfile {
  const entity = pickEntityName(feed, [feed.source, sourceNameFromUrl(feed.url)]);
  const publicationType = inferPublicationType(`${feed.source} ${feed.url}`);
  return {
    about: `${entity} ${publicationType}`,
    pulling: buildPullingSummary(feed),
    scrapedFrom: feed.url,
    scrapedAt: new Date().toISOString(),
  };
}

async function extractSourceProfileFromContent(
  content: string,
  feed: FeedSource
): Promise<SourceProfile> {
  const scrapedAt = new Date().toISOString();
  const fallback = buildFallbackSourceProfile(feed);

  if (feed.type === "rss") {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, "text/xml");
    if (doc.querySelector("parsererror")) return fallback;

    const title =
      doc.querySelector("channel > title")?.textContent?.trim() ||
      doc.querySelector("feed > title")?.textContent?.trim() ||
      "";
    const description =
      doc.querySelector("channel > description")?.textContent ||
      doc.querySelector("feed > subtitle")?.textContent ||
      doc.querySelector("feed > tagline")?.textContent ||
      doc.querySelector("itunes\\:summary")?.textContent ||
      doc.querySelector("dc\\:description")?.textContent ||
      "";
    const feedLink =
      doc.querySelector("channel > link")?.textContent?.trim() ||
      doc.querySelector("feed > link[rel='alternate']")?.getAttribute("href") ||
      doc.querySelector("feed > link")?.getAttribute("href") ||
      feed.url;
    const publisher =
      doc.querySelector("managingEditor")?.textContent?.trim() ||
      doc.querySelector("dc\\:creator")?.textContent?.trim() ||
      doc.querySelector("itunes\\:author")?.textContent?.trim() ||
      doc.querySelector("feed > author > name")?.textContent?.trim() ||
      "";

    const siteMeta =
      !description || looksGenericFeedCopy(description)
        ? await scrapeSiteMeta(feedLink || feed.url, feed.source)
        : { description: "", entity: "", scrapedFrom: feedLink || feed.url };

    const entity = pickEntityName(feed, [
      publisher,
      siteMeta.entity,
      title,
      feed.source,
      sourceNameFromUrl(feedLink || feed.url),
    ]);
    const publicationType = inferPublicationType(
      `${feed.source} ${title} ${description} ${siteMeta.description} ${feed.url}`
    );
    const about = buildAboutSummary(
      entity,
      publicationType,
      description || siteMeta.description
    );

    return {
      about,
      pulling: buildPullingSummary(feed),
      scrapedFrom: siteMeta.scrapedFrom || feed.url,
      scrapedAt,
    };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(content, "text/html");
  const description =
    doc.querySelector("meta[name='description']")?.getAttribute("content") ||
    doc.querySelector("meta[property='og:description']")?.getAttribute("content") ||
    "";
  const siteName =
    doc.querySelector("meta[property='og:site_name']")?.getAttribute("content") ||
    doc.querySelector("meta[name='application-name']")?.getAttribute("content") ||
    doc.title ||
    "";
  const author =
    doc.querySelector("meta[name='author']")?.getAttribute("content") ||
    doc.querySelector("meta[property='article:author']")?.getAttribute("content") ||
    "";

  const entity = pickEntityName(feed, [
    siteName,
    author,
    feed.source,
    sourceNameFromUrl(feed.url),
  ]);
  const publicationType = inferPublicationType(
    `${feed.source} ${siteName} ${description} ${feed.url}`
  );
  const about = buildAboutSummary(entity, publicationType, description);

  return {
    about,
    pulling: buildPullingSummary(feed),
    scrapedFrom: feed.url,
    scrapedAt,
  };
}

function toAbsoluteHttpsUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Feed URL is required.");
  if (/^https?:\/\//i.test(trimmed)) {
    return new URL(trimmed).toString();
  }
  return new URL(`https://${trimmed}`).toString();
}

function titleCase(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sourceNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    const base = host.split(".")[0] || host;
    return titleCase(base.replace(/[-_]+/g, " "));
  } catch {
    return "Custom Source";
  }
}

function createCustomFeedId(source: string, url: string): string {
  const normalized = `${source.trim().toLowerCase()}-${url.trim().toLowerCase()}`;
  const safe = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `custom-${safe || Date.now().toString(36)}`;
}

function inspectFeedDocument(xml: string): {
  isFeed: boolean;
  title: string | null;
  itemCount: number;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) {
    return { isFeed: false, title: null, itemCount: 0 };
  }

  const hasFeedRoot = Boolean(
    doc.querySelector("rss") ||
      doc.querySelector("feed") ||
      doc.querySelector("rdf\\:RDF") ||
      doc.querySelector("channel")
  );
  if (!hasFeedRoot) {
    return { isFeed: false, title: null, itemCount: 0 };
  }

  const title =
    doc.querySelector("channel > title")?.textContent?.trim() ||
    doc.querySelector("feed > title")?.textContent?.trim() ||
    null;

  return {
    isFeed: true,
    title,
    itemCount: doc.querySelectorAll("item, entry").length,
  };
}

function extractFeedLinksFromHtml(html: string, baseUrl: string): string[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const links = doc.querySelectorAll(
    "link[rel~='alternate'][type*='rss'], link[rel~='alternate'][type*='atom'], link[type='application/rss+xml'], link[type='application/atom+xml']"
  );
  const discovered = new Set<string>();

  links.forEach((linkEl) => {
    const href = linkEl.getAttribute("href");
    if (!href) return;
    try {
      discovered.add(new URL(href, baseUrl).toString());
    } catch {
      // Ignore bad feed discovery links.
    }
  });

  return [...discovered];
}

function buildDiscoveryCandidates(inputUrl: string): string[] {
  const initial = new URL(inputUrl);
  const origin = `${initial.protocol}//${initial.host}`;
  const candidates = new Set<string>();
  const enqueue = (value: string) => {
    try {
      candidates.add(new URL(value, origin).toString());
    } catch {
      // Ignore malformed candidate URLs.
    }
  };

  enqueue(initial.toString());
  const pathname = initial.pathname.replace(/\/$/, "");
  const looksLikeFeedPath = /(feed|rss|atom|xml)/i.test(pathname);

  if (!looksLikeFeedPath) {
    FEED_DISCOVERY_PATHS.forEach((path) => enqueue(path));
    if (pathname) {
      enqueue(`${pathname}/feed`);
      enqueue(`${pathname}/rss`);
      enqueue(`${pathname}.xml`);
    }
  }

  if (initial.hostname.includes("substack.com")) {
    enqueue("/feed");
  }

  return [...candidates];
}

async function discoverRssFeed(inputUrl: string): Promise<{
  feedUrl: string;
  feedTitle: string | null;
}> {
  const normalizedInput = toAbsoluteHttpsUrl(inputUrl);
  const queue = buildDiscoveryCandidates(normalizedInput);
  const seen = new Set<string>();

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    try {
      const content = await withTimeout(
        fetchWithTauri(candidate),
        FEED_TIMEOUT_MS,
        candidate
      );
      const feedInfo = inspectFeedDocument(content);
      if (feedInfo.isFeed) {
        return { feedUrl: candidate, feedTitle: feedInfo.title };
      }

      const discovered = extractFeedLinksFromHtml(content, candidate);
      discovered.forEach((url) => {
        if (!seen.has(url)) queue.push(url);
      });
    } catch {
      // Continue scanning other candidates.
    }
  }

  throw new Error("Could not discover an RSS/Atom feed from that URL.");
}

function buildRuntimeFeeds(
  enabledById: Record<string, boolean>,
  customFeeds: CustomFeedSource[]
): FeedSource[] {
  const builtIns = DEFAULT_FEEDS.map((feed) => ({
    ...feed,
    enabled: enabledById[feed.id] ?? true,
    builtIn: true as const,
  }));
  const custom = customFeeds.map((feed) => ({
    ...feed,
    type: "rss" as const,
    builtIn: false as const,
  }));
  return [...builtIns, ...custom];
}

function getDefaultItemTriageState(): ItemTriageState {
  return {
    bucket: "inbox",
    read: false,
    updatedAt: new Date().toISOString(),
  };
}

function getItemTriageState(
  triageByLink: Record<string, ItemTriageState>,
  link: string
): ItemTriageState {
  return triageByLink[link] || getDefaultItemTriageState();
}

function calculateScrollIndicator(container: HTMLElement | null): ScrollIndicator {
  if (!container) return { visible: false, top: 0, height: 0 };

  const { scrollTop, scrollHeight, clientHeight } = container;
  const maxScrollTop = scrollHeight - clientHeight;

  if (maxScrollTop <= 0) {
    return { visible: false, top: 0, height: 0 };
  }

  const trackHeight = Math.max(clientHeight - SCROLL_TRACK_VERTICAL_PADDING * 2, 0);
  const proportionalHeight = (clientHeight / scrollHeight) * trackHeight;
  const thumbHeight = Math.max(proportionalHeight, MIN_SCROLL_THUMB_HEIGHT);
  const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
  const thumbTop = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * maxThumbTop : 0;

  return { visible: true, top: thumbTop, height: thumbHeight };
}

function isSimilarIndicator(a: ScrollIndicator, b: ScrollIndicator): boolean {
  if (a.visible !== b.visible) return false;
  if (!a.visible && !b.visible) return true;
  return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function normalizeFeedItems(items: FeedItem[]): FeedItem[] {
  const deduped = new Map<string, FeedItem>();

  for (const item of items) {
    const key = item.link || `${item.source}:${item.title}`;
    if (!key) continue;
    const current = deduped.get(key);

    if (!current) {
      deduped.set(key, item);
      continue;
    }

    if (new Date(item.pubDate).getTime() > new Date(current.pubDate).getTime()) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .slice(0, MAX_TOTAL_ITEMS);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  source: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${source} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

interface FeedFetchResult {
  feedId: string;
  items: FeedItem[];
  issue?: FeedFetchIssue;
  latencyMs: number;
  checkedAt: string;
}

async function fetchFeedWithRetry(feed: FeedSource): Promise<FeedFetchResult> {
  let lastError = "Unknown error";
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();

  for (let attempt = 0; attempt <= FEED_RETRIES; attempt += 1) {
    try {
      const content = await withTimeout(fetchWithTauri(feed.url), FEED_TIMEOUT_MS, feed.source);
      const parser = feed.parserKey ? HTML_FEED_PARSERS[feed.parserKey] : undefined;
      const items =
        feed.type === "html"
          ? (() => {
              if (!parser) {
                throw new Error("No parser configured for HTML source");
              }
              return parser(content, feed.source, feed.category);
            })()
          : parseFeed(content, feed.source, feed.category, feed.filter);
      return {
        feedId: feed.id,
        items: items.slice(0, MAX_ITEMS_PER_FEED),
        latencyMs: Date.now() - startedAt,
        checkedAt,
      };
    } catch (error) {
      lastError = getErrorMessage(error);
      if (attempt < FEED_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }

  return {
    feedId: feed.id,
    items: [],
    issue: {
      feedId: feed.id,
      source: feed.source,
      category: feed.category,
      url: feed.url,
      message: lastError,
    },
    latencyMs: Date.now() - startedAt,
    checkedAt,
  };
}

function formatTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffHours < 1) return "now";
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatFullDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDateTime(dateString?: string): string {
  if (!dateString) return "never";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function healthStatusClass(status: SourceHealthStatus): string {
  if (status === "healthy") return "bg-emerald-500/15 text-emerald-300";
  if (status === "error") return "bg-rose-500/15 text-rose-300";
  if (status === "disabled") return "bg-zinc-600/25 text-zinc-300";
  return "bg-zinc-700/25 text-zinc-400";
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3.75a2.25 2.25 0 0 1 2.25 2.25v.2a6.27 6.27 0 0 1 1.98.82l.14-.14a2.25 2.25 0 1 1 3.18 3.18l-.14.14c.37.62.64 1.29.8 2h.2a2.25 2.25 0 1 1 0 4.5h-.2a6.23 6.23 0 0 1-.82 1.98l.15.15a2.25 2.25 0 0 1-3.18 3.18l-.15-.15a6.23 6.23 0 0 1-1.98.82V18a2.25 2.25 0 1 1-4.5 0v-.2a6.23 6.23 0 0 1-1.98-.82l-.15.15a2.25 2.25 0 0 1-3.18-3.18l.15-.15a6.23 6.23 0 0 1-.82-1.98H3.5a2.25 2.25 0 1 1 0-4.5h.2a6.23 6.23 0 0 1 .82-1.98l-.15-.15a2.25 2.25 0 0 1 3.18-3.18l.15.15c.62-.37 1.29-.64 1.98-.82V6A2.25 2.25 0 0 1 12 3.75z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 4v5h-5" />
      <path d="M4 20v-5h5" />
      <path d="M18.2 9.2A7 7 0 0 0 6.2 6.7L5 8" />
      <path d="M5.8 14.8a7 7 0 0 0 12 2.5L19 16" />
    </svg>
  );
}

let tauriFetchPromise: Promise<typeof import("@tauri-apps/plugin-http").fetch> | null = null;

async function getTauriFetch() {
  if (!tauriFetchPromise) {
    tauriFetchPromise = import("@tauri-apps/plugin-http").then(
      (module) => module.fetch
    );
  }
  return tauriFetchPromise;
}

async function fetchWithTauri(url: string): Promise<string> {
  const tauriFetch = await getTauriFetch();
  const response = await tauriFetch(url, { method: "GET" });
  return response.text();
}

// Extract article content from HTML
function extractArticleContent(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Remove scripts, styles, nav, footer, etc.
  const removeSelectors = [
    "script",
    "style",
    "nav",
    "footer",
    "header",
    "aside",
    ".comments",
    ".sidebar",
    ".ad",
    ".subscription",
  ];
  removeSelectors.forEach((sel) => {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  });

  // Try to find main content
  const article =
    doc.querySelector("article") ||
    doc.querySelector(".post-content") ||
    doc.querySelector(".entry-content") ||
    doc.querySelector("main") ||
    doc.body;

  // Get text content and clean it up
  const text = article?.textContent || "";
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15000); // Limit to ~15k chars for API
}

// Call Ollama API via Tauri HTTP
async function summarizeWithOllama(
  content: string,
  title: string
): Promise<{ tldr: string; bullets: string[] }> {
  const tauriFetch = await getTauriFetch();

  const response = await tauriFetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama3.2",
      prompt: `Summarize this article titled "${title}". Provide:
1. A one-sentence TLDR (max 20 words)
2. Exactly 3 bullet points with the main ideas (each max 15 words)

Format your response exactly like this:
TLDR: [your tldr here]
• [bullet 1]
• [bullet 2]
• [bullet 3]

Article content:
${content}`,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const text = data.response;

  // Parse the response
  const tldrMatch = text.match(/TLDR:\s*(.+?)(?:\n|$)/);
  const bulletMatches = text.match(/•\s*(.+?)(?:\n|$)/g);

  return {
    tldr: tldrMatch?.[1]?.trim() || "Summary unavailable",
    bullets:
      bulletMatches?.map((b: string) => b.replace(/^•\s*/, "").trim()) || [],
  };
}

export default function Home() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<Category>(CATEGORIES[0]);
  const [activeBucket, setActiveBucket] = useState<TriageBucket>("inbox");
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [readingMode, setReadingMode] = useState<ReadingMode>("headline");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sourcesGloballyEnabled, setSourcesGloballyEnabled] = useState(true);
  const [feedEnabledById, setFeedEnabledById] = useState<Record<string, boolean>>({});
  const [customFeeds, setCustomFeeds] = useState<CustomFeedSource[]>([]);
  const [triageByLink, setTriageByLink] = useState<Record<string, ItemTriageState>>({});
  const [savedViews, setSavedViews] = useState<SavedSourceView[]>([]);
  const [feedHealth, setFeedHealth] = useState<Record<string, SourceHealth>>({});
  const [sourceProfiles, setSourceProfiles] = useState<Record<string, SourceProfile>>({});
  const [isHydratingProfiles, setIsHydratingProfiles] = useState(false);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [newFeedName, setNewFeedName] = useState("");
  const [newFeedCategory, setNewFeedCategory] = useState<Category>("Crypto");
  const [isAddingFeed, setIsAddingFeed] = useState(false);
  const [addFeedError, setAddFeedError] = useState<string | null>(null);
  const [addFeedSuccess, setAddFeedSuccess] = useState<string | null>(null);
  const [feedIssues, setFeedIssues] = useState<FeedFetchIssue[]>([]);
  const [mainScrollIndicator, setMainScrollIndicator] = useState<ScrollIndicator>({
    visible: false,
    top: 0,
    height: 0,
  });
  const [panelScrollIndicator, setPanelScrollIndicator] = useState<ScrollIndicator>({
    visible: false,
    top: 0,
    height: 0,
  });
  const mainScrollRef = useRef<HTMLElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hasLoadedRef = useRef(false);
  const fetchRunIdRef = useRef(0);
  const isFetchingRef = useRef(false);
  const summariesRef = useRef<Record<string, AISummary>>({});
  const mainScrollIndicatorRef = useRef<ScrollIndicator>({
    visible: false,
    top: 0,
    height: 0,
  });
  const panelScrollIndicatorRef = useRef<ScrollIndicator>({
    visible: false,
    top: 0,
    height: 0,
  });
  const mainRafRef = useRef<number | null>(null);
  const panelRafRef = useRef<number | null>(null);

  // Summary panel state
  const [showPanel, setShowPanel] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, AISummary>>({});

  const allFeeds = useMemo(
    () => buildRuntimeFeeds(feedEnabledById, customFeeds),
    [feedEnabledById, customFeeds]
  );
  const activeFeeds = useMemo(
    () =>
      sourcesGloballyEnabled ? allFeeds.filter((feed) => feed.enabled) : [],
    [allFeeds, sourcesGloballyEnabled]
  );

  useEffect(() => {
    setSavedViews((prev) =>
      prev.filter((view) =>
        allFeeds.some(
          (feed) => feed.category === view.category && feed.source === view.source
        )
      )
    );
  }, [allFeeds]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const storedEnabledById = window.localStorage.getItem(
        SETTINGS_STORAGE_KEYS.enabledById
      );
      if (storedEnabledById) {
        const parsed = JSON.parse(storedEnabledById);
        if (parsed && typeof parsed === "object") {
          setFeedEnabledById(parsed as Record<string, boolean>);
        }
      }

      const storedCustomFeeds = window.localStorage.getItem(
        SETTINGS_STORAGE_KEYS.customFeeds
      );
      if (storedCustomFeeds) {
        const parsed = JSON.parse(storedCustomFeeds);
        if (Array.isArray(parsed)) {
          const safeFeeds: CustomFeedSource[] = parsed
            .filter((entry) => entry && typeof entry === "object")
            .map((entry): CustomFeedSource => ({
              id: String((entry as { id?: string }).id || ""),
              url: String((entry as { url?: string }).url || ""),
              source: String((entry as { source?: string }).source || ""),
              category:
                (entry as { category?: Category }).category === "Marketing"
                  ? "Marketing"
                  : "Crypto",
              enabled: (entry as { enabled?: boolean }).enabled !== false,
              createdAt: String(
                (entry as { createdAt?: string }).createdAt || new Date().toISOString()
              ),
            }))
            .filter((entry) => entry.id && entry.url && entry.source);
          setCustomFeeds(safeFeeds);
        }
      }

      const storedGlobalEnabled = window.localStorage.getItem(
        SETTINGS_STORAGE_KEYS.globalEnabled
      );
      if (storedGlobalEnabled !== null) {
        setSourcesGloballyEnabled(storedGlobalEnabled === "true");
      }

      const storedTriageByLink = window.localStorage.getItem(
        SETTINGS_STORAGE_KEYS.triageByLink
      );
      if (storedTriageByLink) {
        const parsed = JSON.parse(storedTriageByLink);
        if (parsed && typeof parsed === "object") {
          const safe: Record<string, ItemTriageState> = {};
          Object.entries(parsed as Record<string, ItemTriageState>).forEach(
            ([link, value]) => {
              if (!link || typeof value !== "object" || !value) return;
              safe[link] = {
                bucket:
                  value.bucket === "later" || value.bucket === "archive"
                    ? value.bucket
                    : "inbox",
                read: Boolean(value.read),
                updatedAt: value.updatedAt || new Date().toISOString(),
              };
            }
          );
          setTriageByLink(safe);
        }
      }

      const storedSavedViews = window.localStorage.getItem(
        SETTINGS_STORAGE_KEYS.savedViews
      );
      if (storedSavedViews) {
        const parsed = JSON.parse(storedSavedViews);
        if (Array.isArray(parsed)) {
          const safeViews: SavedSourceView[] = parsed
            .filter((entry) => entry && typeof entry === "object")
            .map((entry): SavedSourceView => ({
              id: String((entry as { id?: string }).id || ""),
              category:
                (entry as { category?: Category }).category === "Marketing"
                  ? "Marketing"
                  : "Crypto",
              source: String((entry as { source?: string }).source || ""),
            }))
            .filter((entry) => entry.id && entry.source);
          setSavedViews(safeViews);
        }
      }

      const storedReadingMode = window.localStorage.getItem(
        SETTINGS_STORAGE_KEYS.readingMode
      );
      if (storedReadingMode === "headline" || storedReadingMode === "expanded") {
        setReadingMode(storedReadingMode);
      }
    } catch (storageError) {
      console.error("Failed to hydrate settings from local storage", storageError);
    } finally {
      setSettingsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!settingsHydrated || typeof window === "undefined") return;
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.enabledById,
      JSON.stringify(feedEnabledById)
    );
  }, [feedEnabledById, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated || typeof window === "undefined") return;
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.customFeeds,
      JSON.stringify(customFeeds)
    );
  }, [customFeeds, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated || typeof window === "undefined") return;
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.globalEnabled,
      String(sourcesGloballyEnabled)
    );
  }, [sourcesGloballyEnabled, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated || typeof window === "undefined") return;
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.triageByLink,
      JSON.stringify(triageByLink)
    );
  }, [settingsHydrated, triageByLink]);

  useEffect(() => {
    if (!settingsHydrated || typeof window === "undefined") return;
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEYS.savedViews,
      JSON.stringify(savedViews)
    );
  }, [savedViews, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated || typeof window === "undefined") return;
    window.localStorage.setItem(SETTINGS_STORAGE_KEYS.readingMode, readingMode);
  }, [readingMode, settingsHydrated]);

  useEffect(() => {
    summariesRef.current = summaries;
  }, [summaries]);

  // Filter by category first, then by source
  const categoryItems = useMemo(
    () => items.filter((i) => i.category === activeCategory),
    [items, activeCategory]
  );
  const sources = useMemo(
    () => Array.from(new Set(categoryItems.map((i) => i.source))).sort((a, b) => a.localeCompare(b)),
    [categoryItems]
  );
  const sourceFilteredItems = useMemo(
    () =>
      activeFilter
        ? categoryItems.filter((i) => i.source === activeFilter)
        : categoryItems,
    [activeFilter, categoryItems]
  );
  const filteredItems = useMemo(
    () => {
      const laneFiltered = sourceFilteredItems.filter((item) => {
        const state = getItemTriageState(triageByLink, item.link);
        return state.bucket === activeBucket;
      });

      return [...laneFiltered].sort((a, b) => {
        if (activeBucket === "inbox") {
          const aRead = getItemTriageState(triageByLink, a.link).read;
          const bRead = getItemTriageState(triageByLink, b.link).read;
          if (aRead !== bRead) return aRead ? 1 : -1;
        }
        return new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime();
      });
    },
    [activeBucket, sourceFilteredItems, triageByLink]
  );
  const bucketCounts = useMemo(() => {
    const counts = { inbox: 0, later: 0, archive: 0, unreadInbox: 0 };
    sourceFilteredItems.forEach((item) => {
      const state = getItemTriageState(triageByLink, item.link);
      counts[state.bucket] += 1;
      if (state.bucket === "inbox" && !state.read) {
        counts.unreadInbox += 1;
      }
    });
    return counts;
  }, [sourceFilteredItems, triageByLink]);
  const categoryIssues = useMemo(
    () => feedIssues.filter((issue) => issue.category === activeCategory),
    [feedIssues, activeCategory]
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<Category, number>();
    for (const item of items) {
      counts.set(item.category, (counts.get(item.category) || 0) + 1);
    }
    return counts;
  }, [items]);
  const settingsFeeds = useMemo(
    () =>
      [...allFeeds].sort((a, b) => {
        if (a.category === b.category) {
          return a.source.localeCompare(b.source);
        }
        return a.category.localeCompare(b.category);
      }),
    [allFeeds]
  );
  const enabledSourceCount = useMemo(
    () => allFeeds.filter((feed) => feed.enabled).length,
    [allFeeds]
  );
  const healthCounts = useMemo(() => {
    const counts = {
      healthy: 0,
      error: 0,
      disabled: 0,
      idle: 0,
    };

    allFeeds.forEach((feed) => {
      const status = feedHealth[feed.id]?.status ?? (feed.enabled ? "idle" : "disabled");
      counts[status] += 1;
    });

    return counts;
  }, [allFeeds, feedHealth]);
  const missingProfileFeeds = useMemo(
    () => settingsFeeds.filter((feed) => !sourceProfiles[feed.id]),
    [settingsFeeds, sourceProfiles]
  );
  const savedViewsForCategory = useMemo(
    () => savedViews.filter((view) => view.category === activeCategory),
    [activeCategory, savedViews]
  );
  const activeFilterIsSaved = useMemo(
    () =>
      Boolean(
        activeFilter &&
          savedViewsForCategory.some((view) => view.source === activeFilter)
      ),
    [activeFilter, savedViewsForCategory]
  );

  const selectedItem =
    selectedLink
      ? filteredItems.find((item) => item.link === selectedLink) || filteredItems[selectedIndex]
      : filteredItems[selectedIndex];
  const updateMainScrollIndicator = useCallback(() => {
    if (mainRafRef.current !== null) return;
    mainRafRef.current = window.requestAnimationFrame(() => {
      mainRafRef.current = null;
      const next = calculateScrollIndicator(mainScrollRef.current);
      const prev = mainScrollIndicatorRef.current;
      if (isSimilarIndicator(prev, next)) return;
      mainScrollIndicatorRef.current = next;
      setMainScrollIndicator(next);
    });
  }, []);
  const updatePanelScrollIndicator = useCallback(() => {
    if (panelRafRef.current !== null) return;
    panelRafRef.current = window.requestAnimationFrame(() => {
      panelRafRef.current = null;
      const next = calculateScrollIndicator(panelScrollRef.current);
      const prev = panelScrollIndicatorRef.current;
      if (isSimilarIndicator(prev, next)) return;
      panelScrollIndicatorRef.current = next;
      setPanelScrollIndicator(next);
    });
  }, []);

  const generateSummaryForItem = useCallback(async (item: FeedItem) => {
    const cacheKey = item.link;
    const cached = summariesRef.current[cacheKey];

    // Already have summary or loading
    if (cached?.bullets?.length || cached?.loading) {
      setShowPanel(true);
      return;
    }

    // Start loading
    setSummaries((prev) => ({
      ...prev,
      [cacheKey]: { tldr: "", bullets: [], loading: true },
    }));
    setShowPanel(true);

    try {
      // Fetch article content
      const html = await fetchWithTauri(item.link);
      const content = extractArticleContent(html);

      // Get summary from Ollama
      const summary = await summarizeWithOllama(content, item.title);

      setSummaries((prev) => ({
        ...prev,
        [cacheKey]: { ...summary, loading: false },
      }));
    } catch (e) {
      console.error("Summary error:", e);
      setSummaries((prev) => ({
        ...prev,
        [cacheKey]: {
          tldr: "",
          bullets: [],
          loading: false,
          error:
            e instanceof Error
              ? e.message
              : "Failed to generate summary. Is Ollama running?",
        },
      }));
    }
  }, []);

  // Generate summary for current selection
  const generateSummary = useCallback(async () => {
    if (!selectedItem) return;
    setTriageByLink((prev) => {
      const previous = prev[selectedItem.link] || getDefaultItemTriageState();
      return {
        ...prev,
        [selectedItem.link]: {
          ...previous,
          read: true,
          updatedAt: new Date().toISOString(),
        },
      };
    });
    await generateSummaryForItem(selectedItem);
  }, [selectedItem, generateSummaryForItem]);

  const setFeedEnabled = useCallback(
    (feedId: string, enabled: boolean) => {
      const isCustomFeed = customFeeds.some((feed) => feed.id === feedId);
      if (isCustomFeed) {
        setCustomFeeds((prev) =>
          prev.map((feed) =>
            feed.id === feedId ? { ...feed, enabled } : feed
          )
        );
        return;
      }
      setFeedEnabledById((prev) => ({ ...prev, [feedId]: enabled }));
    },
    [customFeeds]
  );

  const setAllFeedsEnabled = useCallback((enabled: boolean) => {
    const nextBuiltIns = DEFAULT_FEEDS.reduce<Record<string, boolean>>(
      (acc, feed) => {
        acc[feed.id] = enabled;
        return acc;
      },
      {}
    );
    setFeedEnabledById(nextBuiltIns);
    setCustomFeeds((prev) => prev.map((feed) => ({ ...feed, enabled })));
  }, []);

  const updateItemTriage = useCallback(
    (
      link: string,
      updater: (previous: ItemTriageState) => ItemTriageState
    ) => {
      setTriageByLink((prev) => {
        const previous = prev[link] || getDefaultItemTriageState();
        const next = updater(previous);
        return { ...prev, [link]: { ...next, updatedAt: new Date().toISOString() } };
      });
    },
    []
  );

  const markItemRead = useCallback(
    (link: string, read = true) => {
      updateItemTriage(link, (previous) => ({ ...previous, read }));
    },
    [updateItemTriage]
  );

  const setItemBucket = useCallback(
    (link: string, bucket: TriageBucket) => {
      updateItemTriage(link, (previous) => ({
        ...previous,
        bucket,
        read: bucket === "archive" ? true : previous.read,
      }));
    },
    [updateItemTriage]
  );

  const triageSelectedItem = useCallback(
    (bucket: TriageBucket) => {
      const item = filteredItems[selectedIndex];
      if (!item) return;
      setItemBucket(item.link, bucket);
      if (bucket === "inbox") markItemRead(item.link, true);
    },
    [filteredItems, markItemRead, selectedIndex, setItemBucket]
  );

  const saveSourceView = useCallback(
    (source: string) => {
      const id = `${activeCategory}:${source}`;
      setSavedViews((prev) => {
        if (prev.some((view) => view.id === id)) return prev;
        return [...prev, { id, category: activeCategory, source }];
      });
    },
    [activeCategory]
  );

  const removeSavedView = useCallback((viewId: string) => {
    setSavedViews((prev) => prev.filter((view) => view.id !== viewId));
  }, []);

  const removeCustomFeed = useCallback((feedId: string) => {
    setCustomFeeds((prev) => prev.filter((feed) => feed.id !== feedId));
    setFeedHealth((prev) => {
      if (!(feedId in prev)) return prev;
      const next = { ...prev };
      delete next[feedId];
      return next;
    });
    setSourceProfiles((prev) => {
      if (!(feedId in prev)) return prev;
      const next = { ...prev };
      delete next[feedId];
      return next;
    });
  }, []);

  const handleAddFeed = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setAddFeedError(null);
      setAddFeedSuccess(null);

      if (!newFeedUrl.trim()) {
        setAddFeedError("Feed URL is required.");
        return;
      }

      setIsAddingFeed(true);
      try {
        const { feedUrl, feedTitle } = await discoverRssFeed(newFeedUrl);
        const normalizedFeedUrl = new URL(feedUrl).toString();
        const duplicate = allFeeds.find(
          (feed) => new URL(feed.url).toString() === normalizedFeedUrl
        );
        if (duplicate) {
          throw new Error(`Source already exists: ${duplicate.source}`);
        }

        const sourceName =
          newFeedName.trim() || feedTitle || sourceNameFromUrl(normalizedFeedUrl);
        let feedId = createCustomFeedId(sourceName, normalizedFeedUrl);
        if (allFeeds.some((feed) => feed.id === feedId)) {
          feedId = `${feedId}-${Date.now().toString(36).slice(-4)}`;
        }

        const newFeed: CustomFeedSource = {
          id: feedId,
          url: normalizedFeedUrl,
          source: sourceName,
          category: newFeedCategory,
          enabled: true,
          createdAt: new Date().toISOString(),
        };

        setCustomFeeds((prev) => [newFeed, ...prev]);
        setNewFeedUrl("");
        setNewFeedName("");
        setAddFeedSuccess(`Added ${sourceName}`);
      } catch (addError) {
        setAddFeedError(getErrorMessage(addError));
      } finally {
        setIsAddingFeed(false);
      }
    },
    [allFeeds, newFeedCategory, newFeedName, newFeedUrl]
  );

  const fetchFeeds = useCallback(async () => {
    if (!settingsHydrated) return;
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    const runId = ++fetchRunIdRef.current;

    setIsRefreshing(true);
    if (!hasLoadedRef.current) setLoading(true);
    setError(null);

    try {
      if (!sourcesGloballyEnabled || activeFeeds.length === 0) {
        if (runId !== fetchRunIdRef.current) return;
        const checkedAt = new Date().toISOString();
        setItems([]);
        setFeedIssues([]);
        setLastUpdated(new Date());
        setFeedHealth((prev) => {
          const next = { ...prev };
          allFeeds.forEach((feed) => {
            const existing = next[feed.id];
            next[feed.id] = {
              status: !sourcesGloballyEnabled || !feed.enabled ? "disabled" : "idle",
              lastCheckedAt: checkedAt,
              lastSuccessAt: existing?.lastSuccessAt,
              lastError: existing?.lastError,
              failureCount: existing?.failureCount ?? 0,
              lastItemsCount: 0,
              latencyMs: existing?.latencyMs,
            };
          });
          return next;
        });
        return;
      }

      const results = await Promise.all(activeFeeds.map((feed) => fetchFeedWithRetry(feed)));
      if (runId !== fetchRunIdRef.current) return;

      const allItems = normalizeFeedItems(results.flatMap((result) => result.items));
      const issues = results
        .map((result) => result.issue)
        .filter((issue): issue is FeedFetchIssue => Boolean(issue));
      const resultByFeedId = new Map(results.map((result) => [result.feedId, result]));
      setItems(allItems);
      setFeedIssues(issues);
      setLastUpdated(new Date());
      setFeedHealth((prev) => {
        const next = { ...prev };
        allFeeds.forEach((feed) => {
          if (!feed.enabled || !sourcesGloballyEnabled) {
            const existing = next[feed.id];
            next[feed.id] = {
              status: "disabled",
              lastCheckedAt: existing?.lastCheckedAt,
              lastSuccessAt: existing?.lastSuccessAt,
              lastError: existing?.lastError,
              failureCount: existing?.failureCount ?? 0,
              lastItemsCount: 0,
              latencyMs: existing?.latencyMs,
            };
            return;
          }

          const result = resultByFeedId.get(feed.id);
          const existing = next[feed.id];
          if (!result) {
            next[feed.id] = {
              status: existing?.status || "idle",
              lastCheckedAt: existing?.lastCheckedAt,
              lastSuccessAt: existing?.lastSuccessAt,
              lastError: existing?.lastError,
              failureCount: existing?.failureCount ?? 0,
              lastItemsCount: existing?.lastItemsCount ?? 0,
              latencyMs: existing?.latencyMs,
            };
            return;
          }

          if (result.issue) {
            next[feed.id] = {
              status: "error",
              lastCheckedAt: result.checkedAt,
              lastSuccessAt: existing?.lastSuccessAt,
              lastError: result.issue.message,
              failureCount: (existing?.failureCount ?? 0) + 1,
              lastItemsCount: 0,
              latencyMs: result.latencyMs,
            };
            return;
          }

          next[feed.id] = {
            status: "healthy",
            lastCheckedAt: result.checkedAt,
            lastSuccessAt: result.checkedAt,
            lastError: undefined,
            failureCount: 0,
            lastItemsCount: result.items.length,
            latencyMs: result.latencyMs,
          };
        });
        return next;
      });

      if (allItems.length === 0 && issues.length > 0) {
        setError("Failed to load feeds. Check source errors.");
      }
    } catch (e) {
      if (runId !== fetchRunIdRef.current) return;
      console.error("Feed fetch error:", e);
      setError("Failed to load feeds");
      setFeedIssues([]);
    } finally {
      if (runId === fetchRunIdRef.current) {
        setLoading(false);
        setIsRefreshing(false);
        hasLoadedRef.current = true;
      }
      isFetchingRef.current = false;
    }
  }, [activeFeeds, allFeeds, settingsHydrated, sourcesGloballyEnabled]);

  useEffect(() => {
    if (!showSettings || missingProfileFeeds.length === 0) {
      return;
    }

    let cancelled = false;
    setIsHydratingProfiles(true);

    (async () => {
      try {
        const profiles = await Promise.all(
          missingProfileFeeds.map(async (feed) => {
            try {
              const content = await withTimeout(
                fetchWithTauri(feed.url),
                FEED_TIMEOUT_MS,
                feed.source
              );
              return {
                feedId: feed.id,
                profile: await extractSourceProfileFromContent(content, feed),
              };
            } catch {
              return {
                feedId: feed.id,
                profile: buildFallbackSourceProfile(feed),
              };
            }
          })
        );

        if (cancelled) return;
        setSourceProfiles((prev) => {
          const next = { ...prev };
          profiles.forEach(({ feedId, profile }) => {
            next[feedId] = profile;
          });
          return next;
        });
      } finally {
        if (!cancelled) setIsHydratingProfiles(false);
      }
    })();

    return () => {
      cancelled = true;
      setIsHydratingProfiles(false);
    };
  }, [missingProfileFeeds, showSettings]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = Math.min(i + 1, filteredItems.length - 1);
          const nextItem = filteredItems[next];
          if (nextItem) setSelectedLink(nextItem.link);
          return next;
        });
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = Math.max(i - 1, 0);
          const nextItem = filteredItems[next];
          if (nextItem) setSelectedLink(nextItem.link);
          return next;
        });
      } else if (e.key === "Enter" || e.key === "o") {
        e.preventDefault();
        const item = filteredItems[selectedIndex];
        if (item) {
          markItemRead(item.link, true);
          window.open(item.link, "_blank");
        }
      } else if (e.key === "r") {
        e.preventDefault();
        fetchFeeds();
      } else if (e.key === "s") {
        e.preventDefault();
        setShowPanel((prev) => !prev);
      } else if (e.key === "g") {
        e.preventDefault();
        generateSummary();
      } else if (e.key === ",") {
        e.preventDefault();
        setShowSettings((prev) => !prev);
      } else if (e.key === "l") {
        e.preventDefault();
        triageSelectedItem("later");
      } else if (e.key === "a") {
        e.preventDefault();
        triageSelectedItem("archive");
      } else if (e.key === "u") {
        e.preventDefault();
        const item = filteredItems[selectedIndex];
        if (!item) return;
        setItemBucket(item.link, "inbox");
        markItemRead(item.link, false);
      } else if (e.key === "Escape") {
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        if (showPanel) {
          setShowPanel(false);
        } else {
          setActiveFilter(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedIndex,
    filteredItems,
    fetchFeeds,
    generateSummary,
    markItemRead,
    selectedLink,
    setItemBucket,
    showSettings,
    showPanel,
    triageSelectedItem,
  ]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex]);

  useEffect(() => {
    if (filteredItems.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      if (selectedLink) setSelectedLink(null);
      return;
    }

    if (selectedLink) {
      const idx = filteredItems.findIndex((item) => item.link === selectedLink);
      if (idx === -1) {
        setSelectedIndex(0);
        setSelectedLink(filteredItems[0]?.link ?? null);
        return;
      }
      if (idx !== selectedIndex) setSelectedIndex(idx);
      return;
    }

    if (selectedIndex > filteredItems.length - 1) {
      setSelectedIndex(0);
      setSelectedLink(filteredItems[0]?.link ?? null);
      return;
    }

    if (selectedIndex === 0 && filteredItems[0]) {
      setSelectedLink(filteredItems[0].link);
    }
  }, [filteredItems, selectedIndex, selectedLink]);

  useEffect(() => {
    if (activeFilter && !sources.includes(activeFilter)) {
      setActiveFilter(null);
      setSelectedIndex(0);
      setSelectedLink(null);
    }
  }, [activeFilter, sources]);

  useEffect(() => {
    updateMainScrollIndicator();
    const mainEl = mainScrollRef.current;
    if (!mainEl) return;

    mainEl.addEventListener("scroll", updateMainScrollIndicator, { passive: true });
    window.addEventListener("resize", updateMainScrollIndicator);

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateMainScrollIndicator);
      observer.observe(mainEl);
    }

    return () => {
      mainEl.removeEventListener("scroll", updateMainScrollIndicator);
      window.removeEventListener("resize", updateMainScrollIndicator);
      observer?.disconnect();
      if (mainRafRef.current !== null) {
        window.cancelAnimationFrame(mainRafRef.current);
        mainRafRef.current = null;
      }
    };
  }, [
    updateMainScrollIndicator,
    filteredItems.length,
    loading,
    activeCategory,
    activeFilter,
    showPanel,
  ]);

  useEffect(() => {
    if (!showPanel) {
      const hidden = { visible: false, top: 0, height: 0 };
      panelScrollIndicatorRef.current = hidden;
      setPanelScrollIndicator(hidden);
      return;
    }

    updatePanelScrollIndicator();
    const panelEl = panelScrollRef.current;
    if (!panelEl) return;

    panelEl.addEventListener("scroll", updatePanelScrollIndicator, { passive: true });
    window.addEventListener("resize", updatePanelScrollIndicator);

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updatePanelScrollIndicator);
      observer.observe(panelEl);
    }

    return () => {
      panelEl.removeEventListener("scroll", updatePanelScrollIndicator);
      window.removeEventListener("resize", updatePanelScrollIndicator);
      observer?.disconnect();
      if (panelRafRef.current !== null) {
        window.cancelAnimationFrame(panelRafRef.current);
        panelRafRef.current = null;
      }
    };
  }, [showPanel, selectedItem, summaries, updatePanelScrollIndicator]);

  useEffect(() => {
    fetchFeeds();
    const interval = setInterval(fetchFeeds, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchFeeds]);

  const currentSummary = selectedItem ? summaries[selectedItem.link] : null;

  return (
    <div className="h-screen overflow-hidden flex bg-[#09090b] text-[#fafafa] font-mono antialiased selection:bg-white/20">
      {/* Left rail */}
      <aside className="w-60 shrink-0 border-r border-[#18181b] bg-[#0b0b0d] flex flex-col min-h-0">
        <div className="px-4 py-4 border-b border-[#18181b]">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold tracking-tight">feed</span>
            <span className="text-[10px] text-[#52525b] uppercase tracking-wider">
              {activeCategory}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto modern-scrollbar px-4 py-4 space-y-4 min-h-0">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[#52525b]">
              Category
            </div>
            <div className="mt-2 space-y-1">
              {CATEGORIES.map((category) => {
                const count = categoryCounts.get(category) || 0;
                return (
                  <button
                    key={category}
                    onClick={() => {
                      setActiveCategory(category);
                      setActiveFilter(null);
                      setActiveBucket("inbox");
                      setSelectedIndex(0);
                      setSelectedLink(null);
                    }}
                    className={`text-xs px-2.5 py-2 rounded-md transition-all w-full text-left flex items-center justify-between ${
                      activeCategory === category
                        ? "bg-[#27272a] text-[#fafafa]"
                        : "text-[#71717a] hover:text-[#fafafa] hover:bg-[#18181b]"
                    }`}
                  >
                    <span>{category}</span>
                    {count > 0 && (
                      <span className="text-[10px] text-[#52525b]">
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-[#52525b]">
              Triage
            </div>
            <div className="mt-2 space-y-1">
              {(
                [
                  ["inbox", "Inbox", bucketCounts.inbox, bucketCounts.unreadInbox],
                  ["later", "Later", bucketCounts.later, 0],
                  ["archive", "Archive", bucketCounts.archive, 0],
                ] as const
              ).map(([bucket, label, count, unread]) => (
                <button
                  key={bucket}
                  onClick={() => {
                    setActiveBucket(bucket);
                    setSelectedIndex(0);
                    setSelectedLink(null);
                  }}
                  className={`w-full flex items-center justify-between text-xs px-2.5 py-2 rounded-md transition-colors ${
                    activeBucket === bucket
                      ? "bg-[#1c1c1f] text-[#fafafa]"
                      : "text-[#a1a1aa] hover:text-[#fafafa] hover:bg-[#18181b]"
                  }`}
                >
                  <span>{label}</span>
                  <span className="flex items-center gap-2 text-[10px] text-[#52525b]">
                    {bucket === "inbox" && unread > 0 && (
                      <span className="text-[#fbbf24]">{unread}</span>
                    )}
                    <span>{count}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-[#52525b]">
              Saved Views
            </div>
            <div className="mt-2 space-y-1">
              {savedViewsForCategory.length === 0 && (
                <div className="text-[10px] text-[#52525b]">no saved views</div>
              )}
              {savedViewsForCategory.map((view) => (
                <div
                  key={view.id}
                  className={`flex items-center justify-between rounded-md px-2.5 py-2 ${
                    activeFilter === view.source
                      ? "bg-[#1c1c1f] text-[#fafafa]"
                      : "text-[#a1a1aa] hover:text-[#fafafa] hover:bg-[#18181b]"
                  }`}
                >
                  <button
                    onClick={() => {
                      setActiveFilter(view.source);
                      setSelectedIndex(0);
                      setSelectedLink(null);
                    }}
                    className="text-xs truncate max-w-[140px]"
                    title={view.source}
                  >
                    {view.source}
                  </button>
                  <button
                    onClick={() => removeSavedView(view.id)}
                    className="text-[10px] text-[#71717a] hover:text-[#fafafa]"
                    aria-label={`Remove saved view ${view.source}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className={`flex-1 min-h-0 flex flex-col min-w-0 ${showPanel ? "border-r border-[#27272a]" : ""}`}>
        {/* Header */}
        <header className="shrink-0 border-b border-[#27272a] bg-[#09090b]/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="px-5 py-4 flex items-center justify-between">
            <div className="flex items-baseline gap-3">
              <h1 className="text-base font-semibold tracking-tight capitalize">
                {activeBucket}
              </h1>
              <span className="text-[#52525b] text-xs">
                {filteredItems.length} items
              </span>
            </div>

            <div className="flex items-center gap-4">
              {lastUpdated && (
                <span className="text-[#52525b] text-xs tabular-nums">
                  {lastUpdated.toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              )}
              {categoryIssues.length > 0 && (
                <span className="text-[#f59e0b] text-xs tabular-nums">
                  {categoryIssues.length} source error
                  {categoryIssues.length === 1 ? "" : "s"}
                </span>
              )}
              {!sourcesGloballyEnabled && (
                <span className="text-[#f59e0b] text-xs tabular-nums">
                  sources paused
                </span>
              )}
              <button
                onClick={() => setShowSettings(true)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#27272a] bg-[#111114] text-[#71717a] hover:text-[#fafafa] hover:border-[#3f3f46] transition-colors"
                aria-label="Open settings"
                title="Settings"
              >
                <SettingsIcon className="h-5 w-5" />
              </button>
              <button
                onClick={fetchFeeds}
                disabled={isRefreshing || !settingsHydrated}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#27272a] bg-[#111114] text-[#71717a] hover:text-[#fafafa] hover:border-[#3f3f46] transition-colors disabled:opacity-50"
                aria-label="Refresh feed"
                title={isRefreshing ? "Refreshing" : "Refresh feed"}
              >
                <RefreshIcon
                  className={`h-5 w-5 ${
                    isRefreshing ? "animate-spin" : ""
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Filters and modes */}
          <div className="px-5 py-2 border-b border-[#18181b] flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[10px] uppercase tracking-wider text-[#52525b]">
                Source
              </span>
              <select
                value={activeFilter ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  setActiveFilter(value ? value : null);
                  setSelectedIndex(0);
                  setSelectedLink(null);
                }}
                title={activeFilter ?? "All sources"}
                className="text-xs rounded-md border border-[#27272a] bg-[#0b0b0d] px-2 py-1 text-[#fafafa] max-w-[220px] min-w-[160px] w-[200px] truncate"
              >
                <option value="">All sources</option>
                {sources.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
              {activeFilter && (
                <button
                  onClick={() => {
                    setActiveFilter(null);
                    setSelectedIndex(0);
                    setSelectedLink(null);
                  }}
                  className="text-[10px] text-[#71717a] hover:text-[#fafafa]"
                >
                  clear
                </button>
              )}
              {activeFilter && !activeFilterIsSaved && (
                <button
                  onClick={() => saveSourceView(activeFilter)}
                  className="text-[10px] px-2 py-1 rounded-full border border-[#27272a] text-[#71717a] hover:text-[#fafafa] hover:border-[#3f3f46]"
                >
                  save view
                </button>
              )}
            </div>

            <div className="flex items-center gap-1 rounded-md bg-[#111114] border border-[#27272a] p-0.5">
              {(["headline", "expanded"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setReadingMode(mode)}
                  className={`text-[10px] px-2 py-1 rounded transition-colors ${
                    readingMode === mode
                      ? "bg-[#fafafa] text-[#09090b]"
                      : "text-[#71717a] hover:text-[#fafafa]"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          {categoryIssues.length > 0 && (
            <div className="px-5 py-2 border-t border-[#18181b] bg-[#111114]">
              <details>
                <summary className="cursor-pointer text-xs text-[#f59e0b] hover:text-[#fbbf24]">
                  {categoryIssues.length} failed source
                  {categoryIssues.length === 1 ? "" : "s"} in{" "}
                  {activeCategory.toLowerCase()}
                </summary>
                <ul className="mt-2 space-y-1.5 text-xs">
                  {categoryIssues.map((issue) => (
                    <li key={`${issue.source}-${issue.url}`} className="text-[#71717a]">
                      <span className="text-[#f59e0b]">{issue.source}</span>: {issue.message}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </header>

        {/* Feed */}
        <div className="relative min-h-0 flex-1">
          <main ref={mainScrollRef} className="modern-scrollbar h-full overflow-y-auto pr-3">
            {loading ? (
              <div className="p-5 space-y-3">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="animate-pulse flex gap-4">
                    <div className="w-12 h-4 bg-[#27272a] rounded" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-[#27272a] rounded w-3/4" />
                      <div className="h-3 bg-[#27272a] rounded w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="p-5">
                <div className="text-[#ef4444] text-sm">{error}</div>
                <button
                  onClick={fetchFeeds}
                  className="mt-3 text-xs text-[#71717a] hover:text-[#fafafa] underline underline-offset-2"
                >
                  try again
                </button>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="p-5 text-[#52525b] text-sm">
                {activeFilter ? (
                  <>
                    No items from {activeFilter}.{" "}
                    <button
                      onClick={() => {
                        setActiveFilter(null);
                        setSelectedIndex(0);
                        setSelectedLink(null);
                      }}
                      className="text-[#71717a] hover:text-[#fafafa] underline underline-offset-2"
                    >
                      Show all
                    </button>
                  </>
                ) : (
                  <>
                    {!sourcesGloballyEnabled ? (
                      <>
                        All sources are paused.{" "}
                        <button
                          onClick={() => setShowSettings(true)}
                          className="text-[#71717a] hover:text-[#fafafa] underline underline-offset-2"
                        >
                          Open settings
                        </button>
                      </>
                    ) : activeFeeds.length === 0 ? (
                      <>
                        No sources enabled.{" "}
                        <button
                          onClick={() => setShowSettings(true)}
                          className="text-[#71717a] hover:text-[#fafafa] underline underline-offset-2"
                        >
                          Enable sources
                        </button>
                      </>
                    ) : (
                      activeBucket === "inbox"
                        ? "Inbox is clear."
                        : activeBucket === "later"
                          ? "No items saved for later."
                          : "Archive is empty."
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="w-full">
                <ul
                  ref={listRef}
                  className="divide-y divide-[#18181b]"
                  role="listbox"
                >
                  {filteredItems.map((item, i) => {
                    const triageState = getItemTriageState(triageByLink, item.link);
                    const isRead = triageState.read;

                    return (
                      <li
                        key={`${item.link}-${i}`}
                        role="option"
                        aria-selected={i === selectedIndex}
                      >
                        <a
                          href={item.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => {
                            if (e.metaKey || e.ctrlKey) {
                              markItemRead(item.link, true);
                              return;
                            }
                            e.preventDefault();
                            setSelectedIndex(i);
                            setSelectedLink(item.link);
                            markItemRead(item.link, true);
                          }}
                          className={`group block px-5 py-4 transition-colors outline-none border-l-2 ${
                            triageState.bucket === "inbox" && !isRead
                              ? "border-l-[#fbbf24]"
                              : "border-l-transparent"
                          } ${
                            i === selectedIndex
                              ? "bg-[#18181b]"
                              : "hover:bg-[#18181b]/50"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0 space-y-1">
                              <div className="flex items-center justify-between gap-3 text-[10px] text-[#71717a]">
                                <div className="flex items-center gap-2">
                                  <span
                                    className="font-medium uppercase tracking-wider"
                                    style={{ color: getSourceColor(item.source) }}
                                  >
                                    {item.source}
                                  </span>
                                  {summaries[item.link]?.bullets?.length > 0 && (
                                    <span className="text-[#52525b]">• summarized</span>
                                  )}
                                </div>
                                <time
                                  dateTime={item.pubDate}
                                  title={formatFullDate(item.pubDate)}
                                  className="tabular-nums text-[#52525b]"
                                >
                                  {formatTime(item.pubDate)}
                                </time>
                              </div>

                              <h2
                                className={`text-sm leading-snug transition-colors ${
                                  i === selectedIndex
                                    ? isRead
                                      ? "text-[#e4e4e7]"
                                      : "text-[#fafafa]"
                                    : isRead
                                      ? "text-[#71717a]"
                                      : "text-[#a1a1aa]"
                                }`}
                              >
                                {item.title}
                              </h2>

                              {readingMode === "expanded" && item.summary && (
                                <p className="text-xs text-[#52525b] line-clamp-3 leading-relaxed">
                                  {item.summary}
                                </p>
                              )}

                              <div
                                className={`mt-2 flex items-center gap-1.5 text-[10px] text-[#71717a] transition-opacity ${
                                  i === selectedIndex
                                    ? "opacity-100"
                                    : "opacity-0 group-hover:opacity-100"
                                }`}
                              >
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setItemBucket(item.link, "inbox");
                                    markItemRead(item.link, true);
                                  }}
                                  className="px-2 py-0.5 rounded border border-[#27272a] hover:text-[#fafafa]"
                                >
                                  inbox
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setItemBucket(item.link, "later");
                                  }}
                                  className="px-2 py-0.5 rounded border border-[#27272a] hover:text-[#fafafa]"
                                >
                                  later
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setItemBucket(item.link, "archive");
                                  }}
                                  className="px-2 py-0.5 rounded border border-[#27272a] hover:text-[#fafafa]"
                                >
                                  archive
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    markItemRead(item.link, !isRead);
                                  }}
                                  className="px-2 py-0.5 rounded border border-[#27272a] hover:text-[#fafafa]"
                                >
                                  {isRead ? "unread" : "read"}
                                </button>
                              </div>
                            </div>
                          </div>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </main>
          {mainScrollIndicator.visible && (
            <div className="pointer-events-none absolute inset-y-1.5 right-1 w-1.5 rounded-full bg-white/10">
              <div
                className="absolute left-0 right-0 rounded-full bg-gradient-to-b from-white/80 to-zinc-400/80 shadow-[0_0_10px_rgba(250,250,250,0.15)]"
                style={{
                  height: `${mainScrollIndicator.height}px`,
                  transform: `translateY(${mainScrollIndicator.top}px)`,
                }}
              />
            </div>
          )}
        </div>

        {/* Footer with keyboard hints */}
        <footer className="shrink-0 border-t border-[#18181b] px-5 py-2.5 bg-[#09090b]">
          <div className="flex items-center justify-between gap-3 text-[10px] text-[#52525b]">
            <span className="truncate">
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">
                j
              </kbd>
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a] ml-0.5">
                k
              </kbd>{" "}
              navigate •{" "}
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">g</kbd>{" "}
              summarize •{" "}
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">s</kbd>{" "}
              panel •{" "}
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">
                enter
              </kbd>{" "}
              open •{" "}
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">
                l
              </kbd>{" "}
              later •{" "}
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">
                a
              </kbd>{" "}
              archive •{" "}
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">
                u
              </kbd>{" "}
              unread •{" "}
              <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">
                ,
              </kbd>{" "}
              settings
            </span>
            <span className="shrink-0 text-[#71717a]">
              {`${activeBucket} • ${
                activeFilter ? `filter: ${activeFilter}` : `${sources.length} sources`
              } • ${readingMode}`}
            </span>
          </div>
        </footer>
      </div>

      {/* Side Panel for Summary */}
      {showPanel && (
        <aside className="relative min-h-0 w-80 shrink-0 flex flex-col bg-[#0f0f11] border-l border-[#27272a]">
          <div className="px-4 py-3 border-b border-[#27272a] flex items-center justify-between">
            <h2 className="text-xs font-medium text-[#71717a] uppercase tracking-wider">
              Summary
            </h2>
            <button
              onClick={() => setShowPanel(false)}
              className="text-[#52525b] hover:text-[#fafafa] transition-colors"
              aria-label="Close panel"
            >
              <span className="text-sm">×</span>
            </button>
          </div>

          <div className="relative min-h-0 flex-1">
            <div ref={panelScrollRef} className="modern-scrollbar h-full min-h-0 overflow-y-auto p-4 pr-6">
              {selectedItem && (
                <div className="space-y-4">
                  {/* Article title */}
                  <div>
                    <span
                      className="text-[10px] font-medium uppercase tracking-wider"
                      style={{
                        color: getSourceColor(selectedItem.source),
                      }}
                    >
                      {selectedItem.source}
                    </span>
                    <h3 className="text-sm font-medium mt-1 leading-snug">
                      {selectedItem.title}
                    </h3>
                    <p className="text-[10px] text-[#52525b] mt-1">
                      {formatFullDate(selectedItem.pubDate)}
                    </p>
                  </div>

                  {/* Summary content */}
                  {currentSummary?.loading ? (
                    <div className="space-y-3 animate-pulse">
                      <div className="h-4 bg-[#27272a] rounded w-full" />
                      <div className="h-4 bg-[#27272a] rounded w-5/6" />
                      <div className="space-y-2 mt-4">
                        <div className="h-3 bg-[#27272a] rounded w-full" />
                        <div className="h-3 bg-[#27272a] rounded w-4/5" />
                        <div className="h-3 bg-[#27272a] rounded w-full" />
                      </div>
                    </div>
                  ) : currentSummary?.error ? (
                    <div className="text-[#ef4444] text-xs">
                      {currentSummary.error}
                      <button
                        onClick={() => selectedItem && generateSummaryForItem(selectedItem)}
                        className="block mt-2 text-[#71717a] hover:text-[#fafafa] underline underline-offset-2"
                      >
                        try again
                      </button>
                    </div>
                  ) : currentSummary?.bullets?.length ? (
                    <div className="space-y-4">
                      {/* TLDR */}
                      <div>
                        <h4 className="text-[10px] font-medium text-[#71717a] uppercase tracking-wider mb-1.5">
                          TLDR
                        </h4>
                        <p className="text-sm text-[#a1a1aa] leading-relaxed">
                          {currentSummary.tldr}
                        </p>
                      </div>

                      {/* Bullets */}
                      <div>
                        <h4 className="text-[10px] font-medium text-[#71717a] uppercase tracking-wider mb-2">
                          Key Points
                        </h4>
                        <ul className="space-y-2">
                          {currentSummary.bullets.map((bullet, i) => (
                            <li
                              key={i}
                              className="text-xs text-[#a1a1aa] leading-relaxed flex gap-2"
                            >
                              <span className="text-[#52525b] shrink-0">•</span>
                              <span>{bullet}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Open link */}
                      <a
                        href={selectedItem.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-[#71717a] hover:text-[#fafafa] transition-colors mt-2"
                      >
                        Read full article →
                      </a>
                    </div>
                  ) : (
                    <div className="text-[#52525b] text-xs">
                      Press{" "}
                      <kbd className="px-1 py-0.5 bg-[#27272a] rounded text-[#71717a]">
                        g
                      </kbd>{" "}
                      to generate summary
                    </div>
                  )}
                </div>
              )}
            </div>
            {panelScrollIndicator.visible && (
              <div className="pointer-events-none absolute inset-y-1.5 right-1 w-1.5 rounded-full bg-white/10">
                <div
                  className="absolute left-0 right-0 rounded-full bg-gradient-to-b from-white/80 to-zinc-400/80 shadow-[0_0_10px_rgba(250,250,250,0.15)]"
                  style={{
                    height: `${panelScrollIndicator.height}px`,
                    transform: `translateY(${panelScrollIndicator.top}px)`,
                  }}
                />
              </div>
            )}
          </div>
        </aside>
      )}

      {/* Settings Drawer */}
      {showSettings && (
        <div className="fixed inset-0 z-40 flex">
          <button
            className="flex-1 bg-black/55 backdrop-blur-[1px]"
            onClick={() => setShowSettings(false)}
            aria-label="Close settings"
          />
          <aside className="h-full w-[min(560px,100vw)] border-l border-[#27272a] bg-[#0f0f11] shadow-2xl shadow-black/40 flex flex-col">
            <div className="shrink-0 px-5 py-4 border-b border-[#27272a] flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold tracking-tight">settings</h2>
                <p className="text-[11px] text-[#71717a] mt-1">
                  Source controls, health, and feed onboarding
                </p>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="text-[#52525b] hover:text-[#fafafa] transition-colors"
                aria-label="Close settings"
              >
                <span className="text-base">×</span>
              </button>
            </div>

            <div className="modern-scrollbar min-h-0 flex-1 overflow-y-auto p-5 space-y-4">
              <section className="rounded-xl border border-[#27272a] bg-[#111114] p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="text-[#a1a1aa]">
                    Sources:{" "}
                    <span className="text-[#fafafa] tabular-nums">
                      {enabledSourceCount}/{allFeeds.length}
                    </span>
                  </span>
                  <span className="text-[#a1a1aa]">
                    Healthy:{" "}
                    <span className="text-emerald-300 tabular-nums">
                      {healthCounts.healthy}
                    </span>
                  </span>
                  <span className="text-[#a1a1aa]">
                    Errors:{" "}
                    <span className="text-rose-300 tabular-nums">
                      {healthCounts.error}
                    </span>
                  </span>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setSourcesGloballyEnabled((prev) => !prev)}
                    className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                      sourcesGloballyEnabled
                        ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                        : "bg-zinc-700/25 text-zinc-300 hover:bg-zinc-700/45"
                    }`}
                  >
                    {sourcesGloballyEnabled ? "Global: ON" : "Global: OFF"}
                  </button>
                  <button
                    onClick={() => setAllFeedsEnabled(true)}
                    className="text-xs px-3 py-1.5 rounded-md bg-[#18181b] text-[#a1a1aa] hover:text-[#fafafa] transition-colors"
                  >
                    Enable all sources
                  </button>
                  <button
                    onClick={() => setAllFeedsEnabled(false)}
                    className="text-xs px-3 py-1.5 rounded-md bg-[#18181b] text-[#a1a1aa] hover:text-[#fafafa] transition-colors"
                  >
                    Disable all sources
                  </button>
                  <button
                    onClick={fetchFeeds}
                    disabled={isRefreshing}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#18181b] text-[#a1a1aa] hover:text-[#fafafa] transition-colors disabled:opacity-50"
                    aria-label="Refresh source health"
                    title={isRefreshing ? "Refreshing source health" : "Refresh source health"}
                  >
                    <RefreshIcon
                      className={`h-5 w-5 ${
                        isRefreshing ? "animate-spin" : ""
                      }`}
                    />
                  </button>
                </div>
              </section>

              <section className="rounded-xl border border-[#27272a] bg-[#111114] p-4 space-y-3">
                <div>
                  <h3 className="text-xs uppercase tracking-wider text-[#71717a]">
                    Add New Feed
                  </h3>
                  <p className="text-[11px] text-[#52525b] mt-1">
                    Paste any publication URL. Feed discovery will automatically find its RSS/Atom endpoint.
                  </p>
                </div>

                <form onSubmit={handleAddFeed} className="space-y-2.5">
                  <input
                    type="text"
                    value={newFeedUrl}
                    onChange={(e) => setNewFeedUrl(e.target.value)}
                    placeholder="https://example.com"
                    className="w-full rounded-md border border-[#27272a] bg-[#09090b] px-3 py-2 text-xs text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#52525b]"
                  />
                  <div className="grid grid-cols-2 gap-2.5">
                    <input
                      type="text"
                      value={newFeedName}
                      onChange={(e) => setNewFeedName(e.target.value)}
                      placeholder="Display name (optional)"
                      className="rounded-md border border-[#27272a] bg-[#09090b] px-3 py-2 text-xs text-[#fafafa] placeholder:text-[#52525b] focus:outline-none focus:border-[#52525b]"
                    />
                    <select
                      value={newFeedCategory}
                      onChange={(e) =>
                        setNewFeedCategory(
                          e.target.value === "Marketing" ? "Marketing" : "Crypto"
                        )
                      }
                      className="rounded-md border border-[#27272a] bg-[#09090b] px-3 py-2 text-xs text-[#fafafa] focus:outline-none focus:border-[#52525b]"
                    >
                      {CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="submit"
                    disabled={isAddingFeed}
                    className="w-full rounded-md bg-[#fafafa] text-[#09090b] text-xs font-medium py-2 hover:bg-[#e4e4e7] transition-colors disabled:opacity-70"
                  >
                    {isAddingFeed ? "Adding feed..." : "Add feed"}
                  </button>
                  {addFeedError && (
                    <p className="text-[11px] text-rose-300">{addFeedError}</p>
                  )}
                  {addFeedSuccess && (
                    <p className="text-[11px] text-emerald-300">{addFeedSuccess}</p>
                  )}
                </form>
              </section>

              <section className="rounded-xl border border-[#27272a] bg-[#111114] p-4">
                <div className="mb-3">
                  <h3 className="text-xs uppercase tracking-wider text-[#71717a]">
                    Sources
                  </h3>
                  <p className="text-[11px] text-[#52525b] mt-1">
                    Publication context, pull endpoint, and essential source controls
                  </p>
                  {isHydratingProfiles && (
                    <p className="text-[10px] text-[#71717a] mt-1">
                      Scraping publication descriptions...
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  {settingsFeeds.map((feed) => {
                    const health = feedHealth[feed.id];
                    const profile = sourceProfiles[feed.id];
                    const status: SourceHealthStatus =
                      !sourcesGloballyEnabled || !feed.enabled
                        ? "disabled"
                        : health?.status || "idle";

                    return (
                      <article
                        key={feed.id}
                        className="rounded-lg border border-[#27272a] bg-[#09090b] px-3 py-3"
                      >
                        <div className="flex items-start gap-3 justify-between">
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs text-[#fafafa]">{feed.source}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#18181b] text-[#71717a]">
                                {feed.category}
                              </span>
                              {!feed.builtIn && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1f2937] text-[#93c5fd]">
                                  custom
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-[#a1a1aa] leading-relaxed">
                              {profile?.about || buildFallbackSourceProfile(feed).about}
                            </p>
                            <p className="text-[10px] text-[#71717a] leading-relaxed">
                              {profile?.pulling || buildPullingSummary(feed)}
                            </p>
                            <p className="text-[10px] text-[#52525b]">
                              checked {formatShortDateTime(health?.lastCheckedAt)}
                            </p>
                          </div>

                          <div className="shrink-0 flex items-center gap-2">
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider ${healthStatusClass(
                                status
                              )}`}
                            >
                              {status}
                            </span>
                            <button
                              onClick={() => setFeedEnabled(feed.id, !feed.enabled)}
                              className={`text-[10px] px-2.5 py-1 rounded-md transition-colors ${
                                feed.enabled
                                  ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                                  : "bg-zinc-700/25 text-zinc-300 hover:bg-zinc-700/45"
                              }`}
                            >
                              {feed.enabled ? "ON" : "OFF"}
                            </button>
                          </div>
                        </div>

                        {status === "error" && health?.lastError && (
                          <p className="mt-1.5 text-[10px] text-rose-300 break-words">
                            {health.lastError}
                          </p>
                        )}

                        {!feed.builtIn && (
                          <div className="mt-2">
                            <button
                              onClick={() => removeCustomFeed(feed.id)}
                              className="text-[10px] text-[#71717a] hover:text-rose-300 transition-colors"
                            >
                              Remove source
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            </div>
          </aside>
        </div>
      )}

    </div>
  );
}
