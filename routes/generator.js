const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const algorithm = 'aes-256-cbc';
// 從環境變數中取得金鑰 (環境變數名稱：URL_KEY)
const fixedKey = process.env.URL_KEY;
if (!fixedKey) {
    throw new Error("環境變數 URL_KEY 未設置");
}
const key = crypto.createHash('sha256').update(String(fixedKey)).digest().slice(0, 32);
// 固定 IV (示範用途，不建議在生產環境中使用固定 IV)
const iv = Buffer.alloc(16, 0);

function encrypt(text) {
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
}

router.post('/', (req, res) => {
    const { target, title } = req.body;
    if (!target) {
        return res.status(400).json({ error: '請提供 target 欄位' });
    }

    // 將 target 與 title 包成 JSON 字串
    const payload = JSON.stringify({ target, title });
    try {
        const encryptedPayload = encrypt(payload);
        // 取得完整的網址，假設使用目前請求的協定與主機名稱
        const protocol = req.protocol;
        const host = req.get('host');
        const fullUrl = `${protocol}://${host}/r?target=${encodeURIComponent(encryptedPayload)}`;
        return res.json({ url: fullUrl });
    } catch (err) {
        console.error('Encryption error:', err);
        return res.status(500).json({ error: '加密失敗' });
    }
});

module.exports = router;
