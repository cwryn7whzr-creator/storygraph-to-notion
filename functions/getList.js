import "dotenv/config";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import parseBookPane from "../utils/parseBookPane.js";

const USERNAME = process.env.USERNAME;

const createStorygraphUrl = (target, username, page = 1) =>
  `https://app.thestorygraph.com/${target}/${username}?page=${page}`;

/**
 * Fetch book pane outerHTML strings using Playwright and wait for elements to render.
 */
const fetchBookPaneHtmls = async (browser, url) => {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Wait up to 5 seconds for book panes to dynamically render on the page
  await page.waitForSelector(".book-pane", { timeout: 5000 }).catch(() => {
    console.log(`No .book-pane elements rendered at ${url}`);
  });

  const paneHtmls = await page.$$eval(".book-pane", (elements) =>
    elements.map((el) => el.outerHTML)
  );

  await context.close();
  return paneHtmls;
};

/**
 * Fetch and parse all book panes across multiple pages for a target list.
 */
const fetchAllBookPanes = async (target, username, limit = Infinity) => {
  let pageNum = 1;
  let hasMorePages = true;
  const allBookPanes = [];

  const browser = await chromium.launch({ headless: true });

  try {
    while (hasMorePages) {
      const url = createStorygraphUrl(target, username, pageNum);
      const paneHtmls = await fetchBookPaneHtmls(browser, url);

      for (let i = 0; i <= limit - 1 && i < paneHtmls.length; i++) {
        // Load the HTML string into Cheerio so $pane.find() works in parseBookPane
        const $ = cheerio.load(paneHtmls[i]);
        allBookPanes.push($.root());
      }

      hasMorePages = paneHtmls.length >= 10;
      pageNum++;
      if (pageNum >= 5 || allBookPanes.length >= limit) {
        hasMorePages = false;
      }
    }
  } finally {
    await browser.close();
  }

  return allBookPanes.filter((pane) => pane != null);
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
