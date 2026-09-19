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
      // Wait for book cards to appear in the DOM
      await page
        .waitForSelector(".book-pane, .book-title-author-and-series", { timeout: 10000 })
        .catch(() => {});

      // Scroll down to trigger any lazy-loaded image/card rendering
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(1000);

      // Extract current page's HTML book cards
      const paneHtmls = await page.$$eval(
        ".book-pane, .book-title-author-and-series",
        (elements) =>
          elements.map((el) => {
            const card = el.closest(".book-pane") || el.closest(".search-results-item") || el;
            return card.outerHTML;
          })
      );

      const uniquePanes = [...new Set(paneHtmls)].filter(Boolean);
      console.log(`[SCRAPER] Page ${pageCount}: Found ${uniquePanes.length} books.`);

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

      // Look for StoryGraph's real "Next" pagination link or button
      const nextButton = await page.$("a[rel='next'], a:has-text('Next'), .pagination .next a");

      if (nextButton && allBookPanes.length < limit) {
        pageCount++;
        console.log(`[SCRAPER] Clicking Next button for Page ${pageCount}...`);
        
        await Promise.all([
          page.waitForResponse((resp) => resp.status() === 200, { timeout: 10000 }).catch(() => {}),
          nextButton.click(),
        ]);
        
        await page.waitForTimeout(2000); // Allow Turbo stream to attach new items to DOM
      } else {
        console.log(`[SCRAPER] No further 'Next' page button found. Finished scraping ${target}.`);
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
