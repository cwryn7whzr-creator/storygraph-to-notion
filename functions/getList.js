import * as cheerio from "cheerio";

export default function parseBookPane($pane) {
  const BASE_URL = "https://app.thestorygraph.com";

  const formatUrl = (rawUrl) => {
    if (!rawUrl || rawUrl.startsWith("data:image")) return undefined;
    
    // Clean potential srcset descriptors like "https://... 2x" or ", https://..."
    let cleanUrl = rawUrl.trim().split(",")[0].split(" ")[0];
    
    if (cleanUrl.startsWith("http://") || cleanUrl.startsWith("https://")) {
      return cleanUrl;
    }
    return `${BASE_URL}${cleanUrl.startsWith("/") ? "" : "/"}${cleanUrl}`;
  };

  const rawBookLink = $pane.find("a[href*='/books/']").first().attr("href") || "";
  const idMatch = rawBookLink.match(/\/books\/([a-zA-Z0-9-]+)/);
  const id = idMatch ? idMatch[1] : undefined;

  const title =
    $pane.find(".book-title-author-and-series a").first().text().trim() ||
    $pane.find("a[href*='/books/']").first().text().trim() ||
    $pane.find(".title").text().trim() ||
    "Untitled Book";

  const author =
    $pane.find("a[href*='/authors/']").first().text().trim() ||
    $pane.find(".author").text().trim() ||
    "Unknown Author";

  // ENHANCED COVER PICKER
  const imgNode = $pane.find("img.book-cover, img[src*='amazon'], img[data-src], img").first();
  const rawCover =
    imgNode.attr("data-src") ||
    imgNode.attr("data-lazy-src") ||
    imgNode.attr("srcset") ||
    imgNode.attr("src") ||
    "";
  
  const cover = formatUrl(rawCover);

  let dateRead = undefined;
  const dateElement = $pane.find(".read-date, .date-read, p.read-date-text").first();
  let rawDateText = "";

  if (dateElement.length) {
    rawDateText = dateElement.text().trim();
  } else {
    // Optimized: Use $(el) instead of cheerio.load(el)$pane.find("p, span").each((_, el) => {
      const text = $pane.find(el).text().trim();
      if (/^(Read|Finished)/i.test(text)) {
        rawDateText = text;
        return false; // Break loop
      }
    });
  }

  if (rawDateText) {
    // Fix: Use word boundaries so "January" isn't modified to "Ja uary"
    const cleanDate = rawDateText.replace(/\b(Read|Finished|in)\b/gi, "").trim();
    const parsedDate = new Date(cleanDate);
    if (!isNaN(parsedDate.getTime())) {
      dateRead = parsedDate.toISOString().split("T")[0];
    }
  }

  let rating = undefined;
  const ratingNode = $pane.find(".star-rating, .rating, [aria-label*='stars']").first();
  const ratingText = ratingNode.attr("aria-label") || ratingNode.text().trim() || "";
  const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)\s*(?:out of 5|stars)?/i);
  if (ratingMatch) {
    const num = parseFloat(ratingMatch[1]);
    if (num <= 5) rating = num;
  }

  // Common StoryGraph UI noise to ignore
  const UI_BLACKLIST = ["edit", "filter", "add to list", "view all", "remove"];

  const genreTags = [];
  $pane.find(".tag, .genre-tag, a[href*='/genres/']").each((_, el) => {
    const tag = $pane.find(el).text().trim().replace(/,/g, "");
    const lowerTag = tag.toLowerCase();
    
    if (
      tag &&
      !genreTags.includes(tag) &&
      tag.length < 50 &&
      !UI_BLACKLIST.includes(lowerTag)
    ) {
      genreTags.push(tag);
    }
  });

  const moodTags = [];
  $pane.find(".mood-tag, a[href*='/moods/']").each((_, el) => {
    const mood = $pane.find(el).text().trim().replace(/,/g, "");
    if (mood && !moodTags.includes(mood) && mood.length < 50) {
      moodTags.push(mood);
    }
  });

  let pageCount = undefined;
  $pane.find("p, span, div").each((_, el) => {
    const txt = $pane.find(el).text().trim();
    const match = txt.match(/(\d{1,5})\s*pages?/i);
    if (match) {
      pageCount = parseInt(match[1], 10);
      return false; // Break loop
    }
  });

  return { id, title, author, cover, dateRead, rating, genreTags, moodTags, pageCount };
}
