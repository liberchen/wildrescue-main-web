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

router.get('/', (req, res) => {
    // 新增 debug 資訊，取得使用者相關資訊
    const uaString = req.headers['user-agent'] || 'Unknown';
    const ua = useragent.parse(uaString);
    const referrer = req.headers.referer || 'Direct/Unknown';

    // 根據 referer 判斷社群平台（僅作簡單判斷，實際可能需更複雜邏輯）
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

    // 取得用戶 IP (注意: 若部署在反向代理後，需確認 x-forwarded-for 是否正確)
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'Unknown';
    if (ip.includes(',')) {
        ip = ip.split(',')[0].trim();
    }
    const geo = geoip.lookup(ip) || {};
    const country = geo.country || "Unknown";

    // 輸出 debug log
    console.log(`[DEBUG] Request from IP: ${ip} (${country})`);
    console.log(`[DEBUG] User-Agent: ${uaString}`);
    console.log(`[DEBUG] Parsed UA: ${JSON.stringify(ua)}`);
    console.log(`[DEBUG] Referrer: ${referrer}`);
    console.log(`[DEBUG] Inferred Platform: ${platform}`);

    // 取得加密的 payload
    const encryptedPayload = req.query.target;
    if (!encryptedPayload) {
        return res.send('請提供 target 參數（經過加密且以 Base64 編碼後的內容），例如：?target=ENCRYPTED_PAYLOAD');
    }

    // 解密 payload
    const decryptedPayload = decrypt(encryptedPayload);
    if (!decryptedPayload) {
        return res.send('無法解密 target 參數，請確認加密格式與金鑰正確。');
    }

    let payload;
    try {
        // 解析解密後的 JSON 字串，內容格式：{ target: "目標網址", title: "文章標題" }
        payload = JSON.parse(decryptedPayload);
    } catch (err) {
        return res.send('解密後的內容無法解析，請確認加密內容正確。');
    }

    const targetUrl = payload.target;
    const customTitle = payload.title || "全台灣最大荒野救援";
    const ogDescription = "立即加入我們，獲得即時救援與豐富社群互動！";
    const ogImage = "https://www.wildrescue.tw/images/og-preview.png";

    // 可以將 debug 資訊也寫入回應（或僅記錄在 server log 中），但注意不要暴露太多使用者資訊到前端
    console.log(`[DEBUG] Decrypted Payload: ${JSON.stringify(payload)}`);

    res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <title>${customTitle}</title>
  <!-- 3 秒後自動跳轉 -->
  <meta http-equiv="refresh" content="3;url=${targetUrl}">
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
  <p>即將跳轉到目標頁面，如果沒有自動跳轉，請點<a href="${targetUrl}">這裡</a>。</p>
  <!-- 以下為 debug 資訊，僅供開發使用，請視需要移除 -->
  <hr>
  <h3>Debug Info</h3>
  <p><strong>IP:</strong> ${ip} (${country})</p>
  <p><strong>User Agent:</strong> ${uaString}</p>
  <p><strong>Parsed UA:</strong> ${JSON.stringify(ua)}</p>
  <p><strong>Referrer:</strong> ${referrer}</p>
  <p><strong>Inferred Platform:</strong> ${platform}</p>
</body>
</html>`);
});

module.exports = router;
