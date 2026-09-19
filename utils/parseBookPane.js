export default function parseBookPane($pane) {
  // Extract title using multiple common StoryGraph selectors
  const title =
    $pane.find(".book-title-author-and-series a").first().text().trim() ||
    $pane.find("a[href*='/books/']").first().text().trim() ||
    $pane.find(".title").text().trim() ||
    "Untitled Book";

  // Extract author
  const author =
    $pane.find("a[href*='/authors/']").first().text().trim() ||
    $pane.find(".author").text().trim() ||
    "Unknown Author";

  // Extract cover image
  const cover =
    $pane.find("img.book-cover").attr("src") ||
    $pane.find("img").attr("src") ||
    "";

  return { title, author, cover };
}
