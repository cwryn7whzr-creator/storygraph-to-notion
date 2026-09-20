import { Client } from "@notionhq/client";
import * as scraper from "../functions/getList.js";
import { enrichBooks, normTitle } from "./storygraphExtras.js";

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const databaseId = process.env.NOTION_DATABASE_ID;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RETRIES = 6;

// Kept below Notion's practical per-integration request ceiling.
const NOTION_MIN_INTERVAL_MS = 500;

const stats = {
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  failed: [],
  noCover: [],
  noYear: [],
  duplicateMatches: 0,
};

const optionalProps = {
  yearsRead: false,
  timesRead: false,
  yearRead: false,
  storyGraphId: false,
};

let lastNotionRequestAt = 0;

const clean = (value) =>
  String(value || "").replace(/\s+/g, " ").trim();

const normAuthor = (value) =>
  clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const validExternalUrl = (url) =>
  typeof url === "string" &&
  /^https?:\/\//i.test(url) &&
  url.length < 2000
    ? url
    : null;

function guessImageContentType(url) {
  if (/\.png(?:\?|$)/i.test(url)) return "image/png";
  if (/\.webp(?:\?|$)/i.test(url)) return "image/webp";
  if (/\.gif(?:\?|$)/i.test(url)) return "image/gif";
  return "image/jpeg";
}

function safeCoverFilename(title, url) {
  const extension =
    url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)?.[1] || "jpg";

  const base =
    String(title || "book-cover")
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .slice(0, 70) || "book-cover";

  return `${base}-cover.${extension}`;
}

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
    const rateLimited =
      error?.status === 429 || error?.code === "rate_limited";

    if (!rateLimited || attempt >= MAX_RETRIES) {
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
      `[NOTION] Rate limited during ${label}. Retry ` +
        `${attempt}/${MAX_RETRIES - 1} in ${Math.ceil(
          retryMs / 1000
        )}s...`
    );

    await delay(retryMs);

    return notionRequest(fn, label, attempt + 1);
  }
}

function getPlainText(property) {
  if (!property) {
    return "";
  }

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

function getSelectName(property) {
  return property?.type === "select"
    ? property.select?.name || null
    : null;
}

function getDateStart(property) {
  return property?.type === "date"
    ? property.date?.start || null
    : null;
}

function getMultiSelectNames(property) {
  return property?.type === "multi_select"
    ? property.multi_select.map((item) => item.name).filter(Boolean)
    : [];
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

function hasFilesProperty(property) {
  return property?.type === "files" && property.files?.length > 0;
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

function multiSelectProperty(values) {
  return {
    multi_select: values.map((value) => ({
      name: String(value).slice(0, 100),
    })),
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
    Rating: "number",
    Genres: "multi_select",
    Moods: "multi_select",
    "Page Count": "number",
  };

  for (const [name, type] of Object.entries(expectedProperties)) {
    if (schema[name]?.type !== type) {
      console.warn(
        `[NOTION] Property "${name}" is missing or is not type "${type}". ` +
          "That value will be skipped."
      );
    }
  }

  if (!optionalProps.storyGraphId) {
    console.log(
      '[NOTION] Optional "StoryGraph ID" Rich text property not found; ID storage is skipped.'
    );
  }

  return schema;
}

function pageCompleteness(page) {
  const properties = page.properties || {};
  let score = 0;

  if (getPlainText(properties.Title)) score += 2;
  if (getPlainText(properties.Author)) score += 2;
  if (getSelectName(properties.Status)) score += 1;
  if (getNumber(properties.Rating) !== null) score += 1;
  if (getDateStart(properties["Date Read"])) score += 1;
  if (getMultiSelectNames(properties.Genres).length) score += 2;
  if (getMultiSelectNames(properties.Moods).length) score += 2;
  if (getNumber(properties["Page Count"]) !== null) score += 1;
  if (getNumber(properties["Year Read"]) !== null) score += 1;
  if (getMultiSelectNames(properties["Years Read"]).length) score += 2;
  if (getNumber(properties["Times Read"]) !== null) score += 1;
  if (getPlainText(properties["StoryGraph ID"])) score += 3;
  if (hasFilesProperty(properties["Cover Image"])) score += 2;
  if (getPageCoverUrl(page)) score += 2;

  return score;
}

function chooseCanonicalPage(candidates) {
  return [...candidates].sort((left, right) => {
    const scoreDifference =
      pageCompleteness(right) - pageCompleteness(left);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return String(left.id).localeCompare(String(right.id));
  })[0];
}

async function loadExistingPages() {
  const pages = [];
  const byExactTitle = new Map();
  const byStoryGraphId = new Map();

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
      pages.push(page);

      const properties = page.properties || {};
      const title = getPlainText(properties.Title);
      const storyGraphId = getPlainText(properties["StoryGraph ID"]);

      if (title) {
        const matches = byExactTitle.get(title) || [];
        matches.push(page);
        byExactTitle.set(title, matches);
      }

      if (storyGraphId) {
        const matches = byStoryGraphId.get(storyGraphId) || [];
        matches.push(page);
        byStoryGraphId.set(storyGraphId, matches);
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`[NOTION] Loaded ${pages.length} existing pages.`);

  return {
    pages,
    byExactTitle,
    byStoryGraphId,
  };
}

function sameAuthor(book, page) {
  const existingAuthor = getPlainText(page.properties?.Author);

  if (!book.author || !existingAuthor) {
    return false;
  }

  return normAuthor(book.author) === normAuthor(existingAuthor);
}

// Exact title matches win. StoryGraph ID is used next. A normalized-title
// fallback is accepted only when author names also match exactly after
// normalization. This avoids merging different books with similar titles.
function findExistingPage(book, indexes) {
  const exactMatches = indexes.byExactTitle.get(book.title) || [];

  if (exactMatches.length > 0) {
    const canonical = chooseCanonicalPage(exactMatches);

    if (exactMatches.length > 1) {
      stats.duplicateMatches++;

      console.warn(
        `[DUPLICATE] Exact title "${book.title}" has ${exactMatches.length} ` +
          `Notion pages. Keeping page ${canonical.id} as canonical ` +
          `(data score ${pageCompleteness(canonical)}).`
      );
    }

    return canonical;
  }

  if (book.id) {
    const idMatches = indexes.byStoryGraphId.get(book.id) || [];

    if (idMatches.length > 0) {
      const canonical = chooseCanonicalPage(idMatches);

      console.log(
        `[MATCH] StoryGraph ID matched "${book.title}" to existing ` +
          `"${getPlainText(canonical.properties?.Title)}".`
      );

      return canonical;
    }
  }

  const normalizedBookTitle = normTitle(book.title);

  const safeSimilarMatches = indexes.pages.filter((page) => {
    const existingTitle = getPlainText(page.properties?.Title);

    if (!existingTitle || normTitle(existingTitle) !== normalizedBookTitle) {
      return false;
    }

    return sameAuthor(book, page);
  });

  if (safeSimilarMatches.length > 0) {
    const canonical = chooseCanonicalPage(safeSimilarMatches);

    stats.duplicateMatches++;

    console.log(
      `[MATCH] Normalized title + author matched "${book.title}" to ` +
        `"${getPlainText(canonical.properties?.Title)}" ` +
        `(data score ${pageCompleteness(canonical)}).`
    );

    return canonical;
  }

  return null;
}

function rememberPage(indexes, page) {
  indexes.pages.push(page);

  const properties = page.properties || {};
  const title = getPlainText(properties.Title);
  const storyGraphId = getPlainText(properties["StoryGraph ID"]);

  if (title) {
    const matches = indexes.byExactTitle.get(title) || [];
    matches.push(page);
    indexes.byExactTitle.set(title, matches);
  }

  if (storyGraphId) {
    const matches = indexes.byStoryGraphId.get(storyGraphId) || [];
    matches.push(page);
    indexes.byStoryGraphId.set(storyGraphId, matches);
  }
}

// Keeps intentional repeat reads. The book's displayed title is never
// normalized or replaced; exact title remains the record key.
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

    for (const field of [
      "cover",
      "author",
      "pageCount",
      "dateRead",
      "rating",
      "id",
      "bookUrl",
    ]) {
      if (
        first[field] === undefined ||
        first[field] === null ||
        first[field] === ""
      ) {
        first[field] = book[field];
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
    book.yearsRead.sort((left, right) => left - right);

    book.yearRead = book.yearsRead.length
      ? book.yearsRead[book.yearsRead.length - 1]
      : undefined;
  }

  return merged;
}

// Imports an external public image into Notion's file system. The returned
// value is a file_upload object usable in a Files & media property.
async function importCoverToNotion(imageUrl, title) {
  const url = validExternalUrl(imageUrl);

  if (!url) {
    return null;
  }

  try {
    const upload = await notionRequest(
      () =>
        notion.fileUploads.create({
          mode: "external_url",
          filename: safeCoverFilename(title, url),
          content_type: guessImageContentType(url),
          external_url: url,
        }),
      `import cover "${title}"`
    );

    console.log(`[COVER] Imported cover for "${title}".`);

    return {
      type: "file_upload",
      file_upload: {
        id: upload.id,
      },
    };
  } catch (error) {
    console.warn(
      `[COVER] Could not import cover for "${title}": ${error.message}`
    );

    return null;
  }
}

async function createBookProperties(book, listType, schema) {
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

  // New records get an actual Notion-imported image in the Files & media
  // property, which can be selected as the Gallery card preview.
  if (
    canUse(schema, "Cover Image", "files") &&
    validExternalUrl(book.cover)
  ) {
    const coverUpload = await importCoverToNotion(
      book.cover,
      book.title
    );

    if (coverUpload) {
      properties["Cover Image"] = {
        files: [coverUpload],
      };
    }
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
    properties.Genres = multiSelectProperty(book.genreTags.slice(0, 20));
  }

  if (
    canUse(schema, "Moods", "multi_select") &&
    book.moodTags?.length
  ) {
    properties.Moods = multiSelectProperty(book.moodTags.slice(0, 20));
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
//   Only fill Notion fields that are empty.
//
// to-read / currently-reading:
//   Refresh fields when StoryGraph supplies a value. Do not erase a Notion
//   value when StoryGraph supplies nothing.
//
// Covers:
//   Always fill-only. Existing page covers and existing Cover Image files are
//   never overwritten.
async function buildExistingPageUpdate(book, listType, page, schema) {
  const existing = page.properties || {};
  const properties = {};

  const isReadHistory = listType === "books-read";
  let cover;

  if (!getPageCoverUrl(page) && validExternalUrl(book.cover)) {
    cover = coverPayload(book.cover);
  }

  if (
    canUse(schema, "Cover Image", "files") &&
    !hasFilesProperty(existing["Cover Image"]) &&
    validExternalUrl(book.cover)
  ) {
    const coverUpload = await importCoverToNotion(
      book.cover,
      book.title
    );

    if (coverUpload) {
      properties["Cover Image"] = {
        files: [coverUpload],
      };
    }
  }

  if (
    canUse(schema, "Author", "rich_text") &&
    book.author &&
    (!isReadHistory || !getPlainText(existing.Author))
  ) {
    properties.Author = richTextProperty(book.author);
  }

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
    properties.Genres = multiSelectProperty(book.genreTags.slice(0, 20));
  }

  if (
    canUse(schema, "Moods", "multi_select") &&
    book.moodTags?.length &&
    (!isReadHistory ||
      getMultiSelectNames(existing.Moods).length === 0)
  ) {
    properties.Moods = multiSelectProperty(book.moodTags.slice(0, 20));
  }

  if (
    canUse(schema, "Page Count", "number") &&
    book.pageCount &&
    (!isReadHistory || getNumber(existing["Page Count"]) === null)
  ) {
    properties["Page Count"] = {
      number: Number(book.pageCount),
    };
  }

  // These read-history values always remain fill-only.
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

  if (
    optionalProps.storyGraphId &&
    book.id &&
    !getPlainText(existing["StoryGraph ID"])
  ) {
    properties["StoryGraph ID"] = richTextProperty(book.id);
  }

  return { properties, cover };
}

async function saveBook(book, listType, indexes, schema) {
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
    const existingPage = findExistingPage(book, indexes);

    if (!existingPage) {
      const properties = await createBookProperties(
        book,
        listType,
        schema
      );

      const page = await notionRequest(
        () =>
          notion.pages.create({
            parent: {
              database_id: databaseId,
            },
            ...(validExternalUrl(book.cover)
              ? { cover: coverPayload(book.cover) }
              : {}),
            properties,
          }),
        `create "${book.title}"`
      );

      rememberPage(indexes, page);

      stats.created++;
      console.log(`Added new book: ${book.title}`);
      return;
    }

    const update = await buildExistingPageUpdate(
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

    await notionRequest(
      () =>
        notion.pages.update({
          page_id: existingPage.id,
          ...(update.cover ? { cover: update.cover } : {}),
          properties: update.properties,
        }),
      `update "${book.title}"`
    );

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
    console.error(
      `Error scraping list ${target}: ${error.message}`
    );

    return [];
  }
}

function logFieldCounts(listType, books) {
  const count = (test) => books.filter(test).length;

  console.log(
    `[FIELDS] ${listType}: ${books.length} books | ` +
      `cover ${count((book) => book.cover)} | ` +
      `rating ${count((book) => book.rating !== undefined)} | ` +
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
    const indexes = await loadExistingPages();

    // Active lists refresh first. books-read runs last but only fills blanks,
    // so it cannot replace the active reading status of an existing book.
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
        const repeats = books.filter(
          (book) => book.timesRead > 1
        );

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
        await saveBook(book, listType, indexes, schema);
      }
    }

    console.log("Sync to Notion completed.");

    console.log(
      `Summary: ${stats.created} created, ${stats.updated} updated, ` +
        `${stats.unchanged} unchanged, ${stats.skipped} skipped, ` +
        `${stats.failed.length} failed, ${stats.duplicateMatches} ` +
        "canonical duplicate matches."
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
