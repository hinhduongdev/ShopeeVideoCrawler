// Content script: automates "Chọn tất cả" + "Lấy link hàng loạt" button clicks
// CSV download is intercepted by background.js via chrome.downloads API

(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));

  console.log('[Shopee Crawler] Content script started on affiliate page.');

  // --- Click "Chọn tất cả sản phẩm trên trang này" checkbox ---
  async function clickSelectAll() {
    const selectors = [
      '#batch-bar input[type="checkbox"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        console.log(`[Shopee Crawler] Clicking select-all via: ${sel}`);
        el.click();
        await wait(500);
        return true;
      }
    }

    console.warn('[Shopee Crawler] Could not find "Chọn tất cả" checkbox.');
    return false;
  }

  // --- Click "Lấy link hàng loạt" button ---
  async function clickGetLinksButton() {
    const allButtons = document.querySelectorAll('button, a, div[role="button"], span');
    for (const btn of allButtons) {
      const text = btn.textContent.trim();
      if (text.includes('Lấy link hàng loạt') || text.includes('Get links')) {
        console.log('[Shopee Crawler] Found "Lấy link hàng loạt" button, clicking...');
        btn.click();
        return true;
      }
    }

    console.warn('[Shopee Crawler] Could not find "Lấy link hàng loạt" button.');
    return false;
  }

  // --- Wait for popup then click "Lấy link" confirm button inside it ---
  async function clickPopupConfirmButton() {
    const maxWait = 8000;
    const interval = 300;
    let elapsed = 0;

    while (elapsed < maxWait) {
      await wait(interval);
      elapsed += interval;

      // Look for a popup/modal/dialog that appeared after clicking "Lấy link hàng loạt"
      const allButtons = document.querySelectorAll(
        '[class*="modal"] button, [class*="popup"] button, [class*="dialog"] button, ' +
        '[role="dialog"] button, [class*="Modal"] button, [class*="Popup"] button'
      );

      for (const btn of allButtons) {
        const text = btn.textContent.trim();
        // Match the confirm "Lấy link" button but NOT the original "Lấy link hàng loạt" button
        if (
          (text === 'Lấy link' || text === 'Xác nhận' || text === 'Confirm' || text === 'OK') &&
          !text.includes('hàng loạt')
        ) {
          console.log(`[Shopee Crawler] Found popup confirm button: "${text}", clicking...`);
          btn.click();
          return true;
        }
      }

      // Fallback: scan ALL buttons for exact "Lấy link" text in case popup isn't wrapped in a modal class
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        const text = btn.textContent.trim();
        if (text === 'Lấy link' || text === 'Lấy Link') {
          console.log(`[Shopee Crawler] Found confirm button via fallback: "${text}", clicking...`);
          btn.click();
          return true;
        }
      }
    }

    console.warn('[Shopee Crawler] Popup confirm button not found within timeout.');
    return false;
  }

  // --- Main execution ---
  try {
    await wait(1000);

    const selectedAll = await clickSelectAll();
    if (!selectedAll) {
      alert('[Shopee Crawler] Không tìm thấy checkbox "Chọn tất cả sản phẩm". Hãy chắc chắn bạn đang ở đúng trang.');
      return;
    }

    await wait(1000);

    const clickedBtn = await clickGetLinksButton();
    if (!clickedBtn) {
      alert('[Shopee Crawler] Không tìm thấy nút "Lấy link hàng loạt".');
      return;
    }

    console.log('[Shopee Crawler] Waiting for popup to appear...');
    const confirmedPopup = await clickPopupConfirmButton();
    if (!confirmedPopup) {
      alert('[Shopee Crawler] Không tìm thấy nút "Lấy link" trong popup. Hãy thử click thủ công.');
      return;
    }

    console.log('[Shopee Crawler] Popup confirmed. Background is monitoring for CSV download...');

  } catch (err) {
    console.error('[Shopee Crawler] Error:', err);
    alert('[Shopee Crawler] Lỗi: ' + err.message);
  }
})();