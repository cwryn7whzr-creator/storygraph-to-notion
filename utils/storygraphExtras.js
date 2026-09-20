// utils/storygraphExtras.js
//
// Fills in two things the list pages don't show:
//   1. Star ratings  -> taken from the public reviews page  (/user_reviews/<user>)
//   2. Year read     -> worked out from the public stats pages (/stats/<user>?year=YYYY)
//
// Both use the same shared browser as getList.js, so the Cloudflare cookie carries over.
// Every step is wrapped so a failure here logs a warning and the sync carries on without it.

import fs from "fs";
import {
  BASE,
  HARDCODED_USERNAME,
  getContext,
  openPage,
  loadEverythingOnPage,
} from "../functions/getList.js";

const PAGE_SIZE = 10; // StoryGraph serves 10 books per page / scroll batch
const MAX_REVIEW_PAGES = 40;
const MIN_YEAR = 2000;

const pause = (baseMs) => new Promise((r) => setTimeout(r, baseMs + Math.random() * 1200));

export const normTitle = (t) =>
  (t || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// 1. RATINGS
// ---------------------------------------------------------------------------

// Runs INSIDE the browser (page.evaluate), so it can't use anything from outside
// this function. For every book link it climbs to the review card (the biggest
// ancestor that still holds only that one book), then reads the rating shown
// on it, e.g. "5.0" or "4.25".
export function extractReviewCardsInPage() {
  const bookId = (href) => href?.match(/\/books\/([^/?#]+)/)?.[1] || null;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const idsIn = (node) =>
    new Set(
      [...node.querySelectorAll("a[href*='/books/']")]
        .map((a) => bookId(a.getAttribute("href")))
        .filter(Boolean)
    );

  const seen = new Set();
  const cards = [];

  for (const link of document.querySelectorAll("a[href*='/books/']")) {
    const id = bookId(link.getAttribute("href"));
    if (!id || seen.has(id)) continue;
    seen.add(id);

    let card = link;
    for (let i = 0; i < 8; i++) {
      const parent = card.parentElement;
      if (!parent || parent === document.body || idsIn(parent).size > 1) break;
      card = parent;
    }

    const title =
      [...card.querySelectorAll("a[href*='/books/']")]
        .map((a) => clean(a.textContent))
        .find((t) => t && t.length < 300) || "";

    // Main method: an element whose whole text is a decimal rating like "5.0" / "4.25".
    let rating;
    for (const el of card.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (/^[0-5]\.\d{1,2}$/.test(t)) {
        const n = parseFloat(t);
        if (n > 0 && n <= 5) {
          rating = n;
          break;
        }
      }
    }

    // Backup: an aria-label / title such as "4.25 out of 5 stars".
    if (rating === undefined) {
      for (const el of [card, ...card.querySelectorAll("[aria-label], [title]")]) {
        const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
        const m = label.match(/(\d(?:\.\d{1,2})?)\s*(?:out of 5|stars?)/i);
        if (m) {
          const n = parseFloat(m[1]);
          if (n > 0 && n <= 5) {
            rating = n;
            break;
          }
        }
      }
    }

    cards.push({ id, title, rating, html: card.outerHTML.slice(0, 3000) });
  }
  return cards;
}

const scrapeUserReviews = async () => {
  const context = await getContext();
  const page = await context.newPage();
  const found = new Map(); // bookId -> { id, title, rating }
  let expected = null;
  let emptyStreak = 0;
  let pageNo = 1;

  try {
    while (pageNo <= MAX_REVIEW_PAGES) {
      const url = new URL(`${BASE}/user_reviews/${HARDCODED_USERNAME}`);
      if (pageNo > 1) url.searchParams.set("page", String(pageNo));
      console.log(`[REVIEWS] navigating to page ${pageNo}: ${url}`);

      const status = await openPage(page, url.toString(), `reviews p${pageNo}`);
      if (status !== "ok") {
        console.warn(`[REVIEWS] page ${pageNo}: ${status}. Stopping.`);
        break;
      }

      try {
        await page.waitForSelector("a[href*='/books/']", { timeout: 10000, state: "attached" });
      } catch {
        console.warn(
          `[REVIEWS] page ${pageNo}: no book links. URL: ${page.url()} | Title: ${await page.title()}`
        );
        if (pageNo === 1) {
          await page.screenshot({ path: "debug-user-reviews.png", fullPage: true }).catch(() => {});
          fs.writeFileSync("debug-user-reviews.html", await page.content());
          console.warn("[REVIEWS] saved debug-user-reviews.png and debug-user-reviews.html");
        }
        break;
      }

      if (expected === null) {
        expected = await page
          .evaluate(() => {
            const m = (document.body.innerText || "").match(/(\d{1,5})\s+reviews?\s+by/i);
            return m ? Number(m[1]) : null;
          })
          .catch(() => null);
        console.log(`[REVIEWS] StoryGraph says there are ${expected ?? "an unknown number of"} reviews.`);
      }

      await loadEverythingOnPage(page, expected, `reviews p${pageNo}`);
      const cards = await page.evaluate(extractReviewCardsInPage);

      if (pageNo === 1 && cards.length > 0) {
        fs.writeFileSync(
          "debug-user-reviews-sample.html",
          cards
            .slice(0, 3)
            .map((c) => c.html)
            .join("\n\n<!-- ---------- next card ---------- -->\n\n")
        );
      }

      let added = 0;
      for (const c of cards) {
        const prev = found.get(c.id);
        if (!prev) {
          found.set(c.id, { id: c.id, title: c.title, rating: c.rating });
          added++;
        } else if (prev.rating === undefined && c.rating !== undefined) {
          prev.rating = c.rating;
        }
      }

      const withRating = [...found.values()].filter((r) => r.rating !== undefined).length;
      console.log(
        `[REVIEWS] page ${pageNo}: added ${added} (${found.size} total, ${withRating} with a rating).`
      );

      if (expected && found.size >= expected) break;
      emptyStreak = added === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= 2) break;

      // Same trick as the book lists: ?page=N re-reads everything from N onward,
      // so jump to the page that holds the first review we still don't have.
      pageNo = pageNo === 1 ? Math.max(2, Math.floor(found.size / PAGE_SIZE) + 1) : pageNo + 1;
      await pause(2500);
    }
  } finally {
    await page.close().catch(() => {});
  }

  if (expected && found.size < expected) {
    console.warn(`[REVIEWS] WARNING collected ${found.size} of ${expected} expected reviews.`);
  }

  const byId = new Map();
  const byTitle = new Map(); // null = two different books share this title, so don't guess
  for (const r of found.values()) {
    if (r.rating === undefined) continue;
    byId.set(r.id, r.rating);
    const key = normTitle(r.title);
    if (!key) continue;
    byTitle.set(key, byTitle.has(key) && byTitle.get(key) !== r.rating ? null : r.rating);
  }
  console.log(`[REVIEWS] finished: ${byId.size} books have a rating.`);
  return { byId, byTitle };
};

// Scraped once per run, then reused for all three lists.
let reviewsPromise = null;
const getRatings = () => {
  reviewsPromise ??= scrapeUserReviews().catch((err) => {
    console.error("[REVIEWS] Failed, continuing without ratings:", err.message);
    return { byId: new Map(), byTitle: new Map() };
  });
  return reviewsPromise;
};

export const applyRatings = (books, { byId, byTitle }) => {
  let matched = 0;
  for (const b of books) {
    if (b.rating !== undefined) continue;
    let r = b.id ? byId.get(b.id) : undefined;
    if (r === undefined) {
      const t = byTitle.get(normTitle(b.title));
      if (typeof t === "number") r = t;
    }
    if (r !== undefined) {
      b.rating = r;
      matched++;
    }
  }
  return matched;
};

// ---------------------------------------------------------------------------
// 2. YEAR READ
//
// The public pages don't show read dates, but the public stats page tells us
// how many reads happened in each year ("27 books, 8,205 pages"). The
// books-read list has one entry per read (a reread is its own entry) and is
// ordered newest first, so the first N1 entries belong to the latest year, the
// next N2 to the year before, and so on. Entries left over after the last year
// with data have no read date on StoryGraph, so they get no year.
//
// For a year with no reads at all, StoryGraph shows the ALL-TIME total instead
// (e.g. 201), so any count at or above the list size is treated as "no data".
// ---------------------------------------------------------------------------

const readYearCount = async (page) => {
  await page
    .waitForFunction(
      () => /\d[\d,]*\s+books?,\s*[\d,]+\s+pages/i.test(document.body.innerText),
      null,
      { timeout: 8000 }
    )
    .catch(() => {});

  const text = ((await page.evaluate(() => document.body.innerText).catch(() => "")) || "").replace(
    /\s+/g,
    " "
  );
  const strict = text.match(/\bRead (\d[\d,]*) books?, [\d,]+ pages/);
  const loose = strict ? null : text.match(/(\d[\d,]*) books?, [\d,]+ pages/);
  const m = strict || loose;
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

const scrapeYearCounts = async (allTimeTotal) => {
  const context = await getContext();
  const page = await context.newPage();
  const counts = new Map(); // year -> books read that year
  let total = 0;
  let emptyRun = 0;

  try {
    for (let year = new Date().getFullYear(); year >= MIN_YEAR; year--) {
      const status = await openPage(
        page,
        `${BASE}/stats/${HARDCODED_USERNAME}?year=${year}`,
        `stats ${year}`
      );
      if (status === "blocked") {
        console.warn(`[YEARS] blocked on ${year}. Year data will be incomplete.`);
        break;
      }

      let n = status === "ok" ? await readYearCount(page) : null;
      if (n !== null && allTimeTotal && n >= allTimeTotal) {
        console.log(`[YEARS] ${year}: page shows the all-time total (${n}), so no reads that year.`);
        n = 0;
      }
      if (n && n > 0) {
        counts.set(year, n);
        total += n;
        emptyRun = 0;
        console.log(`[YEARS] ${year}: ${n} books read.`);
      } else {
        emptyRun++;
        // Stop after 3 empty years in a row once we've found some (or 6 if none yet).
        if ((total > 0 && emptyRun >= 3) || emptyRun >= 6) break;
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
  let i = 0;
  for (const year of years) {
    const start = i;
    for (let n = 0; n < counts.get(year) && i < books.length; n++) books[i++].yearRead = year;
    if (i > start) {
      spans.push({ year, count: i - start, first: books[start].title, last: books[i - 1].title });
    }
  }
  return { assigned: i, spans };
};

let yearCountsPromise = null;
const getYearCounts = (allTimeTotal) => {
  yearCountsPromise ??= scrapeYearCounts(allTimeTotal).catch((err) => {
    console.error("[YEARS] Failed, continuing without year read:", err.message);
    return new Map();
  });
  return yearCountsPromise;
};

// ---------------------------------------------------------------------------
// Entry point used by syncToNotion.js
// ---------------------------------------------------------------------------
export const enrichBooks = async (books, listType) => {
  if (!books.length) return;

  const ratings = await getRatings();
  const matched = applyRatings(books, ratings);
  console.log(`[REVIEWS] ${listType}: matched a rating for ${matched} of ${books.length} books.`);

  if (listType !== "books-read") return;

  const counts = await getYearCounts(books.length);
  if (counts.size === 0) {
    console.warn("[YEARS] No yearly counts found, so Year Read will be left empty.");
    return;
  }

  const { assigned, spans } = assignYearsByPosition(books, counts);
  const statsTotal = [...counts.values()].reduce((a, b) => a + b, 0);

  // First/last title per year, so you can eyeball the boundaries against books you remember.
  for (const s of spans) {
    console.log(`[YEARS] ${s.year}: ${s.count} books, from "${s.first}" to "${s.last}"`);
  }
  console.log(`[YEARS] assigned a year to ${assigned} of ${books.length} entries.`);

  if (statsTotal > books.length) {
    console.warn(
      `[YEARS] Stats count ${statsTotal} reads but only ${books.length} list entries were scraped, ` +
        `so some reads are missing from the list and older years may be off.`
    );
  } else if (statsTotal < books.length) {
    console.warn(
      `[YEARS] Stats count ${statsTotal} reads but the list has ${books.length} entries, ` +
        `so the oldest ${books.length - statsTotal} entries have no year (probably no read date on StoryGraph).`
    );
  } else {
    console.log(`[YEARS] Stats total (${statsTotal}) matches the list (${books.length} entries).`);
  }
};
