// Service worker: orchestrates opening product pages and extracting videos

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CRAWL_VIDEOS_FROM_PRODUCTS') {
    const originTabId = sender.tab.id;
    processProductLinks(message.productLinks, originTabId);
  }

  if (message.type === 'DOWNLOAD_FILE') {
    const { filename, content, mimeType } = message;
    const dataUrl = 'data:' + mimeType + ';base64,' + btoa(unescape(encodeURIComponent(content)));
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true; // keep sendResponse channel open for async
  }

  return false;
});

async function processProductLinks(productLinks, originTabId) {
  const allVideos = [];
  const total = productLinks.length;

  for (let i = 0; i < total; i++) {
    const product = productLinks[i];
    console.log(`[Background] Processing ${i + 1}/${total}: ${product.name || product.link}`);

    // Notify content script of progress
    try {
      await chrome.tabs.sendMessage(originTabId, {
        type: 'CRAWL_PROGRESS',
        current: i + 1,
        total,
        productName: product.name || '',
      });
    } catch (e) { /* content script may not be listening yet */ }

    try {
      const videos = await openAndExtractVideos(product);
      allVideos.push(...videos);
    } catch (err) {
      console.error(`[Background] Error processing ${product.link}:`, err.message);
    }

    // Delay between pages to avoid rate-limiting
    if (i < total - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Send all results back to the content script
  try {
    await chrome.tabs.sendMessage(originTabId, {
      type: 'VIDEO_CRAWL_RESULTS',
      videos: allVideos,
    });
  } catch (err) {
    console.error('[Background] Failed to send results:', err.message);
  }

  console.log(`[Background] Done. Total videos found: ${allVideos.length}`);
}

// Two-step navigation:
// Step 1: Open affiliate product detail page → find a.view-product href
// Step 2: Navigate to the real shopee.vn product page → extract <video> tags
function openAndExtractVideos(product) {
  return new Promise((resolve) => {
    let resolved = false;

    // Step 1: Open the affiliate product detail page
    chrome.tabs.create({ url: product.link, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve([]);
        return;
      }

      const tabId = tab.id;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { chrome.tabs.remove(tabId); } catch (e) {}
          resolve([]);
        }
      }, 35000);

      function onAffiliateLoaded(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onAffiliateLoaded);

        // Wait for affiliate SPA to render, then extract a.view-product href
        setTimeout(async () => {
          if (resolved) return;

          try {
            const hrefResult = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const link = document.querySelector('a.view-product[href*="shopee.vn"]');
                return link ? link.href : null;
              },
            });

            const realProductUrl = hrefResult?.[0]?.result;

            if (!realProductUrl) {
              console.log(`[Background] a.view-product not found on ${product.link}, skipping...`);
              clearTimeout(timeout);
              resolved = true;
              chrome.tabs.remove(tabId);
              resolve([]);
              return;
            }

            console.log(`[Background] Found real product URL: ${realProductUrl}`);

            // Step 2: Navigate the same tab to the real Shopee product page
            chrome.tabs.update(tabId, { url: realProductUrl });

            function onProductLoaded(navTabId, navChangeInfo) {
              if (navTabId !== tabId || navChangeInfo.status !== 'complete') return;
              chrome.tabs.onUpdated.removeListener(onProductLoaded);

              // Wait for Shopee SPA to render video elements
              setTimeout(async () => {
                if (resolved) return;

                try {
                  const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: extractVideosFromProductPage,
                  });

                  clearTimeout(timeout);
                  resolved = true;
                  chrome.tabs.remove(tabId);

                  const pageVideos = (results?.[0]?.result || []).map(v => ({
                    ...v,
                    productName: product.name || '',
                    productLink: realProductUrl,
                  }));

                  resolve(pageVideos);
                } catch (err) {
                  clearTimeout(timeout);
                  resolved = true;
                  try { chrome.tabs.remove(tabId); } catch (e) {}
                  resolve([]);
                }
              }, 5000); // 5s for video rendering
            }

            chrome.tabs.onUpdated.addListener(onProductLoaded);

          } catch (err) {
            clearTimeout(timeout);
            resolved = true;
            try { chrome.tabs.remove(tabId); } catch (e) {}
            resolve([]);
          }
        }, 3000); // 3s for affiliate page SPA
      }

      chrome.tabs.onUpdated.addListener(onAffiliateLoaded);
    });
  });
}

// This function is injected into the actual Shopee product page to find <video> tags
async function extractVideosFromProductPage() {
    const videos = [];
    const wait = (ms) => new Promise(res => setTimeout(res, ms));

    console.log("[Crawler] Starting extraction process...");

    // 1. CLICK VIDEO THUMBNAIL TO TRIGGER RENDERING
    const videoSelectors = [
        'div._jA1mTx', 
        'div.VfAyB', 
        '.product-video__play-button',
        'div[data-test-id="video-thumbnail"]',
        '[class*="video"] [class*="play"]',
        '[class*="video-thumbnail"]',
    ];

    for (const selector of videoSelectors) {
        const btn = document.querySelector(selector);
        if (btn) {
            console.log(`[Crawler] Found trigger: ${selector}, clicking...`);
            btn.click();
            break;
        }
    }

    // 2. WAIT FOR VIDEO ELEMENT (Max 8 seconds)
    let retryCount = 0;
    let videoElement = null;
    
    while (retryCount < 16) {
        videoElement = document.querySelector('video');
        if (videoElement && (videoElement.src || videoElement.currentSrc)) {
            console.log("[Crawler] Video element detected!");
            break;
        }
        await wait(500);
        retryCount++;
    }

    // 3. EXTRACT FROM <video> TAG (skip blob: URLs)
    if (videoElement) {
        const src = videoElement.src || videoElement.currentSrc;
        if (src && !src.startsWith('blob:')) {
            videos.push({ videoUrl: src, type: 'video-element' });
        } else {
            console.log("[Crawler] Video src is blob:, will scan page source for direct URL...");
        }
    }

    // 4. SCAN PAGE SOURCE FOR DIRECT VIDEO URLs
    // This catches ALL .mp4 URLs including Shopee CDN patterns like:
    // - down-zl-sg.vod.susercontent.com
    // - down-vn.img.susercontent.com  
    // - cv.shopee.vn
    if (videos.length === 0) {
        console.log("[Crawler] Scanning page for video URLs...");

        // 4a. Scan <script> tags
        document.querySelectorAll('script').forEach(script => {
            const text = script.textContent || '';
            if (text.length < 50) return;

            // Broad pattern: any .mp4 URL from susercontent.com or shopee CDN
            const patterns = [
                /https?:\/\/[^\s"'\\]*\.vod\.susercontent\.com\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
                /https?:\/\/[^\s"'\\]*\.img\.susercontent\.com\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
                /https?:\/\/[^\s"'\\]*susercontent\.com\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
                /https?:\/\/cv\.shopee\.vn\/file\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
                /https?:\/\/[^\s"'\\]+\/mms\/[^\s"'\\]+\.mp4[^\s"'\\]*/gi,
            ];

            for (const pattern of patterns) {
                const matches = text.match(pattern);
                if (matches) {
                    matches.forEach(url => {
                        const cleanUrl = url
                            .replace(/\\u002F/g, '/')
                            .replace(/\\/g, '')
                            .replace(/["',;}\])+]+$/, '');
                        if (cleanUrl.length > 15 && !videos.some(v => v.videoUrl === cleanUrl)) {
                            videos.push({ videoUrl: cleanUrl, type: 'script-extracted' });
                        }
                    });
                }
            }
        });

        // 4b. Scan page HTML for video URLs (sometimes in data attributes or inline)
        const pageHtml = document.documentElement.innerHTML;
        const htmlPattern = /https?:\/\/[^\s"'<>]*susercontent\.com[^\s"'<>]*\.mp4[^\s"'<>]*/gi;
        const htmlMatches = pageHtml.match(htmlPattern);
        if (htmlMatches) {
            htmlMatches.forEach(url => {
                const cleanUrl = url.replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/["',;}\])+]+$/, '');
                if (cleanUrl.length > 15 && !videos.some(v => v.videoUrl === cleanUrl)) {
                    videos.push({ videoUrl: cleanUrl, type: 'html-extracted' });
                }
            });
        }

        // 4c. Check global state objects
        try {
            const globals = [window.__INITIAL_STATE__, window.__NEXT_DATA__, window.__rawData__];
            for (const obj of globals) {
                if (!obj) continue;
                const str = JSON.stringify(obj);
                const stateMatches = str.match(/https?:\/\/[^\s"\\]*\.mp4[^\s"\\]*/gi) || [];
                stateMatches.forEach(url => {
                    const cleanUrl = url.replace(/\\/g, '');
                    if (cleanUrl.length > 15 && !videos.some(v => v.videoUrl === cleanUrl)) {
                        videos.push({ videoUrl: cleanUrl, type: 'global-state' });
                    }
                });
            }
        } catch (e) {}
    }

    // 5. DEDUPLICATE AND RETURN
    const seen = new Set();
    const finalResults = videos.filter(v => {
        if (!v.videoUrl || v.videoUrl.length < 10 || seen.has(v.videoUrl)) return false;
        seen.add(v.videoUrl);
        return true;
    });
    console.log(`[Crawler] Extraction finished. Found ${finalResults.length} videos.`);
    
    return finalResults;
}