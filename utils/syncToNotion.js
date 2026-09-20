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

// These properties are only sent if the database really has them with the right type;
// otherwise Notion would reject every page.
//   "Years Read" = Multi-select (every year the book was read, rereads included)
//   "Times Read" = Number       (how many times it was read)
//   "Year Read"  = Number       (most recent year read; optional)
const optionalProps = { yearsRead: false, timesRead: false, yearRead: false };
async function checkOptionalProperties() {
  try {
    const db = await notion.databases.retrieve({ database_id: databaseId });
    const p = db.properties || {};
    optionalProps.yearsRead = p["Years Read"]?.type === "multi_select";
    optionalProps.timesRead = p["Times Read"]?.type === "number";
    optionalProps.yearRead = p["Year Read"]?.type === "number";
  } catch (error) {
    console.warn(`Could not read the database schema: ${error.message}`);
  }
  if (!optionalProps.yearsRead) {
    console.warn('No Multi-select property called "Years Read" in the Notion database, so years read will be skipped.');
  }
  if (!optionalProps.timesRead) {
    console.warn('No Number property called "Times Read" in the Notion database, so times read will be skipped.');
  }
}

// The list has one entry per READ, so a reread book shows up more than once. Notion has one
// row per title, so fold repeat entries into one book: every year goes into yearsRead, and
// timesRead counts the entries. Only books-read gets these; the other lists pass through.
function mergeRepeatBooks(books, listType) {
  if (listType !== "books-read") return books;

  const byTitle = new Map();
  const merged = [];
  for (const b of books) {
    if (!b || !b.title || b.title === "Untitled Book") {
      merged.push(b); // skipped later, same as before
      continue;
    }
    const first = byTitle.get(b.title);
    if (!first) {
      const copy = { ...b, timesRead: 1, yearsRead: b.yearRead ? [b.yearRead] : [] };
      byTitle.set(b.title, copy);
      merged.push(copy);
      continue;
    }
    first.timesRead++;
    if (b.yearRead && !first.yearsRead.includes(b.yearRead)) first.yearsRead.push(b.yearRead);
    // Fill any blanks from the repeat entry (the first entry is the most recent read).
    for (const key of ["cover", "author", "pageCount", "dateRead", "rating"]) {
      if (first[key] === undefined || first[key] === null || first[key] === "") {
        if (b[key] !== undefined && b[key] !== null && b[key] !== "") first[key] = b[key];
      }
    }
  }
  for (const b of byTitle.values()) {
    b.yearsRead.sort((x, y) => x - y);
    b.yearRead = b.yearsRead.length ? b.yearsRead[b.yearsRead.length - 1] : undefined;
  }
  return merged;
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
      "Year Read": optionalProps.yearRead && book.yearRead ? { number: book.yearRead } : undefined,
      "Years Read":
        optionalProps.yearsRead && book.yearsRead?.length
          ? { multi_select: book.yearsRead.map((y) => ({ name: String(y) })) }
          : undefined,
      "Times Read": optionalProps.timesRead && book.timesRead ? { number: book.timesRead } : undefined,
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
    await checkOptionalProperties();

    // Order matters: a book on more than one list keeps the status from the
    // LAST list processed. "Read" goes last so it isn't overwritten by
    // "Want to Read" or "Reading".
    const listTypes = ["to-read", "currently-reading", "books-read"];

    for (const listType of listTypes) {
      console.log(`Fetching ${listType} list...`);
      const scraped = await scrapeStoryGraphList({ target: listType });
      console.log(`Found ${scraped.length} books in ${listType}`);
      await enrichBooks(scraped, listType);
      logFieldCounts(listType, scraped);

      const books = mergeRepeatBooks(scraped, listType);
      if (books.length !== scraped.length) {
        console.log(`Merged ${scraped.length} entries into ${books.length} titles (repeat reads count toward Times Read).`);
        const repeats = books.filter((b) => b.timesRead > 1);
        console.log(
          `Read more than once (${repeats.length}): ` +
            repeats
              .slice(0, 40)
              .map((b) => `${b.title.slice(0, 50)} (${b.timesRead}x${b.yearsRead.length ? `: ${b.yearsRead.join(", ")}` : ""})`)
              .join(" | ")
        );
      }

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
