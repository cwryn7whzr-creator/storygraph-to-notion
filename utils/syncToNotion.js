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

let lastNotionRequestAt = 0;
const reportedDuplicateGroups = new Set();

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const clean = (value) =>
  String(value || "").replace(/\s+/g, " ").trim();

const normAuthor = (value) =>
  clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// The same authors listed in a different order still count as the same list.
const authorKey = (value) =>
  normAuthor(value).split(" ").filter(Boolean).sort().join(" ");

// The parser falls back to "Unknown Author" when it finds nothing. That is a
// placeholder, not data, so it must never overwrite or merge anything.
const hasKnownAuthor = (book) =>
  Boolean(book?.author) && book.author !== "Unknown Author";

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

const sortYearNames = (names) =>
  [...names].sort(
    (a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b))
  );

// ---------------------------------------------------------------------------
// Notion request wrapper: pacing + retry on rate limits
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Reading values out of Notion pages
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Building values to send to Notion
// ---------------------------------------------------------------------------

function titleProperty(value) {
  return {
    title: [{ text: { content: String(value).slice(0, 2000) } }],
  };
}

function richTextProperty(value) {
  return {
    rich_text: [{ text: { content: String(value).slice(0, 2000) } }],
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
    external: { url },
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

// ---------------------------------------------------------------------------
// Notion property names.
//
// Property names are matched ignoring capitalization, spaces and punctuation,
// so "Storygraph ID" is found even though this script says "StoryGraph ID".
// P maps a plain key to the name your database actually uses. A key is left
// out when the property is missing or has the wrong type, and that value is
// then skipped instead of failing the sync.
// ---------------------------------------------------------------------------

const PROPERTY_SPECS = {
  title: { label: "Title", type: "title" },
  author: { label: "Author", type: "rich_text" },
  status: { label: "Status", type: "select" },
  coverImage: { label: "Cover Image", type: "files" },
  rating: { label: "Rating", type: "number" },
  genres: { label: "Genres", type: "multi_select" },
  moods: { label: "Moods", type: "multi_select" },
  pageCount: { label: "Page Count", type: "number" },
  yearsRead: { label: "Years Read", type: "multi_select" },
  timesRead: { label: "Times Read", type: "number" },
  yearRead: { label: "Year Read", type: "number", optional: true },
  storyGraphId: { label: "StoryGraph ID", type: "rich_text", optional: true },
};

const P = {};

const normPropName = (name) =>
  String(name).toLowerCase().replace(/[^a-z0-9]/g, "");

// pv = "property value": a page's value for one of the keys above.
const pv = (page, key) => (P[key] ? page?.properties?.[P[key]] : undefined);

function resolveProperties(schema) {
  const entries = Object.entries(schema);

  for (const [key, spec] of Object.entries(PROPERTY_SPECS)) {
    let found;

    if (spec.type === "title") {
      // A database has exactly one title property, whatever it is called.
      found = entries.find(([, definition]) => definition.type === "title");
    } else {
      const sameName = entries.filter(
        ([name]) => normPropName(name) === normPropName(spec.label)
      );

      found = sameName.find(([, definition]) => definition.type === spec.type);

      if (!found && sameName.length > 0) {
        console.warn(
          `[NOTION] Property "${sameName[0][0]}" exists but is type ` +
            `"${sameName[0][1].type}", not "${spec.type}". ` +
            `${spec.label} will be skipped.`
        );
        continue;
      }
    }

    if (found) {
      P[key] = found[0];

      if (found[0] !== spec.label && spec.type !== "title") {
        console.log(`[NOTION] Using property "${found[0]}" for ${spec.label}.`);
      }
    } else if (spec.optional) {
      console.log(
        `[NOTION] Optional "${spec.label}" ${spec.type} property not found; ` +
          "that value is skipped."
      );
    } else {
      console.warn(
        `[NOTION] Property "${spec.label}" (${spec.type}) not found. ` +
          "That value will be skipped."
      );
    }
  }

  if (!P.title) {
    throw new Error("The Notion database has no title property.");
  }
}

async function checkDatabaseProperties() {
  const db = await notionRequest(
    () => notion.databases.retrieve({ database_id: databaseId }),
    "database schema retrieval"
  );

  resolveProperties(db.properties || {});
}

// ---------------------------------------------------------------------------
// Existing pages: preload once, index, and pick a canonical page
// ---------------------------------------------------------------------------

function pageCompleteness(page) {
  let score = 0;

  if (getPlainText(pv(page, "title"))) score += 2;
  if (getPlainText(pv(page, "author"))) score += 2;
  if (getSelectName(pv(page, "status"))) score += 1;
  if (getNumber(pv(page, "rating")) !== null) score += 1;
  if (getMultiSelectNames(pv(page, "genres")).length) score += 2;
  if (getMultiSelectNames(pv(page, "moods")).length) score += 2;
  if (getNumber(pv(page, "pageCount")) !== null) score += 1;
  if (getNumber(pv(page, "yearRead")) !== null) score += 1;
  if (getMultiSelectNames(pv(page, "yearsRead")).length) score += 2;
  if (getNumber(pv(page, "timesRead")) !== null) score += 1;
  if (getPlainText(pv(page, "storyGraphId"))) score += 3;
  if (hasFilesProperty(pv(page, "coverImage"))) score += 2;
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

const addToIndex = (map, key, page) => {
  const list = map.get(key) || [];
  list.push(page);
  map.set(key, list);
};

function indexPage(indexes, page) {
  indexes.pages.push(page);

  const title = getPlainText(pv(page, "title"));
  const storyGraphId = getPlainText(pv(page, "storyGraphId"));

  if (title) {
    addToIndex(indexes.byExactTitle, title, page);
    addToIndex(indexes.byNormTitle, normTitle(title), page);
  }

  if (storyGraphId) {
    addToIndex(indexes.byStoryGraphId, storyGraphId, page);
  }
}

async function loadExistingPages() {
  const indexes = {
    pages: [],
    byExactTitle: new Map(),
    byNormTitle: new Map(),
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
      indexPage(indexes, page);
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`[NOTION] Loaded ${indexes.pages.length} existing pages.`);

  return indexes;
}

function sameAuthor(book, page) {
  const existingAuthor = getPlainText(pv(page, "author"));

  if (!hasKnownAuthor(book) || !existingAuthor) {
    return false;
  }

  return normAuthor(book.author) === normAuthor(existingAuthor);
}

// Where both the book and the page have a StoryGraph ID, they must agree.
function idsAgree(book, page) {
  const pageId = getPlainText(pv(page, "storyGraphId"));

  return !book.id || !pageId || book.id === pageId;
}

// Matching order:
//   1. StoryGraph ID (reliable once the ID property is filled in)
//   2. exact title (your existing behaviour; titles are never "cleaned up")
//   3. normalized title + same author + agreeing IDs (punctuation/case variants)
// Returns { page, duplicates } where duplicates are OTHER pages that matched
// the same way. They are reported and merged into, never deleted.
function findExistingPage(book, indexes) {
  const splitCanonical = (matches, via) => {
    const canonical = chooseCanonicalPage(matches);

    return {
      page: canonical,
      duplicates: matches.filter((page) => page.id !== canonical.id),
      via,
    };
  };

  if (book.id) {
    const idMatches = indexes.byStoryGraphId.get(book.id) || [];

    if (idMatches.length > 0) {
      const result = splitCanonical(idMatches, "id");
      const existingTitle = getPlainText(pv(result.page, "title"));

      if (existingTitle !== book.title) {
        console.log(
          `[MATCH] StoryGraph ID matched "${book.title}" to existing ` +
            `"${existingTitle}".`
        );
      }

      return result;
    }
  }

  const exactMatches = indexes.byExactTitle.get(book.title) || [];

  if (exactMatches.length > 0) {
    return splitCanonical(exactMatches, "title");
  }

  const similarMatches = (
    indexes.byNormTitle.get(normTitle(book.title)) || []
  ).filter((page) => sameAuthor(book, page) && idsAgree(book, page));

  if (similarMatches.length > 0) {
    const result = splitCanonical(similarMatches, "normalized");

    console.log(
      `[MATCH] Normalized title + author matched "${book.title}" to ` +
        `"${getPlainText(pv(result.page, "title"))}" ` +
        `(data score ${pageCompleteness(result.page)}).`
    );

    return result;
  }

  return null;
}

// Safety net for title-based matching: say so when the author on the Notion
// page clearly differs from StoryGraph's, so a wrong match can be spotted.
function warnIfAuthorDiffers(book, page) {
  const notionAuthor = getPlainText(pv(page, "author"));

  if (
    notionAuthor &&
    hasKnownAuthor(book) &&
    authorKey(notionAuthor) !== authorKey(book.author)
  ) {
    console.log(
      `[CHECK] "${book.title}": Notion author "${notionAuthor}" differs from ` +
        `StoryGraph author "${book.author}". Make sure this is the same book.`
    );
  }
}

function reportDuplicates(book, canonical, duplicates) {
  if (duplicates.length === 0 || reportedDuplicateGroups.has(canonical.id)) {
    return;
  }

  reportedDuplicateGroups.add(canonical.id);
  stats.duplicateMatches++;

  console.warn(
    `[DUPLICATE] "${book.title}" matches ${duplicates.length + 1} Notion ` +
      `pages. Canonical (most complete, data score ` +
      `${pageCompleteness(canonical)}): ${canonical.url}`
  );

  for (const duplicate of duplicates) {
    console.warn(
      `[DUPLICATE]   Left unchanged for manual review ` +
        `(data score ${pageCompleteness(duplicate)}): ${duplicate.url}`
    );
  }
}

// ---------------------------------------------------------------------------
// Repeat reads (books-read only). One Notion page per book:
//   Times Read = number of completed-read entries
//   Years Read = every known year
//   Year Read  = the most recent known year
//
// Entries are combined when they share a StoryGraph ID (the same book read
// again). Entries with DIFFERENT IDs are combined only when the title is
// identical AND the authors match too (different editions of one work), and
// that is written to the log. Title alone is never enough.
// ---------------------------------------------------------------------------

function mergeRepeatBooks(books, listType) {
  if (listType !== "books-read") {
    return { books, editionMerges: [] };
  }

  const merged = [];
  const byId = new Map();
  const byTitleAndAuthor = new Map();
  const editionMerges = [];

  for (const book of books) {
    if (!book || !book.title || book.title === "Untitled Book") {
      merged.push(book);
      continue;
    }

    const authorPart = hasKnownAuthor(book) ? authorKey(book.author) : "";
    const titleAuthorKey = authorPart ? `${book.title}|${authorPart}` : null;

    let target = book.id ? byId.get(book.id) : undefined;

    if (!target && titleAuthorKey) {
      target = byTitleAndAuthor.get(titleAuthorKey);

      if (target && book.id && target.id && book.id !== target.id) {
        editionMerges.push(book.title);
      }
    }

    if (!target) {
      const copy = {
        ...book,
        timesRead: 1,
        yearsRead: book.yearRead ? [book.yearRead] : [],
      };

      merged.push(copy);

      if (book.id) byId.set(book.id, copy);
      if (titleAuthorKey) byTitleAndAuthor.set(titleAuthorKey, copy);

      continue;
    }

    target.timesRead++;

    if (book.id && !byId.has(book.id)) {
      byId.set(book.id, target);
    }

    if (book.yearRead && !target.yearsRead.includes(book.yearRead)) {
      target.yearsRead.push(book.yearRead);
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
        target[field] === undefined ||
        target[field] === null ||
        target[field] === ""
      ) {
        target[field] = book[field];
      }
    }

    if (!target.genreTags?.length && book.genreTags?.length) {
      target.genreTags = book.genreTags;
    }

    if (!target.moodTags?.length && book.moodTags?.length) {
      target.moodTags = book.moodTags;
    }
  }

  for (const book of merged) {
    if (!book?.yearsRead) continue;

    book.yearsRead.sort((left, right) => left - right);

    book.yearRead = book.yearsRead.length
      ? book.yearsRead[book.yearsRead.length - 1]
      : undefined;
  }

  return { books: merged, editionMerges };
}

// ---------------------------------------------------------------------------
// Covers
//
// Cover Image is a Files & media property. For a Gallery card preview it needs
// a real image. We ask Notion to import the picture from StoryGraph's URL,
// wait for the import to finish, then attach it. If the import fails we fall
// back to attaching the direct image link, so the property is not left empty.
// Existing covers are never replaced.
// ---------------------------------------------------------------------------

async function importCoverToNotion(url, title) {
  try {
    // content_type is left out on purpose: Notion works it out from the image.
    const upload = await notionRequest(
      () =>
        notion.fileUploads.create({
          mode: "external_url",
          filename: safeCoverFilename(title, url),
          external_url: url,
        }),
      `import cover "${title}"`
    );

    // Notion downloads the image in the background. Wait until it says done.
    for (let attempt = 1; attempt <= 10; attempt++) {
      let status;

      try {
        const check = await notionRequest(
          () => notion.fileUploads.retrieve({ file_upload_id: upload.id }),
          `check cover import "${title}"`
        );

        status = check.status;
      } catch {
        // Cannot check status with this library version: attach optimistically.
        return { type: "file_upload", file_upload: { id: upload.id } };
      }

      if (status === "uploaded") {
        console.log(`[COVER] Imported cover for "${title}".`);
        return { type: "file_upload", file_upload: { id: upload.id } };
      }

      if (status === "failed" || status === "expired") {
        console.warn(`[COVER] Notion could not import the cover for "${title}" (${status}).`);
        return null;
      }

      await delay(1500);
    }

    console.warn(`[COVER] Import for "${title}" did not finish in time.`);
    return null;
  } catch (error) {
    console.warn(
      `[COVER] Could not import cover for "${title}": ${error.message}`
    );

    return null;
  }
}

async function buildCoverFile(book) {
  const url = validExternalUrl(book.cover);

  if (!url) {
    return null;
  }

  const imported = await importCoverToNotion(url, book.title);

  if (imported) {
    return imported;
  }

  console.warn(
    `[COVER] Attaching the direct image link for "${book.title}" instead of an imported file.`
  );

  return {
    type: "external",
    name: safeCoverFilename(book.title, url),
    external: { url },
  };
}

// ---------------------------------------------------------------------------
// New pages
// ---------------------------------------------------------------------------

async function createBookProperties(book, listType) {
  const properties = {
    [P.title]: titleProperty(book.title),
  };

  if (P.author && hasKnownAuthor(book)) {
    properties[P.author] = richTextProperty(book.author);
  }

  if (P.status) {
    properties[P.status] = { select: { name: listTypeToStatus(listType) } };
  }

  if (P.coverImage) {
    const coverFile = await buildCoverFile(book);

    if (coverFile) {
      properties[P.coverImage] = { files: [coverFile] };
    }
  }

  if (P.rating && book.rating !== undefined) {
    properties[P.rating] = { number: Number(book.rating) };
  }

  if (P.genres && book.genreTags?.length) {
    properties[P.genres] = multiSelectProperty(book.genreTags.slice(0, 20));
  }

  if (P.moods && book.moodTags?.length) {
    properties[P.moods] = multiSelectProperty(book.moodTags.slice(0, 20));
  }

  if (P.pageCount && book.pageCount) {
    properties[P.pageCount] = { number: Number(book.pageCount) };
  }

  if (P.yearRead && book.yearRead) {
    properties[P.yearRead] = { number: Number(book.yearRead) };
  }

  if (P.yearsRead && book.yearsRead?.length) {
    properties[P.yearsRead] = multiSelectProperty(book.yearsRead);
  }

  if (P.timesRead && book.timesRead) {
    properties[P.timesRead] = { number: Number(book.timesRead) };
  }

  if (P.storyGraphId && book.id) {
    properties[P.storyGraphId] = richTextProperty(book.id);
  }

  return properties;
}

// ---------------------------------------------------------------------------
// Existing pages
//
// books-read:
//   Only fill Notion fields that are empty.
//
// to-read / currently-reading:
//   Refresh a field when StoryGraph supplies a usable value AND it differs from
//   what Notion has. Never erase a value because StoryGraph supplied nothing.
//
// Read-history fields (Year Read, Years Read, Times Read, StoryGraph ID) and
// covers are always fill-only. Nothing is written when nothing changed.
// ---------------------------------------------------------------------------

async function buildExistingPageUpdate(book, listType, page) {
  const isReadHistory = listType === "books-read";
  const properties = {};
  let cover;

  const text = (key) => getPlainText(pv(page, key));
  const number = (key) => getNumber(pv(page, key));
  const names = (key) => getMultiSelectNames(pv(page, key));

  // Page cover: fill only if the page has none.
  if (!getPageCoverUrl(page) && validExternalUrl(book.cover)) {
    cover = coverPayload(book.cover);
  }

  // Cover Image property: fill only if empty.
  if (
    P.coverImage &&
    !hasFilesProperty(pv(page, "coverImage")) &&
    validExternalUrl(book.cover)
  ) {
    const coverFile = await buildCoverFile(book);

    if (coverFile) {
      properties[P.coverImage] = { files: [coverFile] };
    }
  }

  if (P.author && hasKnownAuthor(book)) {
    const current = text("author");

    if (isReadHistory ? !current : clean(book.author) !== current) {
      properties[P.author] = richTextProperty(book.author);
    }
  }

  if (P.status) {
    const current = getSelectName(pv(page, "status"));
    const wanted = listTypeToStatus(listType);

    if (isReadHistory ? !current : current !== wanted) {
      properties[P.status] = { select: { name: wanted } };
    }
  }

  if (P.rating && book.rating !== undefined) {
    const current = number("rating");

    if (isReadHistory ? current === null : current !== Number(book.rating)) {
      properties[P.rating] = { number: Number(book.rating) };
    }
  }

  if (P.pageCount && book.pageCount) {
    const current = number("pageCount");

    if (isReadHistory ? current === null : current !== Number(book.pageCount)) {
      properties[P.pageCount] = { number: Number(book.pageCount) };
    }
  }

  for (const [key, tags] of [
    ["genres", book.genreTags],
    ["moods", book.moodTags],
  ]) {
    if (!P[key] || !tags?.length) {
      continue;
    }

    const current = names(key);
    const wanted = tags.slice(0, 20);

    if (isReadHistory ? current.length === 0 : !sameSet(current, wanted)) {
      properties[P[key]] = multiSelectProperty(wanted);
    }
  }

  // Always fill-only.
  if (P.yearRead && book.yearRead && number("yearRead") === null) {
    properties[P.yearRead] = { number: Number(book.yearRead) };
  }

  if (P.yearsRead && book.yearsRead?.length && names("yearsRead").length === 0) {
    properties[P.yearsRead] = multiSelectProperty(book.yearsRead);
  }

  if (P.timesRead && book.timesRead && number("timesRead") === null) {
    properties[P.timesRead] = { number: Number(book.timesRead) };
  }

  if (P.storyGraphId && book.id && !text("storyGraphId")) {
    properties[P.storyGraphId] = richTextProperty(book.id);
  }

  return { properties, cover };
}

// For confirmed duplicates, copy only non-destructive data into the canonical
// page: union Years Read / Genres / Moods, keep the higher Times Read, fill
// blanks. Nothing is removed from any page, and the duplicates stay untouched.
// (Times Read is never added up: two duplicate pages may describe the same reads.)
function applyDuplicateMerge(update, canonical, duplicates) {
  if (duplicates.length === 0) {
    return;
  }

  const values = (page, key) => getMultiSelectNames(pv(page, key));

  for (const key of ["yearsRead", "genres", "moods"]) {
    if (!P[key]) continue;

    const current = values(canonical, key);
    const pending = update.properties[P[key]];
    const base = pending ? pending.multi_select.map((item) => item.name) : current;

    const union = [
      ...new Set([
        ...base,
        ...duplicates.flatMap((duplicate) => values(duplicate, key)),
      ]),
    ];

    if (pending || !sameSet(union, current)) {
      update.properties[P[key]] = multiSelectProperty(
        key === "yearsRead" ? sortYearNames(union) : union
      );
    }
  }

  if (P.timesRead) {
    const current = getNumber(pv(canonical, "timesRead"));
    const pending = update.properties[P.timesRead]?.number;
    const baseline = pending ?? current ?? 0;

    const highest = Math.max(
      0,
      ...duplicates.map((duplicate) => getNumber(pv(duplicate, "timesRead")) ?? 0)
    );

    if (highest > baseline) {
      update.properties[P.timesRead] = { number: highest };
    }
  }

  const fillBlank = (key, read, write) => {
    if (!P[key] || update.properties[P[key]]) return;

    const current = read(canonical);

    if (current !== null && current !== "" && current !== undefined) return;

    for (const duplicate of duplicates) {
      const value = read(duplicate);

      if (value !== null && value !== "" && value !== undefined) {
        update.properties[P[key]] = write(value);
        return;
      }
    }
  };

  fillBlank("author", (page) => getPlainText(pv(page, "author")), richTextProperty);
  fillBlank("storyGraphId", (page) => getPlainText(pv(page, "storyGraphId")), richTextProperty);
  fillBlank("rating", (page) => getNumber(pv(page, "rating")), (value) => ({ number: value }));
  fillBlank("pageCount", (page) => getNumber(pv(page, "pageCount")), (value) => ({ number: value }));
  fillBlank("yearRead", (page) => getNumber(pv(page, "yearRead")), (value) => ({ number: value }));

  // Covers: only external links can be copied safely (Notion-hosted file links expire).
  if (P.coverImage && !update.properties[P.coverImage] && !hasFilesProperty(pv(canonical, "coverImage"))) {
    for (const duplicate of duplicates) {
      const file = pv(duplicate, "coverImage")?.files?.find(
        (item) => item.type === "external" && item.external?.url
      );

      if (file) {
        update.properties[P.coverImage] = {
          files: [{ type: "external", name: file.name, external: { url: file.external.url } }],
        };
        break;
      }
    }
  }

  if (!update.cover && !getPageCoverUrl(canonical)) {
    const fromDuplicate = duplicates
      .map((duplicate) => duplicate.cover)
      .find((item) => item?.type === "external" && item.external?.url);

    if (fromDuplicate) {
      update.cover = coverPayload(fromDuplicate.external.url);
    }
  }
}

// ---------------------------------------------------------------------------
// Saving one book
// ---------------------------------------------------------------------------

async function saveBook(book, listType, indexes) {
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
    const match = findExistingPage(book, indexes);

    if (!match) {
      const properties = await createBookProperties(book, listType);

      const page = await notionRequest(
        () =>
          notion.pages.create({
            parent: { database_id: databaseId },
            ...(validExternalUrl(book.cover)
              ? { cover: coverPayload(book.cover) }
              : {}),
            properties,
          }),
        `create "${book.title}"`
      );

      indexPage(indexes, page);

      stats.created++;
      console.log(`Added new book: ${book.title}`);
      return;
    }

    const { page: existingPage, duplicates } = match;

    reportDuplicates(book, existingPage, duplicates);
    warnIfAuthorDiffers(book, existingPage);

    const update = await buildExistingPageUpdate(book, listType, existingPage);

    applyDuplicateMerge(update, existingPage, duplicates);

    if (Object.keys(update.properties).length === 0 && !update.cover) {
      stats.unchanged++;
      console.log(`Unchanged book: ${book.title}`);
      return;
    }

    const updated = await notionRequest(
      () =>
        notion.pages.update({
          page_id: existingPage.id,
          ...(update.cover ? { cover: update.cover } : {}),
          properties: update.properties,
        }),
      `update "${book.title}"`
    );

    // Keep our copy current, so later lists see what was just written.
    Object.assign(existingPage, updated);

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

// ---------------------------------------------------------------------------
// Scraping, logging, and the main routine
// ---------------------------------------------------------------------------

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

    await checkDatabaseProperties();
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

      const { books, editionMerges } = mergeRepeatBooks(scraped, listType);

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

      if (editionMerges.length > 0) {
        console.log(
          `[MERGE] Counted as one book because the title AND author are identical ` +
            `even though StoryGraph IDs differ (probably different editions): ` +
            editionMerges.join(" | ")
        );
      }

      for (const book of books) {
        await saveBook(book, listType, indexes);
      }
    }

    console.log("Sync to Notion completed.");

    console.log(
      `Summary: ${stats.created} created, ${stats.updated} updated, ` +
        `${stats.unchanged} unchanged, ${stats.skipped} skipped, ` +
        `${stats.failed.length} failed, ${stats.duplicateMatches} ` +
        "duplicate groups need manual review."
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
