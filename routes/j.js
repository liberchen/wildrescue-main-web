const express = require('express');
const { Pool } = require('pg');
const useragent = require('express-useragent');
const geoip = require('geoip-lite');

const router = express.Router();

// 建立 PostgreSQL 連線池 (使用 Heroku 的 DATABASE_URL 與 ssl 設定)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
console.debug("[DEBUG] PostgreSQL pool for j.js created using DATABASE_URL.");

pool.on('error', (err, client) => {
    console.error("[DEBUG] Unexpected error on idle PostgreSQL client in j.js:", err);
});

// 定義熱門社群 app 的設定
const appConfigs = [
    {
        name: 'line',
        domain: 'line.me',
        // 將 "https://" 或 "http://" 替換成 "line://"
        createDeepLink: (url) => url.replace(/^https?:\/\//i, 'line://')
    },
    {
        name: 'discord',
        domain: 'discord.com',
        // 將 "https://" 或 "http://" 替換成 "discord://"
        createDeepLink: (url) => url.replace(/^https?:\/\//i, 'discord://')
    }
    // 可依需要新增其他 app 設定
];

router.get('/', async (req, res) => {
    // 取得查詢參數 target (這裡 target 為識別碼 identity)
    const identity = req.query.target;
    if (!identity) {
        return res.status(400).send("請提供 target 參數");
    }

    // 取得使用者相關資訊並記錄
    const uaString = req.headers['user-agent'] || 'Unknown';
    const ua = useragent.parse(uaString);
    const referrer = req.headers.referer || 'Direct/Unknown';

    let sourceIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'Unknown';
    if (sourceIp.includes(',')) {
        sourceIp = sourceIp.split(',')[0].trim();
    }
    const geo = geoip.lookup(sourceIp) || {};
    const country = geo.country || "Unknown";

    console.debug(`[DEBUG] /j invoked. Target identity: ${identity}`);
    console.debug(`[DEBUG] Request from IP: ${sourceIp} (${country})`);
    console.debug(`[DEBUG] User-Agent: ${uaString}`);
    console.debug(`[DEBUG] Referrer: ${referrer}`);

    try {
        // 查詢資料庫，根據 identity 取得 destination_url 與 title (若有)
        const queryText = `
            SELECT destination_url, title
            FROM url_list
            WHERE identity = $1 AND is_active = true
                LIMIT 1;
        `;
        const result = await pool.query(queryText, [identity]);
        if (result.rowCount === 0) {
            console.error("[DEBUG] 未找到對應的轉址記錄，identity:", identity);
            return res.status(404).send("未找到對應的轉址記錄");
        }
        const destinationUrl = result.rows[0].destination_url;
        const recordTitle = result.rows[0].title;
        console.debug(`[DEBUG] Found destination_url: ${destinationUrl}`);

        // 使用資料庫中的 title 作為預覽標題，若無則使用預設
        const customTitle = recordTitle && recordTitle.trim().length > 0 ? recordTitle : "荒野救援 - 轉址中";

        // 檢查是否為熱門社群 app 並嘗試產生 deep link
        let deepLink = null;
        for (const config of appConfigs) {
            if (destinationUrl.toLowerCase().includes(config.domain)) {
                deepLink = config.createDeepLink(destinationUrl);
                console.debug(`[DEBUG] 產生 deep link: ${deepLink} 針對 ${config.name}`);
                break;
            }
        }

        // 組成 HTML 頁面，用 meta refresh 與 JavaScript 轉址
        const ogDescription = "荒野救援";
        const ogImage = "https://www.wildrescue.tw/images/og-preview.png";

        let script = "";
        if (deepLink) {
            script = `
  <script>
    function openDeepLink() {
      var startTime = Date.now();
      window.location = "${deepLink}";
      setTimeout(function(){
          var elapsed = Date.now() - startTime;
          if(elapsed < 2000) {
              window.location = "${destinationUrl}";
          }
      }, 1500);
    }
    window.onload = openDeepLink;
  </script>`;
        } else {
            script = `<meta http-equiv="refresh" content="3;url=${destinationUrl}">`;
        }

        const htmlOutput = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <title>${customTitle}</title>
  ${script}
  <!-- Open Graph Meta Tags -->
  <meta property="og:title" content="${customTitle}">
  <meta property="og:description" content="${ogDescription}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:url" content="${req.protocol}://${req.get('host')}${req.originalUrl}">
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${customTitle}">
  <meta name="twitter:description" content="${ogDescription}">
  <meta name="twitter:image" content="${ogImage}">
  <style>
    body { font-family: sans-serif; text-align: center; padding: 2rem; }
    p { font-size: 1.2rem; }
  </style>
</head>
<body>
  <h1>${customTitle}</h1>
  <p>正在轉向目的地，如果未自動跳轉，請點 <a href="${destinationUrl}">這裡</a> 進行手動操作。</p>
  <div id="backup" style="display:none; margin-top:20px;">
    <p>請點擊以下連結手動轉向：</p>
    <p><a href="${destinationUrl}" target="_blank">${destinationUrl}</a></p>
  </div>
</body>
</html>`;
        res.send(htmlOutput);
    } catch (err) {
        console.error("[DEBUG] Error in /j route:", err);
        res.status(500).send("伺服器錯誤");
    }
});

module.exports = router;
