const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const batchSizeInput = document.getElementById('batchSize');
const maxPagesInput = document.getElementById('maxPages');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');

function setProgress(current, total) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressWrap.style.display = 'block';
  progressLabel.style.display = 'block';
  progressBar.style.width = pct + '%';
  progressLabel.textContent = `${current}/${total} (${pct}%)`;
}

function resetProgress() {
  progressWrap.style.display = 'none';
  progressLabel.style.display = 'none';
  progressBar.style.width = '0%';
  progressLabel.textContent = '';
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// Restore UI state if crawl is already running when popup opens
chrome.runtime.sendMessage({ type: 'GET_CRAWL_STATUS' }, (response) => {
  if (response?.active) {
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    if (response.batchSize) batchSizeInput.value = response.batchSize;
    if (response.maxPages) maxPagesInput.value = response.maxPages;
    if (response.paused) {
      pauseBtn.dataset.paused = 'true';
      pauseBtn.textContent = '▶ Tiếp tục';
      pauseBtn.style.backgroundColor = '#2e7d32';
    } else {
      pauseBtn.dataset.paused = 'false';
      pauseBtn.textContent = '⏸ Tạm dừng';
      pauseBtn.style.backgroundColor = '#e08800';
    }
    if (response.lastStatus) setStatus(response.lastStatus);
    if (response.progress) setProgress(response.progress.current, response.progress.total);
  }
});

startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes('affiliate.shopee.vn')) {
    alert('Vui lòng mở trang Shopee Affiliate trước!');
    return;
  }

  startBtn.disabled = true;
  pauseBtn.disabled = false;
  pauseBtn.textContent = '⏸ Tạm dừng';
  pauseBtn.style.backgroundColor = '#e08800';
  resetProgress();
  setStatus('Đang chọn sản phẩm & lấy link...');

  try {
    // 1. Tell background to start monitoring for CSV downloads
    const batchSize = Math.max(1, Math.min(10, parseInt(batchSizeInput.value, 10) || 5));
    const maxPages = Math.max(1, Math.min(25, parseInt(maxPagesInput.value, 10) || 25));
    await chrome.runtime.sendMessage({ type: 'START_CSV_MONITORING', tabId: tab.id, batchSize, maxPages });

    // 2. Inject content script to automate button clicks
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (err) {
    setStatus('Lỗi: ' + err.message);
    startBtn.disabled = false;
    pauseBtn.disabled = true;
  }
});

pauseBtn.addEventListener('click', () => {
  const isPaused = pauseBtn.dataset.paused === 'true';
  if (!isPaused) {
    // Pause
    chrome.runtime.sendMessage({ type: 'PAUSE_CRAWL' }).catch(() => {});
    pauseBtn.dataset.paused = 'true';
    pauseBtn.textContent = '▶ Tiếp tục';
    pauseBtn.style.backgroundColor = '#2e7d32';
    setStatus('⏸ Đã tạm dừng. Nhấn Tiếp tục để chạy lại.');
  } else {
    // Resume
    chrome.runtime.sendMessage({ type: 'RESUME_CRAWL' }).catch(() => {});
    pauseBtn.dataset.paused = 'false';
    pauseBtn.textContent = '⏸ Tạm dừng';
    pauseBtn.style.backgroundColor = '#e08800';
    setStatus('▶ Đang tiếp tục...');
  }
});

// Listen for progress and completion from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CSV_PARSED') {
    setStatus(`Tìm thấy ${message.count} sản phẩm. Đang tải video...`);
  }

  if (message.type === 'PAGE_ADVANCE') {
    resetProgress();
    setStatus(`📄 Đang xử lý trang ${message.page}...`);
  }

  if (message.type === 'CRAWL_PROGRESS') {
    setStatus(`🎬 [Trang ${message.page}] ${message.current}/${message.total}: ${message.productName}`);
    setProgress(message.current, message.total);
  }

  if (message.type === 'CRAWL_COMPLETE') {
    setProgress(message.totalProducts, message.totalProducts);
    const pagesInfo = message.totalPages > 1 ? ` (${message.totalPages} trang)` : '';
    const stoppedInfo = message.stopped ? ' [Dừng sớm]' : '';
    setStatus(`Hoàn tất! ${message.totalVideos}/${message.totalProducts} video đã tải vào ShopeeAff${pagesInfo}${stoppedInfo}.`);
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    pauseBtn.dataset.paused = 'false';
    pauseBtn.textContent = '⏸ Tạm dừng';
    pauseBtn.style.backgroundColor = '#888';
  }
});