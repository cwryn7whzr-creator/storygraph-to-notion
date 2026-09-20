import "dotenv/config";
import fs from "fs";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import parseBookPane from "../utils/parseBookPane.js";

export const HARDCODED_USERNAME = "seaw457";
export const BASE = "https://app.thestorygraph.com";
const PAGE_SIZE = 10; // pages/scroll batches hold 10 books (page 2 started 10 in, page 3 started 20 in, ...)
const MAX_PAGES = 200; // safety cap so a bad selector can never loop forever
const MAX_SCROLL_ROUNDS = 80; // safety cap on infinite-scroll loading per page
const MAX_EMPTY_PAGES_IN_A_ROW = 3; // tolerate a few pages that add nothing before giving up
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser/i;

const BOOK_SELECTOR =
  ".book-pane, .search-results-item, .book-pane-wrapper, .book-title-author-and-series";
const PROFILE_SELECTOR = ".currently-reading-cover-wrapper, .currently-reading-title-author";

// Squeezes HTML down so it is readable in the GitHub log: collapses whitespace,
// and replaces giant inline data: images with a short placeholder.
const compactHtml = (html, max) =>
  html
    .replace(/(src|srcset)="data:[^"]*"/g, '$1="data:..."')
    .replace(/\s+/g, " ")
    .slice(0, max);

// Where to look for each list. Currently-reading tries its own list page first
// (same layout as the other lists), then falls back to the profile page.
const buildSources = (target) => {
  if (target === "currently-reading") {
    return [
      { tag: "currently-reading", url: `${BASE}/currently-reading/${HARDCODED_USERNAME}`, selector: BOOK_SELECTOR, paginate: true },
      { tag: "currently-reading-profile", url: `${BASE}/profile/${HARDCODED_USERNAME}`, selector: PROFILE_SELECTOR, paginate: false },
    ];
  }
  return [{ tag: target, url: `${BASE}/${target}/${HARDCODED_USERNAME}`, selector: BOOK_SELECTOR, paginate: true }];
};

const pause = (baseMs) => new Promise((r) => setTimeout(r, baseMs + Math.random() * 1200));

// ---------------------------------------------------------------------------
// One shared browser for the whole run, so Cloudflare's "you passed" cookie
// carries over to every later page and list.
// ---------------------------------------------------------------------------
let sharedBrowser = null;
let sharedContext = null;

export const getContext = async () => {
  if (sharedContext) return sharedContext;

  const launchOptions = {
    headless: process.env.HEADED !== "1", // HEADED=1 + xvfb-run is the stealthier option
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  };

  try {
    sharedBrowser = await chromium.launch({ ...launchOptions, channel: "chrome" });
    console.log("[SCRAPER] Using installed Google Chrome.");
  } catch (err) {
    console.warn(
      `[SCRAPER] Google Chrome not available (${err.message.split("\n")[0]}). Using bundled Chromium.`
    );
    sharedBrowser = await chromium.launch(launchOptions);
  }

  const major = sharedBrowser.version().split(".")[0];
  sharedContext = await sharedBrowser.newContext({
    viewport: { width: 1280, height: 1000 },
    locale: "en-US",
    timezoneId: "America/New_York",
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  });

  await sharedContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return sharedContext;
};

// Call this once at the very end of the run (syncToNotion.js does this).
export const closeBrowser = async () => {
  if (sharedBrowser) await sharedBrowser.close().catch(() => {});
  sharedBrowser = null;
  sharedContext = null;
};

// ---------------------------------------------------------------------------
// Opens a URL and, if Cloudflare shows "Just a moment...", waits for it to
// clear. Retries up to 3x. Returns "ok", "404" or "blocked".
// ---------------------------------------------------------------------------
export const openPage = async (page, url, label) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    if (response && response.status() === 404) return "404";
    if (response && response.status() >= 400) console.warn(`[SCRAPER] ${label}: HTTP ${response.status()}`);

    let title = await page.title().catch(() => "Just a moment...");

    if (CHALLENGE_TITLE.test(title)) {
      console.log(`[SCRAPER] ${label}: Cloudflare check (attempt ${attempt}). Waiting for it to clear...`);
      for (let i = 0; i < 45 && CHALLENGE_TITLE.test(title); i++) {
        await page.waitForTimeout(1000);
        title = await page.title().catch(() => "Just a moment...");
      }
    }

    if (!CHALLENGE_TITLE.test(title)) return "ok";

    console.warn(`[SCRAPER] ${label}: still blocked after attempt ${attempt}.`);
    await page.waitForTimeout(5000 * attempt);
  }
  return "blocked";
};

// ---------------------------------------------------------------------------
// Reads the list size Storygraph shows on the page, e.g. "Filter list (201
// books)" or "201 books". Returns null if it can't find one.
// ---------------------------------------------------------------------------
const readExpectedTotal = (page) =>
  page
    .evaluate(() => {
      const text = document.body.innerText || "";
      const patterns = [
        /\((\d{1,5})\s+books?\)/i,
        /^[ \t]*(\d{1,5})[ \t]+books?[ \t]*$/im,
        /currently reading\s*\((\d{1,5})\)/i,
      ];
      for (const re of patterns) {
        const m = text.match(re);
        if (m) return Number(m[1]);
      }
      return null;
    })
    .catch(() => null);

const countBookLinks = (page) =>
  page.evaluate(
    () =>
      new Set(
        [...document.querySelectorAll("a[href*='/books/']")]
          .map((a) => a.getAttribute("href")?.match(/\/books\/([^/?#]+)/)?.[1])
          .filter(Boolean)
      ).size
  );

// ---------------------------------------------------------------------------
// Storygraph lists use infinite scroll: more books appear as you scroll down.
// Keep scrolling to the bottom until the number of books stops growing (or we
// reach the expected total), then make sure the cover images have loaded.
//
// options.waitForImages (default true): set to false when only book IDs are
// needed (mood/genre segment pages), which saves 10+ seconds per page.
// ---------------------------------------------------------------------------
export const loadEverythingOnPage = async (page, expectedTotal, label, options = {}) => {
  const { waitForImages = true } = options;

  let last = await countBookLinks(page);
  let stable = 0;
  let rounds = 0;

  // While still short of the expected total, wait longer: later batches load slower.
  const patience = () => (expectedTotal && last < expectedTotal ? 6 : 3);
  while (rounds < MAX_SCROLL_ROUNDS && stable < patience()) {
    rounds++;
    await page.evaluate(async () => {
      for (let y = window.scrollY; y < document.body.scrollHeight; y += 500) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(expectedTotal && last < expectedTotal ? 2500 : 1500);

    const now = await countBookLinks(page);
    if (now > last) {
      last = now;
      stable = 0;
    } else {
      stable++;
    }
    if (expectedTotal && last >= expectedTotal) break;
  }

  console.log(
    `[SCRAPER] ${label}: scrolling loaded ${last} books in ${rounds} rounds` +
      (expectedTotal ? ` (expected ${expectedTotal})` : "")
  );

  if (!waitForImages) return;

  // Final slow pass from the top so every lazy-loaded cover image gets a chance to load.
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
  });
  await page
    .waitForFunction(() => [...document.images].every((img) => img.complete), null, { timeout: 12000 })
    .catch(() => {});
  await page.waitForTimeout(800);
};

// ---------------------------------------------------------------------------
// Runs INSIDE the browser (page.evaluate), so it can't use anything from outside
// this function. Every list entry matches the card selector several times
// (wrapper, pane, title block...), and those matches sit inside each other.
// Each match is tagged with a "group" = its outermost matched ancestor, so all
// matches of ONE entry share a group number, even when the same book appears in
// several entries (a reread).
// ---------------------------------------------------------------------------
export function extractCardsInPage(cardSelector) {
  const WRAPPERS = ".book-pane, .search-results-item, .book-pane-wrapper";
  const bookId = (href) => href?.match(/\/books\/([^/?#]+)/)?.[1] || null;
  const idsIn = (node) =>
    new Set(
      [...node.querySelectorAll("a[href*='/books/']")]
        .map((a) => bookId(a.getAttribute("href")))
        .filter(Boolean)
    );

  // Use the known wrapper if there is one; otherwise climb until the
  // parent would contain more than one distinct book (max 5 levels).
  const resolveCard = (el) => {
    const wrapper = el.closest(WRAPPERS);
    if (wrapper) return wrapper;
    let node = el;
    for (let i = 0; i < 5; i++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body) break;
      if (idsIn(parent).size > 1) break;
      node = parent;
    }
    return node;
  };

  const matched = [...document.querySelectorAll(cardSelector)];
  const matchedSet = new Set(matched);
  const groupNumbers = new Map(); // outermost matched element -> group number

  const items = matched
    .map((el) => {
      let root = el;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (matchedSet.has(p)) root = p;
      }
      if (!groupNumbers.has(root)) groupNumbers.set(root, groupNumbers.size);

      const card = resolveCard(el);

      // Promote lazy-load attributes so captured HTML has real image URLs.
      card.querySelectorAll("img").forEach((img) => {
        const lazy =
          img.getAttribute("data-src") ||
          img.getAttribute("data-lazy-src") ||
          img.getAttribute("data-original");
        if (lazy && (!img.getAttribute("src") || img.getAttribute("src").startsWith("data:"))) {
          img.setAttribute("src", lazy);
        }
      });

      // Flag cards with no usable image so we can inspect them.
      const noImage = ![...card.querySelectorAll("img")].some((img) => {
        const s = img.getAttribute("src") || "";
        return s && !s.startsWith("data:") && !/\.svg(\?|$)/i.test(s);
      });

      const id = bookId(card.querySelector("a[href*='/books/']")?.getAttribute("href"));
      return { id, html: card.outerHTML, noImage, group: groupNumbers.get(root) };
    })
    .filter((c) => c.id);

  const pageUniqueIds = new Set(
    [...document.querySelectorAll("a[href*='/books/']")]
      .map((a) => bookId(a.getAttribute("href")))
      .filter(Boolean)
  ).size;

  return { items, pageUniqueIds };
}

// Runs in Node. Two views of the same matches:
//   entryList  = one item per list entry (the fullest card of each group)
//   uniqueList = one item per book ID (the old behaviour)
export const groupItems = (items) => {
  const keepFuller = (map, key, item) => {
    const prev = map.get(key);
    if (!prev || item.html.length > prev.html.length) map.set(key, item);
  };
  const byGroup = new Map();
  const byId = new Map();
  for (const item of items) {
    keepFuller(byGroup, item.group, item);
    keepFuller(byId, item.id, item);
  }
  return { entryList: [...byGroup.values()], uniqueList: [...byId.values()] };
};

// Entries can only be trusted if there are at least as many as distinct books on the page
// and no more than the total StoryGraph reports.
export const entriesLookRight = (entryCount, pageUniqueIds, expectedTotal) =>
  Boolean(expectedTotal) && entryCount >= pageUniqueIds && entryCount <= expectedTotal;

// ---------------------------------------------------------------------------
// Scrapes one source (one URL, all its pages). Returns an array of card HTML,
// one per list ENTRY in page order. A book read twice appears twice.
// ---------------------------------------------------------------------------
const scrapeSource = async (page, source, limit) => {
  const { tag, url: baseUrl, selector: cardSelector, paginate } = source;
  const entries = [];
  const seenIds = new Set(); // only used in "unique-ids" mode
  let mode = null; // "entries" or "unique-ids", decided on the first page
  let noImageSaved = 0;
  let pageCount = 1;
  let emptyStreak = 0;
  let expectedTotal = null;
  let hasNextPage = true;

  while (hasNextPage && entries.length < limit && pageCount <= MAX_PAGES) {
    // 1. Navigate. Page 1 = base URL, later pages add ?page=N safely.
    const u = new URL(baseUrl);
    if (pageCount > 1) u.searchParams.set("page", String(pageCount));
    console.log(`[SCRAPER] ${tag}: navigating to page ${pageCount}: ${u}`);

    const status = await openPage(page, u.toString(), `${tag} p${pageCount}`);

    if (status === "404") {
      console.warn(`[SCRAPER] ${tag}: 404 at ${u}.`);
      break;
    }

    if (status === "blocked") {
      console.warn(
        `[SCRAPER] ${tag}: BLOCKED by Cloudflare on page ${pageCount}. ` +
          (pageCount > 1
            ? `Results are PARTIAL (${entries.length} entries so far); the list was NOT fully scraped.`
            : "No books collected.")
      );
      await page.screenshot({ path: `debug-${tag}-blocked.png`, fullPage: true }).catch(() => {});
      break;
    }

    // 2. Wait for cards, but never fail silently.
    try {
      await page.waitForSelector(cardSelector, { timeout: 10000 });
    } catch {
      console.warn(
        `[SCRAPER] ${tag}: no cards on page ${pageCount}. ` +
          `URL: ${page.url()} | Title: ${await page.title()}`
      );
      if (pageCount === 1) {
        await page.screenshot({ path: `debug-${tag}.png`, fullPage: true });
        fs.writeFileSync(`debug-${tag}.html`, await page.content());
        console.warn(`[SCRAPER] ${tag}: saved debug-${tag}.png and debug-${tag}.html`);
      }
      if (pageCount === 1 || !expectedTotal) break;
      // A tail page that fails to render shouldn't end the whole list; try the next one.
      emptyStreak++;
      if (emptyStreak >= MAX_EMPTY_PAGES_IN_A_ROW || pageCount >= Math.ceil(expectedTotal / PAGE_SIZE) + 1) break;
      pageCount++;
      await pause(2500);
      continue;
    }

    // 3. Learn how many books the list should have (first time only).
    if (expectedTotal === null) {
      expectedTotal = await readExpectedTotal(page);
      console.log(
        `[SCRAPER] ${tag}: Storygraph says this list has ${expectedTotal ?? "an unknown number of"} books.`
      );
    }

    // 4. Scroll until everything is loaded, and wait for cover images.
    await loadEverythingOnPage(page, expectedTotal, `${tag} p${pageCount}`);

    // 5. Extract cards.
    const { items, pageUniqueIds } = await page.evaluate(extractCardsInPage, cardSelector);
    const { entryList, uniqueList } = groupItems(items);

    // Decide once (on the first page) whether entries could be told apart.
    if (mode === null) {
      mode = entriesLookRight(entryList.length, pageUniqueIds, expectedTotal) ? "entries" : "unique-ids";
      console.log(
        `[SCRAPER] ${tag}: page ${pageCount} had ${items.length} matches = ${entryList.length} entries, ` +
          `${uniqueList.length} unique books (counting by ${mode}).`
      );
      if (mode === "unique-ids") {
        console.warn(
          `[SCRAPER] ${tag}: could not tell separate entries apart, so repeat reads will not be counted.`
        );
      }
    }
    const cards = mode === "entries" ? entryList : uniqueList;

    // Save the first few cards from page 1 so we can check the parser against real HTML.
    if (pageCount === 1 && cards.length > 0) {
      fs.writeFileSync(
        `debug-${tag}-sample.html`,
        cards
          .slice(0, 3)
          .map((c) => c.html)
          .join("\n\n<!-- ---------- next card ---------- -->\n\n")
      );
      // Also print one card into the log so it can be copied without downloading artifacts.
      console.log(`[SAMPLE-HTML] ${tag}: ${compactHtml(cards[0].html, 6000)}`);
    }

    // Save a few cards that have no usable cover image.
    const noImageCards = cards.filter((c) => c.noImage);
    if (noImageCards.length > 0) {
      console.log(`[SCRAPER] ${tag}: ${noImageCards.length} card(s) on page ${pageCount} had no usable image.`);
      for (const c of noImageCards) {
        if (noImageSaved >= 3) break;
        fs.appendFileSync(`debug-${tag}-noimage.html`, `${c.html}\n\n<!-- ---------- next card ---------- -->\n\n`);
        noImageSaved++;
      }
    }

    // 6. Merge into the list. Count only genuinely new entries.
    let added = 0;
    if (mode === "entries") {
      // Page N starts (N-1)*PAGE_SIZE entries into the list and runs to the end, so skip the
      // part we already have and keep the rest, repeats included.
      const offset = (pageCount - 1) * PAGE_SIZE;
      for (const c of cards.slice(Math.max(0, entries.length - offset))) {
        if (entries.length >= limit) break;
        entries.push(c);
        added++;
      }
    } else {
      for (const c of cards) {
        if (seenIds.has(c.id) || entries.length >= limit) continue;
        seenIds.add(c.id);
        entries.push(c);
        added++;
      }
    }

    console.log(`[SCRAPER] ${tag}: page ${pageCount} added ${added} new entries (${entries.length} total).`);

    // 7. Decide whether to keep going.
    if (!paginate) {
      hasNextPage = false;
    } else if (expectedTotal && entries.length >= expectedTotal) {
      hasNextPage = false; // we have everything Storygraph says exists
    } else {
      emptyStreak = added === 0 ? emptyStreak + 1 : 0;
      const lastPage = expectedTotal ? Math.ceil(expectedTotal / PAGE_SIZE) + 1 : MAX_PAGES;
      if (emptyStreak >= MAX_EMPTY_PAGES_IN_A_ROW || pageCount >= lastPage) {
        hasNextPage = false;
      } else {
        // ?page=N starts N-1 pages in and then scrolls to the same stopping point every time,
        // so walking 2, 3, 4... only re-reads entries we already have. From page 1, jump straight
        // to the page holding the first entry we're still missing.
        pageCount = pageCount === 1 ? Math.max(2, Math.floor(entries.length / PAGE_SIZE) + 1) : pageCount + 1;
        await pause(2500); // slower, slightly random pacing looks less like a bot
      }
    }
  }

  // Final tally so gaps are obvious in the log.
  if (expectedTotal && entries.length < expectedTotal && entries.length < limit) {
    console.warn(
      mode === "unique-ids"
        ? `[SCRAPER] ${tag}: collected ${entries.length} unique books; the list shows ${expectedTotal} entries, ` +
            `so about ${expectedTotal - entries.length} are probably repeat reads.`
        : `[SCRAPER] ${tag}: WARNING collected ${entries.length} of ${expectedTotal} expected entries. ` +
            `${expectedTotal - entries.length} may be missing.`
    );
  } else {
    console.log(`[SCRAPER] ${tag}: collected ${entries.length}${expectedTotal ? ` of ${expectedTotal} expected` : ""}.`);
  }

  return entries.map((e) => e.html);
};

const fetchAllBookPanes = async (target, limit = Infinity) => {
  const context = await getContext();
  const page = await context.newPage();
  let books = [];

  try {
    const sources = buildSources(target);
    for (let i = 0; i < sources.length; i++) {
      books = await scrapeSource(page, sources[i], limit);
      if (books.length > 0) break;
      if (i < sources.length - 1) {
        console.warn(`[SCRAPER] ${target}: nothing found via "${sources[i].tag}", trying "${sources[i + 1].tag}"...`);
      }
    }
  } catch (err) {
    console.error(`[SCRAPER] Error while scraping ${target}:`, err.message);
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`[SCRAPER] ${target}: finished with ${books.length} books.`);
  return books.map((html) => cheerio.load(html).root());
};

export const handler = async (req) => {
  const target = req.queryStringParameters?.target || "books-read";
  const parsedLimit = Number(req.queryStringParameters?.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : Infinity;

  try {
    const bookPanes = await fetchAllBookPanes(target, limit);
    const data = bookPanes.map((pane) => parseBookPane(pane));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
