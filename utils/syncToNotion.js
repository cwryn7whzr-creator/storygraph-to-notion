import { Client } from "@notionhq/client";
import * as scraper from "../functions/getList.js";
import { enrichBooks, normTitle } from "./storygraphExtras.js";

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const databaseId = process.env.NOTION_DATABASE_ID;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// WHAT TO DO WHEN A BOOK IS ALREADY IN NOTION (found by its StoryGraph ID).
// Set it separately for each list:
//
//   "skip"         do nothing to the page
//   "fill-blanks"  only fill fields that are empty on the page
//   "update"       refresh fields when StoryGraph has a value (a page is only
//                  written to when something actually changed)
//
// Books that are NOT in Notion yet are always added, whatever these say.
// ---------------------------------------------------------------------------
const WHEN_BOOK_ALREADY_IN_NOTION = {
  "to-read": "update",
  "currently-reading": "update",
  "books-read": "skip",
};

// With books-read set to "skip", a book that you finish would stay "Reading" (or
// "Want to Read") in Notion forever. When this is true, a book that is on your
// books-read list, is NOT on your to-read / currently-reading lists, and still
// shows "Reading" or "Want to Read" in Notion is marked "Read", and its empty
// fields (rating, genres, moods, years...) are filled once. After that it is
// left alone. Set to false to leave finished books completely untouched.
const MARK_FINISHED_BOOKS_AS_READ = true;

const MAX_RETRIES = 6;

// Kept below Notion's practical per-integration request ceiling.
const NOTION_MIN_INTERVAL_MS = 500;

// File uploads (cover images) work with this API version.
const NOTION_API_VERSION = "2022-06-28";

const stats = {
  created: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  skippedExisting: 0,
  idsRecorded: 0,
  editionIdsAdded: 0,
  finished: 0,
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

// The real name of your StoryGraph ID property. It is looked up in the database
// (ignoring capitalization), so "Storygraph ID" works as well as "StoryGraph ID".
let storyGraphIdName = "StoryGraph ID";

let lastNotionRequestAt = 0;

// Pages that are on your to-read / currently-reading lists in THIS run, so a book
// you are re-reading is not marked "Read" just because it is also in books-read.
const activePageIds = new Set();
let finishedRuleActive = false;

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

const sameSet = (left, right) =>
  left.length === right.length && left.every((item) => right.includes(item));

// The same authors listed in a different order still count as the same authors.
const authorKey = (value) =>
  normAuthor(value).split(" ").filter(Boolean).sort().join(" ");

// The parser writes "Unknown Author" when it finds nothing. That is a
// placeholder, not data, so it must never be written over a real author.
const hasKnownAuthor = (book) =>
  Boolean(book?.author) && book.author !== "Unknown Author";

// A page's StoryGraph ID field can hold more than one ID, separated by commas
// or spaces (useful when you merge two editions of a book into one page).
const idsFromText = (text) =>
  String(text || "")
    .split(/[\s,;|]+/)
    .map((id) => id.trim())
    .filter(Boolean);

// All StoryGraph IDs that belong to one scraped book (repeat reads and other
// editions that were combined into it can carry more than one).
const idsOf = (book) => {
  const list = book?.ids?.length ? book.ids : book?.id ? [book.id] : [];

  return [...new Set(list.filter(Boolean))];
};

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

// Direct call to Notion's web API. Used for cover-image uploads, because the
// version of the Notion library installed here has no file-upload feature
// (that is why the log said "Cannot read properties of undefined (reading
// 'create')"). Errors look like the library's, so notionRequest() can retry them.
async function notionFetch(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.message || `Notion API responded with ${response.status}`
    );

    error.status = response.status;
    error.code = data.code;
    error.headers = response.headers;

    throw error;
  }

  return data;
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

  // Find the StoryGraph ID property whatever its capitalization.
  const normName = (name) =>
    String(name).toLowerCase().replace(/[^a-z0-9]/g, "");

  const idCandidates = Object.entries(schema).filter(
    ([name]) => normName(name) === "storygraphid"
  );

  const idProperty = idCandidates.find(
    ([, definition]) => definition.type === "rich_text"
  );

  if (idProperty) {
    optionalProps.storyGraphId = true;
    storyGraphIdName = idProperty[0];

    if (storyGraphIdName !== "StoryGraph ID") {
      console.log(
        `[NOTION] Using property "${storyGraphIdName}" as the StoryGraph ID.`
      );
    }
  } else if (idCandidates.length > 0) {
    console.warn(
      `[NOTION] Property "${idCandidates[0][0]}" is type "${idCandidates[0][1].type}". ` +
        'It must be a "Text" (Rich text) property to hold StoryGraph IDs.'
    );
  } else {
    console.warn(
      '[NOTION] No "StoryGraph ID" Text (Rich text) property found. Existing books ' +
        "will be recognized by title only, and IDs cannot be recorded. Add the property."
    );
  }

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
  if (getPlainText(properties[storyGraphIdName])) score += 3;
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

// Adds a page to the "by StoryGraph ID" lookup, once for every ID in its field.
function indexStoryGraphIds(indexes, page) {
  const ids = idsFromText(getPlainText(page.properties?.[storyGraphIdName]));

  for (const id of ids) {
    const matches = indexes.byStoryGraphId.get(id) || [];

    if (!matches.includes(page)) {
      matches.push(page);
    }

    indexes.byStoryGraphId.set(id, matches);
  }
}

async function loadExistingPages() {
  const indexes = {
    pages: [],
    byExactTitle: new Map(),
    byStoryGraphId: new Map(),
  };

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
      indexes.pages.push(page);

      const title = getPlainText(page.properties?.Title);

      if (title) {
        const matches = indexes.byExactTitle.get(title) || [];
        matches.push(page);
        indexes.byExactTitle.set(title, matches);
      }

      indexStoryGraphIds(indexes, page);
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(
    `[NOTION] Loaded ${indexes.pages.length} existing pages ` +
      `(${indexes.byStoryGraphId.size} StoryGraph IDs recorded).`
  );

  return indexes;
}

function sameAuthor(book, page) {
  const existingAuthor = getPlainText(page.properties?.Author);

  if (!book.author || !existingAuthor) {
    return false;
  }

  return normAuthor(book.author) === normAuthor(existingAuthor);
}

// Same authors (any order), both known. Used to decide that a second StoryGraph ID
// on a same-title book is another edition of the same book.
function authorsMatch(book, page) {
  const existingAuthor = getPlainText(page.properties?.Author);

  if (!hasKnownAuthor(book) || !existingAuthor) {
    return false;
  }

  return authorKey(book.author) === authorKey(existingAuthor);
}

// Exact title matches win. StoryGraph ID is used next. A normalized-title
// fallback is accepted only when author names also match exactly after
// normalization. This avoids merging different books with similar titles.
//
// quiet = true: look only, without logging or counting (used for pre-checks).
function findExistingPage(book, indexes, quiet = false) {
  const exactMatches = indexes.byExactTitle.get(book.title) || [];

  if (exactMatches.length > 0) {
    const canonical = chooseCanonicalPage(exactMatches);

    if (exactMatches.length > 1 && !quiet) {
      stats.duplicateMatches++;

      console.warn(
        `[DUPLICATE] Exact title "${book.title}" has ${exactMatches.length} ` +
          `Notion pages. Keeping page ${canonical.id} as canonical ` +
          `(data score ${pageCompleteness(canonical)}).`
      );
    }

    return canonical;
  }

  for (const id of idsOf(book)) {
    const idMatches = indexes.byStoryGraphId.get(id) || [];

    if (idMatches.length > 0) {
      const canonical = chooseCanonicalPage(idMatches);

      if (!quiet) {
        console.log(
          `[MATCH] StoryGraph ID matched "${book.title}" to existing ` +
            `"${getPlainText(canonical.properties?.Title)}".`
        );
      }

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

    if (!quiet) {
      stats.duplicateMatches++;

      console.log(
        `[MATCH] Normalized title + author matched "${book.title}" to ` +
          `"${getPlainText(canonical.properties?.Title)}" ` +
          `(data score ${pageCompleteness(canonical)}).`
      );
    }

    return canonical;
  }

  return null;
}

// Is this book already in Notion? Checks the StoryGraph ID first. Pages that do
// not have an ID recorded yet are recognized by title (the same matching as
// before), so nothing gets added twice while IDs are still being filled in.
// Returns { page, via: "id" | "title" }, or null when the book is not in Notion.
function findKnownPage(book, indexes, quiet = false) {
  for (const id of idsOf(book)) {
    const matches = indexes.byStoryGraphId.get(id);

    if (matches?.length) {
      return { page: chooseCanonicalPage(matches), via: "id" };
    }
  }

  const page = findExistingPage(book, indexes, quiet);

  return page ? { page, via: "title" } : null;
}

function rememberPage(indexes, page) {
  indexes.pages.push(page);

  const title = getPlainText(page.properties?.Title);

  if (title) {
    const matches = indexes.byExactTitle.get(title) || [];
    matches.push(page);
    indexes.byExactTitle.set(title, matches);
  }

  indexStoryGraphIds(indexes, page);
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
        ids: idsOf(book),
        timesRead: 1,
        yearsRead: book.yearRead ? [book.yearRead] : [],
      };

      byTitle.set(book.title, copy);
      merged.push(copy);
      continue;
    }

    first.timesRead++;

    for (const id of idsOf(book)) {
      if (!first.ids.includes(id)) {
        first.ids.push(id);
      }
    }

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

// Imports an external public image into Notion's own storage. The returned value
// goes in the Cover Image (Files & media) property. A file stored by Notion shows
// as a real picture thumbnail and works as a Gallery card preview. A plain link
// to an address without ".jpg" at the end (like StoryGraph's) only shows as a
// generic file icon, which is what the "empty doc" chips are.
async function importCoverToNotion(imageUrl, title) {
  const url = validExternalUrl(imageUrl);

  if (!url) {
    return null;
  }

  try {
    // No content type is sent: Notion works it out from the image itself.
    const upload = await notionRequest(
      () =>
        notionFetch("/file_uploads", {
          method: "POST",
          body: {
            mode: "external_url",
            filename: safeCoverFilename(title, url),
            external_url: url,
          },
        }),
      `import cover "${title}"`
    );

    // Notion downloads the picture in the background. Wait until it is done.
    for (let attempt = 1; attempt <= 12; attempt++) {
      const check = await notionRequest(
        () => notionFetch(`/file_uploads/${upload.id}`),
        `check cover import "${title}"`
      );

      if (check.status === "uploaded") {
        console.log(`[COVER] Imported cover for "${title}".`);

        return {
          type: "file_upload",
          file_upload: {
            id: upload.id,
          },
        };
      }

      if (check.status === "failed" || check.status === "expired") {
        const reason = check.file_import_result?.error?.message;

        console.warn(
          `[COVER] Notion could not import the cover for "${title}" ` +
            `(${check.status}${reason ? `: ${reason}` : ""}).`
        );

        return null;
      }

      await delay(1500);
    }

    console.warn(`[COVER] The cover import for "${title}" did not finish in time.`);

    return null;
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

  if (optionalProps.storyGraphId && idsOf(book).length > 0) {
    properties[storyGraphIdName] = richTextProperty(idsOf(book).join(", "));
  }

  return properties;
}

// Works out what to change on a page that already exists.
//
// mode "fill-blanks": only fill fields that are empty.
// mode "update":      refresh a field when StoryGraph supplies a value AND it
//                     differs from what Notion has. Nothing is erased when
//                     StoryGraph supplies nothing, and nothing is written when
//                     nothing changed.
//
// Covers, Year Read, Years Read and Times Read are always fill-only, and an
// existing page cover or Cover Image is never replaced.
async function buildExistingPageUpdate(book, listType, page, schema, mode) {
  const existing = page.properties || {};
  const properties = {};
  const fillOnly = mode !== "update";
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

  if (canUse(schema, "Author", "rich_text") && hasKnownAuthor(book)) {
    const current = getPlainText(existing.Author);

    if (fillOnly ? !current : clean(book.author) !== current) {
      properties.Author = richTextProperty(book.author);
    }
  }

  if (canUse(schema, "Status", "select")) {
    const current = getSelectName(existing.Status);
    const wanted = listTypeToStatus(listType);

    if (fillOnly ? !current : current !== wanted) {
      properties.Status = {
        select: {
          name: wanted,
        },
      };
    }
  }

  if (canUse(schema, "Rating", "number") && book.rating !== undefined) {
    const current = getNumber(existing.Rating);

    if (fillOnly ? current === null : current !== Number(book.rating)) {
      properties.Rating = {
        number: Number(book.rating),
      };
    }
  }

  if (canUse(schema, "Page Count", "number") && book.pageCount) {
    const current = getNumber(existing["Page Count"]);

    if (fillOnly ? current === null : current !== Number(book.pageCount)) {
      properties["Page Count"] = {
        number: Number(book.pageCount),
      };
    }
  }

  for (const [name, tags] of [
    ["Genres", book.genreTags],
    ["Moods", book.moodTags],
  ]) {
    if (!canUse(schema, name, "multi_select") || !tags?.length) {
      continue;
    }

    const current = getMultiSelectNames(existing[name]);
    const wanted = tags.slice(0, 20);

    if (fillOnly ? current.length === 0 : !sameSet(current, wanted)) {
      properties[name] = multiSelectProperty(wanted);
    }
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

  return { properties, cover };
}

// Decides what to write in the page's StoryGraph ID field, if anything.
//   - empty field                      -> record the book's ID(s)
//   - field has other IDs, and this is the same book (matched by ID, or by title
//     with the same authors) -> add the new ID after the existing ones,
//     separated by a comma (a second edition)
//   - field has other IDs and we are NOT sure it is the same book -> change
//     nothing and report it
function planIdUpdate(book, known) {
  if (!optionalProps.storyGraphId) {
    return { value: null };
  }

  const stored = idsFromText(getPlainText(known.page.properties?.[storyGraphIdName]));
  const wanted = idsOf(book);
  const missing = wanted.filter((id) => !stored.includes(id));

  if (wanted.length === 0 || missing.length === 0) {
    return { value: null };
  }

  if (stored.length === 0) {
    return { value: wanted.join(", "), kind: "recorded" };
  }

  if (known.via === "id" || authorsMatch(book, known.page)) {
    return { value: [...stored, ...missing].join(", "), kind: "edition", added: missing };
  }

  return { value: null, conflict: { stored, wanted } };
}

// A book you have finished: it is on books-read, is not on an active list, and
// Notion still says "Want to Read" or "Reading".
function isFinishedBook(listType, page) {
  if (!finishedRuleActive || listType !== "books-read") {
    return false;
  }

  const status = getSelectName(page.properties?.Status);

  return (
    (status === "Want to Read" || status === "Reading") &&
    !activePageIds.has(page.id)
  );
}

// A book that is already in Notion. What happens depends on WHEN_BOOK_ALREADY_IN_NOTION
// for this list. Two small writes can happen even under "skip": recording the
// StoryGraph ID (see planIdUpdate) and marking a finished book as Read.
async function handleExistingBook(book, listType, known, indexes, schema) {
  const { page } = known;
  const mode = WHEN_BOOK_ALREADY_IN_NOTION[listType] || "skip";

  if (listType !== "books-read") {
    activePageIds.add(page.id);
  }

  const idPlan = planIdUpdate(book, known);
  const finished = isFinishedBook(listType, page);

  if (idPlan.conflict) {
    console.log(
      `[CHECK] "${book.title}" matches an existing Notion page by title, but that page has ` +
        `StoryGraph ID ${idPlan.conflict.stored.join(", ")} while StoryGraph says ` +
        `${idPlan.conflict.wanted.join(", ")}, and the authors do not clearly match. ` +
        "Nothing was changed. If it is another edition, add the ID to that page's StoryGraph ID field."
    );
  }

  let update = { properties: {}, cover: undefined };

  if (mode !== "skip" || finished) {
    update = await buildExistingPageUpdate(
      book,
      listType,
      page,
      schema,
      mode === "update" ? "update" : "fill-blanks"
    );
  }

  if (finished && canUse(schema, "Status", "select")) {
    update.properties.Status = { select: { name: "Read" } };
  }

  if (idPlan.value) {
    update.properties[storyGraphIdName] = richTextProperty(idPlan.value);
  }

  const propertyCount = Object.keys(update.properties).length;

  if (propertyCount === 0 && !update.cover) {
    if (mode === "skip") {
      stats.skippedExisting++;
      console.log(`Already in Notion, no action: ${book.title}`);
    } else {
      stats.unchanged++;
      console.log(`Unchanged book: ${book.title}`);
    }

    return;
  }

  const updated = await notionRequest(
    () =>
      notion.pages.update({
        page_id: page.id,
        ...(update.cover ? { cover: update.cover } : {}),
        properties: update.properties,
      }),
    `update "${book.title}"`
  );

  // Keep our copy current, so later lists see what was just written.
  Object.assign(page, updated);
  indexStoryGraphIds(indexes, page);

  const onlyTheId =
    propertyCount === 1 && update.properties[storyGraphIdName] && !update.cover;

  if (finished) {
    stats.finished++;
    console.log(`Finished book marked as Read and empty fields filled: ${book.title}`);
  } else if (onlyTheId && idPlan.kind === "recorded") {
    stats.idsRecorded++;
    console.log(`Recorded StoryGraph ID on existing page (nothing else changed): ${book.title}`);
  } else if (onlyTheId && idPlan.kind === "edition") {
    stats.editionIdsAdded++;
    console.log(
      `Added second-edition StoryGraph ID (${idPlan.added.join(", ")}) to existing page: ${book.title}`
    );
  } else {
    stats.updated++;
    console.log(
      listType === "books-read"
        ? `Filled missing read-history fields: ${book.title}`
        : `Synced active-list fields: ${book.title}`
    );
  }

  if (idPlan.kind === "edition" && !onlyTheId) {
    stats.editionIdsAdded++;
  }
}

async function saveBook(book, listType, indexes, schema) {
  if (!book?.title || book.title === "Untitled Book") {
    console.log(
      `Skipping entry with missing title (id: ${book?.id || "none"})...`
    );

    stats.skipped++;
    return;
  }

  try {
    const known = findKnownPage(book, indexes);

    if (known) {
      await handleExistingBook(book, listType, known, indexes, schema);
      return;
    }

    // Not in Notion yet: add it with everything StoryGraph gave us.
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

    if (listType !== "books-read") {
      activePageIds.add(page.id);
    }

    stats.created++;
    console.log(`Added new book: ${book.title}`);
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

    console.log(
      "[MODE] Books already in Notion (matched by StoryGraph ID): " +
        Object.entries(WHEN_BOOK_ALREADY_IN_NOTION)
          .map(([list, action]) => `${list} = ${action}`)
          .join(", ") +
        `. Finished books marked Read: ${MARK_FINISHED_BOOKS_AS_READ ? "yes" : "no"}.`
    );

    const schema = await checkDatabaseProperties();
    const indexes = await loadExistingPages();

    // Active lists refresh first. books-read runs last but only fills blanks,
    // so it cannot replace the active reading status of an existing book.
    const listTypes = [
      "to-read",
      "currently-reading",
      "books-read",
    ];

    let activeBookCount = 0;

    for (const listType of listTypes) {
      if (listType === "books-read") {
        // If BOTH active lists came back empty, they probably failed to load (they are
        // rarely both empty). Then we cannot tell which books are still being read,
        // so finished books are not marked this run.
        finishedRuleActive = MARK_FINISHED_BOOKS_AS_READ && activeBookCount > 0;

        if (MARK_FINISHED_BOOKS_AS_READ && !finishedRuleActive) {
          console.warn(
            "[FINISHED] to-read and currently-reading both came back empty, so finished books " +
              "will not be marked as Read in this run."
          );
        }
      }

      console.log(`Fetching ${listType} list...`);

      const scraped = await scrapeStoryGraphList({
        target: listType,
      });

      console.log(`Found ${scraped.length} books in ${listType}`);

      if (listType !== "books-read") {
        activeBookCount += scraped.length;
      }

      // The extra StoryGraph lookups (ratings, moods, genres, years) are only
      // needed when they will actually be written: for a book being ADDED, for a
      // finished book, or when this list is set to "fill-blanks" / "update" for
      // books-read. Otherwise skip them: it saves many minutes and many requests.
      const listMode = WHEN_BOOK_ALREADY_IN_NOTION[listType] || "skip";

      const needsEnrichment = scraped.some((book) => {
        const known = findKnownPage(book, indexes, true);

        if (!known) {
          return true;
        }

        if (listType === "books-read") {
          return listMode !== "skip" || isFinishedBook(listType, known.page);
        }

        return false;
      });

      if (needsEnrichment) {
        await enrichBooks(scraped, listType);
        logFieldCounts(listType, scraped);
      } else {
        console.log(
          `[SKIP] Nothing on the ${listType} list needs ratings, moods, genres or years, ` +
            "so they are not looked up."
        );
      }

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
        `${stats.unchanged} unchanged, ` +
        `${stats.skippedExisting} already in Notion (no action), ` +
        `${stats.finished} finished books marked Read, ` +
        `${stats.idsRecorded} StoryGraph IDs recorded, ` +
        `${stats.editionIdsAdded} second-edition IDs added, ` +
        `${stats.skipped} skipped, ` +
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
