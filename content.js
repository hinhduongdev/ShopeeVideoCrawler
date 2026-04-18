(async () => {
  const MODE = window.__CRAWL_MODE__ || 'all';
  console.log(`[Shopee Crawler] Starting in mode: ${MODE}`);

  const wait = (ms) => new Promise(res => setTimeout(res, ms));

  // --- Utility: scroll to bottom to load all items ---
  async function scrollToLoadAll() {
    const scrollTarget = document.documentElement;
    let prevHeight = 0;
    let retries = 0;

    while (retries < 15) {
      const currentHeight = scrollTarget.scrollHeight;
      scrollTarget.scrollTo({ top: currentHeight, behavior: 'smooth' });
      await wait(1500);

      if (currentHeight === prevHeight) {
        retries++;
      } else {
        retries = 0;
      }
      prevHeight = currentHeight;
    }

    scrollTarget.scrollTo({ top: 0 });
    await wait(500);
    console.log("[Shopee Crawler] Finished scrolling to load all items.");
  }

  // --- Utility: download via background script using chrome.downloads API ---
  function triggerDownload(filename, content, mimeType) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_FILE',
        filename,
        content,
        mimeType,
      }, (response) => {
        if (response?.success) {
          console.log(`[Shopee Crawler] Downloaded ${filename}`);
        } else {
          console.error(`[Shopee Crawler] Download failed for ${filename}:`, response?.error);
        }
        resolve();
      });
    });
  }

  // --- Utility: download data as CSV ---
  async function downloadCSV(filename, headers, rows) {
    const BOM = '\uFEFF';
    const csvContent = BOM + [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    await triggerDownload(filename, csvContent, 'text/csv;charset=utf-8;');
    console.log(`[Shopee Crawler] Downloaded ${filename} with ${rows.length} rows.`);
  }

  // --- Utility: download data as JSON ---
  async function downloadJSON(filename, data) {
    const jsonContent = JSON.stringify(data, null, 2);
    await triggerDownload(filename, jsonContent, 'application/json;charset=utf-8;');
  }

  // --- Collect product links from the affiliate listing page ---
  async function collectProductLinks() {
    console.log("[Shopee Crawler] Scrolling to load all products...");
    await scrollToLoadAll();

    const products = [];

    // Collect all affiliate product links from the listing page
    // These are links to affiliate.shopee.vn product detail pages (NOT shopee.vn)
    // The a.view-product with real shopee.vn URLs only exists on each detail page
    const allLinks = document.querySelectorAll('a[href]');

    allLinks.forEach(a => {
      const href = a.href;
      // Match affiliate product detail links
      if (href.includes('affiliate.shopee.vn') && (href.includes('/offer/product') || href.includes('/product/'))) {
        const card = a.closest('tr, [class*="product"], [class*="offer"], [class*="item"], [class*="card"]') || a.parentElement;
        const nameEl = card?.querySelector('[class*="name"], [class*="title"], td:first-child') || a;
        const commissionEl = card?.querySelector('[class*="commission"], [class*="rate"], [class*="percent"]');
        const priceEl = card?.querySelector('[class*="price"]');

        products.push({
          name: (nameEl ? nameEl.textContent.trim() : '').substring(0, 200),
          link: href,
          commission: commissionEl ? commissionEl.textContent.trim() : '',
          price: priceEl ? priceEl.textContent.trim() : '',
        });
      }
    });

    // Fallback: try structured rows/cards
    if (products.length === 0) {
      const rows = document.querySelectorAll(
        'table tbody tr, .product-list .product-item, .offer-list-item, [class*="product-card"], [class*="OfferItem"], [class*="offer-item"]'
      );

      rows.forEach(row => {
        const linkEl = row.querySelector('a[href]');
        const nameEl = row.querySelector('[class*="name"], [class*="title"], td:first-child') || linkEl;
        const commissionEl = row.querySelector('[class*="commission"], [class*="rate"], [class*="percent"]');
        const priceEl = row.querySelector('[class*="price"]');

        if (linkEl && linkEl.href) {
          products.push({
            name: (nameEl ? nameEl.textContent.trim() : '').substring(0, 200),
            link: linkEl.href,
            commission: commissionEl ? commissionEl.textContent.trim() : '',
            price: priceEl ? priceEl.textContent.trim() : '',
          });
        }
      });
    }

    // Deduplicate by link
    const seen = new Set();
    const unique = products.filter(p => {
      if (seen.has(p.link)) return false;
      seen.add(p.link);
      return true;
    });

    console.log(`[Shopee Crawler] Collected ${unique.length} product links.`);
    return unique;
  }

  // ===== CRAWL PRODUCTS (download product list) =====
  async function crawlProducts() {
    const products = await collectProductLinks();

    if (products.length > 0) {
      await downloadCSV(
        `shopee_products_${Date.now()}.csv`,
        ['Name', 'Link', 'Commission', 'Price'],
        products.map(p => [p.name, p.link, p.commission, p.price || ''])
      );
      await downloadJSON(`shopee_products_${Date.now()}.json`, products);
    } else {
      alert("[Shopee Crawler] Không tìm thấy sản phẩm nào. Hãy chắc chắn bạn đang ở trang Product Offer.");
    }

    return products;
  }

  // ===== CRAWL VIDEOS (visit each product detail page) =====
  async function crawlVideos(productLinks) {
    // If no links passed, collect them from the current page
    if (!productLinks || productLinks.length === 0) {
      productLinks = await collectProductLinks();
    }

    if (productLinks.length === 0) {
      alert("Không tìm thấy link sản phẩm nào để crawl video.");
      return [];
    }

    console.log(`[Shopee Crawler] Sending ${productLinks.length} product links to background for video extraction...`);
    console.log("[Shopee Crawler] Each product page will be opened in a background tab. This may take a while...");

    return new Promise((resolve) => {
      const listener = async (message) => {
        if (message.type === 'CRAWL_PROGRESS') {
          console.log(`[Shopee Crawler] 🎬 Video extraction: ${message.current}/${message.total} — ${message.productName}`);
        }

        if (message.type === 'VIDEO_CRAWL_RESULTS') {
          chrome.runtime.onMessage.removeListener(listener);

          const videos = message.videos || [];
          console.log(`[Shopee Crawler] Video crawl complete! Found ${videos.length} videos across ${productLinks.length} products.`);

          if (videos.length > 0) {
            await downloadCSV(
              `shopee_videos_${Date.now()}.csv`,
              ['Product Name', 'Product Link', 'Video URL', 'Type'],
              videos.map(v => [v.productName || '', v.productLink || '', v.videoUrl, v.type])
            );
            await downloadJSON(`shopee_videos_${Date.now()}.json`, videos);
          } else {
            alert("Không tìm thấy video nào trong các trang sản phẩm.");
          }

          resolve(videos);
        }
      };

      chrome.runtime.onMessage.addListener(listener);

      chrome.runtime.sendMessage({
        type: 'CRAWL_VIDEOS_FROM_PRODUCTS',
        productLinks: productLinks,
      });
    });
  }

  // ===== MAIN =====
  try {
    let productResults = [];
    let videoResults = [];

    if (MODE === 'products') {
      productResults = await crawlProducts();
    }

    if (MODE === 'videos') {
      videoResults = await crawlVideos();
    }

    if (MODE === 'all') {
      // Crawl products first, then reuse the links for video extraction
      productResults = await crawlProducts();
      videoResults = await crawlVideos(productResults);
    }

    const total = (productResults?.length || 0) + (videoResults?.length || 0);
    console.log(`[Shopee Crawler] Done! Total items crawled: ${total}`);

    if (total > 0) {
      alert(`Crawl hoàn tất!\nSản phẩm: ${productResults?.length || 0}\nVideo: ${videoResults?.length || 0}\nFile CSV & JSON đã được tải xuống.`);
    }
  } catch (err) {
    console.error("[Shopee Crawler] Error:", err);
    alert("Có lỗi xảy ra: " + err.message);
  }
})();