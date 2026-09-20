import "dotenv/config";
import fs from "fs";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import parseBookPane from "../utils/parseBookPane.js";

const HARDCODED_USERNAME = "seaw457";
const MAX_PAGES = 200; // safety cap so a bad selector can never loop forever
const PAGE_DELAY_MS = 1500; // be polite to avoid throttling

const createStorygraphUrl = (target) => {
  if (target === "currently-reading") {
    return `https://app.thestorygraph.com/profile/${HARDCODED_USERNAME}`;
  }
  return `https://app.thestorygraph.com/${target}/${HARDCODED_USERNAME}`;
};

const fetchAllBookPanes = async (target, limit = Infinity) => {
  // Map of bookId -> card HTML. De-dupes by book, and lets us keep the most
  // complete HTML if the same book is matched by more than one element.
  const books = new Map();

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  const baseUrl = createStorygraphUrl(target);

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

      const response = await page.goto(u.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 35000,
      });

      if (response && response.status() === 404) {
        console.error(`[SCRAPER] ${target}: 404 at ${u}.`);
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
          // Empty first page = selector, privacy, or bot-block problem. Save evidence.
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
        await page.waitForTimeout(PAGE_DELAY_MS);
      }
    }
  } catch (err) {
    console.error(`[SCRAPER] Error while scraping ${baseUrl}:`, err.message);
  } finally {
    await browser.close();
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
