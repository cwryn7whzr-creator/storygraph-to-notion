// utils/storygraphExtras.js
//
// Adds data that StoryGraph's normal list cards do not expose:
//
//   1. Ratings from /user_reviews/<user>
//   2. Read years from /stats/<user>?year=YYYY
//   3. Moods from public Stats chart segment pages
//   4. Genres from public Stats chart segment pages
//
// Mood and genre chart pages are scraped once per run and then assigned to
// books by StoryGraph book ID. Title matching is retained only as a cautious
// fallback for ratings, not for genres/moods.

import fs from "fs";
import {
  BASE,
  HARDCODED_USERNAME,
  getContext,
  openPage,
  loadEverythingOnPage,
} from "../functions/getList.js";

const PAGE_SIZE = 10;
const MAX_REVIEW_PAGES = 40;
const MIN_YEAR = 2000;

const MAX_TAG_SEGMENTS = 80;
const MAX_SEGMENT_PAGES = 60;
const MAX_EMPTY_SEGMENT_PAGES = 2;

const pause = (baseMs) =>
  new Promise((resolve) =>
    setTimeout(resolve, baseMs + Math.floor(Math.random() * 1200))
  );

export const normTitle = (title) =>
  (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

const bookIdFromHref = (href) =>
  href?.match(/\/books\/([^/?#]+)/)?.[1] || null;

// ---------------------------------------------------------------------------
// 1. RATINGS
// ---------------------------------------------------------------------------

export function extractReviewCardsInPage() {
  const idFromHref = (href) =>
    href?.match(/\/books\/([^/?#]+)/)?.[1] || null;

  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const idsIn = (node) =>
    new Set(
      [...node.querySelectorAll("a[href*='/books/']")]
        .map((a) => idFromHref(a.getAttribute("href")))
        .filter(Boolean)
    );

  const seen = new Set();
  const cards = [];

  for (const link of document.querySelectorAll("a[href*='/books/']")) {
    const id = idFromHref(link.getAttribute("href"));

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);

    let card = link;

    for (let i = 0; i < 8; i++) {
      const parent = card.parentElement;

      if (
        !parent ||
        parent === document.body ||
        idsIn(parent).size > 1
      ) {
        break;
      }

      card = parent;
    }

    const title =
      [...card.querySelectorAll("a[href*='/books/']")]
        .map((a) => text(a.textContent))
        .find((value) => value && value.length < 300) || "";

    let rating;

    for (const el of card.querySelectorAll("*")) {
      if (el.children.length) {
        continue;
      }

      const value = (el.textContent || "").trim();

      if (/^[0-5]\.\d{1,2}$/.test(value)) {
        const number = parseFloat(value);

        if (number > 0 && number <= 5) {
          rating = number;
          break;
        }
      }
    }

    if (rating === undefined) {
      for (const el of [
        card,
        ...card.querySelectorAll("[aria-label], [title]"),
      ]) {
        const label =
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          "";

        const match = label.match(
          /(\d(?:\.\d{1,2})?)\s*(?:out of 5|stars?)/i
        );

        if (match) {
          const number = parseFloat(match[1]);

          if (number > 0 && number <= 5) {
            rating = number;
            break;
          }
        }
      }
    }

    cards.push({
      id,
      title,
      rating,
      html: card.outerHTML.slice(0, 3000),
    });
  }

  return cards;
}

const scrapeUserReviews = async () => {
  const context = await getContext();
  const page = await context.newPage();

  const found = new Map();
  let expected = null;
  let emptyStreak = 0;
  let pageNo = 1;

  try {
    while (pageNo <= MAX_REVIEW_PAGES) {
      const url = new URL(
        `${BASE}/user_reviews/${HARDCODED_USERNAME}`
      );

      if (pageNo > 1) {
        url.searchParams.set("page", String(pageNo));
      }

      console.log(`[REVIEWS] navigating to page ${pageNo}: ${url}`);

      const status = await openPage(
        page,
        url.toString(),
        `reviews p${pageNo}`
      );

      if (status !== "ok") {
        console.warn(
          `[REVIEWS] page ${pageNo}: ${status}. Stopping.`
        );
        break;
      }

      try {
        await page.waitForSelector("a[href*='/books/']", {
          timeout: 10000,
          state: "attached",
        });
      } catch {
        console.warn(
          `[REVIEWS] page ${pageNo}: no book links. ` +
            `URL: ${page.url()} | Title: ${await page.title()}`
        );

        if (pageNo === 1) {
          await page
            .screenshot({
              path: "debug-user-reviews.png",
              fullPage: true,
            })
            .catch(() => {});

          fs.writeFileSync(
            "debug-user-reviews.html",
            await page.content()
          );
        }

        break;
      }

      if (expected === null) {
        expected = await page
          .evaluate(() => {
            const match = (document.body.innerText || "").match(
              /(\d{1,5})\s+reviews?\s+by/i
            );

            return match ? Number(match[1]) : null;
          })
          .catch(() => null);

        console.log(
          `[REVIEWS] StoryGraph says there are ` +
            `${expected ?? "an unknown number of"} reviews.`
        );
      }

      await loadEverythingOnPage(
        page,
        expected,
        `reviews p${pageNo}`
      );

      const cards = await page.evaluate(extractReviewCardsInPage);

      if (pageNo === 1 && cards.length > 0) {
        fs.writeFileSync(
          "debug-user-reviews-sample.html",
          cards
            .slice(0, 3)
            .map((card) => card.html)
            .join("\n\n<!-- ---------- next card ---------- -->\n\n")
        );
      }

      let added = 0;

      for (const card of cards) {
        const previous = found.get(card.id);

        if (!previous) {
          found.set(card.id, {
            id: card.id,
            title: card.title,
            rating: card.rating,
          });

          added++;
        } else if (
          previous.rating === undefined &&
          card.rating !== undefined
        ) {
          previous.rating = card.rating;
        }
      }

      const withRating = [...found.values()].filter(
        (review) => review.rating !== undefined
      ).length;

      console.log(
        `[REVIEWS] page ${pageNo}: added ${added} ` +
          `(${found.size} total, ${withRating} with a rating).`
      );

      if (expected && found.size >= expected) {
        break;
      }

      emptyStreak = added === 0 ? emptyStreak + 1 : 0;

      if (emptyStreak >= 2) {
        break;
      }

      pageNo =
        pageNo === 1
          ? Math.max(2, Math.floor(found.size / PAGE_SIZE) + 1)
          : pageNo + 1;

      await pause(2500);
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (expected && found.size < expected) {
    console.warn(
      `[REVIEWS] WARNING collected ${found.size} of ${expected} expected reviews.`
    );
  }

  const byId = new Map();
  const byTitle = new Map();

  for (const review of found.values()) {
    if (review.rating === undefined) {
      continue;
    }

    byId.set(review.id, review.rating);

    const key = normTitle(review.title);

    if (!key) {
      continue;
    }

    byTitle.set(
      key,
      byTitle.has(key) && byTitle.get(key) !== review.rating
        ? null
        : review.rating
    );
  }

  console.log(
    `[REVIEWS] finished: ${byId.size} books have a rating.`
  );

  return { byId, byTitle };
};

let reviewsPromise = null;

const getRatings = () => {
  reviewsPromise ??= scrapeUserReviews().catch((error) => {
    console.error(
      "[REVIEWS] Failed, continuing without ratings:",
      error.message
    );

    return {
      byId: new Map(),
      byTitle: new Map(),
    };
  });

  return reviewsPromise;
};

export const applyRatings = (books, { byId, byTitle }) => {
  let matched = 0;

  for (const book of books) {
    if (book.rating !== undefined) {
      continue;
    }

    let rating = book.id ? byId.get(book.id) : undefined;

    if (rating === undefined) {
      const byName = byTitle.get(normTitle(book.title));

      if (typeof byName === "number") {
        rating = byName;
      }
    }

    if (rating !== undefined) {
      book.rating = rating;
      matched++;
    }
  }

  return matched;
};

// ---------------------------------------------------------------------------
// 2. YEAR READ
// ---------------------------------------------------------------------------

const readYearCount = async (page) => {
  await page
    .waitForFunction(
      () =>
        /\d[\d,]*\s+books?,\s*[\d,]+\s+pages/i.test(
          document.body.innerText
        ),
      null,
      { timeout: 8000 }
    )
    .catch(() => {});

  const text = (
    (await page
      .evaluate(() => document.body.innerText)
      .catch(() => "")) || ""
  ).replace(/\s+/g, " ");

  const strict = text.match(
    /\bRead (\d[\d,]*) books?, [\d,]+ pages/
  );

  const loose = strict
    ? null
    : text.match(/(\d[\d,]*) books?, [\d,]+ pages/);

  const match = strict || loose;

  return match ? Number(match[1].replace(/,/g, "")) : null;
};

const scrapeYearCounts = async (allTimeTotal) => {
  const context = await getContext();
  const page = await context.newPage();

  const counts = new Map();

  let total = 0;
  let emptyRun = 0;

  try {
    for (
      let year = new Date().getFullYear();
      year >= MIN_YEAR;
      year--
    ) {
      const status = await openPage(
        page,
        `${BASE}/stats/${HARDCODED_USERNAME}?year=${year}`,
        `stats ${year}`
      );

      if (status === "blocked") {
        console.warn(
          `[YEARS] blocked on ${year}. Year data will be incomplete.`
        );
        break;
      }

      let count =
        status === "ok" ? await readYearCount(page) : null;

      if (
        count !== null &&
        allTimeTotal &&
        count >= allTimeTotal
      ) {
        console.log(
          `[YEARS] ${year}: page shows the all-time total ` +
            `(${count}), so no reads that year.`
        );

        count = 0;
      }

      if (count && count > 0) {
        counts.set(year, count);
        total += count;
        emptyRun = 0;

        console.log(`[YEARS] ${year}: ${count} books read.`);
      } else {
        emptyRun++;

        if ((total > 0 && emptyRun >= 3) || emptyRun >= 6) {
          break;
        }
      }

      await pause(1200);
    }
  } finally {
    await page.close().catch(() => {});
  }

  return counts;
};

export const assignYearsByPosition = (books, counts) => {
  const years = [...counts.keys()].sort((a, b) => b - a);

  const spans = [];
  let index = 0;

  for (const year of years) {
    const start = index;

    for (
      let count = 0;
      count < counts.get(year) && index < books.length;
      count++
    ) {
      books[index++].yearRead = year;
    }

    if (index > start) {
      spans.push({
        year,
        count: index - start,
        first: books[start].title,
        last: books[index - 1].title,
      });
    }
  }

  return {
    assigned: index,
    spans,
  };
};

let yearCountsPromise = null;

const getYearCounts = (allTimeTotal) => {
  yearCountsPromise ??= scrapeYearCounts(allTimeTotal).catch(
    (error) => {
      console.error(
        "[YEARS] Failed, continuing without year read:",
        error.message
      );

      return new Map();
    }
  );

  return yearCountsPromise;
};

// ---------------------------------------------------------------------------
// 3. PUBLIC STATS CHART TAGS: MOODS AND GENRES
//
// The normal StoryGraph list cards do not include these tags. The public stats
// charts do. Each clickable chart label opens a segment page containing books
// assigned that mood or genre.
//
// Output:
//   {
//     moodsByBookId: Map<BookID, string[]>,
//     genresByBookId: Map<BookID, string[]>
//   }
//
// This code uses only StoryGraph IDs to apply the tags. It never changes a
// displayed book title or merges records by title.
// ---------------------------------------------------------------------------

const chartConfig = {
  moods: {
    chartType: "Moods",
    logName: "MOODS",
  },
  genres: {
    chartType: "Genres",
    logName: "GENRES",
  },
};

function normalTagLabel(value) {
  return clean(value)
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function chartSegmentUrl(chartType, label, pageNo = 1) {
  const url = new URL(`${BASE}/stats/segment/`);

  url.searchParams.set("user_id", HARDCODED_USERNAME);
  url.searchParams.set("chart_type", chartType);
  url.searchParams.set("label", label);
  url.searchParams.set("year", "0");
  url.searchParams.set("read_status", "Read");

  if (pageNo > 1) {
    url.searchParams.set("page", String(pageNo));
  }

  return url.toString();
}

// Runs in the browser. Finds chart segment links and takes the exact `label`
// query parameter when it exists. The fallback uses visible link text.
export function extractChartSegmentsInPage(chartType) {
  const cleanText = (value) =>
    String(value || "").replace(/\s+/g, " ").trim();

  const items = [];
  const seen = new Set();

  for (const link of document.querySelectorAll("a[href]")) {
    const rawHref = link.getAttribute("href") || "";

    if (
      !rawHref.includes("/stats/segment") ||
      !rawHref.includes("chart_type=")
    ) {
      continue;
    }

    let url;

    try {
      url = new URL(rawHref, window.location.origin);
    } catch {
      continue;
    }

    if (
      String(url.searchParams.get("chart_type") || "").toLowerCase() !==
      String(chartType).toLowerCase()
    ) {
      continue;
    }

    const label =
      cleanText(url.searchParams.get("label")) ||
      cleanText(link.textContent);

    if (!label || label.length > 100) {
      continue;
    }

    const key = label.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    items.push({
      label,
      href: url.href,
    });
  }

  return items;
}

// Runs in the browser. Returns distinct StoryGraph book IDs found in a chart
// segment page. The same book is included once per tag segment.
export function extractBookIdsFromSegmentPage() {
  const ids = new Set();

  for (const link of document.querySelectorAll("a[href*='/books/']")) {
    const match = (link.getAttribute("href") || "").match(
      /\/books\/([^/?#]+)/
    );

    if (match?.[1]) {
      ids.add(match[1]);
    }
  }

  return [...ids];
}

async function getChartSegmentLinks(page, chartType, logName) {
  const candidateUrls = [
    `${BASE}/stats/${HARDCODED_USERNAME}?year=0`,
    `${BASE}/stats/${HARDCODED_USERNAME}`,
  ];

  for (const url of candidateUrls) {
    const status = await openPage(
      page,
      url,
      `${logName.toLowerCase()} chart`
    );

    if (status !== "ok") {
      continue;
    }

    await page.waitForTimeout(1500);

    const links = await page
      .evaluate(extractChartSegmentsInPage, chartType)
      .catch(() => []);

    if (links.length > 0) {
      console.log(
        `[${logName}] found ${links.length} clickable ${chartType} chart labels.`
      );

      return links.slice(0, MAX_TAG_SEGMENTS);
    }
  }

  return [];
}

async function scrapeTagSegment(
  page,
  { label, href },
  chartType,
  logName
) {
  const bookIds = new Set();

  let pageNo = 1;
  let emptyStreak = 0;

  while (pageNo <= MAX_SEGMENT_PAGES) {
    let url;

    if (pageNo === 1 && href) {
      const first = new URL(href);
      first.searchParams.set("user_id", HARDCODED_USERNAME);
      first.searchParams.set("chart_type", chartType);
      first.searchParams.set("label", label);
      first.searchParams.set("year", "0");
      first.searchParams.set("read_status", "Read");

      url = first.toString();
    } else {
      url = chartSegmentUrl(chartType, label, pageNo);
    }

    const status = await openPage(
      page,
      url,
      `${logName.toLowerCase()} "${label}" p${pageNo}`
    );

    if (status !== "ok") {
      if (pageNo === 1) {
        console.warn(
          `[${logName}] "${label}": ${status}; skipping this label.`
        );
      }

      break;
    }

    try {
      await page.waitForSelector("a[href*='/books/']", {
        timeout: 9000,
        state: "attached",
      });
    } catch {
      if (pageNo === 1) {
        console.warn(
          `[${logName}] "${label}": no book links found. ` +
            `URL: ${page.url()} | Title: ${await page.title()}`
        );

        await page
          .screenshot({
            path: `debug-${logName.toLowerCase()}-${label
              .replace(/[^a-z0-9]+/gi, "-")
              .slice(0, 40)}.png`,
            fullPage: true,
          })
          .catch(() => {});
      }

      break;
    }

    await loadEverythingOnPage(
      page,
      null,
      `${logName.toLowerCase()} "${label}" p${pageNo}`
    );

    const ids = await page.evaluate(extractBookIdsFromSegmentPage);

    let added = 0;

    for (const id of ids) {
      if (!bookIds.has(id)) {
        bookIds.add(id);
        added++;
      }
    }

    if (added === 0) {
      emptyStreak++;
    } else {
      emptyStreak = 0;
    }

    // StoryGraph segment results are normally fully loaded on page 1 through
    // infinite scroll. We only continue if page 1 had results and later pages
    // might expose more.
    if (emptyStreak >= MAX_EMPTY_SEGMENT_PAGES) {
      break;
    }

    // If fewer than ten unique books appeared, there is no likely next page.
    if (ids.length < PAGE_SIZE) {
      break;
    }

    pageNo++;
    await pause(1400);
  }

  console.log(
    `[${logName}] "${label}": matched ${bookIds.size} StoryGraph book IDs.`
  );

  return bookIds;
}

async function scrapeChartTags(kind) {
  const config = chartConfig[kind];

  if (!config) {
    throw new Error(`Unknown chart tag type: ${kind}`);
  }

  const { chartType, logName } = config;

  const context = await getContext();
  const page = await context.newPage();

  const tagsByBookId = new Map();

  try {
    const segments = await getChartSegmentLinks(
      page,
      chartType,
      logName
    );

    if (segments.length === 0) {
      console.warn(
        `[${logName}] Could not find chart segment links. ` +
          `No ${kind} will be applied this run.`
      );

      return tagsByBookId;
    }

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];

      console.log(
        `[${logName}] ${index + 1}/${segments.length}: ` +
          `fetching "${segment.label}"...`
      );

      const ids = await scrapeTagSegment(
        page,
        segment,
        chartType,
        logName
      );

      for (const id of ids) {
        const tags = tagsByBookId.get(id) || [];

        if (!tags.includes(segment.label)) {
          tags.push(segment.label);
        }

        tagsByBookId.set(id, tags);
      }

      await pause(900);
    }
  } finally {
    await page.close().catch(() => {});
  }

  const booksWithTags = tagsByBookId.size;
  const tagAssignments = [...tagsByBookId.values()].reduce(
    (sum, tags) => sum + tags.length,
    0
  );

  console.log(
    `[${logName}] finished: ${booksWithTags} books with ` +
      `${tagAssignments} ${kind} assignments.`
  );

  return tagsByBookId;
}

let chartTagsPromise = null;

const getChartTags = () => {
  chartTagsPromise ??= Promise.all([
    scrapeChartTags("moods").catch((error) => {
      console.error(
        "[MOODS] Failed, continuing without moods:",
        error.message
      );

      return new Map();
    }),

    scrapeChartTags("genres").catch((error) => {
      console.error(
        "[GENRES] Failed, continuing without genres:",
        error.message
      );

      return new Map();
    }),
  ]).then(([moodsByBookId, genresByBookId]) => ({
    moodsByBookId,
    genresByBookId,
  }));

  return chartTagsPromise;
};

function mergeTagLists(existingTags, incomingTags) {
  return [
    ...new Set(
      [...(existingTags || []), ...(incomingTags || [])]
        .map(normalTagLabel)
        .filter(Boolean)
    ),
  ];
}

export const applyChartTags = async (books, listType) => {
  // Your public chart URLs are Read-only (`read_status=Read`), so we only
  // apply public stats tags to your books-read list. This prevents a read-chart
  // genre/mood assignment from being incorrectly copied onto an unread book.
  if (listType !== "books-read" || books.length === 0) {
    return {
      moodMatches: 0,
      genreMatches: 0,
    };
  }

  const { moodsByBookId, genresByBookId } = await getChartTags();

  let moodMatches = 0;
  let genreMatches = 0;

  for (const book of books) {
    if (!book.id) {
      continue;
    }

    const moods = moodsByBookId.get(book.id) || [];
    const genres = genresByBookId.get(book.id) || [];

    if (moods.length > 0) {
      book.moodTags = mergeTagLists(book.moodTags, moods);
      moodMatches++;
    }

    if (genres.length > 0) {
      book.genreTags = mergeTagLists(book.genreTags, genres);
      genreMatches++;
    }
  }

  console.log(
    `[MOODS] ${listType}: matched moods for ${moodMatches} of ${books.length} books.`
  );

  console.log(
    `[GENRES] ${listType}: matched genres for ${genreMatches} of ${books.length} books.`
  );

  return {
    moodMatches,
    genreMatches,
  };
};

// ---------------------------------------------------------------------------
// Entry point used by syncToNotion.js
// ---------------------------------------------------------------------------

export const enrichBooks = async (books, listType) => {
  if (!books.length) {
    return;
  }

  const ratings = await getRatings();

  const ratingMatches = applyRatings(books, ratings);

  console.log(
    `[REVIEWS] ${listType}: matched a rating for ` +
      `${ratingMatches} of ${books.length} books.`
  );

  await applyChartTags(books, listType);

  if (listType !== "books-read") {
    return;
  }

  const counts = await getYearCounts(books.length);

  if (counts.size === 0) {
    console.warn(
      "[YEARS] No yearly counts found, so Year Read will be left empty."
    );

    return;
  }

  const { assigned, spans } = assignYearsByPosition(books, counts);

  const statsTotal = [...counts.values()].reduce(
    (sum, count) => sum + count,
    0
  );

  for (const span of spans) {
    console.log(
      `[YEARS] ${span.year}: ${span.count} books, ` +
        `from "${span.first}" to "${span.last}"`
    );
  }

  console.log(
    `[YEARS] assigned a year to ${assigned} of ${books.length} entries.`
  );

  if (statsTotal > books.length) {
    console.warn(
      `[YEARS] Stats count ${statsTotal} reads but only ${books.length} ` +
        `list entries were scraped, so some reads are missing from the list ` +
        "and older years may be off."
    );
  } else if (statsTotal < books.length) {
    console.warn(
      `[YEARS] Stats count ${statsTotal} reads but the list has ` +
        `${books.length} entries, so the oldest ` +
        `${books.length - statsTotal} entries have no year ` +
        "(probably no read date on StoryGraph)."
    );
  } else {
    console.log(
      `[YEARS] Stats total (${statsTotal}) matches the list ` +
        `(${books.length} entries).`
    );
  }
};
