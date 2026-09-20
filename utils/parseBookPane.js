import * as cheerio from "cheerio";

export default function parseBookPane($pane) {
  const BASE_URL = "https://app.thestorygraph.com";

  // Helper to construct valid absolute URLs
  const formatUrl = (rawUrl) => {
    if (!rawUrl) return undefined;
    if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
      return rawUrl;
    }
    return `${BASE_URL}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
  };

  // Extract book ID from href
  const rawBookLink = $pane.find("a[href*='/books/']").first().attr("href") || "";
  const idMatch = rawBookLink.match(/\/books\/([a-zA-Z0-9-]+)/);
  const id = idMatch ? idMatch[1] : undefined;

  // Extract Title
  const title =
    $pane.find(".book-title-author-and-series a").first().text().trim() ||
    $pane.find("a[href*='/books/']").first().text().trim() ||
    $pane.find(".title").text().trim() ||
    "Untitled Book";

  // Extract Author
  const author =
    $pane.find("a[href*='/authors/']").first().text().trim() ||
    $pane.find(".author").text().trim() ||
    "Unknown Author";

  // Extract Cover Image URL
  const rawCover =
    $pane.find("img.book-cover").attr("src") ||
    $pane.find("img").attr("src") ||
    "";
  const cover = formatUrl(rawCover);

  // Extract Read Date
  let dateRead = undefined;
  const dateElement = $pane.find(".read-date, .date-read, p.read-date-text").first();
  let rawDateText = "";

  if (dateElement.length) {
    rawDateText = dateElement.text().trim();
  } else {
    $pane.find("p").each((_, el) => {
      const text = cheerio.load(el).root().text().trim();
      if (/^(Read|Finished)/i.test(text)) {
        rawDateText = text;
        return false; // Exit loop on first match
      }
    });
  }

  if (rawDateText) {
    const cleanDate = rawDateText.replace(/Read|Finished|in/gi, "").trim();
    const parsedDate = new Date(cleanDate);
    if (!isNaN(parsedDate.getTime())) {
      dateRead = parsedDate.toISOString().split("T")[0];
    }
  }

  // Extract Rating
  let rating = undefined;
  const ratingNode = $pane.find(".star-rating, .rating, [aria-label*='stars']").first();
  const ratingText = ratingNode.attr("aria-label") || ratingNode.text().trim() || "";
  const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)\s*(?:out of 5|stars)?/i);
  if (ratingMatch) {
    const num = parseFloat(ratingMatch[1]);
    if (num <= 5) rating = num;
  }

  // Extract Genres
  const genreTags = [];
  $pane.find(".tag, .genre-tag, a[href*='/genres/']").each((_, el) => {
    const tag = cheerio.load(el).root().text().trim().replace(/,/g, "");
    if (tag && !genreTags.includes(tag) && tag.length < 50) {
      genreTags.push(tag);
    }
  });

  // Extract Moods
  const moodTags = [];
  $pane.find(".mood-tag, a[href*='/moods/']").each((_, el) => {
    const mood = cheerio.load(el).root().text().trim().replace(/,/g, "");
    if (mood && !moodTags.includes(mood) && mood.length < 50) {
      moodTags.push(mood);
    }
  });

  // Extract Page Count
  let pageCount = undefined;
  $pane.find("p, span").each((_, el) => {
    const txt = cheerio.load(el).root().text().trim();
    const match = txt.match(/^(\d{1,5})\s*pages$/i);
    if (match) {
      pageCount = parseInt(match[1], 10);
    }
  });

  return { id, title, author, cover, dateRead, rating, genreTags, moodTags, pageCount };
}
