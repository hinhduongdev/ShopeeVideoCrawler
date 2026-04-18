# Shopee Video & Affiliate Crawler Extension

This tool automates the collection of affiliate product links and extracts original videos from Shopee for content creators (re-uploaders/affiliates).

## 🚀 Operational Flow

Below is a flowchart of the communication between the components in the Extension:

### Detailed processing steps:

1. **Popup (UI Context):**

- The user clicks the activation button on the Extension interface.

- `popup.js` sends a `Command` signal to the **Content Script** running in the Shopee Affiliate tab.

2. **Content Script (Root Tab):**

- Scans the DOM structure of the affiliate list page.

- Extracts a list of `Product Links` and sends this data array to the **Background Script**.

3. **Background Script (Service Worker):**

- Acts as an orchestrator.

- Browse through the list of links, opening each product in a **hidden tab** (`active: false`) to avoid interrupting the user's work.

- Use `chrome.scripting.executeScript` to inject extraction logic into each new product tab.

4. **New Tabs (Target Products):**

- Simulate user behavior (clicking on the video thumbnail).

- Wait for the `<video>` tag to render and capture the `src` (original mp4 link).

- Send the retrieved video data back to the **Background Script**.

5. **Results & Download:**

- The **Background Script** compiles the data after completing the loop.

- Send the final result to the **Download API** to export the `.csv`/`.json` file to the user's computer.

## 📁 Directory Structure

```text
CrawlExtensions/
├── manifest.json # Configures permissions and components of the Extension
├── popup.html/js # Console and click event handling
├── background.js # Service Worker for tab navigation and crawl flow management
├── content.js # Script that interacts directly with Shopee's DOM
└── icons/ # Contains icons displayed in the browser
