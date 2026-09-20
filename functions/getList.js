import "dotenv/config";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import parseBookPane from "../utils/parseBookPane.js";

const USERNAME = process.env.USERNAME || "seaw457";

const createStorygraphUrl = (target, username) =>
  `https://app.thestorygraph.com/${target}/${username}`;

const fetchAllBookPanes = async (target, username, limit = Infinity) => {
  const allBookPanes = [];
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();
  const url = createStorygraphUrl(target, username);

  try {
    console.log(`[SCRAPER] Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });

    let hasNextPage = true;
    let pageCount = 1;

    while (hasNextPage && allBookPanes.length < limit) {
      // 1. Give dynamic Turbo frames time to attach content
      await page.waitForTimeout(2500);

      // 2. Multi-stage scroll to force lazy loading images & elements
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);

      // 3. Multi-selector targeting all possible card representations
      const cardSelector =
        ".book-pane, .search-results-item, .book-pane-wrapper, .book-title-author-and-series, [data-controller*='book-pane']";

      await page
        .waitForSelector(cardSelector, { timeout: 15000 })
        .catch(() => console.log(`[SCRAPER] Container selector timeout on page ${pageCount}. Attempting direct DOM evaluation.`));

      // 4. Extract card HTML blocks safely
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

      // 5. Multi-strategy selector for pagination
      const paginationSelector =
        ".pagination .next a:not(.disabled), .pagination a[rel='next']:not(.disabled), a.next_page:not(.disabled), [aria-label*='next' i]:not(.disabled)";

      const nextButton = await page.$(paginationSelector);

      if (nextButton && allBookPanes.length < limit) {
        const isVisible = await nextButton.isVisible().catch(() => false);
        const isDisabled = await page.evaluate(
          (el) => el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true",
          nextButton
        );

        if (!isVisible || isDisabled) {
          console.log(`[SCRAPER] Reached end of pagination for ${target}.`);
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
  const username = req.queryStringParameters?.username || USERNAME;
  const limit = req.queryStringParameters?.limit || Infinity;

  try {
    const bookPanes = await fetchAllBookPanes(target, username, limit);
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
