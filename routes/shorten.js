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
        console.error("[DEBUG] Decryption error:", err);
        return null;
    }
}

// Base62 編碼字元集
const base62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

// 使用 BigInt 來產生指定長度的 candidate 字串
function getCandidate(hashBigInt, len) {
    const modVal = BigInt(62) ** BigInt(len);
    const candidateNum = hashBigInt % modVal;
    let candidate = "";
    let temp = candidateNum;
    if (temp === BigInt(0)) {
        candidate = "0";
    } else {
        while (temp > 0) {
            const remainder = temp % BigInt(62);
            candidate = base62[Number(remainder)] + candidate;
            temp = temp / BigInt(62);
        }
    }
    // 補足不足至指定長度
    while (candidate.length < len) {
        candidate = "0" + candidate;
    }
    return candidate;
}

// 根據 recordId、destinationUrl 與 URL_KEY 產生 SHA256 hash，並轉換成 BigInt
function generateHashBigInt(recordId, destinationUrl) {
    const data = recordId.toString() + destinationUrl + process.env.URL_KEY;
    const hashHex = crypto.createHash('sha256').update(data).digest('hex');
    const hashBigInt = BigInt("0x" + hashHex);
    console.debug(`[DEBUG] Generated hash BigInt: ${hashBigInt}`);
    return hashBigInt;
}

// 主要處理邏輯：根據傳入的資料產生短網址
async function processShortenPayload(encryptedInput, source_ip) {
    let payload;
    // 判斷是否為 plain text 輸入 (例如以 "http" 開頭)
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
    const title = payload.title || "";
    if (!destinationUrl) {
        throw new Error("目標網址 (target) 為必填項");
    }

    const client = await pool.connect();
    console.debug("[DEBUG] PostgreSQL client acquired.");
    try {
        await client.query('BEGIN');
        console.debug("[DEBUG] Transaction started.");

        // 產生一個臨時 identity，避免 INSERT 時欄位為 NULL（此處使用 16 字節隨機數轉為十六進位字串）
        const tempIdentity = crypto.randomBytes(16).toString('hex');
        console.debug(`[DEBUG] Generated temporary identity: ${tempIdentity}`);

        // INSERT 新記錄，將 title 一併儲存
        const insertQuery = `
            INSERT INTO url_list (source_ip, destination_url, title, identity, is_active, create_at)
            VALUES ($1, $2, $3, $4, true, NOW())
                RETURNING id;
        `;
        const insertResult = await client.query(insertQuery, [source_ip, destinationUrl, title, tempIdentity]);
        console.debug(`[DEBUG] Insert executed, result: ${JSON.stringify(insertResult.rows)}`);
        const insertedId = Number(insertResult.rows[0].id);
        console.debug(`[DEBUG] Inserted record id (as number): ${insertedId}`);

        // 產生 hash BigInt 值，作為生成最終 identity 的基礎
        const hashBigInt = generateHashBigInt(insertedId, destinationUrl);

        // 從最短 6 碼嘗試到 10 碼
        let identityCandidate;
        let updated = false;
        let candidateLength;
        for (candidateLength = 6; candidateLength <= 10; candidateLength++) {
            identityCandidate = getCandidate(hashBigInt, candidateLength);
            console.debug(`[DEBUG] Trying identity candidate (length ${candidateLength}): ${identityCandidate}`);
            try {
                const updateQuery = `UPDATE url_list SET identity = $1 WHERE id = $2;`;
                await client.query(updateQuery, [identityCandidate, insertedId]);
                console.debug(`[DEBUG] Successfully updated identity with candidate: ${identityCandidate}`);
                updated = true;
                break; // 成功即跳出
            } catch (err) {
                if (err.code === '23505') {
                    console.warn(`[DEBUG] Candidate conflict for length ${candidateLength}: ${identityCandidate}`);
                    // 繼續嘗試較長的 candidate
                } else {
                    console.error("[DEBUG] Error during identity update:", err);
                    throw err;
                }
            }
        }
        // 若 6 到 10 碼皆衝突，則以 10 碼的 candidate 加上隨機後綴重試 (最多 5 次)
        let attempt = 0;
        while (!updated && attempt < 5) {
            identityCandidate = getCandidate(hashBigInt, 10) + Math.floor(Math.random() * 10).toString();
            console.debug(`[DEBUG] Fallback candidate attempt ${attempt + 1}: ${identityCandidate}`);
            try {
                const updateQuery = `UPDATE url_list SET identity = $1 WHERE id = $2;`;
                await client.query(updateQuery, [identityCandidate, insertedId]);
                console.debug(`[DEBUG] Successfully updated identity with fallback candidate: ${identityCandidate}`);
                updated = true;
                break;
            } catch (err) {
                if (err.code === '23505') {
                    console.warn(`[DEBUG] Fallback candidate conflict: ${identityCandidate}. Retrying...`);
                    attempt++;
                } else {
                    console.error("[DEBUG] Error during fallback identity update:", err);
                    throw err;
                }
            }
        }
        if (!updated) {
            console.error("[DEBUG] Failed to generate a unique identity after attempts.");
            throw new Error("無法生成唯一識別碼");
        }
        await client.query('COMMIT');
        console.debug("[DEBUG] Transaction committed successfully.");
        client.release();

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

// POST /api/shorten 路由
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

// GET /api/shorten 路由 (供測試使用)
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
