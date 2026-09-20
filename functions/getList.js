import * as cheerio from "cheerio";
import fs from "fs";

const MAX_PAGES = 200; // safety cap so a bad selector can never loop forever
const PAGE_DELAY_MS = 1500; // be polite to avoid throttling

/**
 * Scrape a Storygraph list (read, to-read, currently-reading).
 *
 * @param {import("playwright").Page} page  Authenticated Playwright page
 * @param {string} url                      Base list URL (may already contain a query string)
 * @param {string} target                   "read" | "to-read" | "currently-reading"
 * @param {number} limit                    Max books to return (default: no limit)
 * @returns {Promise<Array>}                Array of cheerio roots, one per book card
 */
export async function getList(page, url, target, limit = Infinity) {
  const allBookPanes = [];
  const seenIds = new Set();
  let hasNextPage = true;
  let pageCount = 1;

  const cardSelector =
    target === "currently-reading"
      ? ".currently-reading-cover-wrapper, .currently-reading-title-author"
      : ".book-pane";

  while (hasNextPage && allBookPanes.length < limit && pageCount <= MAX_PAGES) {
    // 1. Navigate (page 1 uses the base URL, later pages add ?page=N safely)
    const u = new URL(url);
    if (pageCount > 1) u.searchParams.set("page", String(pageCount));
    console.log(`[SCRAPER] ${target}: navigating to page ${pageCount}: ${u}`);
    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 35000 });

    // 2. Wait for cards, but never fail silently
    try {
      await page.waitForSelector(cardSelector, { timeout: 10000 });
    } catch {
      console.warn(
        `[SCRAPER] ${target}: no cards on page ${pageCount}. ` +
          `URL: ${page.url()} | Title: ${await page.title()}`
      );
      if (pageCount === 1) {
        // Page 1 empty = selector, login, or bot-block problem. Save evidence.
        await page.screenshot({ path: `debug-${target}.png`, fullPage: true });
        fs.writeFileSync(`debug-${target}.html`, await page.content());
        console.warn(`[SCRAPER] ${target}: saved debug-${target}.png and debug-${target}.html`);
      }
      break;
    }

    // 3. Scroll to trigger lazy-loaded images
    await page.evaluate(async () => {
      for (let i = 0; i < document.body.scrollHeight; i += 300) {
        window.scrollTo(0, i);
        await new Promise((r) => setTimeout(r, 50));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);

    // 4. Extract cards. Also promote lazy-load attributes to src so the
    //    captured HTML has real image URLs, not placeholders.
    const cards = await page.$$eval(cardSelector, (els) =>
      els.map((el) => {
        const card = el.closest(".book-pane") || el.closest(".flex-col") || el;

        card.querySelectorAll("img").forEach((img) => {
          const lazy =
            img.getAttribute("data-src") ||
            img.getAttribute("data-lazy-src") ||
            img.getAttribute("data-original");
          if (lazy && (!img.src || img.src.startsWith("data:"))) {
            img.setAttribute("src", lazy);
          }
        });

        const href = card.querySelector("a[href*='/books/']")?.getAttribute("href") || null;
        return { id: href, html: card.outerHTML };
      })
    );

    // 5. De-dupe by book link (not by HTML) and add to results
    let added = 0;
    for (const { id, html } of cards) {
      if (!id || seenIds.has(id)) continue;
      if (allBookPanes.length >= limit) break;
      seenIds.add(id);
      allBookPanes.push(cheerio.load(html).root());
      added++;
    }

    console.log(
      `[SCRAPER] ${target}: page ${pageCount} added ${added} new books ` +
        `(${allBookPanes.length} total).`
    );

    // 6. Stop when a page adds nothing new, or when there's no pagination
    if (added === 0 || target === "currently-reading") {
      hasNextPage = false;
    } else {
      pageCount++;
      await page.waitForTimeout(PAGE_DELAY_MS);
    }
  }

  console.log(`[SCRAPER] ${target}: finished with ${allBookPanes.length} books.`);
  return allBookPanes;
}
