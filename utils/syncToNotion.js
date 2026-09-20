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

// ---------------------------------------------------------------------------
// Run mode (set SYNC_MODE; the workflow passes it in)
//
//   active  (default)  to-read + currently-reading only. Fast: two StoryGraph pages.
//   full               adds books-read, ratings and years read. Slow: run it by hand.
//   cleanup            Notion only, no StoryGraph: merges and removes duplicate pages,
//                      ties Times Read to the years found, repairs covers.
//                      Preview only unless CLEANUP_APPLY=true.
// ---------------------------------------------------------------------------

const VALID_MODES = ["active", "full", "cleanup"];
const MODE = String(process.env.SYNC_MODE || "active").trim().toLowerCase();
const CLEANUP_APPLY =
  String(process.env.CLEANUP_APPLY || "").trim().toLowerCase() === "true";

const LISTS_BY_MODE = {
  active: ["to-read", "currently-reading"],
  full: ["to-read", "currently-reading", "books-read"],
};

// Importing a cover into Notion takes a few seconds each, so per run it is capped.
// Whatever is left over is picked up on the next run.
const COVER_REPAIR_LIMIT =
  Number(process.env.COVER_REPAIR_LIMIT) > 0
    ? Number(process.env.COVER_REPAIR_LIMIT)
    : MODE === "cleanup"
      ? 60
      : 15;

const coverBudget = { left: COVER_REPAIR_LIMIT };

// Cleanup only: any year earlier than this is removed from Years Read. Use it to drop years
// StoryGraph has no data for (an old bug labelled undated books "2017"). 0 = leave years alone.
const MIN_YEAR_READ =
  Number(process.env.MIN_YEAR_READ) > 0 ? Number(process.env.MIN_YEAR_READ) : 0;

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
    String(url || "").match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)?.[1] || "jpg";

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
// Property names are matched ignoring capitalization, spaces, punctuation and a
// trailing "s", so "Storygraph ID" is found even though this script says
// "StoryGraph ID", and "Authors" is found for "Author".
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
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/s$/, "");

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
// Ranking pages: which of several pages for the same book is the one to keep.
// Order of importance: has a rating, has a cover (either place), has a read
// year, then how many other fields are filled in, then the older page.
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

function pageSignals(page) {
  return {
    hasRating: getNumber(pv(page, "rating")) !== null,
    hasCover:
      hasFilesProperty(pv(page, "coverImage")) || Boolean(getPageCoverUrl(page)),
    hasYears:
      getMultiSelectNames(pv(page, "yearsRead")).length > 0 ||
      getNumber(pv(page, "yearRead")) !== null,
    score: pageCompleteness(page),
  };
}

// Negative result = `left` is the better page to keep.
function comparePages(left, right) {
  const a = pageSignals(left);
  const b = pageSignals(right);

  for (const key of ["hasRating", "hasCover", "hasYears"]) {
    if (a[key] !== b[key]) {
      return a[key] ? -1 : 1;
    }
  }

  if (a.score !== b.score) {
    return b.score - a.score;
  }

  const created = String(left.created_time || "").localeCompare(
    String(right.created_time || "")
  );

  if (created !== 0) {
    return created;
  }

  return String(left.id).localeCompare(String(right.id));
}

function chooseCanonicalPage(candidates) {
  return [...candidates].sort(comparePages)[0];
}

function describeForLog(page) {
  const signals = pageSignals(page);
  const years = getMultiSelectNames(pv(page, "yearsRead")).length;

  return (
    `${page.url || page.id} (rating ${signals.hasRating ? "yes" : "no"}, ` +
    `cover ${signals.hasCover ? "yes" : "no"}, years ${years}, ` +
    `data score ${signals.score})`
  );
}

// ---------------------------------------------------------------------------
// Existing pages: preload once and index
// ---------------------------------------------------------------------------

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
// the same way. They are merged into, and removed by the cleanup run.
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
      `pages. Kept: ${describeForLog(canonical)}`
  );

  for (const duplicate of duplicates) {
    console.warn(
      `[DUPLICATE]   Extra page, run the cleanup mode to merge and remove: ` +
        describeForLog(duplicate)
    );
  }
}

// ---------------------------------------------------------------------------
// Repeat reads (books-read only). One Notion page per book.
//
//   Years Read = every known year
//   Times Read = how many years were found (at least 1). It is tied to the
//                years on purpose: a book with 2 known years shows 2, however many
//                entries StoryGraph has for it.
//
// Entries are combined when they share a StoryGraph ID (the same book read
// again). Entries with DIFFERENT IDs are combined only when the title is
// identical AND the authors match too (different editions of one work), and
// that is written to the log. Title alone is never enough.
// ---------------------------------------------------------------------------

function mergeRepeatBooks(books, listType) {
  if (listType !== "books-read") {
    return { books, editionMerges: [], entryMismatches: [] };
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
        listEntries: 1,
        yearsRead: book.yearRead ? [book.yearRead] : [],
      };

      merged.push(copy);

      if (book.id) byId.set(book.id, copy);
      if (titleAuthorKey) byTitleAndAuthor.set(titleAuthorKey, copy);

      continue;
    }

    target.listEntries++;

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

  const entryMismatches = [];

  for (const book of merged) {
    if (!book?.yearsRead) continue;

    book.yearsRead.sort((left, right) => left - right);

    book.yearRead = book.yearsRead.length
      ? book.yearsRead[book.yearsRead.length - 1]
      : undefined;

    book.timesRead = Math.max(1, book.yearsRead.length);

    if (book.listEntries > book.timesRead) {
      entryMismatches.push(
        `${book.title.slice(0, 50)} (${book.listEntries} list entries, ` +
          `${book.yearsRead.length} known years)`
      );
    }
  }

  return { books: merged, editionMerges, entryMismatches };
}

// ---------------------------------------------------------------------------
// Covers
//
// A cover lives in two places: the Cover Image property (Files & media) and the
// page's own cover. Rules:
//
//   * A link YOU added (Goodreads, Amazon, anything that is not StoryGraph) is
//     never replaced. It is copied into whichever of the two places is empty or
//     only holds a StoryGraph link.
//   * Otherwise StoryGraph's cover is used in both places.
//   * StoryGraph image links have no file extension, and Notion then shows a
//     blank document icon instead of a thumbnail. Those are re-imported as real
//     image files (a few per run, see COVER_REPAIR_LIMIT).
// ---------------------------------------------------------------------------

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

const urlHost = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

const isStoryGraphUrl = (url) => /(^|\.)thestorygraph\.com$/i.test(urlHost(url));

const urlHasImageExt = (url) => {
  try {
    return IMAGE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

const nameHasImageExt = (name) => IMAGE_EXT.test(String(name || "").trim());

const externalUrlOf = (file) =>
  file?.type === "external" ? file.external?.url || null : null;

// "Yours": any external link that is not StoryGraph's.
const isYourCover = (url) => Boolean(url) && !isStoryGraphUrl(url);

function bestYourCoverUrl(pages) {
  for (const page of pages || []) {
    const files = P.coverImage ? pv(page, "coverImage")?.files || [] : [];
    const fromFile = files.map(externalUrlOf).filter(Boolean).find(isYourCover);

    if (fromFile) {
      return fromFile;
    }

    const fromCover = page?.cover?.type === "external" ? page.cover.external?.url : null;

    if (isYourCover(fromCover)) {
      return fromCover;
    }
  }

  return null;
}

// Any external cover link at all (yours or StoryGraph's) found on these pages.
function anyExternalCoverUrl(pages) {
  for (const page of pages || []) {
    const files = P.coverImage ? pv(page, "coverImage")?.files || [] : [];
    const fromFile = files.map(externalUrlOf).filter(Boolean)[0];

    if (fromFile) {
      return fromFile;
    }

    const fromCover = page?.cover?.type === "external" ? page.cover.external?.url : null;

    if (fromCover) {
      return fromCover;
    }
  }

  return null;
}

// Asks Notion to import the picture, waits for it to finish, and returns a
// file_upload reference. Returns null if that fails.
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

// Import first; if that fails, attach the direct link with a proper image name.
async function buildCoverFileFromUrl(url, title) {
  const imported = await importCoverToNotion(url, title);

  if (imported) {
    return imported;
  }

  console.warn(
    `[COVER] Attaching the direct image link for "${title}" instead of an imported file.`
  );

  return {
    type: "external",
    name: safeCoverFilename(title, url),
    external: { url },
  };
}

async function buildCoverFile(book) {
  const url = validExternalUrl(book.cover);

  return url ? buildCoverFileFromUrl(url, book.title) : null;
}

const externalFileEntry = (title, url) => ({
  type: "external",
  name: safeCoverFilename(title, url),
  external: { url },
});

// Works out what, if anything, should change about a page's covers.
//   sourceUrl       StoryGraph's cover URL for this book (null when there is none)
//   manualCandidate a link of yours found on a duplicate page
//   allowImport     false = look only, do not import (preview)
// Returns { files, cover, kind, wouldImport }. `files` / `cover` are only set when
// something should be written.
async function planCovers(page, title, sourceUrl, options = {}) {
  const { allowImport = true, manualCandidate = null } = options;
  const result = { files: undefined, cover: undefined, kind: null, wouldImport: false };

  const files = P.coverImage ? pv(page, "coverImage")?.files || [] : [];
  const allExternal = files.every((file) => file.type === "external");
  const fileUrls = files.map(externalUrlOf).filter(Boolean);

  const pageCoverUrl = page?.cover?.type === "external" ? page.cover.external?.url || null : null;
  const hasPageCover = Boolean(getPageCoverUrl(page));
  const pageCoverIsStoryGraph = Boolean(pageCoverUrl) && isStoryGraphUrl(pageCoverUrl);

  const ownFileUrl = fileUrls.find(isYourCover) || null;
  const yourUrl =
    ownFileUrl ||
    (isYourCover(pageCoverUrl) ? pageCoverUrl : null) ||
    (isYourCover(manualCandidate) ? manualCandidate : null);

  // ---- A cover you added yourself exists: keep it, mirror it, never replace it ----
  if (yourUrl) {
    if (P.coverImage) {
      if (ownFileUrl) {
        const ownFile = files.find((file) => externalUrlOf(file) === ownFileUrl);

        // Give a link with no extension anywhere a proper image name (avoids the blank icon).
        if (allExternal && !urlHasImageExt(ownFileUrl) && !nameHasImageExt(ownFile.name)) {
          result.files = files.map((file) => ({
            type: "external",
            name: file === ownFile ? safeCoverFilename(title, ownFileUrl) : file.name,
            external: { url: externalUrlOf(file) },
          }));
          result.kind = "rename";
        }
      } else if (
        files.length === 0 ||
        (files.length > 0 && allExternal && fileUrls.every(isStoryGraphUrl))
      ) {
        result.files = [externalFileEntry(title, yourUrl)];
        result.kind = "mirror";
      }
    }

    if (!hasPageCover || pageCoverIsStoryGraph) {
      result.cover = coverPayload(yourUrl);
      result.kind = result.kind || "mirror";
    }

    return result;
  }

  // ---- No cover of yours: use StoryGraph's, in both places ----
  const storyGraphUrl =
    fileUrls.find(isStoryGraphUrl) ||
    validExternalUrl(sourceUrl) ||
    (pageCoverIsStoryGraph ? pageCoverUrl : null);

  if (P.coverImage && storyGraphUrl) {
    const needsImport = (file) =>
      file.type === "external" && isStoryGraphUrl(file.external?.url) && !urlHasImageExt(file.external?.url);

    const needsFile = files.length === 0;
    const needsRepair = files.length === 1 && needsImport(files[0]);

    if (needsFile || needsRepair) {
      if (coverBudget.left <= 0) {
        stats.coverDeferred = (stats.coverDeferred || 0) + 1;
      } else if (!allowImport) {
        result.wouldImport = true;
        result.kind = needsFile ? "fill" : "repair";
      } else {
        coverBudget.left--;
        result.files = [await buildCoverFileFromUrl(storyGraphUrl, title)];
        result.kind = needsFile ? "fill" : "repair";
      }
    }
  }

  if (!hasPageCover && storyGraphUrl) {
    result.cover = coverPayload(storyGraphUrl);
    result.kind = result.kind || "fill";
  }

  return result;
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
//   Only fill Notion fields that are empty. Status is the one exception: a book
//   that has left your to-read / currently-reading lists and is now in books-read
//   is switched to Read (full mode only, where all three lists are known).
//
// to-read / currently-reading:
//   Refresh a field when StoryGraph supplies a usable value AND it differs from
//   what Notion has. Never erase a value because StoryGraph supplied nothing.
//
// Read-history fields (Years Read, Times Read, StoryGraph ID) are always
// fill-only. Covers follow the rules above. Nothing is written when nothing changed.
// ---------------------------------------------------------------------------

async function buildExistingPageUpdate(book, listType, page, duplicates = []) {
  const isReadHistory = listType === "books-read";
  const properties = {};
  let cover;

  const text = (key) => getPlainText(pv(page, key));
  const number = (key) => getNumber(pv(page, key));
  const names = (key) => getMultiSelectNames(pv(page, key));

  const coverPlan = await planCovers(page, book.title, validExternalUrl(book.cover), {
    allowImport: true,
    manualCandidate: bestYourCoverUrl(duplicates),
  });

  if (coverPlan.files && P.coverImage) {
    properties[P.coverImage] = { files: coverPlan.files };
  }

  if (coverPlan.cover) {
    cover = coverPlan.cover;
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
    const fillOnly = isReadHistory && !book.overrideStatus;

    if (fillOnly ? !current : current !== wanted) {
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

// Copies non-destructive data from duplicate pages into the page being kept:
// union Years Read / Genres / Moods, and fill blanks. Nothing is removed from any page here.
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
  fillBlank("status", (page) => getSelectName(pv(page, "status")), (value) => ({ select: { name: value } }));
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

    const update = await buildExistingPageUpdate(book, listType, existingPage, duplicates);

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

    const changed = [
      ...Object.keys(update.properties),
      ...(update.cover ? ["page cover"] : []),
    ].join(", ");

    console.log(
      listType === "books-read"
        ? `Filled missing read-history fields (${changed}): ${book.title}`
        : `Synced active-list fields (${changed}): ${book.title}`
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
// CLEANUP MODE (Notion only, no StoryGraph)
//
// 1. Finds duplicate pages. Two pages are duplicates when they have the same
//    StoryGraph ID. A page with no ID also counts as a duplicate of another page
//    with the same title (ignoring case/punctuation) AND the same known author.
//    Pages that carry two DIFFERENT StoryGraph IDs are never merged; they are
//    listed for you to look at.
// 2. Keeps the best page (rating, then cover, then read year, then most fields),
//    copies anything useful from the others into it, and moves the others to
//    Notion's trash (recoverable for 30 days).
// 3. Ties Times Read to the number of years in Years Read.
// 4. Repairs covers (see the cover rules above).
//
// Nothing is written unless CLEANUP_APPLY=true.
// ---------------------------------------------------------------------------

function findDuplicateGroups(pages) {
  const parent = pages.map((_, index) => index);

  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }

    return index;
  };

  const union = (a, b) => {
    parent[find(a)] = find(b);
  };

  const ids = pages.map((page) => getPlainText(pv(page, "storyGraphId")));
  const titles = pages.map((page) => normTitle(getPlainText(pv(page, "title"))));
  const authors = pages.map((page) => authorKey(getPlainText(pv(page, "author"))));

  // Same StoryGraph ID.
  const firstWithId = new Map();

  ids.forEach((id, index) => {
    if (!id) return;

    if (firstWithId.has(id)) {
      union(index, firstWithId.get(id));
    } else {
      firstWithId.set(id, index);
    }
  });

  // Same title and same known author, when at least one of the two has no ID.
  const byTitle = new Map();

  titles.forEach((title, index) => {
    if (title) addToIndex(byTitle, title, index);
  });

  const editionPairs = [];

  for (const list of byTitle.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];

        if (!authors[i] || authors[i] !== authors[j]) continue;

        if (ids[i] && ids[j]) {
          if (ids[i] !== ids[j]) {
            editionPairs.push(getPlainText(pv(pages[i], "title")));
          }

          continue;
        }

        union(i, j);
      }
    }
  }

  const components = new Map();

  pages.forEach((page, index) => addToIndex(components, find(index), index));

  const groups = [];
  const review = [];

  for (const members of components.values()) {
    if (members.length < 2) continue;

    const memberPages = members.map((index) => pages[index]);
    const distinctIds = new Set(members.map((index) => ids[index]).filter(Boolean));

    if (distinctIds.size > 1) {
      review.push(memberPages);
      continue;
    }

    const sorted = [...memberPages].sort(comparePages);

    groups.push({ winner: sorted[0], losers: sorted.slice(1) });
  }

  return { groups, review, editionPairs: [...new Set(editionPairs)] };
}

// Moves a page to Notion's trash. Tries the older `archived` flag first and the newer
// `in_trash` flag if the API rejects it.
async function trashPage(page, title) {
  try {
    await notionRequest(
      () => notion.pages.update({ page_id: page.id, archived: true }),
      `trash "${title}"`
    );
  } catch (error) {
    if (error?.status === 429) throw error;

    await notionRequest(
      () => notion.pages.update({ page_id: page.id, in_trash: true }),
      `trash "${title}"`
    );
  }
}

// Removes years earlier than MIN_YEAR_READ from Years Read.
function addOldYearStrip(update, page, title) {
  if (!MIN_YEAR_READ || !P.yearsRead) return false;

  const pending = update.properties[P.yearsRead]?.multi_select?.map((item) => item.name);
  const years = pending ?? getMultiSelectNames(pv(page, "yearsRead"));
  const kept = years.filter((year) => !(Number(year) > 0 && Number(year) < MIN_YEAR_READ));

  if (kept.length === years.length) return false;

  update.properties[P.yearsRead] = multiSelectProperty(sortYearNames(kept));

  console.log(
    `[YEARS] "${title}": removing ${years.filter((year) => !kept.includes(year)).join(", ")} ` +
      `from Years Read (earlier than ${MIN_YEAR_READ}).`
  );

  return true;
}

// Times Read = number of years found.
function addTimesReadFix(update, page, title) {
  if (!P.timesRead || !P.yearsRead) return false;

  const pendingYears = update.properties[P.yearsRead]?.multi_select?.map((item) => item.name);
  const years = pendingYears ?? getMultiSelectNames(pv(page, "yearsRead"));

  if (years.length === 0) return false;

  const pendingTimes = update.properties[P.timesRead]?.number;
  const current = pendingTimes ?? getNumber(pv(page, "timesRead"));

  if (current === years.length) return false;

  update.properties[P.timesRead] = { number: years.length };

  console.log(
    `[TIMES] "${title}": Times Read ${current ?? "empty"} -> ${years.length} ` +
      `(years: ${sortYearNames(years).join(", ")})`
  );

  return true;
}

async function runCleanup(indexes) {
  const apply = CLEANUP_APPLY;
  const pages = indexes.pages;

  const withId = pages.filter((page) => getPlainText(pv(page, "storyGraphId"))).length;

  console.log(
    `[CLEANUP] ${pages.length} pages loaded, ${withId} with a StoryGraph ID. ` +
      (apply
        ? "APPLY mode: changes will be written."
        : "PREVIEW mode: nothing will be changed.")
  );

  if (!P.storyGraphId) {
    console.warn(
      '[CLEANUP] No "StoryGraph ID" property found, so duplicates can only be found by title + author.'
    );
  }

  const summary = {
    groups: 0,
    trashed: 0,
    years: 0,
    times: 0,
    covers: 0,
    coverKinds: { mirror: 0, rename: 0, fill: 0, repair: 0 },
    failed: 0,
  };

  const { groups, review, editionPairs } = findDuplicateGroups(pages);
  const handled = new Set();
  const trashedIds = new Set();

  const finish = async (update, page, title, manualCandidate, sourceUrl = null) => {
    addOldYearStrip(update, page, title) && summary.years++;
    addTimesReadFix(update, page, title) && summary.times++;

    const plan = await planCovers(page, title, sourceUrl, {
      allowImport: apply,
      manualCandidate,
    });

    if (plan.files && P.coverImage) {
      update.properties[P.coverImage] = { files: plan.files };
    }

    if (plan.cover) {
      update.cover = plan.cover;
    }

    if (plan.kind) {
      summary.covers++;
      summary.coverKinds[plan.kind]++;
      console.log(
        `[COVER] "${title}": ${plan.kind}` +
          (plan.wouldImport ? " (would re-import as a real image file)" : "")
      );
    }

    return update;
  };

  const write = async (update, page, title) => {
    if (Object.keys(update.properties).length === 0 && !update.cover) {
      return true;
    }

    if (!apply) {
      return true;
    }

    try {
      await notionRequest(
        () =>
          notion.pages.update({
            page_id: page.id,
            ...(update.cover ? { cover: update.cover } : {}),
            properties: update.properties,
          }),
        `update "${title}"`
      );

      return true;
    } catch (error) {
      console.error(
        `[CLEANUP] Could not update "${title}": [${error.code || error.status || "unknown"}] ${error.message}`
      );

      summary.failed++;
      return false;
    }
  };

  // ---- Duplicates ----
  for (const group of groups) {
    const { winner, losers } = group;
    const title = getPlainText(pv(winner, "title")) || "(untitled)";

    summary.groups++;

    console.log(`[DEDUPE] "${title}": keep ${describeForLog(winner)}`);

    for (const loser of losers) {
      console.log(`[DEDUPE]   remove ${describeForLog(loser)}`);
    }

    const update = { properties: {}, cover: undefined };

    applyDuplicateMerge(update, winner, losers);

    await finish(
      update,
      winner,
      title,
      bestYourCoverUrl([winner, ...losers]),
      anyExternalCoverUrl(losers)
    );

    handled.add(winner.id);

    const saved = await write(update, winner, title);

    if (!saved) {
      console.warn(`[DEDUPE] "${title}": update failed, so the extra pages were left alone.`);
      continue;
    }

    for (const loser of losers) {
      summary.trashed++;
      trashedIds.add(loser.id);

      if (apply) {
        try {
          await trashPage(loser, title);
        } catch (error) {
          summary.trashed--;
          summary.failed++;

          console.error(
            `[CLEANUP] Could not trash ${loser.url || loser.id}: ` +
              `[${error.code || error.status || "unknown"}] ${error.message}`
          );
        }
      }
    }
  }

  // ---- Every other page: Times Read and covers ----
  for (const page of pages) {
    if (handled.has(page.id) || trashedIds.has(page.id)) continue;

    const title = getPlainText(pv(page, "title")) || "(untitled)";
    const update = { properties: {}, cover: undefined };

    await finish(update, page, title, null);
    await write(update, page, title);
  }

  // ---- Report ----
  if (review.length > 0) {
    console.warn(
      `[CLEANUP] ${review.length} group(s) hold pages with DIFFERENT StoryGraph IDs and were left alone:`
    );

    for (const members of review) {
      console.warn(
        `[CLEANUP]   ${members.map((page) => page.url || page.id).join("  |  ")}`
      );
    }
  }

  if (editionPairs.length > 0) {
    console.log(
      `[CLEANUP] Same title and author but different StoryGraph IDs (probably different editions), ` +
        `left alone: ${editionPairs.slice(0, 30).join(" | ")}`
    );
  }

  const manyTimesNoYears = pages.filter(
    (page) =>
      !trashedIds.has(page.id) &&
      getMultiSelectNames(pv(page, "yearsRead")).length === 0 &&
      (getNumber(pv(page, "timesRead")) || 0) > 2
  );

  if (manyTimesNoYears.length > 0) {
    console.log(
      `[CLEANUP] Times Read is above 2 but no years are known for: ` +
        manyTimesNoYears
          .slice(0, 20)
          .map((page) => getPlainText(pv(page, "title")).slice(0, 40))
          .join(" | ")
    );
  }

  console.log(
    `[CLEANUP] ${apply ? "Done" : "Preview"}: ${summary.groups} duplicate group(s), ` +
      `${summary.trashed} page(s) ${apply ? "moved to trash" : "would be moved to trash"}, ` +
      (MIN_YEAR_READ ? `${summary.years} page(s) with years before ${MIN_YEAR_READ} removed, ` : "") +
      `${summary.times} Times Read correction(s), ${summary.covers} cover fix(es) ` +
      `(${Object.entries(summary.coverKinds)
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ") || "none"}), ${summary.failed} failed` +
      (stats.coverDeferred
        ? `, ${stats.coverDeferred} cover(s) left for the next run (limit ${COVER_REPAIR_LIMIT} per run)`
        : "") +
      "."
  );

  if (!apply) {
    console.log(
      "[CLEANUP] Nothing was changed. Run this again with apply turned on to make these changes."
    );
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
    if (!VALID_MODES.includes(MODE)) {
      throw new Error(
        `SYNC_MODE must be one of: ${VALID_MODES.join(", ")} (got "${MODE}").`
      );
    }

    console.log(
      `Starting sync to Notion (mode: ${MODE}` +
        (MODE === "cleanup" ? (CLEANUP_APPLY ? ", APPLY" : ", preview only") : "") +
        ")..."
    );

    if (!process.env.NOTION_API_KEY || !databaseId) {
      throw new Error(
        "NOTION_API_KEY and NOTION_DATABASE_ID must both be configured."
      );
    }

    await checkDatabaseProperties();
    const indexes = await loadExistingPages();

    if (MODE === "cleanup") {
      await runCleanup(indexes);
      return;
    }

    // Books on your to-read / currently-reading lists keep that status even if they
    // also appear in books-read.
    const activeKeys = new Set();

    for (const listType of LISTS_BY_MODE[MODE]) {
      console.log(`Fetching ${listType} list...`);

      const scraped = await scrapeStoryGraphList({
        target: listType,
      });

      console.log(`Found ${scraped.length} books in ${listType}`);

      // Cloudflare blocked StoryGraph. Nothing useful was fetched, so stop now instead of
      // spending minutes on the remaining lists, and make the run show as failed.
      if (scraper.wasBlocked?.()) {
        console.error(
          `StoryGraph's Cloudflare check blocked this run while fetching ${listType}. ` +
            "Nothing was written for this list and the rest were skipped. Run it again later."
        );

        process.exitCode = 1;
        break;
      }

      if (listType === "books-read") {
        for (const book of scraped) {
          book.overrideStatus = !(
            (book.id && activeKeys.has(book.id)) || activeKeys.has(normTitle(book.title))
          );
        }

        await enrichBooks(scraped, listType);
      } else {
        for (const book of scraped) {
          if (book.id) activeKeys.add(book.id);
          activeKeys.add(normTitle(book.title));
        }
      }

      logFieldCounts(listType, scraped);

      const { books, editionMerges, entryMismatches } = mergeRepeatBooks(scraped, listType);

      if (books.length !== scraped.length) {
        const repeats = books.filter(
          (book) => book.listEntries > 1
        );

        console.log(
          `Merged ${scraped.length} entries into ${books.length} titles ` +
            "(Times Read = number of years found)."
        );

        console.log(
          `Listed more than once (${repeats.length}): ` +
            repeats
              .slice(0, 40)
              .map(
                (book) =>
                  `${book.title.slice(0, 50)} (${book.listEntries} entries` +
                  `${book.yearsRead.length ? `; years ${book.yearsRead.join(", ")}` : ""})`
              )
              .join(" | ")
        );
      }

      if (entryMismatches.length > 0) {
        console.log(
          `[TIMES] More list entries than known years, so Times Read follows the years: ` +
            entryMismatches.slice(0, 20).join(" | ")
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
        "duplicate groups (run cleanup mode to merge them)."
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

    if (stats.coverDeferred) {
      console.log(
        `${stats.coverDeferred} cover(s) still need re-importing; they are picked up on the next run ` +
          `(limit ${COVER_REPAIR_LIMIT} per run).`
      );
    }

    logNoYearBooks();

    if (MODE === "active") {
      console.log(
        "Active mode checks only your to-read and currently-reading lists. A finished book " +
          "switches to Read on the next full run."
      );
    }
  } catch (error) {
    console.error(`Error syncing to Notion: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await scraper.closeBrowser?.();
  }
}

syncAllToNotion();

export { syncAllToNotion };
