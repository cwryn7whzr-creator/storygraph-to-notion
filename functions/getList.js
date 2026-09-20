import "dotenv/config";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import parseBookPane from "../utils/parseBookPane.js";

// Directly hardcode your StoryGraph handle here
const HARDCODED_USERNAME = "seaw457"; 

const createStorygraphUrl = (target) => {
  return `https://app.thestorygraph.com/${target}/${HARDCODED_USERNAME}`;
};

const fetchAllBookPanes = async (target, username, limit = Infinity) => {
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
  const url = createStorygraphUrl(target); // Uses the hardcoded URL directly

  try {
    console.log(`[SCRAPER] Navigating to ${url}...`);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    if (response && response.status() === 404) {
      console.error(`[SCRAPER] Page returned 404 at ${url}. Check handle.`);
      return [];
    }

    // Give dynamic client-side scripts time to populate DOM
    await page.waitForTimeout(3000);

    // Scroll down to trigger lazy loading for card covers and pagination
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    let hasNextPage = true;
    let pageCount = 1;

    while (hasNextPage && allBookPanes.length < limit) {
      // Primary card selectors
      await page
        .waitForSelector(
          ".book-pane, .search-results-item, .book-title-author-and-series, .book-pane-wrapper",
          { timeout: 10000 }
        )
        .catch(() => {});

      // Extract raw card HTML elements
      const paneHtmls = await page.$$eval(         ".book-pane, .search-results-item, .book-pane-wrapper",         (elements) => elements.map((el) => el.outerHTML)       );        let finalPaneHtmls = paneHtmls;       if (finalPaneHtmls.length === 0) {         finalPaneHtmls = await page.$$eval(".book-title-author-and-series", (elements) =>
          elements.map((el) => {
            const parent =
              el.closest(".book-pane") ||
              el.closest(".search-results-item") ||
              el.closest(".book-pane-wrapper") ||
              el.parentElement;
            return parent ? parent.outerHTML : el.outerHTML;
          })
        );
      }

      const uniquePanes = [...new Set(finalPaneHtmls)].filter(Boolean);
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

      // Pagination selector matching active "Next" buttons
      const paginationSelector =
        ".pagination .next a:not(.disabled), .pagination a[rel='next']:not(.disabled), a.next_page:not(.disabled)";

      const nextButton = await page.$(paginationSelector);

      if (nextButton && allBookPanes.length < limit) {
        const isVisible = await nextButton.isVisible().catch(() => false);

        if (!isVisible) {
          console.log(`[SCRAPER] Next page link is hidden. Reached last page for ${target}.`);
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
    const bookPanes = await fetchAllBookPanes(target, HARDCODED_USERNAME, limit);
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
