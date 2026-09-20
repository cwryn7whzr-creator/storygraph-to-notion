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
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  const url = createStorygraphUrl(target, username);

  try {
    console.log(`[SCRAPER] Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    let hasNextPage = true;
    let pageCount = 1;

    while (hasNextPage && allBookPanes.length < limit) {
      await page
        .waitForSelector(".book-pane, .search-results-item, .book-title-author-and-series", {
          timeout: 15000,
        })
        .catch(() => console.log(`[SCRAPER] Timeout waiting for cards on page ${pageCount}`));

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);

      const paneHtmls = await page.$$eval(         ".book-pane, .search-results-item",         (elements) => elements.map((el) => el.outerHTML)       );        let finalPaneHtmls = paneHtmls;       if (finalPaneHtmls.length === 0) {         finalPaneHtmls = await page.$$eval(".book-title-author-and-series", (elements) =>
          elements.map((el) => {
            const parent = el.closest(".book-pane") || el.closest(".search-results-item") || el.parentElement;
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

      const paginationSelector =
        ".pagination .next a, .pagination a[rel='next'], a.next_page, [aria-label*='next' i], .pagination a:has-text('›'), .pagination a:has-text('»')";

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
