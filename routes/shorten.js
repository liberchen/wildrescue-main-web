const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const router = express.Router();

// 建立 PostgreSQL 連線池 (請確保環境變數 DATABASE_URL 已設置)
const pool = new Pool();

// AES-256-CBC 解密設定
const algorithm = 'aes-256-cbc';
const fixedKey = process.env.URL_KEY;
if (!fixedKey) {
    throw new Error("環境變數 URL_KEY 未設置");
}
const key = crypto.createHash('sha256').update(String(fixedKey)).digest().slice(0, 32);
const iv = Buffer.alloc(16, 0);

// 解密函式，輸入為 Base64 編碼後的字串
function decrypt(text) {
    try {
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

// Base62 編碼函式
const base62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function encodeBase62(num) {
    let str = '';
    while (num > 0) {
        str = base62[num % 62] + str;
        num = Math.floor(num / 62);
    }
    return str || '0';
}

// 新 API 路由：/api/shorten
// 外部呼叫需要 POST 一個 JSON payload，格式例如：
// { "target": "<encrypted_payload>" }
// 注意：加密前的 payload 應為 JSON 格式，內容類似：{ "target": "完整網址", "title": "自訂標題" }
router.post('/api/shorten', async (req, res) => {
    try {
        // 驗證請求 payload
        const encryptedPayload = req.body.target;
        if (!encryptedPayload) {
            return res.status(400).json({ error: "請在 JSON 中提供 target 欄位（加密後的字串）" });
        }

        // 解密取得內部 JSON 資料
        const decryptedPayload = decrypt(encryptedPayload);
        if (!decryptedPayload) {
            return res.status(400).json({ error: "無法解密 target 參數，請檢查加密格式與金鑰" });
        }

        let payload;
        try {
            payload = JSON.parse(decryptedPayload);
        } catch (err) {
            return res.status(400).json({ error: "解密後資料解析失敗，請確認格式" });
        }

        const destinationUrl = payload.target;
        const title = payload.title || "";
        if (!destinationUrl) {
            return res.status(400).json({ error: "目標網址 (target) 為必填項" });
        }

        // 取得來源 IP (透過 x-forwarded-for 或 connection.remoteAddress)
        let source_ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'Unknown';
        if (source_ip.includes(',')) {
            source_ip = source_ip.split(',')[0].trim();
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // 插入新記錄，不包括 identity 欄位 (auto-generated id)
            const insertQuery = `
              INSERT INTO url_list (source_ip, destination_url, is_active, create_at)
              VALUES ($1, $2, true, NOW())
              RETURNING id;
            `;
            const insertResult = await client.query(insertQuery, [source_ip, destinationUrl]);
            const insertedId = insertResult.rows[0].id;

            // 生成初步的身份識別碼 (使用 Base62 編碼)
            let identityCandidate = encodeBase62(insertedId);

            // 更新 identity 欄位，若唯一性衝突則嘗試加上隨機後綴
            let updated = false;
            let attempt = 0;
            while (!updated && attempt < 5) {
                try {
                    const updateQuery = `UPDATE url_list SET identity = $1 WHERE id = $2;`;
                    await client.query(updateQuery, [identityCandidate, insertedId]);
                    updated = true;
                } catch (err) {
                    // PostgreSQL unique violation code: '23505'
                    if (err.code === '23505') {
                        identityCandidate = encodeBase62(insertedId) + Math.floor(Math.random() * 10).toString();
                        attempt++;
                    } else {
                        throw err;
                    }
                }
            }
            if (!updated) {
                throw new Error("無法生成唯一識別碼");
            }
            await client.query('COMMIT');
            client.release();

            // 組成最終轉整網址
            const finalUrl = `https://www.wildrescue.tw/j?target=${encodeURIComponent(identityCandidate)}`;
            return res.json({ url: finalUrl });
        } catch (err) {
            await client.query('ROLLBACK');
            client.release();
            console.error("Database error:", err);
            return res.status(500).json({ error: "資料庫錯誤" });
        }
    } catch (err) {
        console.error("Error:", err);
        return res.status(500).json({ error: "伺服器錯誤" });
    }
});

module.exports = router;
