import "dotenv/config";
import { chromium } from "playwright";
import { Window } from "happy-dom";
import parseBookPane from "../utils/parseBookPane.js";

const USERNAME = process.env.USERNAME;

const createStorygraphUrl = (target, username, page = 1) =>
  `https://app.thestorygraph.com/${target}/${username}?page=${page}`;

/**
 * Fetch HTML using a headless browser to pass Cloudflare checks.
 */
const fetchPageHtml = async (browser, url) => {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Navigate to the URL and wait until the DOM is loaded
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const htmlString = await page.content();
  await context.close();

  return htmlString;
};

const collectBookPanesFromHtmlString = (htmlString) => {
  const window = new Window();
  const { document } = window;
  document.documentElement.innerHTML = htmlString;
  return [...document.querySelectorAll(".book-pane")];
};

const fetchAllBookPanes = async (target, username, limit = Infinity) => {
  let pageNum = 1;
  let hasMorePages = true;
  const allBookPanes = [];

  // Launch headless browser once for all pages
  const browser = await chromium.launch({ headless: true });

  try {
    while (hasMorePages) {
      const url = createStorygraphUrl(target, username, pageNum);
      const htmlString = await fetchPageHtml(browser, url);
      const bookPanes = collectBookPanesFromHtmlString(htmlString);

      for (let i = 0; i <= limit - 1 && i < bookPanes.length; i++) {
        allBookPanes.push(bookPanes[i]);
      }

      hasMorePages = bookPanes.length >= 10;
      pageNum++;
      if (pageNum >= 5 || bookPanes.length >= limit) {
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
