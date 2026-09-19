import "dotenv/config";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import parseBookPane from "../utils/parseBookPane.js";

const USERNAME = process.env.USERNAME || "seaw457";

const createStorygraphUrl = (target, username, page = 1) =>
  `https://app.thestorygraph.com/${target}/${username}?page=${page}`;

const fetchBookPaneHtmls = async (browser, url) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // Navigate to URL
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Scroll down iteratively to trigger StoryGraph's lazy-loading
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight || totalHeight > 3000) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    });

    // Wait up to 10 seconds for book card containers to exist in the DOM
    await page
      .waitForSelector(".book-pane, .book-title-author-and-series", { timeout: 10000 })
      .catch(() => {});

    await page.waitForTimeout(1000);
  } catch (err) {
    console.log(`Navigation note for ${url}: ${err.message}`);
  }

  // Extract outerHTML for all book pane elements
  const paneHtmls = await page.$$eval(
    ".book-pane, .book-title-author-and-series",
    (elements) => elements.map((el) => el.closest(".book-pane")?.outerHTML || el.outerHTML)
  );

  await context.close();
  return paneHtmls.filter(Boolean);
};

const fetchAllBookPanes = async (target, username, limit = Infinity) => {
  let pageNum = 1;
  let hasMorePages = true;
  const allBookPanes = [];

  const browser = await chromium.launch({ headless: true });

  try {
    while (hasMorePages) {
      const url = createStorygraphUrl(target, username, pageNum);
      const paneHtmls = await fetchBookPaneHtmls(browser, url);

      if (paneHtmls.length === 0) {
        hasMorePages = false;
        break;
      }

      for (let i = 0; i < paneHtmls.length && allBookPanes.length < limit; i++) {
        const $ = cheerio.load(paneHtmls[i]);
        allBookPanes.push($.root());
      }

      hasMorePages = paneHtmls.length >= 10;
      pageNum++;

      if (pageNum > 10 || allBookPanes.length >= limit) {
        hasMorePages = false;
      }
    }
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
