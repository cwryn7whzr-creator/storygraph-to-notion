import { Client } from "@notionhq/client";
import * as scraper from "../functions/getList.js";
import { enrichBooks } from "./storygraphExtras.js";

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});
const databaseId = process.env.NOTION_DATABASE_ID;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Notion rejects the WHOLE book if the cover URL is not a valid full URL,
// so only pass through clean https/http links.
const validCover = (url) =>
  typeof url === "string" && /^https?:\/\//i.test(url) && url.length < 2000 ? url : null;

const MAX_RETRIES = 6;
const stats = { saved: 0, skipped: 0, failed: [], noCover: [] };

// "Year Read" is only sent if the database really has a Number property with that name;
// otherwise Notion would reject every page.
let hasYearReadProp = false;
async function checkYearReadProperty() {
  try {
    const db = await notion.databases.retrieve({ database_id: databaseId });
    hasYearReadProp = db.properties?.["Year Read"]?.type === "number";
  } catch (error) {
    console.warn(`Could not read the database schema: ${error.message}`);
  }
  if (!hasYearReadProp) {
    console.warn('No Number property called "Year Read" in the Notion database, so year read will be skipped.');
  }
}

async function addBookToNotion(book, listType, attempt = 1) {
  if (!book || !book.title || book.title === "Untitled Book") {
    console.log(`Skipping entry with missing title (id: ${book?.id ?? "none"})...`);
    stats.skipped++;
    return;
  }

  try {
    const cover = validCover(book.cover);
    if (book.cover && !cover) {
      console.warn(`Bad cover URL for "${book.title}": ${String(book.cover).slice(0, 100)}`);
    }
    if (!book.cover && attempt === 1) stats.noCover.push(book.title);

    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "Title",
        title: {
          equals: book.title,
        },
      },
    });

    const bookProperties = {
      Title: {
        title: [
          {
            text: {
              content: book.title,
            },
          },
        ],
      },
      Author: {
        rich_text: [
          {
            text: {
              content: book.author || "Unknown",
            },
          },
        ],
      },
      Status: {
        select: {
          name: listTypeToStatus(listType),
        },
      },
      "Cover Image": cover
        ? {
            files: [
              {
                name: `${book.title || "Book"} Cover`.slice(0, 100),
                type: "external",
                external: {
                  url: cover,
                },
              },
            ],
          }
        : undefined,
      "Date Read": book.dateRead
        ? {
            date: {
              start: book.dateRead,
            },
          }
        : undefined,
      Rating:
        book.rating !== undefined
          ? {
              number: book.rating,
            }
          : undefined,
      Genres:
        book.genreTags && book.genreTags.length > 0
          ? {
              multi_select: book.genreTags
                .map((tag) => ({ name: tag.replace(/,/g, "") }))
                .slice(0, 10),
            }
          : undefined,
      Moods:
        book.moodTags && book.moodTags.length > 0
          ? {
              multi_select: book.moodTags
                .map((tag) => ({ name: tag.replace(/,/g, "") }))
                .slice(0, 10),
            }
          : undefined,
      "Page Count": book.pageCount
        ? {
            number: Number(book.pageCount),
          }
        : undefined,
      "Year Read": hasYearReadProp && book.yearRead ? { number: book.yearRead } : undefined,
    };

    // Remove undefined properties prior to sending to Notion API
    Object.keys(bookProperties).forEach(
      (key) => bookProperties[key] === undefined && delete bookProperties[key]
    );

    // Shared payload structure containing page cover and properties
    const pagePayload = {
      cover: cover
        ? {
            type: "external",
            external: {
              url: cover,
            },
          }
        : undefined,
      properties: bookProperties,
    };

    if (response.results.length > 0) {
      const pageId = response.results[0].id;
      await notion.pages.update({
        page_id: pageId,
        ...pagePayload,
      });
      console.log(`Updated book: ${book.title}`);
    } else {
      await notion.pages.create({
        parent: { database_id: databaseId },
        ...pagePayload,
      });
      console.log(`Added new book: ${book.title}`);
    }
    stats.saved++;
  } catch (error) {
    if ((error.status === 429 || error.code === "rate_limited") && attempt < MAX_RETRIES) {
      // Use Notion's own "retry after" hint when it gives one, otherwise back off.
      const hint = Number(error.headers?.get?.("retry-after") ?? error.headers?.["retry-after"]);
      const waitMs = Number.isFinite(hint) && hint > 0 ? hint * 1000 : 3000 * attempt;
      console.warn(`Rate limited on "${book.title}". Retry ${attempt}/${MAX_RETRIES - 1} in ${waitMs / 1000}s...`);
      await delay(waitMs);
      return addBookToNotion(book, listType, attempt + 1);
    }
    // Notion's message says exactly which property or value it rejected.
    console.error(
      `Error adding book "${book.title}": [${error.code || error.status || "unknown"}] ${error.message}`
    );
    stats.failed.push(book.title);
  }
}

function listTypeToStatus(listType) {
  switch (listType) {
    case "books-read":
      return "Read";
    case "currently-reading":
      return "Reading";
    case "to-read":
      return "Want to Read";
    default:
      return "Unknown";
  }
}

async function scrapeStoryGraphList({ target, limit }) {
  try {
    const result = await scraper.handler({
      queryStringParameters: {
        target,
        limit,
      },
    });

    // If the scraper reported an error, don't try to treat it as a book list.
    if (result.statusCode !== 200) {
      console.error(`Scraper failed for ${target}:`, result.body);
      return [];
    }

    return JSON.parse(result.body);
  } catch (error) {
    console.error(`Error scraping list ${target}:`, error);
    return [];
  }
}

// Prints how many books actually had each field, so we can see at a glance
// which parts of the parser are finding data.
function logFieldCounts(listType, books) {
  const n = (test) => books.filter(test).length;
  console.log(
    `[FIELDS] ${listType}: ${books.length} books | cover ${n((b) => b.cover)} | ` +
      `rating ${n((b) => b.rating !== undefined)} | dateRead ${n((b) => b.dateRead)} | ` +
      `genres ${n((b) => b.genreTags?.length)} | moods ${n((b) => b.moodTags?.length)} | ` +
      `pageCount ${n((b) => b.pageCount)} | yearRead ${n((b) => b.yearRead)}`
  );
}

async function syncAllToNotion() {
  try {
    console.log("Starting sync to Notion...");
    await checkYearReadProperty();

    // Order matters: a book on more than one list keeps the status from the
    // LAST list processed. "Read" goes last so it isn't overwritten by
    // "Want to Read" or "Reading".
    const listTypes = ["to-read", "currently-reading", "books-read"];

    for (const listType of listTypes) {
      console.log(`Fetching ${listType} list...`);
      const books = await scrapeStoryGraphList({ target: listType });
      console.log(`Found ${books.length} books in ${listType}`);
      await enrichBooks(books, listType);
      logFieldCounts(listType, books);

      for (const book of books) {
        await addBookToNotion(book, listType);
        await delay(600); // 2 Notion requests per book; this keeps us under the rate limit
      }
    }

    console.log("Sync to Notion completed!");
    console.log(
      `Summary: ${stats.saved} saved, ${stats.skipped} skipped (no title), ${stats.failed.length} failed.`
    );
    if (stats.failed.length > 0) {
      console.log(`Failed books: ${stats.failed.join(" | ")}`);
    }
    if (stats.noCover.length > 0) {
      console.log(
        `No cover found for ${stats.noCover.length} books: ${stats.noCover.slice(0, 30).join(" | ")}` +
          (stats.noCover.length > 30 ? " | ..." : "")
      );
    }
  } catch (error) {
    console.error("Error syncing to Notion:", error);
  } finally {
    await scraper.closeBrowser?.();
  }
}

syncAllToNotion();

export { syncAllToNotion, addBookToNotion };
