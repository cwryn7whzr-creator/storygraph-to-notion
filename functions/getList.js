import "dotenv/config";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import parseBookPane from "../utils/parseBookPane.js";

const HARDCODED_USERNAME = "seaw457";

const createStorygraphUrl = (target) => {
  if (target === "currently-reading") {
    return `https://app.thestorygraph.com/profile/${HARDCODED_USERNAME}`;
  }
  return `https://app.thestorygraph.com/${target}/${HARDCODED_USERNAME}`;
};

const fetchAllBookPanes = async (target, limit = Infinity) => {
  const allBookPanes = [];
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
  const url = createStorygraphUrl(target);

  try {
    console.log(`[SCRAPER] Navigating to ${url}...`);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });

    if (response && response.status() === 404) {
      console.error(`[SCRAPER] Page returned 404 at ${url}.`);
      return [];
    }

    await page.waitForTimeout(3000);

    let hasNextPage = true;
    let pageCount = 1;

    while (hasNextPage && allBookPanes.length < limit) {
      // Incremental smooth scroll to force lazy-loaded images (data-src) to hydrate
      await page.evaluate(async () => {
        for (let i = 0; i < document.body.scrollHeight; i += 300) {
          window.scrollTo(0, i);
          await new Promise((res) => setTimeout(res, 50));
        }
      });
      await page.waitForTimeout(1000);

      const cardSelector =
        ".book-pane, .search-results-item, .book-pane-wrapper, .currently-reading-cover-wrapper, .book-title-author-and-series";

      await page.waitForSelector(cardSelector, { timeout: 10000 }).catch(() => {});

      const paneHtmls = await page.$$eval(cardSelector, (elements) =>
        elements
          .map((el) => {
            const card =
              el.closest(".book-pane") ||
              el.closest(".search-results-item") ||
              el.closest(".book-pane-wrapper") ||
              el;
            return card ? card.outerHTML : "";
          })
          .filter(Boolean)
      );

      const uniquePanes = [...new Set(paneHtmls)].filter(Boolean);
      console.log(`[SCRAPER] Page ${pageCount}: Found ${uniquePanes.length} books in ${target}.`);

      if (uniquePanes.length === 0) {
        hasNextPage = false;
        break;
      }

      for (const html of uniquePanes) {
        if (allBookPanes.length < limit) {
          const $ = cheerio.load(html);
          allBookPanes.push($.root());
        }
      }

      if (target === "currently-reading") {
        hasNextPage = false;
        break;
      }

      const paginationSelector =
        ".pagination .next a, .pagination a[rel='next'], a.next_page, .pagination a:has-text('›'), .pagination a:has-text('Next'), a[href*='page=']";

      const nextButton = await page.$(paginationSelector);

      if (nextButton && allBookPanes.length < limit) {
        const isVisible = await nextButton.isVisible().catch(() => false);
        const isDisabled = await page.evaluate(
          (el) => el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true",
          nextButton
        );

        if (!isVisible || isDisabled) {
          console.log(`[SCRAPER] Reached last page for ${target}.`);
          hasNextPage = false;
          break;
        }

        pageCount++;
        console.log(`[SCRAPER] Clicking Next button for Page ${pageCount}...`);

        await nextButton.scrollIntoViewIfNeeded().catch(() => {});

        await Promise.all([
          page.waitForResponse((resp) => resp.status() === 200, { timeout: 10000 }).catch(() => {}),
          nextButton.click({ timeout: 5000 }).catch(async () => {
            await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el) el.click();
            }, paginationSelector);
          }),
        ]);

        await page.waitForTimeout(2500);
      } else {
        console.log(`[SCRAPER] No active 'Next' button found. Finished scraping ${target}.`);
        hasNextPage = false;
      }
    }
  } catch (err) {
    console.error(`[SCRAPER] Error while scraping ${url}:`, err.message);
  } finally {
    await browser.close();
  }

  return allBookPanes;
};

export const handler = async (req) => {
  const target = req.queryStringParameters?.target || "books-read";
  const limit = req.queryStringParameters?.limit || Infinity;

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
