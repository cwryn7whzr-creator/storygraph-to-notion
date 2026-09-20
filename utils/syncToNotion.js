import { Client } from "@notionhq/client";
import * as scraper from "../functions/getList.js";

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});
const databaseId = process.env.NOTION_DATABASE_ID;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Notion rejects the WHOLE book if the cover URL is not a valid full URL,
// so only pass through clean https/http links.
const validCover = (url) =>
  typeof url === "string" && /^https?:\/\//i.test(url) && url.length < 2000 ? url : null;

const stats = { saved: 0, skipped: 0, failed: [] };

async function addBookToNotion(book, listType) {
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
    if (error.status === 429) {
      console.warn(`Rate limited on "${book.title}". Retrying in 3 seconds...`);
      await delay(3000);
      return addBookToNotion(book, listType);
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

async function syncAllToNotion() {
  try {
    console.log("Starting sync to Notion...");

    const listTypes = ["books-read", "currently-reading", "to-read"];

    for (const listType of listTypes) {
      console.log(`Fetching ${listType} list...`);
      const books = await scrapeStoryGraphList({ target: listType });
      console.log(`Found ${books.length} books in ${listType}`);

      for (const book of books) {
        await addBookToNotion(book, listType);
        await delay(350);
      }
    }

    console.log("Sync to Notion completed!");
    console.log(
      `Summary: ${stats.saved} saved, ${stats.skipped} skipped (no title), ${stats.failed.length} failed.`
    );
    if (stats.failed.length > 0) {
      console.log(`Failed books: ${stats.failed.join(" | ")}`);
    }
  } catch (error) {
    console.error("Error syncing to Notion:", error);
  }
}

syncAllToNotion();

export { syncAllToNotion, addBookToNotion };
