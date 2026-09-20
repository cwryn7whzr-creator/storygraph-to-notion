let hasNextPage = true;
    let pageCount = 1;

    while (hasNextPage && allBookPanes.length < limit) {
      // 1. If we are beyond page 1, navigate directly to the page URL
      if (pageCount > 1) {
        const pageUrl = `${url}?page=${pageCount}`;
        console.log(`[SCRAPER] Navigating to Page ${pageCount}: ${pageUrl}...`);
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
        await page.waitForTimeout(2000);
      }

      // 2. Incremental smooth scroll to force lazy-loaded images to hydrate
      await page.evaluate(async () => {
        for (let i = 0; i < document.body.scrollHeight; i += 300) {
          window.scrollTo(0, i);
          await new Promise((res) => setTimeout(res, 50));
        }
      });
      await page.waitForTimeout(1000);

      // 3. Extract book cards on current page
      const cardSelector = target === "currently-reading"
        ? ".currently-reading-cover-wrapper, .currently-reading-title-author, div:has(> a[href*='/books/'])"
        : ".book-pane, .search-results-item, .book-pane-wrapper, .book-title-author-and-series";

      await page.waitForSelector(cardSelector, { timeout: 10000 }).catch(() => {});

      const paneHtmls = await page.$$eval(cardSelector, (elements, tgt) =>
        elements
          .map((el) => {
            let card;
            if (tgt === "currently-reading") {
              card = el.closest(".currently-reading-cover-wrapper") || 
                     el.closest(".currently-reading-title-author") || 
                     el.closest(".flex-col") || 
                     el;
            } else {
              card = el.closest(".book-pane") ||
                     el.closest(".search-results-item") ||
                     el.closest(".book-pane-wrapper") ||
                     el;
            }
            return card ? card.outerHTML : "";
          })
          .filter(Boolean),
        target
      );

      const uniquePanes = [...new Set(paneHtmls)].filter(Boolean);
      console.log(`[SCRAPER] Page ${pageCount}: Found ${uniquePanes.length} books in ${target}.`);

      // If no cards found on this page, we've reached the end
      if (uniquePanes.length === 0) {
        console.log(`[SCRAPER] No more books found. Finished scraping ${target}.`);
        hasNextPage = false;
        break;
      }

      for (const html of uniquePanes) {
        if (allBookPanes.length < limit) {
          const $ = cheerio.load(html);
          allBookPanes.push($.root());
        }
      }

      // Profile page (currently-reading) only has 1 page
      if (target === "currently-reading") {
        hasNextPage = false;
        break;
      }

      // 4. Check if a 'Next' link exists in the DOM to know if another page exists
      const hasNextLink = await page.evaluate(() => {
        const nextEl = document.querySelector(".pagination .next a, a[rel='next'], a.next_page, .pagination a:has-text('Next')");
        if (!nextEl) return false;
        return !nextEl.classList.contains("disabled") && nextEl.getAttribute("aria-disabled") !== "true";
      });

      if (hasNextLink && allBookPanes.length < limit) {
        pageCount++;
      } else {
        console.log(`[SCRAPER] Reached last page (${pageCount}) for ${target}.`);
        hasNextPage = false;
      }
    }
