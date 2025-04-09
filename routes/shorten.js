const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const router = express.Router();

console.debug("[DEBUG] Initializing shorten.js module.");

// 建立 PostgreSQL 連線池，請確保 DATABASE_URL 已設置
const pool = new Pool();
console.debug("[DEBUG] PostgreSQL pool created.");

// AES-256-CBC 解密設定
const algorithm = 'aes-256-cbc';
const fixedKey = process.env.URL_KEY;
if (!fixedKey) {
    throw new Error("環境變數 URL_KEY 未設置");
}
const key = crypto.createHash('sha256').update(String(fixedKey)).digest().slice(0, 32);
const iv = Buffer.alloc(16, 0);
console.debug("[DEBUG] AES key and IV generated.");

// 解密函式：輸入 Base64 編碼後的字串
function decrypt(text) {
    try {
        console.debug(`[DEBUG] Decrypting payload: ${text}`);
        const encryptedText = Buffer.from(text, 'base64');
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        let decrypted = decipher.update(encryptedText, undefined, 'utf8');
        decrypted += decipher.final('utf8');
        console.debug(`[DEBUG] Decryption successful: ${decrypted}`);
        return decrypted;
    } catch (err) {
        console.error('[DEBUG] Decryption error:', err);
        return null;
    }
}

// Base62 編碼函式
const base62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function encodeBase62(num) {
    let str = '';
    console.debug(`[DEBUG] Converting number ${num} to Base62`);
    while (num > 0) {
        str = base62[num % 62] + str;
        num = Math.floor(num / 62);
    }
    const encoded = str || '0';
    console.debug(`[DEBUG] Base62 encoded result: ${encoded}`);
    return encoded;
}

// 新 API 路由：/api/shorten
// 外部呼叫需要 POST 一個 JSON payload，格式例如：
// { "target": "<encrypted_payload>", "title": "自訂標題" }
// 傳入的 target 為加密後的字串（Base64 編碼），加密前的內容必須為 JSON 並包含 target 與 title 兩個欄位。
router.post('/api/shorten', async (req, res) => {
    console.debug(`[DEBUG] Received POST request to /api/shorten with body: ${JSON.stringify(req.body)}`);
    try {
        // 驗證並取得加密的 payload
        const encryptedPayload = req.body.target;
        if (!encryptedPayload) {
            console.error("[DEBUG] target 欄位缺失");
            return res.status(400).json({ error: "請在 JSON 中提供 target 欄位（加密後的字串）" });
        }

        // 解密 payload
        const decryptedPayload = decrypt(encryptedPayload);
        if (!decryptedPayload) {
            console.error("[DEBUG] 解密失敗");
            return res.status(400).json({ error: "無法解密 target 參數，請檢查加密格式與金鑰" });
        }

        let payload;
        try {
            payload = JSON.parse(decryptedPayload);
            console.debug(`[DEBUG] Parsed payload: ${JSON.stringify(payload)}`);
        } catch (err) {
            console.error("[DEBUG] Payload JSON 解析失敗:", err);
            return res.status(400).json({ error: "解密後資料解析失敗，請確認格式" });
        }

        const destinationUrl = payload.target;
        const title = payload.title || "";
        if (!destinationUrl) {
            console.error("[DEBUG] destinationUrl 缺失");
            return res.status(400).json({ error: "目標網址 (target) 為必填項" });
        }

        // 取得來源 IP (利用 x-forwarded-for 或 connection.remoteAddress)
        let source_ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'Unknown';
        if (source_ip.includes(',')) {
            source_ip = source_ip.split(',')[0].trim();
        }
        console.debug(`[DEBUG] Detected source IP: ${source_ip}`);

        // 開始資料庫操作
        const client = await pool.connect();
        console.debug("[DEBUG] Database client acquired.");
        try {
            await client.query('BEGIN');
            console.debug("[DEBUG] Transaction started.");

            // 插入資料到 url_list (先不處理 identity 欄位)
            const insertQuery = `
                INSERT INTO url_list (source_ip, destination_url, is_active, create_at)
                VALUES ($1, $2, true, NOW())
                    RETURNING id;
            `;
            const insertResult = await client.query(insertQuery, [source_ip, destinationUrl]);
            console.debug(`[DEBUG] Insert executed: ${JSON.stringify(insertResult.rows)}`);
            const insertedId = insertResult.rows[0].id;

            // 初步產生 identity 值 (使用 Base62 編碼自動增量 id)
            let identityCandidate = encodeBase62(insertedId);
            console.debug(`[DEBUG] Initial identity candidate: ${identityCandidate}`);

            // 更新 identity 欄位，若唯一性衝突則重試 (最多 5 次)
            let updated = false;
            let attempt = 0;
            while (!updated && attempt < 5) {
                try {
                    const updateQuery = `UPDATE url_list SET identity = $1 WHERE id = $2;`;
                    await client.query(updateQuery, [identityCandidate, insertedId]);
                    console.debug(`[DEBUG] Successfully updated identity with candidate: ${identityCandidate}`);
                    updated = true;
                } catch (err) {
                    if (err.code === '23505') {
                        console.warn(`[DEBUG] Identity candidate conflict: ${identityCandidate}. Retrying...`);
                        identityCandidate = encodeBase62(insertedId) + Math.floor(Math.random() * 10).toString();
                        attempt++;
                    } else {
                        throw err;
                    }
                }
            }
            if (!updated) {
                console.error("[DEBUG] Failed to generate a unique identity after 5 attempts.");
                throw new Error("無法生成唯一識別碼");
            }
            await client.query('COMMIT');
            console.debug("[DEBUG] Transaction committed.");
            client.release();

            // 組成最終短網址: https://www.wildrescue.tw/j?target=(identity)
            const finalUrl = `https://www.wildrescue.tw/j?target=${encodeURIComponent(identityCandidate)}`;
            console.debug(`[DEBUG] Final shortened URL: ${finalUrl}`);
            return res.json({ url: finalUrl });
        } catch (err) {
            await client.query('ROLLBACK');
            client.release();
            console.error("[DEBUG] Database error:", err);
            return res.status(500).json({ error: "資料庫錯誤" });
        }
    } catch (err) {
        console.error("[DEBUG] Server error:", err);
        return res.status(500).json({ error: "伺服器錯誤" });
    }
});

module.exports = router;
