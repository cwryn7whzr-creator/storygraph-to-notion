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

  return { id, title, author, cover };
}
