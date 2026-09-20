// utils/storygraphExtras.js
//
// Fills in data that StoryGraph's normal list cards do not always show:
//
// 1. Star ratings from /user_reviews/<user>
// 2. Year read from public stats pages
// 3. Moods from public Stats chart segment pages
// 4. Genres from public Stats chart segment pages
//
// Moods and genres are matched only by StoryGraph book ID. They are not used
// to rename titles or combine books.

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

const MAX_MOOD_LABELS = 40;
const MAX_GENRE_LABELS = 80;

const pause = (baseMs) =>
  new Promise((resolve) =>
    setTimeout(resolve, baseMs + Math.floor(Math.random() * 1200))
  );

const clean = (value) =>
  String(value || "").replace(/\s+/g, " ").trim();

export const normTitle = (title) =>
  clean(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const bookIdFromHref = (href) =>
  href?.match(/\/books\/([^/?#]+)/)?.[1] || null;

// ---------------------------------------------------------------------------
// 1. RATINGS
// ---------------------------------------------------------------------------

export function extractReviewCardsInPage() {
  const idsIn = (node) =>
    new Set(
      [...node.querySelectorAll("a[href*='/books/']")]
        .map((link) => bookIdFromHref(link.getAttribute("href")))
        .filter(Boolean)
    );

  const seen = new Set();
  const cards = [];

  for (const link of document.querySelectorAll("a[href*='/books/']")) {
    const id = bookIdFromHref(link.getAttribute("href"));

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);

    let card = link;

    for (let i = 0; i < 8; i++) {
      const parent = card.parentElement;

      if (!parent || parent === document.body || idsIn(parent).size > 1) {
        break;
      }

      card = parent;
    }

    const title =
      [...card.querySelectorAll("a[href*='/books/']")]
        .map((bookLink) => clean(bookLink.textContent))
        .find((text) => text && text.length < 300) || "";

    let rating;

    for (const element of card.querySelectorAll("*")) {
      if (element.children.length) {
        continue;
      }

      const text = clean(element.textContent);

      if (/^[0-5]\.\d{1,2}$/.test(text)) {
        const number = parseFloat(text);

        if (number > 0 && number <= 5) {
          rating = number;
          break;
        }
      }
    }

    if (rating === undefined) {
      for (const element of [
        card,
        ...card.querySelectorAll("[aria-label], [title]"),
      ]) {
        const label =
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          "";

        const match = label.match(
          /(\d(?:\.\d{1,2})?)\s*(?:out of 5|stars?)/i
        );

        if (!match) {
          continue;
        }

        const number = parseFloat(match[1]);

        if (number > 0 && number <= 5) {
          rating = number;
          break;
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
        console.warn(`[REVIEWS] page ${pageNo}: ${status}. Stopping.`);
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

  console.log(`[REVIEWS] finished: ${byId.size} books have a rating.`);

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
// 3. MOODS AND GENRES FROM PUBLIC STATS
//
// The standard list cards usually contain no mood or genre data. StoryGraph's
// public Stats page displays those values in chart bars. Clicking a bar opens:
//
// /stats/segment/?user_id=...&chart_type=Moods&label=...&year=0&read_status=Read
//
// This module detects rendered labels, builds those segment URLs, then maps
// each returned book to its StoryGraph book ID.
// ---------------------------------------------------------------------------

const CHART_CONFIG = {
  moods: {
    chartType: "Moods",
    heading: "Moods",
    logName: "MOODS",
    maxLabels: MAX_MOOD_LABELS,
  },
  genres: {
    chartType: "Genres",
    heading: "Genres",
    logName: "GENRES",
    maxLabels: MAX_GENRE_LABELS,
  },
};

const normalizeChartLabel = (value) =>
  clean(value)
    .replace(/^[•\-–—]\s*/, "")
    .replace(/\s+\d+$/, "")
    .slice(0, 100);

const buildSegmentUrl = (chartType, label) => {
  const url = new URL(`${BASE}/stats/segment/`);

  url.searchParams.set("user_id", HARDCODED_USERNAME);
  url.searchParams.set("chart_type", chartType);
  url.searchParams.set("label", label);
  url.searchParams.set("year", "0");
  url.searchParams.set("read_status", "Read");

  return url.toString();
};

// Runs inside the browser. It finds the section headed "Moods" or "Genres",
// then collects short text fragments from the nearby chart area. This avoids
// depending on chart bars being normal <a> links.
export function extractStatsChartLabels(headingText) {
  const cleanText = (value) =>
    String(value || "").replace(/\s+/g, " ").trim();

  const heading = [
    ...document.querySelectorAll("h1, h2, h3, h4, h5, h6"),
  ].find(
    (element) =>
      cleanText(element.textContent).toLowerCase() ===
      String(headingText).toLowerCase()
  );

  if (!heading) {
    return {
      labels: [],
      debug: "heading not found",
    };
  }

  let scope = heading.parentElement;

  for (let level = 0; level < 6 && scope; level++) {
    const scopeText = cleanText(scope.innerText);

    if (
      scope.querySelector("svg, canvas") ||
      /No\. of books|Mood|Genre/i.test(scopeText)
    ) {
      break;
    }

    scope = scope.parentElement;
  }

  if (!scope) {
    return {
      labels: [],
      debug: "chart container not found",
    };
  }

  const rawText = [];

  for (const element of scope.querySelectorAll(
    "svg text, [role='graphics-symbol'], [role='img'], button, a, span, div"
  )) {
    const text = cleanText(element.textContent);

    if (text && text.length <= 100) {
      rawText.push(text);
    }
  }

  const excluded = new Set([
    "Moods",
    "Genres",
    "No. of books",
    "Mood",
    "Genre",
    "Click on any chart segment to view the books",
  ]);

  const labels = [
    ...new Set(
      rawText
        .map((text) => text.replace(/\s+\d+$/, "").trim())
        .filter((text) => {
          if (!text || excluded.has(text)) {
            return false;
          }

          if (/^\d+(\.\d+)?$/.test(text)) {
            return false;
          }

          if (/^\d+\s*(books?|pages?)$/i.test(text)) {
            return false;
          }

          return /^[A-Za-z][A-Za-z+&'’\- ]{1,80}$/.test(text);
        })
    ),
  ];

  return {
    labels,
    debug: `chart text: ${cleanText(scope.innerText).slice(0, 1500)}`,
  };
}

// Runs inside the browser. It returns distinct StoryGraph book IDs found in a
// stats segment result page.
export function extractSegmentBookIds() {
  return [
    ...new Set(
      [...document.querySelectorAll("a[href*='/books/']")]
        .map((link) => bookIdFromHref(link.getAttribute("href")))
        .filter(Boolean)
    ),
  ];
}

async function scrapeChartLabels(kind) {
  const config = CHART_CONFIG[kind];
  const context = await getContext();
  const page = await context.newPage();

  try {
    const status = await openPage(
      page,
      `${BASE}/stats/${HARDCODED_USERNAME}?year=0`,
      `${config.logName.toLowerCase()} chart`
    );

    if (status !== "ok") {
      console.warn(
        `[${config.logName}] Stats page could not be opened: ${status}.`
      );

      return [];
    }

    await page.waitForTimeout(2500);

    const result = await page.evaluate(
      extractStatsChartLabels,
      config.heading
    );

    const labels = result.labels
      .map(normalizeChartLabel)
      .filter(Boolean)
      .filter((label) => label.length <= 100)
      .slice(0, config.maxLabels);

    if (labels.length === 0) {
      console.warn(
        `[${config.logName}] No chart labels found. ${result.debug}`
      );

      await page
        .screenshot({
          path: `debug-${config.logName.toLowerCase()}-chart.png`,
          fullPage: true,
        })
        .catch(() => {});

      fs.writeFileSync(
        `debug-${config.logName.toLowerCase()}-chart.html`,
        await page.content()
      );

      return [];
    }

    console.log(
      `[${config.logName}] detected ${labels.length} chart labels: ` +
        labels.join(" | ")
    );

    return labels;
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeOneSegment(page, config, label) {
  const url = buildSegmentUrl(config.chartType, label);

  const status = await openPage(
    page,
    url,
    `${config.logName.toLowerCase()} "${label}"`
  );

  if (status !== "ok") {
    console.warn(
      `[${config.logName}] "${label}": ${status}; skipping.`
    );

    return [];
  }

  try {
    await page.waitForSelector("a[href*='/books/']", {
      timeout: 10000,
      state: "attached",
    });
  } catch {
    console.warn(
      `[${config.logName}] "${label}": no book links. ` +
        `URL: ${page.url()} | Title: ${await page.title()}`
    );

    return [];
  }

  await loadEverythingOnPage(
    page,
    null,
    `${config.logName.toLowerCase()} "${label}"`
  );

  return page.evaluate(extractSegmentBookIds);
}

async function scrapeChartAssignments(kind) {
  const config = CHART_CONFIG[kind];
  const labels = await scrapeChartLabels(kind);
  const tagsByBookId = new Map();

  if (labels.length === 0) {
    return tagsByBookId;
  }

  const context = await getContext();
  const page = await context.newPage();

  try {
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index];

      console.log(
        `[${config.logName}] ${index + 1}/${labels.length}: ` +
          `fetching "${label}"...`
      );

      const ids = await scrapeOneSegment(page, config, label);

      for (const id of ids) {
        const tags = tagsByBookId.get(id) || [];

        if (!tags.includes(label)) {
          tags.push(label);
        }

        tagsByBookId.set(id, tags);
      }

      console.log(
        `[${config.logName}] "${label}": matched ${ids.length} book IDs.`
      );

      await pause(900);
    }
  } finally {
    await page.close().catch(() => {});
  }

  const tagCount = [...tagsByBookId.values()].reduce(
    (total, tags) => total + tags.length,
    0
  );

  console.log(
    `[${config.logName}] finished: ${tagsByBookId.size} books with ` +
      `${tagCount} tag assignments.`
  );

  return tagsByBookId;
}

let chartTagsPromise = null;

const getChartTags = () => {
  chartTagsPromise ??= Promise.all([
    scrapeChartAssignments("moods").catch((error) => {
      console.error(
        "[MOODS] Failed, continuing without moods:",
        error.message
      );

      return new Map();
    }),

    scrapeChartAssignments("genres").catch((error) => {
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

const mergeTags = (existing = [], incoming = []) =>
  [
    ...new Set(
      [...existing, ...incoming]
        .map((tag) => clean(tag))
        .filter(Boolean)
    ),
  ].slice(0, 20);

async function applyStatsChartTags(books, listType) {
  // The public segment URLs supplied use read_status=Read, so this data
  // belongs to your books-read list only.
  if (listType !== "books-read" || books.length === 0) {
    return;
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
      book.moodTags = mergeTags(book.moodTags, moods);
      moodMatches++;
    }

    if (genres.length > 0) {
      book.genreTags = mergeTags(book.genreTags, genres);
      genreMatches++;
    }
  }

  console.log(
    `[MOODS] ${listType}: matched moods for ` +
      `${moodMatches} of ${books.length} books.`
  );

  console.log(
    `[GENRES] ${listType}: matched genres for ` +
      `${genreMatches} of ${books.length} books.`
  );
}

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

  await applyStatsChartTags(books, listType);

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
        "list entries were scraped, so older years may be off."
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
