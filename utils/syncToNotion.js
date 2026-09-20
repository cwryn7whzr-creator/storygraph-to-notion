import { Client } from "@notionhq/client";
import * as scraper from "../functions/getList.js";
import { enrichBooks } from "./storygraphExtras.js";

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const databaseId = process.env.NOTION_DATABASE_ID;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const validCover = (url) =>
  typeof url === "string" &&
  /^https?:\/\//i.test(url) &&
  url.length < 2000
    ? url
    : null;

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

const MAX_RETRIES = 6;

// Keep below Notion's practical 3-request-per-second integration rate.
// 450ms = about 2.2 requests/second maximum from this script.
const NOTION_MIN_INTERVAL_MS = 450;

const stats = {
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  failed: [],
  noCover: [],
  noYear: [],
};

// These are optional so the script does not fail if you have not added them
// to your Notion database yet.
const optionalProps = {
  yearsRead: false,
  timesRead: false,
  yearRead: false,
  storyGraphId: false,
};

let lastNotionRequestAt = 0;

// Routes every Notion request through a single pacing and retry layer.
async function notionRequest(fn, label, attempt = 1) {
  const waitMs = Math.max(
    0,
    NOTION_MIN_INTERVAL_MS - (Date.now() - lastNotionRequestAt)
  );

  if (waitMs > 0) {
    await delay(waitMs);
  }

  try {
    lastNotionRequestAt = Date.now();
    return await fn();
  } catch (error) {
    const isRateLimited =
      error?.status === 429 || error?.code === "rate_limited";

    if (!isRateLimited || attempt >= MAX_RETRIES) {
      throw error;
    }

    const retryAfter = Number(
      error.headers?.get?.("retry-after") ??
        error.headers?.["retry-after"]
    );

    const retryMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(
            60000,
            2000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 1000)
          );

    console.warn(
      `[NOTION] Rate limited during ${label}. ` +
        `Retry ${attempt}/${MAX_RETRIES - 1} in ${Math.ceil(
          retryMs / 1000
        )}s...`
    );

    await delay(retryMs);
    return notionRequest(fn, label, attempt + 1);
  }
}

function getPlainText(property) {
  if (!property) return "";

  if (property.type === "title" || property.type === "rich_text") {
    return clean(
      property[property.type]
        ?.map((item) => item.plain_text)
        .join("")
    );
  }

  return "";
}

function getNumber(property) {
  return property?.type === "number" ? property.number : null;
}

function getDateStart(property) {
  return property?.type === "date" ? property.date?.start || null : null;
}

function getSelectName(property) {
  return property?.type === "select"
    ? property.select?.name || null
    : null;
}

function getMultiSelectNames(property) {
  return property?.type === "multi_select"
    ? property.multi_select.map((item) => item.name).filter(Boolean)
    : [];
}

function getExternalFileUrl(property) {
  if (property?.type !== "files") return null;

  const file = property.files?.[0];
  if (!file) return null;

  if (file.type === "external") {
    return file.external?.url || null;
  }

  if (file.type === "file") {
    return file.file?.url || null;
  }

  return null;
}

function getPageCoverUrl(page) {
  if (page?.cover?.type === "external") {
    return page.cover.external?.url || null;
  }

  if (page?.cover?.type === "file") {
    return page.cover.file?.url || null;
  }

  return null;
}

function titleProperty(value) {
  return {
    title: [
      {
        text: {
          content: String(value).slice(0, 2000),
        },
      },
    ],
  };
}

function richTextProperty(value) {
  return {
    rich_text: [
      {
        text: {
          content: String(value).slice(0, 2000),
        },
      },
    ],
  };
}

function filesProperty(url, title) {
  return {
    files: [
      {
        name: `${title || "Book"} Cover`.slice(0, 100),
        type: "external",
        external: {
          url,
        },
      },
    ],
  };
}

function coverPayload(url) {
  return {
    type: "external",
    external: {
      url,
    },
  };
}

function multiSelectProperty(values) {
  return {
    multi_select: values.map((value) => ({
      name: String(value).slice(0, 100),
    })),
  };
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

function canUse(schema, propertyName, expectedType) {
  return schema[propertyName]?.type === expectedType;
}

async function checkDatabaseProperties() {
  const db = await notionRequest(
    () => notion.databases.retrieve({ database_id: databaseId }),
    "database schema retrieval"
  );

  const schema = db.properties || {};

  optionalProps.yearsRead =
    schema["Years Read"]?.type === "multi_select";

  optionalProps.timesRead =
    schema["Times Read"]?.type === "number";

  optionalProps.yearRead =
    schema["Year Read"]?.type === "number";

  optionalProps.storyGraphId =
    schema["StoryGraph ID"]?.type === "rich_text";

  const expectedProperties = {
    Title: "title",
    Author: "rich_text",
    Status: "select",
    "Cover Image": "files",
    "Date Read": "date",
    Rating: "number",
    Genres: "multi_select",
    Moods: "multi_select",
    "Page Count": "number",
  };

  for (const [propertyName, expectedType] of Object.entries(
    expectedProperties
  )) {
    if (schema[propertyName]?.type !== expectedType) {
      console.warn(
        `[NOTION] Property "${propertyName}" is missing or is not a ` +
          `"${expectedType}" property. That field will be skipped.`
      );
    }
  }

  if (!optionalProps.yearsRead) {
    console.warn(
      '[NOTION] No Multi-select property named "Years Read"; it will be skipped.'
    );
  }

  if (!optionalProps.timesRead) {
    console.warn(
      '[NOTION] No Number property named "Times Read"; it will be skipped.'
    );
  }

  if (!optionalProps.storyGraphId) {
    console.log(
      '[NOTION] Optional "StoryGraph ID" Rich text property not found; ID storage is skipped.'
    );
  }

  return schema;
}

// Loads all existing pages once. This avoids one database query per book.
async function loadExistingPages() {
  const byExactTitle = new Map();
  let cursor = undefined;

  do {
    const response = await notionRequest(
      () =>
        notion.databases.query({
          database_id: databaseId,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      "database preload"
    );

    for (const page of response.results) {
      const title = getPlainText(page.properties?.Title);

      if (!title) {
        continue;
      }

      if (byExactTitle.has(title)) {
        console.warn(
          `[NOTION] Duplicate existing title "${title}". ` +
            "The first matching page will be used; duplicates are not merged automatically."
        );
        continue;
      }

      byExactTitle.set(title, page);
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(
    `[NOTION] Loaded ${byExactTitle.size} existing pages for exact-title matching.`
  );

  return byExactTitle;
}

// The StoryGraph books-read list contains one item per completed read.
// A reread may therefore appear more than once. Keep one Notion page per
// exact display title while accumulating Times Read and Years Read.
function mergeRepeatBooks(books, listType) {
  if (listType !== "books-read") {
    return books;
  }

  const byTitle = new Map();
  const merged = [];

  for (const book of books) {
    if (!book || !book.title || book.title === "Untitled Book") {
      merged.push(book);
      continue;
    }

    const first = byTitle.get(book.title);

    if (!first) {
      const copy = {
        ...book,
        timesRead: 1,
        yearsRead: book.yearRead ? [book.yearRead] : [],
      };

      byTitle.set(book.title, copy);
      merged.push(copy);
      continue;
    }

    first.timesRead++;

    if (book.yearRead && !first.yearsRead.includes(book.yearRead)) {
      first.yearsRead.push(book.yearRead);
    }

    // Preserve the first / newest entry's display values and fill blanks only.
    for (const key of [
      "cover",
      "author",
      "pageCount",
      "dateRead",
      "rating",
      "id",
    ]) {
      if (
        first[key] === undefined ||
        first[key] === null ||
        first[key] === ""
      ) {
        if (
          book[key] !== undefined &&
          book[key] !== null &&
          book[key] !== ""
        ) {
          first[key] = book[key];
        }
      }
    }

    if (!first.genreTags?.length && book.genreTags?.length) {
      first.genreTags = book.genreTags;
    }

    if (!first.moodTags?.length && book.moodTags?.length) {
      first.moodTags = book.moodTags;
    }
  }

  for (const book of byTitle.values()) {
    book.yearsRead.sort((a, b) => a - b);

    book.yearRead = book.yearsRead.length
      ? book.yearsRead[book.yearsRead.length - 1]
      : undefined;
  }

  return merged;
}

// Used only when creating a new Notion page.
function createBookProperties(book, listType, schema) {
  const cover = validCover(book.cover);

  const properties = {
    Title: titleProperty(book.title),
  };

  if (canUse(schema, "Author", "rich_text") && book.author) {
    properties.Author = richTextProperty(book.author);
  }

  if (canUse(schema, "Status", "select")) {
    properties.Status = {
      select: {
        name: listTypeToStatus(listType),
      },
    };
  }

  if (canUse(schema, "Cover Image", "files") && cover) {
    properties["Cover Image"] = filesProperty(cover, book.title);
  }

  if (canUse(schema, "Date Read", "date") && book.dateRead) {
    properties["Date Read"] = {
      date: {
        start: book.dateRead,
      },
    };
  }

  if (canUse(schema, "Rating", "number") && book.rating !== undefined) {
    properties.Rating = {
      number: Number(book.rating),
    };
  }

  if (
    canUse(schema, "Genres", "multi_select") &&
    book.genreTags?.length
  ) {
    properties.Genres = multiSelectProperty(book.genreTags.slice(0, 10));
  }

  if (
    canUse(schema, "Moods", "multi_select") &&
    book.moodTags?.length
  ) {
    properties.Moods = multiSelectProperty(book.moodTags.slice(0, 10));
  }

  if (canUse(schema, "Page Count", "number") && book.pageCount) {
    properties["Page Count"] = {
      number: Number(book.pageCount),
    };
  }

  if (optionalProps.yearRead && book.yearRead) {
    properties["Year Read"] = {
      number: Number(book.yearRead),
    };
  }

  if (optionalProps.yearsRead && book.yearsRead?.length) {
    properties["Years Read"] = multiSelectProperty(book.yearsRead);
  }

  if (optionalProps.timesRead && book.timesRead) {
    properties["Times Read"] = {
      number: Number(book.timesRead),
    };
  }

  if (optionalProps.storyGraphId && book.id) {
    properties["StoryGraph ID"] = richTextProperty(book.id);
  }

  return properties;
}

// books-read:
//   Fill blank values only. Never replace an existing Notion property.
//
// to-read / currently-reading:
//   Refresh any field StoryGraph actually provides. Do not erase a Notion value
//   when StoryGraph gives no value.
//
// Covers are always fill-only for every list so manually selected covers remain
// protected. If one location is blank, it copies from the other location or
// from StoryGraph's source cover.
function buildExistingPageUpdate(book, listType, existingPage, schema) {
  const existing = existingPage.properties || {};
  const properties = {};

  const sourceCover = validCover(book.cover);
  const existingCoverProperty = getExternalFileUrl(
    existing["Cover Image"]
  );
  const existingPageCover = getPageCoverUrl(existingPage);

  const isReadHistory = listType === "books-read";
  let cover;

  // Cover Image Files & media property:
  // Never replace it if it already exists. Fill only when blank.
  if (
    canUse(schema, "Cover Image", "files") &&
    !existingCoverProperty
  ) {
    const fillCover = sourceCover || existingPageCover;

    if (fillCover) {
      properties["Cover Image"] = filesProperty(fillCover, book.title);
    }
  }

  // Page cover:
  // Never replace it if it already exists. Fill only when blank.
  if (!existingPageCover) {
    const fillPageCover = sourceCover || existingCoverProperty;

    if (fillPageCover) {
      cover = coverPayload(fillPageCover);
    }
  }

  // Author:
  // Read history = fill blank only.
  // Active lists = update if StoryGraph has an author.
  if (
    canUse(schema, "Author", "rich_text") &&
    book.author &&
    (!isReadHistory || !getPlainText(existing.Author))
  ) {
    properties.Author = richTextProperty(book.author);
  }

  // Status:
  // Read history = fill blank only.
  // Active lists = always track the list being synced.
  if (
    canUse(schema, "Status", "select") &&
    (!isReadHistory || !getSelectName(existing.Status))
  ) {
    properties.Status = {
      select: {
        name: listTypeToStatus(listType),
      },
    };
  }

  if (
    canUse(schema, "Date Read", "date") &&
    book.dateRead &&
    (!isReadHistory || !getDateStart(existing["Date Read"]))
  ) {
    properties["Date Read"] = {
      date: {
        start: book.dateRead,
      },
    };
  }

  if (
    canUse(schema, "Rating", "number") &&
    book.rating !== undefined &&
    (!isReadHistory || getNumber(existing.Rating) === null)
  ) {
    properties.Rating = {
      number: Number(book.rating),
    };
  }

  if (
    canUse(schema, "Genres", "multi_select") &&
    book.genreTags?.length &&
    (!isReadHistory ||
      getMultiSelectNames(existing.Genres).length === 0)
  ) {
    properties.Genres = multiSelectProperty(book.genreTags.slice(0, 10));
  }

  if (
    canUse(schema, "Moods", "multi_select") &&
    book.moodTags?.length &&
    (!isReadHistory ||
      getMultiSelectNames(existing.Moods).length === 0)
  ) {
    properties.Moods = multiSelectProperty(book.moodTags.slice(0, 10));
  }

  if (
    canUse(schema, "Page Count", "number") &&
    book.pageCount &&
    (!isReadHistory ||
      getNumber(existing["Page Count"]) === null)
  ) {
    properties["Page Count"] = {
      number: Number(book.pageCount),
    };
  }

  // These are your intentional historic read-tracking fields.
  // They remain fill-only regardless of list type.
  if (
    optionalProps.yearRead &&
    book.yearRead &&
    getNumber(existing["Year Read"]) === null
  ) {
    properties["Year Read"] = {
      number: Number(book.yearRead),
    };
  }

  if (
    optionalProps.yearsRead &&
    book.yearsRead?.length &&
    getMultiSelectNames(existing["Years Read"]).length === 0
  ) {
    properties["Years Read"] = multiSelectProperty(book.yearsRead);
  }

  if (
    optionalProps.timesRead &&
    book.timesRead &&
    getNumber(existing["Times Read"]) === null
  ) {
    properties["Times Read"] = {
      number: Number(book.timesRead),
    };
  }

  // Diagnostic only. Never overwrite an existing StoryGraph ID.
  if (
    optionalProps.storyGraphId &&
    book.id &&
    !getPlainText(existing["StoryGraph ID"])
  ) {
    properties["StoryGraph ID"] = richTextProperty(book.id);
  }

  return { properties, cover };
}

async function saveBook(book, listType, existingPages, schema) {
  if (!book?.title || book.title === "Untitled Book") {
    console.log(
      `Skipping entry with missing title (id: ${book?.id || "none"})...`
    );
    stats.skipped++;
    return;
  }

  if (!book.cover) {
    stats.noCover.push(book.title);
  }

  if (listType === "books-read" && !book.yearRead) {
    stats.noYear.push({
      title: book.title,
      author: book.author || "Unknown Author",
      storyGraphId: book.id || "unknown",
    });
  }

  try {
    const existingPage = existingPages.get(book.title);

    if (!existingPage) {
      const cover = validCover(book.cover);

      const page = await notionRequest(
        () =>
          notion.pages.create({
            parent: {
              database_id: databaseId,
            },
            ...(cover ? { cover: coverPayload(cover) } : {}),
            properties: createBookProperties(book, listType, schema),
          }),
        `create "${book.title}"`
      );

      existingPages.set(book.title, page);
      stats.created++;

      console.log(`Added new book: ${book.title}`);
      return;
    }

    const update = buildExistingPageUpdate(
      book,
      listType,
      existingPage,
      schema
    );

    if (Object.keys(update.properties).length === 0 && !update.cover) {
      stats.unchanged++;
      console.log(`Unchanged book: ${book.title}`);
      return;
    }

    const page = await notionRequest(
      () =>
        notion.pages.update({
          page_id: existingPage.id,
          ...(update.cover ? { cover: update.cover } : {}),
          properties: update.properties,
        }),
      listType === "books-read"
        ? `fill read-history blanks for "${book.title}"`
        : `sync active-list values for "${book.title}"`
    );

    existingPages.set(book.title, page);
    stats.updated++;

    console.log(
      listType === "books-read"
        ? `Filled missing read-history fields: ${book.title}`
        : `Synced active-list fields: ${book.title}`
    );
  } catch (error) {
    console.error(
      `Error saving "${book.title}": ` +
        `[${error.code || error.status || "unknown"}] ${error.message}`
    );

    stats.failed.push(book.title);
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

    if (result.statusCode !== 200) {
      console.error(`Scraper failed for ${target}: ${result.body}`);
      return [];
    }

    return JSON.parse(result.body);
  } catch (error) {
    console.error(`Error scraping list ${target}: ${error.message}`);
    return [];
  }
}

function logFieldCounts(listType, books) {
  const count = (test) => books.filter(test).length;

  console.log(
    `[FIELDS] ${listType}: ${books.length} books | ` +
      `cover ${count((book) => book.cover)} | ` +
      `rating ${count((book) => book.rating !== undefined)} | ` +
      `dateRead ${count((book) => book.dateRead)} | ` +
      `genres ${count((book) => book.genreTags?.length)} | ` +
      `moods ${count((book) => book.moodTags?.length)} | ` +
      `pageCount ${count((book) => book.pageCount)} | ` +
      `yearRead ${count((book) => book.yearRead)}`
  );
}

function logNoYearBooks() {
  if (stats.noYear.length === 0) {
    return;
  }

  console.log(
    `[YEARS] Books with no StoryGraph year (${stats.noYear.length}):`
  );

  for (const book of stats.noYear) {
    console.log(
      `[YEARS] - ${book.title} — ${book.author} ` +
        `(StoryGraph ID: ${book.storyGraphId})`
    );
  }
}

async function syncAllToNotion() {
  try {
    console.log("Starting sync to Notion...");

    if (!process.env.NOTION_API_KEY || !databaseId) {
      throw new Error(
        "NOTION_API_KEY and NOTION_DATABASE_ID must both be configured."
      );
    }

    const schema = await checkDatabaseProperties();
    const existingPages = await loadExistingPages();

    // This ordering is intentional. Active-list statuses are refreshed first.
    // books-read goes last but does not overwrite a populated status, because
    // read history uses fill-only behavior.
    const listTypes = [
      "to-read",
      "currently-reading",
      "books-read",
    ];

    for (const listType of listTypes) {
      console.log(`Fetching ${listType} list...`);

      const scraped = await scrapeStoryGraphList({
        target: listType,
      });

      console.log(`Found ${scraped.length} books in ${listType}`);

      await enrichBooks(scraped, listType);
      logFieldCounts(listType, scraped);

      const books = mergeRepeatBooks(scraped, listType);

      if (books.length !== scraped.length) {
        const repeats = books.filter((book) => book.timesRead > 1);

        console.log(
          `Merged ${scraped.length} entries into ${books.length} titles ` +
            "(repeat reads count toward Times Read)."
        );

        console.log(
          `Read more than once (${repeats.length}): ` +
            repeats
              .slice(0, 40)
              .map(
                (book) =>
                  `${book.title.slice(0, 50)} (${book.timesRead}x${
                    book.yearsRead.length
                      ? `: ${book.yearsRead.join(", ")}`
                      : ""
                  })`
              )
              .join(" | ")
        );
      }

      for (const book of books) {
        await saveBook(book, listType, existingPages, schema);
      }
    }

    console.log("Sync to Notion completed.");

    console.log(
      `Summary: ${stats.created} created, ${stats.updated} updated, ` +
        `${stats.unchanged} unchanged, ${stats.skipped} skipped, ` +
        `${stats.failed.length} failed.`
    );

    if (stats.failed.length > 0) {
      console.log(`Failed books: ${stats.failed.join(" | ")}`);
    }

    if (stats.noCover.length > 0) {
      const uniqueNoCover = [...new Set(stats.noCover)];

      console.log(
        `No source cover found for ${uniqueNoCover.length} books: ` +
          `${uniqueNoCover.slice(0, 30).join(" | ")}` +
          (uniqueNoCover.length > 30 ? " | ..." : "")
      );
    }

    logNoYearBooks();
  } catch (error) {
    console.error(`Error syncing to Notion: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await scraper.closeBrowser?.();
  }
}

syncAllToNotion();

export { syncAllToNotion };
