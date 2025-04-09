const express = require('express');
const crypto = require('crypto');
const useragent = require('express-useragent');
const geoip = require('geoip-lite');
const router = express.Router();

// 使用 AES-256-CBC 加密模式
const algorithm = 'aes-256-cbc';
// 從環境變數中取得金鑰，金鑰存放在 URL_KEY
const fixedKey = process.env.URL_KEY;
if (!fixedKey) {
    throw new Error("環境變數 URL_KEY 未設置");
}
// 產生 32 字節的加密 key
const key = crypto.createHash('sha256').update(String(fixedKey)).digest().slice(0, 32);
// 固定 IV (示範用途，不建議在生產環境中使用固定 IV)
const iv = Buffer.alloc(16, 0);

function decrypt(text) {
    try {
        // 將 Base64 編碼字串轉換為 Buffer
        const encryptedText = Buffer.from(text, 'base64');
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        let decrypted = decipher.update(encryptedText, undefined, 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error('Decryption error:', err);
        return null;
    }
}

// 定義熱門社群 app 的設定：
// 若目標網址包含某些關鍵字，則嘗試生成 deep link，方法為替換 URL 協議部分
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
        // Discord 深層連結有時使用 "discord://"
        createDeepLink: (url) => url.replace(/^https?:\/\//i, 'discord://')
    }
    // 可依需要新增其他 app 設定
];

router.get('/', (req, res) => {
    // 取得使用者相關資訊並輸出到 log
    const uaString = req.headers['user-agent'] || 'Unknown';
    const ua = useragent.parse(uaString);

    // 過濾解析後的 UA，若屬性為布林值則只保留 true 的部分
    const filteredUA = {};
    for (const [key, value] of Object.entries(ua)) {
        if (typeof value === 'boolean') {
            if (value) {
                filteredUA[key] = value;
            }
        } else {
            filteredUA[key] = value;
        }
    }

    const referrer = req.headers.referer || 'Direct/Unknown';

    let platform = "Unknown";
    if (referrer.toLowerCase().includes("line.me")) {
        platform = "Line";
    } else if (referrer.toLowerCase().includes("facebook.com")) {
        platform = "Facebook";
    } else if (referrer.toLowerCase().includes("discord")) {
        platform = "Discord";
    } else if (referrer.toLowerCase().includes("twitter.com")) {
        platform = "Twitter";
    }

    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'Unknown';
    if (ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    const geo = geoip.lookup(ip) || {};
    const country = geo.country || "Unknown";

    console.log(`[DEBUG] Request from IP: ${ip} (${country})`);
    console.log(`[DEBUG] User-Agent: ${uaString}`);
    console.log(`[DEBUG] Parsed UA: ${JSON.stringify(filteredUA)}`);
    console.log(`[DEBUG] Referrer: ${referrer}`);
    console.log(`[DEBUG] Inferred Platform: ${platform}`);

    // 取得加密的 payload
    const encryptedPayload = req.query.target;
    if (!encryptedPayload) {
        return res.send('請提供 target 參數（經過加密且以 Base64 編碼後的內容），例如：?target=ENCRYPTED_PAYLOAD');
    }

    const decryptedPayload = decrypt(encryptedPayload);
    if (!decryptedPayload) {
        return res.send('無法解密 target 參數，請確認加密格式與金鑰正確。');
    }

    let payload;
    try {
        payload = JSON.parse(decryptedPayload);
    } catch (err) {
        return res.send('解密後的內容無法解析，請確認加密內容正確。');
    }

    const targetUrl = payload.target;
    const customTitle = payload.title || "全台灣最大荒野救援";
    const ogDescription = "立即加入我們，獲得即時救援與豐富社群互動！";
    const ogImage = "https://www.wildrescue.tw/images/og-preview.png";

    console.log(`[DEBUG] Decrypted Payload: ${JSON.stringify(payload)}`);

    // 檢查是否為熱門社群 app 並嘗試產生 deep link
    let deepLink = null;
    for (const config of appConfigs) {
        if (targetUrl.toLowerCase().includes(config.domain)) {
            deepLink = config.createDeepLink(targetUrl);
            console.log(`[DEBUG] 產生 deep link: ${deepLink} 針對 ${config.name}`);
            break;
        }
    }

    let htmlOutput = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <title>${customTitle}</title>
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
  </style>`;

    // 如果深層連結存在，採用 JavaScript 嘗試打開應用；否則使用 meta refresh
    if (deepLink) {
        htmlOutput += `
  <script>
    function openDeepLink() {
      var start = Date.now();
      window.location = "${deepLink}";
      setTimeout(function() {
        var elapsed = Date.now() - start;
        if (elapsed < 2000) {
          window.location = "${targetUrl}";
        }
      }, 1500);
    }
    window.onload = openDeepLink;
  </script>`;
    } else {
        htmlOutput += `
  <meta http-equiv="refresh" content="3;url=${targetUrl}">`;
    }

    htmlOutput += `
</head>
<body>
  <h1>${customTitle}</h1>
  <p>若系統未能自動打開應用程式，請點 <a href="${targetUrl}">這裡</a> 進行手動操作。</p>
</body>
</html>`;

    res.send(htmlOutput);
});

module.exports = router;
