const BASE_URL = "https://app.thestorygraph.com";

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

// Reads the text of a parsed node WITHOUT modifying the tree.
// (The old code used cheerio.load(el), which can detach the element from the
// card, silently removing content before later lookups ran.)
const nodeText = (node) => {
  if (!node) return "";
  if (node.type === "text") return node.data || "";
  return (node.children || []).map(nodeText).join("");
};

const toIsoDate = (y, m, d) => {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

const monthNumber = (word) => MONTHS[word.slice(0, 3).toLowerCase()];

// Builds the date from its parts instead of using new Date(), so time zones
// on the GitHub runner can never shift a date by a day.
const parseDate = (text) => {
  if (!text) return undefined;

  // 2024/03/15 or 2024-03-15
  const iso = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return toIsoDate(+iso[1], +iso[2], +iso[3]);

  // Mar 15, 2024
  for (const x of text.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g)) {
    const month = monthNumber(x[1]);
    if (month) return toIsoDate(+x[3], month, +x[2]);
  }

  // 15 Mar 2024
  for (const x of text.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/g)) {
    const month = monthNumber(x[2]);
    if (month) return toIsoDate(+x[3], month, +x[1]);
  }

  // Mar 2024 (no day given: use the 1st of the month)
  for (const x of text.matchAll(/([A-Za-z]{3,9})\.?,?\s+(\d{4})/g)) {
    const month = monthNumber(x[1]);
    if (month) return toIsoDate(+x[2], month, 1);
  }

  return undefined;
};

const formatUrl = (rawUrl) => {
  if (!rawUrl) return undefined;
  let url = rawUrl.trim();
  if (!url || url.startsWith("data:")) return undefined;

  if (url.startsWith("//")) {
    url = `https:${url}`; // protocol-relative URL
  } else if (!/^https?:\/\//i.test(url)) {
    url = `${BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  url = url.replace(/ /g, "%20");
  return url.length < 2000 ? url : undefined; // Notion rejects very long URLs
};

const NOT_A_COVER = /avatar|icon|logo|sprite|placeholder|spinner/i;

export default function parseBookPane($pane) {
  // ---- ID -----------------------------------------------------------------
  const rawBookLink = $pane.find("a[href*='/books/']").first().attr("href") || "";
  const idMatch = rawBookLink.match(/\/books\/([a-zA-Z0-9-]+)/);
  const id = idMatch ? idMatch[1] : undefined;

  // ---- Title --------------------------------------------------------------
  // The first /books/ link is often the cover image (no text), so look at
  // every /books/ link and take the first one that actually has text.
  let title = clean($pane.find(".book-title-author-and-series a[href*='/books/']").first().text());
  if (!title) {
    title =
      $pane
        .find("a[href*='/books/']")
        .toArray()
        .map((el) => clean(nodeText(el)))
        .find((t) => t && t.length < 300) || "";
  }
  if (!title) title = clean($pane.find(".title").first().text());
  if (!title) title = "Untitled Book";

  // ---- Author(s) ----------------------------------------------------------
  const authors = [
    ...new Set(
      $pane
        .find("a[href*='/authors/']")
        .toArray()
        .map((el) => clean(nodeText(el)))
        .filter(Boolean)
    ),
  ];
  const author = authors.length
    ? authors.join(", ")
    : clean($pane.find(".author").first().text()) || "Unknown Author";

  // ---- Cover --------------------------------------------------------------
  // Look at every <img>, skip placeholders/icons, and prefer one whose class
  // says "cover". Reads data-src / srcset / src in that priority order.
  const imageCandidates = $pane
    .find("img")
    .toArray()
    .map((el) => {
      const a = el.attribs || {};
      const srcset = a.srcset || a["data-srcset"];
      const fromSrcset = srcset
        ? srcset.split(/,\s+/).pop().trim().split(/\s+/)[0]
        : undefined;
      const raw = a["data-src"] || a["data-lazy-src"] || a["data-original"] || fromSrcset || a.src || "";
      return { raw: raw.trim(), cls: a.class || "" };
    })
    .filter(
      (c) =>
        c.raw &&
        !c.raw.startsWith("data:") &&
        !/\.svg(\?|$)/i.test(c.raw) &&
        !NOT_A_COVER.test(c.raw)
    );

  const chosenImage = imageCandidates.find((c) => /cover/i.test(c.cls)) || imageCandidates[0];
  const cover = formatUrl(chosenImage?.raw);

  // ---- Date read ----------------------------------------------------------
  let rawDateText = clean($pane.find(".read-date, .date-read, p.read-date-text").first().text());
  if (!parseDate(rawDateText)) {
    rawDateText =
      $pane
        .find("p, span")
        .toArray()
        .map((el) => clean(nodeText(el)))
        .find((t) => /^(Read|Finished)\b/i.test(t) && parseDate(t)) || "";
  }
  const dateRead = parseDate(rawDateText);

  // ---- Rating -------------------------------------------------------------
  let rating = undefined;
  const ratingNode = $pane.find(".star-rating, .rating, [aria-label*='stars']").first();
  const ratingText = ratingNode.attr("aria-label") || clean(ratingNode.text()) || "";
  const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)\s*(?:out of 5|stars)?/i);
  if (ratingMatch) {
    const num = parseFloat(ratingMatch[1]);
    if (num > 0 && num <= 5) rating = num;
  }

  // ---- Genres and moods ---------------------------------------------------
  const collectTags = (selector) => {
    const tags = [];
    $pane
      .find(selector)
      .toArray()
      .forEach((el) => {
        const t = clean(nodeText(el)).replace(/,/g, "");
        if (t && t.length < 50 && !tags.includes(t)) tags.push(t);
      });
    return tags;
  };

  const moodTags = collectTags(".mood-tag, a[href*='/moods/']");
  // Keep moods out of genres in case ".tag" matches both.
  const genreTags = collectTags(".tag, .genre-tag, a[href*='/genres/']").filter(
    (t) => !moodTags.includes(t)
  );

  // ---- Page count ---------------------------------------------------------
  const pageMatch = clean($pane.text()).match(/(\d{1,5})\s*pages?\b/i);
  const pageCount = pageMatch ? parseInt(pageMatch[1], 10) : undefined;

  return { id, title, author, cover, dateRead, rating, genreTags, moodTags, pageCount };
}
