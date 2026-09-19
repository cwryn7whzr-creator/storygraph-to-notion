import { Client } from "@notionhq/client";
import * as scraper from "../functions/getList.js";

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});
const databaseId = process.env.NOTION_DATABASE_ID;
const username = process.env.USERNAME;

/**
 * Adds or updates a book in the Notion database
 */
async function addBookToNotion(book, listType) {
  if (!book || !book.title || book.title === "Untitled Book") {
    console.log("Skipping entry with missing title...");
    return;
  }

  try {
    // Determine filter method: Use StoryGraph ID if present, otherwise fall back to Title
    const filterQuery = book.id
      ? {
          property: "StoryGraph ID",
          rich_text: {
            equals: String(book.id),
          },
        }
      : {
          property: "Title",
          title: {
            equals: book.title,
          },
        };

    const response = await notion.databases.query({
      database_id: databaseId,
      filter: filterQuery,
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
      "StoryGraph ID": book.id
        ? {
            rich_text: [
              {
                text: {
                  content: String(book.id),
                },
              },
            ],
          }
        : undefined,
      Status: {
        select: {
          name: listTypeToStatus(listType),
        },
      },
      "Cover Image":
        book.cover || book.bookCoverStoryGraphUrl
          ? {
              url: book.cover || book.bookCoverStoryGraphUrl,
            }
          : undefined,
      "Page Count": book.pageCount
        ? {
            number: Number(book.pageCount),
          }
        : undefined,
      Genres: {
        multi_select: book.genreTags
          ? book.genreTags.map((tag) => ({ name: tag })).slice(0, 10)
          : [],
      },
      Moods: {
        multi_select: book.moodTags
          ? book.moodTags.map((tag) => ({ name: tag })).slice(0, 10)
          : [],
      },
    };

    // Clean up undefined properties before sending to API
    Object.keys(bookProperties).forEach(
      (key) => bookProperties[key] === undefined && delete bookProperties[key]
    );

    if (response.results.length > 0) {
      // Update existing record
      const pageId = response.results[0].id;
      await notion.pages.update({
        page_id: pageId,
        properties: bookProperties,
      });
      console.log(`Updated book: ${book.title}`);
    } else {
      // Create new page entry
      await notion.pages.create({
        parent: { database_id: databaseId },
        properties: bookProperties,
      });
      console.log(`Added new book: ${book.title}`);
    }
  } catch (error) {
    console.error(`Error adding book ${book.title} to Notion:`, error);
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

async function scrapeStoryGraphList({ target, username, limit }) {
  try {
    const result = await scraper.handler({
      queryStringParameters: {
        target,
        username,
        limit,
      },
    });

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
      const books = await scrapeStoryGraphList({ target: listType, username });
      console.log(`Found ${books.length} books in ${listType}`);

      for (const book of books) {
        await addBookToNotion(book, listType);
      }
    }

    console.log("Sync to Notion completed!");
  } catch (error) {
    console.error("Error syncing to Notion:", error);
  }
}

syncAllToNotion();

export { syncAllToNotion, addBookToNotion };
