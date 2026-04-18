const statusEl = document.getElementById('status');

function setStatus(msg) {
  statusEl.textContent = msg;
}

function disableAll(disabled) {
  document.querySelectorAll('button').forEach(b => b.disabled = disabled);
}

async function executeContentScript(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes("affiliate.shopee.vn")) {
    alert("Vui lòng mở trang Shopee Affiliate trước!");
    return;
  }

  disableAll(true);
  setStatus("Đang crawl dữ liệu...");

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (crawlMode) => { window.__CRAWL_MODE__ = crawlMode; },
      args: [mode]
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    setStatus(mode === 'products'
      ? "Đang crawl sản phẩm..."
      : "Đang crawl... Video sẽ mở từng tab sản phẩm. Xem console để theo dõi tiến trình.");
  } catch (err) {
    setStatus("Lỗi: " + err.message);
    disableAll(false);
  }
}

document.getElementById('crawlProductsBtn').addEventListener('click', () => executeContentScript('products'));
document.getElementById('crawlVideosBtn').addEventListener('click', () => executeContentScript('videos'));
document.getElementById('crawlAllBtn').addEventListener('click', () => executeContentScript('all'));