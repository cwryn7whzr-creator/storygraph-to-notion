export default function parseBookPane($pane) {
  // Extract book ID from href (e.g. /books/12345)
  const bookLink = $pane.find("a[href*='/books/']").first().attr("href") || "";
  const idMatch = bookLink.match(/\/books\/([a-zA-Z0-9-]+)/);
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
  const cover =
    $pane.find("img.book-cover").attr("src") ||
    $pane.find("img").attr("src") ||
    "";

  // Extract Read Date (e.g., "Read Dec 15, 2023" or "Finished Oct 2024")
  let dateRead = undefined;
  const rawDateText = $pane
    .find(".read-date, .date-read, p:contains('Read'), p:contains('Finished')")
    .text()
    .trim();
  if (rawDateText) {
    const parsedDate = new Date(
      rawDateText.replace(/Read|Finished/gi, "").trim()
    );
    if (!isNaN(parsedDate.getTime())) {
      dateRead = parsedDate.toISOString().split("T")[0]; // "YYYY-MM-DD"
    }
  }

  // Extract Rating (e.g., "4.5 stars" or "5/5")
  let rating = undefined;
  const ratingText =
    $pane.find(".star-rating, .rating, [aria-label*='stars']").text().trim() ||
    $pane.find("[aria-label*='stars']").attr("aria-label") ||
    "";
  const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)/);
  if (ratingMatch) {
    rating = parseFloat(ratingMatch[1]);
  }

  // Extract Genres
  const genreTags = [];
  $pane.find(".tag, .genre-tag, a[href*='/genres/']").each((_, el) => {
    const tag = $pane(el).text().trim();
    if (tag && !genreTags.includes(tag)) {
      genreTags.push(tag);
    }
  });

  // Extract Moods
  const moodTags = [];
  $pane.find(".mood-tag").each((_, el) => {
    const mood = $pane(el).text().trim();
    if (mood && !moodTags.includes(mood)) {
      moodTags.push(mood);
    }
  });

  // Extract Page Count
  let pageCount = undefined;
  const pageText = $pane.find("p:contains('pages')").text().trim();
  const pageMatch = pageText.match(/(\d+)\s*pages/i);
  if (pageMatch) {
    pageCount = parseInt(pageMatch[1], 10);
  }

  return { id, title, author, cover, dateRead, rating, genreTags, moodTags, pageCount };
}
