// Injected into the Shopee product page via chrome.scripting.executeScript({ files: ['extractor.js'] })
// Must be self-contained — no references to background.js scope after obfuscation.
(async function extractFirstVideoFromPage() {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));

  // ── Helper: scan scripts + HTML + global state for .mp4 URLs ──────────────
  function scanPageForVideoUrl() {
    const allUrls = new Set();

    const patterns = [
      /https?:\/\/[^\s"'\\]*\.vod\.susercontent\.com\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
      /https?:\/\/[^\s"'\\]*\.img\.susercontent\.com\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
      /https?:\/\/[^\s"'\\]*susercontent\.com\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
      /https?:\/\/cv\.shopee\.vn\/file\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
      /https?:\/\/[^\s"'\\]+\/mms\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
    ];

    // Scan <script> tags
    document.querySelectorAll('script').forEach(function (script) {
      const text = script.textContent || '';
      if (text.length < 50) return;
      for (const pattern of patterns) {
        (text.match(pattern) || []).forEach(function (url) {
          const clean = url.replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/["',;}\])+]+$/, '');
          if (clean.length > 15) allUrls.add(clean);
        });
      }
    });

    // Scan HTML
    const htmlPattern = /https?:\/\/[^\s"'<>]*susercontent\.com[^\s"'<>]*\.mp4[^\s"'<>]*/gi;
    (document.documentElement.innerHTML.match(htmlPattern) || []).forEach(function (url) {
      const clean = url.replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/["',;}\])+]+$/, '');
      if (clean.length > 15) allUrls.add(clean);
    });

    // Scan global state objects
    try {
      const globals = [window.__INITIAL_STATE__, window.__NEXT_DATA__, window.__rawData__, window.pageData];
      for (const obj of globals) {
        if (!obj) continue;
        const str = JSON.stringify(obj);
        (str.match(/https?:\/\/[^\s"\\]*\.mp4[^\s"\\]*/gi) || []).forEach(function (url) {
          const clean = url.replace(/\\/g, '');
          if (clean.length > 15) allUrls.add(clean);
        });
      }
    } catch (e) {}

    return allUrls.size > 0 ? [...allUrls][0] : null;
  }

  // ── Step 1: Fast path — scan page source before any click ─────────────────
  const fastUrl = scanPageForVideoUrl();
  if (fastUrl) {
    console.log('[Crawler] Found video URL via fast scan (no click needed):', fastUrl.substring(0, 80));
    return fastUrl;
  }

  // ── Step 2: Scroll to bring the product gallery into view ─────────────────
  const gallery = document.querySelector(
    '[class*="product-image"], [class*="ProductImage"], [class*="gallery"], [class*="Gallery"]'
  );
  if (gallery) gallery.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await wait(500);

  // ── Step 3: Click the video thumbnail ─────────────────────────────────────
  const videoSelectors = [
    'div._jA1mTx',
    'div.VfAyB',
    '.product-video__play-button',
    'div[data-test-id="video-thumbnail"]',
    '[class*="video"][class*="thumbnail"]',
    '[class*="VideoThumbnail"]',
    '[class*="video-thumb"]',
    '[class*="video"] [class*="play"]',
    '[class*="video-thumbnail"]',
    '[class*="play-btn"]',
    '[class*="playBtn"]',
    '[class*="PlayButton"]',
    '.product-detail__images li:first-child',
    '[class*="image-slot"]:first-child',
  ];

  let clicked = false;
  for (const selector of videoSelectors) {
    const btn = document.querySelector(selector);
    if (btn) {
      console.log('[Crawler] Clicking thumbnail via:', selector);
      btn.click();
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    console.log('[Crawler] No thumbnail selector matched, trying first gallery item...');
    const firstThumb = document.querySelector(
      '[class*="gallery"] li, [class*="gallery"] [class*="item"], [class*="thumbnail"]:first-child'
    );
    if (firstThumb) { firstThumb.click(); clicked = true; }
  }

  // ── Step 4: Wait for <video> element (up to 10 seconds, check every 500ms) ─
  let videoElement = null;
  for (let i = 0; i < 20; i++) {
    await wait(500);
    videoElement = document.querySelector('video');
    if (videoElement) {
      const src = videoElement.src || videoElement.currentSrc
        || (videoElement.querySelector('source') && videoElement.querySelector('source').src);
      if (src && !src.startsWith('blob:')) {
        console.log('[Crawler] Video element found with src:', src.substring(0, 80));
        return src;
      }
      if (src && src.startsWith('blob:')) {
        console.log('[Crawler] Video is blob, scanning page for direct URL...');
        await wait(1000);
        const scanned = scanPageForVideoUrl();
        if (scanned) return scanned;
        break;
      }
    }
  }

  // ── Step 5: Final scan after thumbnail interaction ─────────────────────────
  const finalUrl = scanPageForVideoUrl();
  if (finalUrl) {
    console.log('[Crawler] Video URL found via final scan:', finalUrl.substring(0, 80));
    return finalUrl;
  }

  // ── Step 6: Check <source> tags inside <video> ────────────────────────────
  if (videoElement) {
    for (const src of videoElement.querySelectorAll('source')) {
      if (src.src && !src.src.startsWith('blob:')) return src.src;
    }
  }

  console.log('[Crawler] No video URL found for this product.');
  return null;
})();
