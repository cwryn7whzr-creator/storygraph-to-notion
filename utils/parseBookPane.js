const BASE_URL = "https://app.thestorygraph.com";

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const clean = (value) => (value || "").replace(/\s+/g, " ").trim();

const nodeText = (node) => {
  if (!node) return "";
  if (node.type === "text") return node.data || "";
  return (node.children || []).map(nodeText).join("");
};

const toIsoDate = (year, month, day) => {
  if (
    year < 1900 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(
    2,
    "0"
  )}`;
};

const monthNumber = (word) =>
  MONTHS[word.slice(0, 3).toLowerCase()];

const parseDate = (text) => {
  if (!text) return undefined;

  const iso = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);

  if (iso) {
    return toIsoDate(+iso[1], +iso[2], +iso[3]);
  }

  for (const match of text.matchAll(
    /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g
  )) {
    const month = monthNumber(match[1]);

    if (month) {
      return toIsoDate(+match[3], month, +match[2]);
    }
  }

  for (const match of text.matchAll(
    /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/g
  )) {
    const month = monthNumber(match[2]);

    if (month) {
      return toIsoDate(+match[3], month, +match[1]);
    }
  }

  for (const match of text.matchAll(
    /([A-Za-z]{3,9})\.?,?\s+(\d{4})/g
  )) {
    const month = monthNumber(match[1]);

    if (month) {
      return toIsoDate(+match[2], month, 1);
    }
  }

  return undefined;
};

const formatUrl = (rawUrl) => {
  if (!rawUrl) return undefined;

  let url = rawUrl.trim();

  if (!url || url.startsWith("data:")) {
    return undefined;
  }

  if (url.startsWith("//")) {
    url = `https:${url}`;
  } else if (!/^https?:\/\//i.test(url)) {
    url = `${BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  url = url.replace(/ /g, "%20");

  return url.length < 2000 ? url : undefined;
};

const NOT_A_COVER = /avatar|icon|logo|sprite|placeholder|spinner/i;

export default function parseBookPane($pane) {
  // StoryGraph book ID and direct book page URL.
  const rawBookLink =
    $pane.find("a[href*='/books/']").first().attr("href") || "";

  const bookUrl = formatUrl(rawBookLink);

  const idMatch = rawBookLink.match(/\/books\/([a-zA-Z0-9-]+)/);
  const id = idMatch ? idMatch[1] : undefined;

  // Title
  let title = clean(
    $pane
      .find(".book-title-author-and-series a[href*='/books/']")
      .first()
      .text()
  );

  if (!title) {
    title =
      $pane
        .find("a[href*='/books/']")
        .toArray()
        .map((element) => clean(nodeText(element)))
        .find((text) => text && text.length < 300) || "";
  }

  if (!title) {
    title = clean($pane.find(".title").first().text());
  }

  if (!title) {
    title = "Untitled Book";
  }

  // Author(s)
  const authors = [
    ...new Set(
      $pane
        .find("a[href*='/authors/']")
        .toArray()
        .map((element) => clean(nodeText(element)))
        .filter(Boolean)
    ),
  ];

  const author = authors.length
    ? authors.join(", ")
    : clean($pane.find(".author").first().text()) || "Unknown Author";

  // Cover
  const imageCandidates = $pane
    .find("img")
    .toArray()
    .map((element) => {
      const attrs = element.attribs || {};
      const srcset = attrs.srcset || attrs["data-srcset"];

      const fromSrcset = srcset
        ? srcset.split(/,\s+/).pop().trim().split(/\s+/)[0]
        : undefined;

      const raw =
        attrs["data-src"] ||
        attrs["data-lazy-src"] ||
        attrs["data-original"] ||
        fromSrcset ||
        attrs.src ||
        "";

      return {
        raw: raw.trim(),
        cls: attrs.class || "",
      };
    })
    .filter(
      (candidate) =>
        candidate.raw &&
        !candidate.raw.startsWith("data:") &&
        !/\.svg(\?|$)/i.test(candidate.raw) &&
        !NOT_A_COVER.test(candidate.raw)
    );

  const chosenImage =
    imageCandidates.find((candidate) => /cover/i.test(candidate.cls)) ||
    imageCandidates[0];

  const cover = formatUrl(chosenImage?.raw);

  // Date read
  let rawDateText = clean(
    $pane
      .find(".read-date, .date-read, p.read-date-text")
      .first()
      .text()
  );

  if (!parseDate(rawDateText)) {
    rawDateText =
      $pane
        .find("p, span")
        .toArray()
        .map((element) => clean(nodeText(element)))
        .find(
          (text) =>
            /^(Read|Finished)\b/i.test(text) && parseDate(text)
        ) || "";
  }

  const dateRead = parseDate(rawDateText);

  // Rating
  let rating = undefined;

  const ratingNode = $pane
    .find(".star-rating, .rating, [aria-label*='stars']")
    .first();

  const ratingText =
    ratingNode.attr("aria-label") ||
    clean(ratingNode.text()) ||
    "";

  const ratingMatch = ratingText.match(
    /(\d+(?:\.\d+)?)\s*(?:out of 5|stars)?/i
  );

  if (ratingMatch) {
    const number = parseFloat(ratingMatch[1]);

    if (number > 0 && number <= 5) {
      rating = number;
    }
  }

  // Existing list-card tags, if StoryGraph happens to expose any.
  // Stats-page enrichment adds the normal genres/moods later.
  const collectTags = (selector) => {
    const tags = [];

    $pane
      .find(selector)
      .toArray()
      .forEach((element) => {
        const tag = clean(nodeText(element)).replace(/,/g, "");

        if (tag && tag.length < 50 && !tags.includes(tag)) {
          tags.push(tag);
        }
      });

    return tags;
  };

  const moodTags = collectTags(".mood-tag, a[href*='/moods/']");

  const genreTags = collectTags(
    ".tag, .genre-tag, a[href*='/genres/']"
  ).filter((tag) => !moodTags.includes(tag));

  // Page count
  const pageMatch = clean($pane.text()).match(
    /(\d{1,5})\s*pages?\b/i
  );

  const pageCount = pageMatch
    ? parseInt(pageMatch[1], 10)
    : undefined;

  return {
    id,
    bookUrl,
    title,
    author,
    cover,
    dateRead,
    rating,
    genreTags,
    moodTags,
    pageCount,
  };
}
