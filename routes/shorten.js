const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const router = express.Router();

console.debug("[DEBUG] Initializing shorten.js module.");

// 建立 PostgreSQL 連線池，使用 Heroku 的環境變數 DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
console.debug("[DEBUG] PostgreSQL pool created using DATABASE_URL.");

pool.on('error', (err, client) => {
    console.error("[DEBUG] Unexpected error on idle PostgreSQL client:", err);
});

// AES-256-CBC 解密設定
const algorithm = 'aes-256-cbc';
const fixedKey = process.env.URL_KEY;
if (!fixedKey) {
    throw new Error("環境變數 URL_KEY 未設置");
}
const key = crypto.createHash('sha256').update(String(fixedKey)).digest().slice(0, 32);
const iv = Buffer.alloc(16, 0);
console.debug("[DEBUG] AES key and IV generated.");

// 解密函式：輸入為 Base64 編碼後的字串
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
        console.error("[DEBUG] Decryption error:", err);
        return null;
    }
}

// Base62 編碼函式
const base62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function encodeBase62(num) {
    let str = '';
    console.debug(`[DEBUG] Converting number ${num} to Base62`);
    // 確保 num 為數值型別
    num = Number(num);
    while (num > 0) {
        str = base62[num % 62] + str;
        num = Math.floor(num / 62);
    }
    const encoded = str || '0';
    console.debug(`[DEBUG] Base62 encoded result: ${encoded}`);
    return encoded;
}

// 主要處理邏輯：處理傳入的 payload 並產生短網址
async function processShortenPayload(encryptedInput, source_ip) {
    let payload;
    // 判斷是否為 plain text（以 "http" 開頭），未加密則直接建立 payload
    if (encryptedInput.startsWith("http")) {
        payload = { target: encryptedInput, title: "" };
        console.debug("[DEBUG] Received plain text payload:", JSON.stringify(payload));
    } else {
        const decryptedPayload = decrypt(encryptedInput);
        if (!decryptedPayload) {
            throw new Error("無法解密 target 參數，請確認加密格式與金鑰");
        }
        try {
            payload = JSON.parse(decryptedPayload);
            console.debug("[DEBUG] Parsed payload from encrypted input:", JSON.stringify(payload));
        } catch (err) {
            console.error("[DEBUG] Payload JSON 解析失敗:", err);
            throw new Error("解密後資料解析失敗，請確認格式");
        }
    }
    const destinationUrl = payload.target;
    if (!destinationUrl) {
        throw new Error("目標網址 (target) 為必填項");
    }

    const client = await pool.connect();
    console.debug("[DEBUG] PostgreSQL client acquired.");
    try {
        await client.query('BEGIN');
        console.debug("[DEBUG] Transaction started.");

        // 插入資料，暫不處理 identity 欄位
        const insertQuery = `
            INSERT INTO url_list (source_ip, destination_url, is_active, create_at)
            VALUES ($1, $2, true, NOW())
                RETURNING id;
        `;
        const insertResult = await client.query(insertQuery, [source_ip, destinationUrl]);
        console.debug(`[DEBUG] Insert executed, result: ${JSON.stringify(insertResult.rows)}`);
        // 將 id 明確轉為 Number
        const insertedId = Number(insertResult.rows[0].id);
        console.debug(`[DEBUG] Inserted record id (as number): ${insertedId}`);

        // 產生 identity 值 (利用 Base62 編碼 insertedId)
        let identityCandidate = encodeBase62(insertedId);
        console.debug(`[DEBUG] Initial identity candidate: ${identityCandidate}`);
        if (!identityCandidate) {
            identityCandidate = '0';
            console.debug("[DEBUG] Identity candidate was empty, set to '0'");
        }

        // 更新 identity 欄位；如唯一性衝突則重試最多 5 次
        let updated = false;
        let attempt = 0;
        while (!updated && attempt < 5) {
            try {
                const updateQuery = `UPDATE url_list SET identity = $1 WHERE id = $2;`;
                await client.query(updateQuery, [identityCandidate, insertedId]);
                console.debug(`[DEBUG] Successfully updated identity with candidate: ${identityCandidate}`);
                updated = true;
            } catch (err) {
                if (err.code === '23505') { // 唯一性衝突
                    console.warn(`[DEBUG] Identity candidate conflict: ${identityCandidate}. Retrying...`);
                    identityCandidate = encodeBase62(insertedId) + Math.floor(Math.random() * 10).toString();
                    attempt++;
                } else {
                    console.error("[DEBUG] Error during identity update:", err);
                    throw err;
                }
            }
        }
        if (!updated) {
            console.error("[DEBUG] Failed to generate a unique identity after 5 attempts.");
            throw new Error("無法生成唯一識別碼");
        }
        await client.query('COMMIT');
        console.debug("[DEBUG] Transaction committed successfully.");
        client.release();

        // 組成最終短網址格式: https://www.wildrescue.tw/j?target=<identity>
        const finalUrl = `https://www.wildrescue.tw/j?target=${encodeURIComponent(identityCandidate)}`;
        console.debug(`[DEBUG] Final shortened URL: ${finalUrl}`);
        return finalUrl;
    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        console.error("[DEBUG] Database error during transaction:", err);
        throw err;
    }
}

// POST 路由 (供正式使用)
router.post('/', async (req, res) => {
    console.debug(`[DEBUG] Received POST request to /api/shorten with body: ${JSON.stringify(req.body)}`);
    try {
        const input = req.body.target;
        if (!input) {
            console.error("[DEBUG] POST: target 欄位缺失");
            return res.status(400).json({ error: "請在 JSON 中提供 target 欄位（加密後的字串或未加密的 URL）" });
        }
        let source_ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'Unknown';
        if (source_ip.includes(',')) {
            source_ip = source_ip.split(',')[0].trim();
        }
        console.debug(`[DEBUG] Detected source IP (POST): ${source_ip}`);
        const finalUrl = await processShortenPayload(input, source_ip);
        return res.json({ url: finalUrl });
    } catch (err) {
        console.error("[DEBUG] Server error in POST /api/shorten:", err);
        return res.status(500).json({ error: "伺服器錯誤" });
    }
});

// GET 路由 (供測試使用)
router.get('/', async (req, res) => {
    console.debug(`[DEBUG] Received GET request to /api/shorten with query: ${JSON.stringify(req.query)}`);
    try {
        const input = req.query.target;
        if (!input) {
            console.error("[DEBUG] GET: target 參數缺失");
            return res.status(400).json({ error: "請在 query string 中提供 target 參數" });
        }
        let source_ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'Unknown';
        if (source_ip.includes(',')) {
            source_ip = source_ip.split(',')[0].trim();
        }
        console.debug(`[DEBUG] Detected source IP (GET): ${source_ip}`);
        const finalUrl = await processShortenPayload(input, source_ip);
        return res.json({ url: finalUrl });
    } catch (err) {
        console.error("[DEBUG] Server error in GET /api/shorten:", err);
        return res.status(500).json({ error: "伺服器錯誤" });
    }
});

module.exports = router;
