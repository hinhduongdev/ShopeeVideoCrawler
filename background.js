// Service worker: monitors CSV downloads, extracts videos from product pages, saves to ShopeeAffiliateVideo/

// ---- TRIAL EXPIRATION (remove this block before delivery) ----
const TRIAL_EXPIRES = new Date([50,48,50,54,45,48,52,45,50,48,84,50,48,58,53,57,58,53,57].map(x=>String.fromCharCode(x)).join(''));
// ---- END TRIAL EXPIRATION ----

// Multi-page crawl session state
let crawlSession = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CSV_MONITORING') {
    // ---- TRIAL EXPIRATION CHECK (remove before delivery) ----
    if (new Date() > TRIAL_EXPIRES) {
      sendResponse({ ok: false, expired: true });
      return true;
    }
    // ---- END TRIAL EXPIRATION CHECK ----
    crawlSession = {
      tabId: message.tabId,
      batchSize: message.batchSize || 5,
      maxPages: message.maxPages || 5,
      currentPage: 1,
      allResults: [],
      totalProductsProcessed: 0,
      totalVideosFound: 0,
      paused: false,
      stopped: false,
      resumeResolvers: [],
      lastStatus: 'Đang chọn sản phẩm & lấy link...',
      progress: null,  // { current, total }
    };
    chrome.action.setBadgeBackgroundColor({ color: '#ee4d2d' });
    chrome.action.setBadgeText({ text: '...' });
    startCSVMonitoring(message.tabId, message.batchSize || 5);
    sendResponse({ ok: true });
  }
  if (message.type === 'PAUSE_CRAWL') {
    if (crawlSession) {
      crawlSession.paused = true;
      crawlSession.lastStatus = `⏸ Tạm dừng tại: ${crawlSession.lastStatus}`;
      console.log('[Background] Crawl paused by user.');
    }
    sendResponse({ ok: true });
  }
  if (message.type === 'RESUME_CRAWL') {
    if (crawlSession) {
      crawlSession.paused = false;
      crawlSession.lastStatus = crawlSession.lastStatus.replace(/^⏸ Tạm dừng tại: /, '');
      console.log('[Background] Crawl resumed by user.');
      crawlSession.resumeResolvers.forEach(r => r());
      crawlSession.resumeResolvers = [];
    }
    sendResponse({ ok: true });
  }
  if (message.type === 'GET_CRAWL_STATUS') {
    sendResponse({
      active: crawlSession !== null && !crawlSession.stopped,
      paused: crawlSession?.paused || false,
      lastStatus: crawlSession?.lastStatus || '',
      progress: crawlSession?.progress || null,
      batchSize: crawlSession?.batchSize || null,
      maxPages: crawlSession?.maxPages || null,
    });
  }
  return false;
});

// ===== CSV DOWNLOAD MONITORING =====

// Wait while crawl is paused; resolves immediately if not paused
function waitIfPaused() {
  if (!crawlSession?.paused) return Promise.resolve();
  return new Promise(resolve => {
    crawlSession.resumeResolvers.push(resolve);
  });
}

function startCSVMonitoring(tabId, batchSize = 5) {
  console.log('[Background] CSV download monitoring started');

  const handler = (downloadItem) => {
    if (!downloadItem?.id) return;

    console.log('[Background] Download detected:', downloadItem.url?.substring(0, 120));

    // Remove listener immediately to avoid double-processing
    chrome.downloads.onCreated.removeListener(handler);
    clearTimeout(timeoutId);

    handleCSVDownload(downloadItem, tabId, batchSize);
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

async function handleCSVDownload(downloadItem, tabId, batchSize = 5) {
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
    startCSVMonitoring(tabId, crawlSession?.batchSize || batchSize);
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

  processProducts(products, batchSize);
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

async function processProducts(products, batchSize = 5) {
  const results = [];
  const total = products.length;
  let completed = 0;

  for (let batchStart = 0; batchStart < total; batchStart += batchSize) {
    if (crawlSession?.stopped) {
      console.log('[Background] Crawl stopped, aborting remaining batches.');
      break;
    }
    await waitIfPaused();
    if (crawlSession?.stopped) break;

    const batch = products.slice(batchStart, batchStart + batchSize);

    console.log(`[Background] Starting batch ${batchStart + 1}–${batchStart + batch.length} of ${total} (batchSize=${batchSize})`);

    await Promise.all(batch.map(async (product, batchIdx) => {
      const globalIdx = batchStart + batchIdx;
      console.log(`[Background] Processing ${globalIdx + 1}/${total}: ${product.name}`);

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
          const filename = `ShopeeAffiliateVideo/${safeName}_${globalIdx + 1}.mp4`;

          chrome.downloads.download({
            url: videoUrl,
            filename: filename,
            saveAs: false,
            conflictAction: 'uniquify',
          });
          console.log(`[Background] Downloaded video: ${filename}`);

          // Upload to veed.io
          //await uploadToVeed(videoUrl, product.name);
          //await new Promise(r => setTimeout(r, 2000));
        } else {
          console.log(`[Background] No video found for: ${product.name}`);
        }
      } catch (err) {
        console.error(`[Background] Error processing ${product.name}:`, err.message);
      }

      completed++;
      const pct = Math.round((completed / total) * 100);
      if (crawlSession) {
        crawlSession.lastStatus = `🎬 [Trang ${crawlSession.currentPage}] ${completed}/${total}: ${product.name}`;
        crawlSession.progress = { current: completed, total };
      }
      chrome.action.setBadgeText({ text: pct + '%' });
      chrome.runtime.sendMessage({
        type: 'CRAWL_PROGRESS',
        current: completed,
        total,
        page: crawlSession?.currentPage || 1,
        productName: product.name,
      }).catch(() => {});
    }));

    // Delay between batches to avoid rate-limiting
    if (batchStart + batchSize < total) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Accumulate into session
  if (crawlSession) {
    crawlSession.allResults.push(...results);
    crawlSession.totalProductsProcessed += total;
    crawlSession.totalVideosFound += results.length;
  }

  console.log(`[Background] Page ${crawlSession?.currentPage || 1} done. ${results.length}/${total} videos found.`);

  // Stop requested — finalize immediately
  if (crawlSession?.stopped) {
    return finalizeCrawl();
  }

  // Try to advance to next page, or finalize
  await tryAdvancePage();
}

async function tryAdvancePage() {
  if (!crawlSession) return finalizeCrawl();

  const { tabId, batchSize, maxPages, currentPage } = crawlSession;

  if (currentPage >= maxPages) {
    console.log(`[Background] Reached max pages (${maxPages}). Finalizing.`);
    return finalizeCrawl();
  }

  // Click next page button if available
  let clickResult;
  try {
    const scriptResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: (nextSel, activeSel, disabledCls) => {
        const nextBtn = document.querySelector(nextSel);
        if (!nextBtn || nextBtn.classList.contains(disabledCls)) return { clicked: false };
        const activePage = document.querySelector(activeSel);
        const pg = activePage ? parseInt(activePage.textContent.trim()) : 0;
        nextBtn.click();
        return { clicked: true, page: pg };
      },
      args: ['.page-item.page-next', '.page-item.page-page.active', 'disabled'],
    });
    clickResult = scriptResults?.[0]?.result;
  } catch (e) {
    console.error('[Background] Could not check next page:', e.message);
    return finalizeCrawl();
  }

  if (!clickResult?.clicked) {
    console.log('[Background] No next page available. Finalizing.');
    return finalizeCrawl();
  }

  crawlSession.currentPage = (clickResult.page || currentPage) + 1;
  console.log(`[Background] Advancing to page ${crawlSession.currentPage}...`);

  chrome.runtime.sendMessage({
    type: 'PAGE_ADVANCE',
    page: crawlSession.currentPage,
  }).catch(() => {});

  // Wait for SPA to render the new page
  await new Promise(r => setTimeout(r, 3000));

  // Re-start CSV monitoring then re-inject content script
  startCSVMonitoring(tabId, batchSize);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    console.error('[Background] Could not re-inject content.js:', e.message);
    finalizeCrawl();
  }
}

function finalizeCrawl() {
  chrome.action.setBadgeText({ text: '' });

  const session = crawlSession;
  crawlSession = null;

  if (session && session.allResults.length > 0) {
    const jsonContent = JSON.stringify(session.allResults, null, 2);
    const dataUrl = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(jsonContent)));
    chrome.downloads.download({
      url: dataUrl,
      filename: `ShopeeAffiliateVideo/shopee_videos_${Date.now()}.json`,
      saveAs: false,
    });
  }

  const totalProducts = session?.totalProductsProcessed || 0;
  const totalVideos = session?.totalVideosFound || 0;
  const totalPages = session?.currentPage || 1;
  const stopped = session?.stopped || false;

  chrome.runtime.sendMessage({
    type: 'CRAWL_COMPLETE',
    totalProducts,
    totalVideos,
    totalPages,
    stopped,
  }).catch(() => {});

  console.log(`[Background] Crawl ${stopped ? 'stopped' : 'complete'}. ${totalVideos}/${totalProducts} videos across ${totalPages} page(s).`);
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
              files: ['extractor.js'],
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

// extractFirstVideoFromPage has been moved to extractor.js (self-contained IIFE)
// Injected via chrome.scripting.executeScript({ files: ['extractor.js'] })