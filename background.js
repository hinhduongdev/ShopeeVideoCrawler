// Service worker: monitors CSV downloads, extracts videos from product pages, saves to ShopeeAffiliateVideo/

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CSV_MONITORING') {
    startCSVMonitoring(message.tabId);
    sendResponse({ ok: true });
  }
  return false;
});

// ===== CSV DOWNLOAD MONITORING =====

function startCSVMonitoring(tabId) {
  console.log('[Background] CSV download monitoring started');

  const handler = (downloadItem) => {
    if (!downloadItem?.id) return;

    console.log('[Background] Download detected:', downloadItem.url?.substring(0, 120));

    // Remove listener immediately to avoid double-processing
    chrome.downloads.onCreated.removeListener(handler);
    clearTimeout(timeoutId);

    handleCSVDownload(downloadItem, tabId);
  };

  chrome.downloads.onCreated.addListener(handler);

  // Auto-remove after 30s
  const timeoutId = setTimeout(() => {
    chrome.downloads.onCreated.removeListener(handler);
    console.log('[Background] CSV monitoring timed out after 30s');
    chrome.runtime.sendMessage({
      type: 'CRAWL_COMPLETE', totalProducts: 0, totalVideos: 0,
    }).catch(() => {});
  }, 30000);
}

async function handleCSVDownload(downloadItem, tabId) {
  const url = downloadItem.url;
  const downloadId = downloadItem.id;
  let csvText = null;

  // Method 1: Blob URL — must read from page's MAIN world context (blob is page-scoped)
  if (!csvText && url.startsWith('blob:')) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (blobUrl) => fetch(blobUrl).then(r => r.text()),
        args: [url],
      });
      csvText = results?.[0]?.result;
      console.log('[Background] CSV read from blob URL via page context');
    } catch (e) {
      console.log('[Background] Blob fetch from page failed:', e.message);
    }
  }

  // Method 2: Data URL — decode directly
  if (!csvText && url.startsWith('data:')) {
    try {
      const resp = await fetch(url);
      csvText = await resp.text();
      console.log('[Background] CSV read from data URL');
    } catch (e) {
      console.log('[Background] Data URL decode failed:', e.message);
    }
  }

  // Method 3: Wait for download to complete, then read the saved file
  if (!csvText) {
    try {
      const filePath = await waitForDownloadComplete(downloadId);
      if (filePath) {
        // Read the file via fetch on a file:// URL — not possible in MV3
        // Instead, use XMLHttpRequest or re-fetch the original HTTP URL with cookies
        if (url.startsWith('http')) {
          const resp = await fetch(url);
          if (resp.ok) {
            csvText = await resp.text();
            console.log('[Background] CSV read via HTTP re-fetch');
          }
        }
      }
    } catch (e) {
      console.log('[Background] Download wait/read failed:', e.message);
    }
  }

  // Validate CSV content
  if (!csvText || (!csvText.includes('Link sản phẩm') && !csvText.includes('Tên sản phẩm'))) {
    console.log('[Background] Downloaded content is not the expected CSV. Content preview:',
      csvText ? csvText.substring(0, 200) : '(empty)');
    // Re-start monitoring for the real CSV download
    console.log('[Background] Re-starting CSV monitoring...');
    startCSVMonitoring(tabId);
    return;
  }

  // Parse CSV
  const products = parseCSVToProducts(csvText);
  if (products.length === 0) {
    console.log('[Background] No products found in CSV.');
    chrome.runtime.sendMessage({
      type: 'CRAWL_COMPLETE', totalProducts: 0, totalVideos: 0,
    }).catch(() => {});
    return;
  }

  console.log(`[Background] CSV parsed: ${products.length} products found. Starting video extraction...`);
  chrome.runtime.sendMessage({
    type: 'CSV_PARSED', count: products.length,
  }).catch(() => {});

  processProducts(products);
}

function waitForDownloadComplete(downloadId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(null);
    }, 15000);

    function listener(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        clearTimeout(timeout);
        chrome.downloads.search({ id: downloadId }, (items) => {
          resolve(items?.[0]?.filename || null);
        });
      }
      if (delta.state && delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        clearTimeout(timeout);
        resolve(null);
      }
    }

    chrome.downloads.onChanged.addListener(listener);
  });
}

// ===== CSV PARSER =====

function parseCSVToProducts(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let i = 0;
  while (i < text.length) {
    const row = [];
    while (i < text.length) {
      if (text[i] === '"') {
        i++;
        let field = '';
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else { i++; break; }
          } else { field += text[i]; i++; }
        }
        row.push(field);
      } else {
        let field = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i]; i++;
        }
        row.push(field);
      }
      if (i < text.length && text[i] === ',') { i++; } else { break; }
    }
    while (i < text.length && (text[i] === '\n' || text[i] === '\r')) { i++; }
    if (row.length > 1) rows.push(row);
  }

  if (rows.length < 2) return [];

  const header = rows[0];
  const nameIdx = header.findIndex(h => h.includes('Tên sản phẩm'));
  const linkIdx = header.findIndex(h => h.includes('Link sản phẩm'));
  const skuIdx  = header.findIndex(h => h.includes('Mã sản phẩm'));
  const priceIdx = header.findIndex(h => h.includes('Giá'));
  const affLinkIdx = header.findIndex(h => h.includes('Link ưu đãi'));

  if (nameIdx === -1 || linkIdx === -1) return [];

  return rows.slice(1)
    .filter(row => row[linkIdx] && row[linkIdx].startsWith('http'))
    .map(row => ({
      name: row[nameIdx] || '',
      link: row[linkIdx],
      sku:     skuIdx     !== -1 ? (row[skuIdx]     || '') : '',
      price:   priceIdx   !== -1 ? (row[priceIdx]   || '') : '',
      affLink: affLinkIdx !== -1 ? (row[affLinkIdx] || '') : '',
    }));
}

// ===== VEED.IO AUTO-UPLOAD =====

const VEED_PROJECT_ID = '7dfa6cf4-a77f-4b15-83b0-318af154183d';
const VEED_PROJECT_URL = `https://www.veed.io/edit/${VEED_PROJECT_ID}?source=Dashboard`;

// Upload a video to veed.io by opening the project tab and triggering file upload via the CDN URL
function uploadToVeed(videoUrl, productName) {
  return new Promise((resolve) => {
    console.log(`[Veed] Opening veed.io for: ${productName}`);

    chrome.tabs.create({ url: VEED_PROJECT_URL, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        console.error('[Veed] Could not open veed.io tab');
        resolve(false);
        return;
      }

      const tabId = tab.id;
      const timeout = setTimeout(() => {
        try { chrome.tabs.remove(tabId); } catch (e) {}
        console.warn('[Veed] Upload timed out for:', productName);
        resolve(false);
      }, 60000);

      function onLoaded(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onLoaded);

        // Wait for veed.io React app to mount
        setTimeout(async () => {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: async (cdnUrl, name) => {
                const log = (msg) => console.log('[Veed Inject]', msg);

                // Fetch the video from CDN as a Blob
                log('Fetching video from CDN: ' + cdnUrl.substring(0, 80));
                const resp = await fetch(cdnUrl);
                if (!resp.ok) throw new Error('CDN fetch failed: ' + resp.status);
                const blob = await resp.blob();
                const file = new File([blob], name + '.mp4', { type: 'video/mp4' });
                log('Blob ready, size: ' + blob.size);

                // Find the hidden file input veed.io uses
                const waitForEl = (selector, ms = 15000) => new Promise((res, rej) => {
                  const end = Date.now() + ms;
                  const t = setInterval(() => {
                    const el = document.querySelector(selector);
                    if (el) { clearInterval(t); res(el); }
                    if (Date.now() > end) { clearInterval(t); rej(new Error('Timeout: ' + selector)); }
                  }, 400);
                });

                // Veed.io uses an <input type="file"> that may be hidden
                let fileInput = document.querySelector('input[type="file"][accept*="video"]')
                  || document.querySelector('input[type="file"]');

                if (!fileInput) {
                  log('File input not found, waiting...');
                  fileInput = await waitForEl('input[type="file"]');
                }

                // Inject file via DataTransfer
                const dt = new DataTransfer();
                dt.items.add(file);
                Object.defineProperty(fileInput, 'files', { value: dt.files, configurable: true });
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                fileInput.dispatchEvent(new Event('input', { bubbles: true }));
                log('File dispatched to input: ' + file.name);
                return true;
              },
              args: [videoUrl, productName.replace(/[^a-zA-Z0-9\- ]/g, '').trim().substring(0, 60) || 'video'],
            });

            clearTimeout(timeout);
            const success = results?.[0]?.result === true;
            console.log(`[Veed] Upload triggered for "${productName}": ${success ? 'OK' : 'failed'}`);
            // Keep tab open so user can see / confirm the upload
            resolve(success);
          } catch (err) {
            clearTimeout(timeout);
            try { chrome.tabs.remove(tabId); } catch (e) {}
            console.error('[Veed] Upload script error:', err.message);
            resolve(false);
          }
        }, 5000); // 5s for veed.io to mount
      }

      chrome.tabs.onUpdated.addListener(onLoaded);
    });
  });
}

async function processProducts(products) {
  const results = [];
  const total = products.length;

  for (let i = 0; i < total; i++) {
    const product = products[i];
    console.log(`[Background] Processing ${i + 1}/${total}: ${product.name}`);

    // Broadcast progress (popup may or may not be listening)
    chrome.runtime.sendMessage({
      type: 'CRAWL_PROGRESS',
      current: i + 1,
      total,
      productName: product.name,
    }).catch(() => {});

    try {
      let videoUrl = await openAndExtractVideo(product.link);

      // Retry once if no video found on first attempt
      if (!videoUrl) {
        console.log(`[Background] Retrying ${product.name}...`);
        await new Promise(r => setTimeout(r, 2000));
        videoUrl = await openAndExtractVideo(product.link);
      }

      if (videoUrl) {
        results.push({
          productName: product.name,
          sku: product.sku,
          price: product.price,
          affLink: product.affLink,
          videoUrl: videoUrl,
        });

        // Download the video file
        const safeName = product.name
          .replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\- ]/g, '')
          .trim()
          .substring(0, 80) || 'video';
        const filename = `ShopeeAffiliateVideo/${safeName}_${i + 1}.mp4`;

        chrome.downloads.download({
          url: videoUrl,
          filename: filename,
          saveAs: false,
          conflictAction: 'uniquify',
        });
        console.log(`[Background] Downloaded video: ${filename}`);

        // Upload to veed.io
        //await uploadToVeed(videoUrl, product.name);
        // Space out veed.io tab openings
        //await new Promise(r => setTimeout(r, 2000));
      } else {
        console.log(`[Background] No video found for: ${product.name}`);
      }
    } catch (err) {
      console.error(`[Background] Error processing ${product.name}:`, err.message);
    }

    // Delay between products to avoid rate-limiting
    if (i < total - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Save JSON with results
  if (results.length > 0) {
    const jsonContent = JSON.stringify(results, null, 2);
    const dataUrl = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(jsonContent)));
    chrome.downloads.download({
      url: dataUrl,
      filename: `ShopeeAffiliateVideo/shopee_videos_${Date.now()}.json`,
      saveAs: false,
    });
  }

  // Notify completion
  chrome.runtime.sendMessage({
    type: 'CRAWL_COMPLETE',
    totalProducts: total,
    totalVideos: results.length,
  }).catch(() => {});

  console.log(`[Background] Done. ${results.length}/${total} videos downloaded.`);
}

// Open product page directly (shopee.vn), click thumbnail, extract ONE video
function openAndExtractVideo(productUrl) {
  return new Promise((resolve) => {
    let resolved = false;

    chrome.tabs.create({ url: productUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }

      const tabId = tab.id;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { chrome.tabs.remove(tabId); } catch (e) {}
          resolve(null);
        }
      }, 30000);

      function onLoaded(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onLoaded);

        // Wait for SPA to render, then click thumbnail + extract video
        setTimeout(async () => {
          if (resolved) return;

          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId },
              func: extractFirstVideoFromPage,
            });

            clearTimeout(timeout);
            resolved = true;
            chrome.tabs.remove(tabId);

            const videoUrl = results?.[0]?.result || null;
            resolve(videoUrl);
          } catch (err) {
            clearTimeout(timeout);
            resolved = true;
            try { chrome.tabs.remove(tabId); } catch (e) {}
            resolve(null);
          }
        }, 5000); // 5s for SPA render
      }

      chrome.tabs.onUpdated.addListener(onLoaded);
    });
  });
}

// Injected into the Shopee product page — clicks thumbnail and extracts ONE video URL
async function extractFirstVideoFromPage() {
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
    document.querySelectorAll('script').forEach(script => {
      const text = script.textContent || '';
      if (text.length < 50) return;
      for (const pattern of patterns) {
        (text.match(pattern) || []).forEach(url => {
          const clean = url.replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/["',;}\])+]+$/, '');
          if (clean.length > 15) allUrls.add(clean);
        });
      }
    });

    // Scan HTML
    const htmlPattern = /https?:\/\/[^\s"'<>]*susercontent\.com[^\s"'<>]*\.mp4[^\s"'<>]*/gi;
    (document.documentElement.innerHTML.match(htmlPattern) || []).forEach(url => {
      const clean = url.replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/["',;}\])+]+$/, '');
      if (clean.length > 15) allUrls.add(clean);
    });

    // Scan global state objects
    try {
      const globals = [window.__INITIAL_STATE__, window.__NEXT_DATA__, window.__rawData__, window.pageData];
      for (const obj of globals) {
        if (!obj) continue;
        const str = JSON.stringify(obj);
        (str.match(/https?:\/\/[^\s"\\]*\.mp4[^\s"\\]*/gi) || []).forEach(url => {
          const clean = url.replace(/\\/g, '');
          if (clean.length > 15) allUrls.add(clean);
        });
      }
    } catch (e) {}

    return allUrls.size > 0 ? [...allUrls][0] : null;
  }

  // ── Step 1: Fast path — scan page source before any click ─────────────────
  // Some products embed the video URL directly in the page state
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
    // Generic: any play-button-like element inside a video wrapper
    '[class*="play-btn"]',
    '[class*="playBtn"]',
    '[class*="PlayButton"]',
    // First item in image gallery that might be a video slot
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
        || videoElement.querySelector('source')?.src;
      if (src && !src.startsWith('blob:')) {
        console.log('[Crawler] Video element found with src:', src.substring(0, 80));
        return src;
      }
      // blob: URL — video has started loading; scan source immediately
      if (src && src.startsWith('blob:')) {
        console.log('[Crawler] Video is blob, scanning page for direct URL...');
        // Give HLS/dash player a moment to load JSON config into DOM
        await wait(1000);
        const scanned = scanPageForVideoUrl();
        if (scanned) return scanned;
        break; // stop waiting for video element
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
}