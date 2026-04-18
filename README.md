# Shopee Affiliate Video Crawler Extension

Tự động tải video gốc (.mp4) từ các sản phẩm Shopee Affiliate — không cần thao tác thủ công.

## 🚀 Luồng hoạt động

### Bước 1 — Kích hoạt (Popup)

1. Mở trang **Shopee Affiliate → Product Offer** trên trình duyệt.
2. Nhấn nút **"🎬 Crawl & Tải Video"** trong popup của extension.
3. `popup.js` thông báo `background.js` bắt đầu lắng nghe download CSV, sau đó inject `content.js` vào tab hiện tại.

### Bước 2 — Tự động thao tác trên trang (Content Script)

`content.js` thực hiện tuần tự:

1. Tìm và click checkbox **"Chọn tất cả sản phẩm trên trang này"**.
2. Tìm và click nút **"Lấy link hàng loạt"**.
3. Chờ popup xác nhận xuất hiện, sau đó click nút **"Lấy link"** trong popup — kích hoạt tải file CSV.

### Bước 3 — Bắt file CSV (Background Service Worker)

- `chrome.downloads.onCreated` phát hiện file CSV được tải xuống.
- **Hủy ngay** việc lưu file xuống máy (`chrome.downloads.cancel`).
- Đọc nội dung CSV trực tiếp từ ngữ cảnh trang (dùng `executeScript world: MAIN`) để đảm bảo có đầy đủ cookie phiên đăng nhập.
- Parse CSV, lấy cột **"Tên sản phẩm"** và **"Link sản phẩm"** (`https://shopee.vn/product/...`).

### Bước 4 — Trích xuất video từng sản phẩm (Background)

Với mỗi sản phẩm trong danh sách:

1. Mở tab nền (`active: false`) trỏ đến link `shopee.vn` của sản phẩm.
2. Chờ trang SPA render xong (~3 giây).
3. Inject script vào tab: click thumbnail video → chờ thẻ `<video>` xuất hiện (tối đa 8 giây).
4. Lấy URL video (`.mp4`) — ưu tiên từ `video.src`, fallback scan `<script>` tags và HTML.
5. Đóng tab nền, chuyển sang sản phẩm tiếp theo.

### Bước 5 — Lưu kết quả

- Mỗi video được tải xuống vào thư mục **`Downloads/ShopeeAffiliateVideo/<TênSảnPhẩm>_N.mp4`**.
- Sau khi xử lý toàn bộ, lưu file **`Downloads/ShopeeAffiliateVideo/shopee_videos_<timestamp>.json`** chứa danh sách `{ productName, videoUrl }`.
- Popup hiển thị tiến trình theo thời gian thực và thông báo hoàn tất.

## 📁 Cấu trúc thư mục

```text
ShopeeVideoCrawler/
├── manifest.json          # Cấu hình quyền và các thành phần của Extension
├── popup.html             # Giao diện người dùng
├── popup.js               # Xử lý sự kiện click, lắng nghe tiến trình từ background
├── background.js          # Service Worker: lắng nghe CSV, điều phối mở tab, tải video
├── content.js             # Tự động click trên trang Shopee Affiliate
├── extractor.js           # Script tự chứa: trích xuất URL video từ trang sản phẩm
├── obfuscator-config.json # Cấu hình javascript-obfuscator cho bản release
└── build_demo.bat         # Script build ra bản release đã obfuscate
```

## 🔨 Build bản Release (cho khách hàng)

### Yêu cầu

- **Node.js** đã cài đặt (`node -v` để kiểm tra).
- **javascript-obfuscator** cài qua npm (có trong `package.json`):
  ```bat
  npm install
  ```

### Các bước build

1. Mở Command Prompt hoặc PowerShell trong thư mục `ShopeeVideoCrawler/`.
2. Chạy:
   ```bat
   build_demo.bat
   ```
3. Sau khi build xong, thư mục **`ShopeeVideoCrawler_Release\`** sẽ xuất hiện ở cùng cấp với thư mục source (tức là `../ShopeeVideoCrawler_Release/`).

### Nội dung thư mục release

```text
ShopeeVideoCrawler_Release/
├── manifest.json    # (copy nguyên gốc)
├── popup.html       # (copy nguyên gốc)
├── background.js    # (đã obfuscate)
├── popup.js         # (đã obfuscate)
├── content.js       # (đã obfuscate)
└── extractor.js     # (đã obfuscate)
```

> **Lưu ý:** Các file `package.json`, `package-lock.json`, `node_modules/`, `obfuscator-config.json` và `build_demo.bat` **không** được đưa vào thư mục release.

## 📦 Cài đặt bản Release lên máy khách hàng

## ⚙️ Yêu cầu

- Trình duyệt Chromium (Chrome, Edge, ...) hỗ trợ Manifest V3.
- Đã đăng nhập tài khoản **Shopee Affiliate** tại `affiliate.shopee.vn`.
- Đang ở trang **Product Offer** (có danh sách sản phẩm với checkbox và nút "Lấy link hàng loạt").

## 📦 Cài đặt bản Release lên máy khách hàng

1. Sao chép toàn bộ thư mục **`ShopeeVideoCrawler_Release/`** sang máy khách (USB, zip, Google Drive, v.v.).
2. Trên máy khách, mở trình duyệt Chrome/Edge và truy cập `chrome://extensions/`.
3. Bật **Developer mode** (góc trên bên phải).
4. Nhấn **Load unpacked** → chọn thư mục `ShopeeVideoCrawler_Release/`.
5. Extension sẽ xuất hiện trong danh sách với tên **Shopee Video Crawler**.

> **Lưu ý:** Máy khách **không cần** Node.js hay bất kỳ công cụ build nào. Chỉ cần thư mục release.

## 📂 Output

| File | Mô tả |
|------|-------|
| `ShopeeAffiliateVideo/<TênSP>_N.mp4` | File video gốc của từng sản phẩm |
| `ShopeeAffiliateVideo/shopee_videos_<ts>.json` | JSON chứa `productName` + `videoUrl` |
