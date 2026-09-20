import "dotenv/config";
import fs from "fs";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import parseBookPane from "../utils/parseBookPane.js";

const HARDCODED_USERNAME = "seaw457";
const MAX_PAGES = 200; // safety cap so a bad selector can never loop forever
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser/i;

const createStorygraphUrl = (target) => {
  if (target === "currently-reading") {
    return `https://app.thestorygraph.com/profile/${HARDCODED_USERNAME}`;
  }
  return `https://app.thestorygraph.com/${target}/${HARDCODED_USERNAME}`;
};

const pause = (baseMs) => new Promise((r) => setTimeout(r, baseMs + Math.random() * 1200));

// ---------------------------------------------------------------------------
// One shared browser for the whole run. Cloudflare hands out a "you passed"
// cookie once a check succeeds; reusing the same browser keeps that cookie
// for every later page and list instead of being challenged again each time.
// ---------------------------------------------------------------------------
let sharedBrowser = null;
let sharedContext = null;

const getContext = async () => {
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
    // GitHub's Ubuntu runners include real Google Chrome, which looks far
    // more like a normal visitor than the stripped-down bundled Chromium.
    sharedBrowser = await chromium.launch({ ...launchOptions, channel: "chrome" });
    console.log("[SCRAPER] Using installed Google Chrome.");
  } catch (err) {
    console.warn(
      `[SCRAPER] Google Chrome not available (${err.message.split("\n")[0]}). Using bundled Chromium.`
    );
    sharedBrowser = await chromium.launch(launchOptions);
  }

  // Build a user agent that matches the real browser version and OS.
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
// Opens a URL and, if Cloudflare shows its "Just a moment..." check, waits for
// it to clear (it often clears by itself in a few seconds). Retries up to 3x.
// Returns "ok", "404" or "blocked".
// ---------------------------------------------------------------------------
const openPage = async (page, url, label) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
    if (response && response.status() === 404) return "404";

    let title = await page.title().catch(() => "Just a moment...");

    if (CHALLENGE_TITLE.test(title)) {
      console.log(`[SCRAPER] ${label}: Cloudflare check (attempt ${attempt}). Waiting for it to clear...`);
      for (let i = 0; i < 45 && CHALLENGE_TITLE.test(title); i++) {
        await page.waitForTimeout(1000);
        // title() can throw while the page is redirecting after the check
        title = await page.title().catch(() => "Just a moment...");
      }
    }

    if (!CHALLENGE_TITLE.test(title)) return "ok";

    console.warn(`[SCRAPER] ${label}: still blocked after attempt ${attempt}.`);
    await page.waitForTimeout(5000 * attempt);
  }
  return "blocked";
};

const fetchAllBookPanes = async (target, limit = Infinity) => {
  // Map of bookId -> card HTML. De-dupes by book, and lets us keep the most
  // complete HTML if the same book is matched by more than one element.
  const books = new Map();
  const baseUrl = createStorygraphUrl(target);
  const context = await getContext();
  const page = await context.newPage();

  const cardSelector =
    target === "currently-reading"
      ? ".currently-reading-cover-wrapper, .currently-reading-title-author"
      : ".book-pane, .search-results-item, .book-pane-wrapper, .book-title-author-and-series";

  try {
    let pageCount = 1;
    let hasNextPage = true;

    while (hasNextPage && books.size < limit && pageCount <= MAX_PAGES) {
      // 1. Navigate. Page 1 = base URL, later pages add ?page=N safely.
      const u = new URL(baseUrl);
      if (pageCount > 1) u.searchParams.set("page", String(pageCount));
      console.log(`[SCRAPER] ${target}: navigating to page ${pageCount}: ${u}`);

      const status = await openPage(page, u.toString(), `${target} p${pageCount}`);

      if (status === "404") {
        console.error(`[SCRAPER] ${target}: 404 at ${u}.`);
        break;
      }

      if (status === "blocked") {
        console.warn(
          `[SCRAPER] ${target}: BLOCKED by Cloudflare on page ${pageCount}. ` +
            (pageCount > 1
              ? `Results are PARTIAL (${books.size} books so far); the list was NOT fully scraped.`
              : "No books collected.")
        );
        await page.screenshot({ path: `debug-${target}-blocked.png`, fullPage: true }).catch(() => {});
        break;
      }

      // 2. Wait for cards, but never fail silently.
      try {
        await page.waitForSelector(cardSelector, { timeout: 10000 });
      } catch {
        console.warn(
          `[SCRAPER] ${target}: no cards on page ${pageCount}. ` +
            `URL: ${page.url()} | Title: ${await page.title()}`
        );
        if (pageCount === 1) {
          await page.screenshot({ path: `debug-${target}.png`, fullPage: true });
          fs.writeFileSync(`debug-${target}.html`, await page.content());
          console.warn(`[SCRAPER] ${target}: saved debug-${target}.png and debug-${target}.html`);
        }
        break;
      }

      // 3. Scroll to trigger lazy-loaded images.
      await page.evaluate(async () => {
        for (let i = 0; i < document.body.scrollHeight; i += 300) {
          window.scrollTo(0, i);
          await new Promise((r) => setTimeout(r, 50));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(800);

      // 4. Extract cards.
      const cards = await page.$$eval(cardSelector, (els) => {
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

        return els
          .map((el) => {
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

            const id = bookId(card.querySelector("a[href*='/books/']")?.getAttribute("href"));
            return { id, html: card.outerHTML };
          })
          .filter((c) => c.id);
      });

      // Save the first few cards from page 1 so we can check the parser against real HTML.
      if (pageCount === 1 && cards.length > 0) {
        fs.writeFileSync(
          `debug-${target}-sample.html`,
          cards
            .slice(0, 3)
            .map((c) => c.html)
            .join("\n\n<!-- ---------- next card ---------- -->\n\n")
        );
      }

      // 5. Merge into the Map. Count only genuinely new books.
      let added = 0;
      for (const { id, html } of cards) {
        if (books.has(id)) {
          if (html.length > books.get(id).length) books.set(id, html); // keep the fuller card
          continue;
        }
        if (books.size >= limit) continue;
        books.set(id, html);
        added++;
      }

      console.log(
        `[SCRAPER] ${target}: page ${pageCount} added ${added} new books (${books.size} total).`
      );

      // 6. Stop when a page adds nothing new, or when there's no pagination.
      if (added === 0 || target === "currently-reading") {
        hasNextPage = false;
      } else {
        pageCount++;
        await pause(2500); // slower, slightly random pacing looks less like a bot
      }
    }
  } catch (err) {
    console.error(`[SCRAPER] Error while scraping ${baseUrl}:`, err.message);
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`[SCRAPER] ${target}: finished with ${books.size} books.`);
  return [...books.values()].map((html) => cheerio.load(html).root());
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
