const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

// 載入路由模組
const rRoute = require('./routes/r');               // 轉址功能
const generatorRoute = require('./routes/generator'); // 加密連結產生器
const jRoute = require('./routes/j');                 // j.js：解密並轉址（含熱門社群 deep link）
const shortenRoute = require('./routes/shorten');     // shorten API，用於產生短網址

const app = express();
const PORT = process.env.PORT || 3000;

console.debug(`[DEBUG] Starting server on PORT: ${PORT}`);

// 使用 body-parser 解析 JSON 請求
app.use(bodyParser.json());
console.debug("[DEBUG] bodyParser.json middleware installed.");

// 全域 Debug Middleware：記錄每筆請求的詳細資訊
app.use((req, res, next) => {
    const sourceIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'Unknown';
    console.debug(`[DEBUG] ${req.method} ${req.url} from IP: ${sourceIp}`);
    next();
});

// 掛載路由
app.use('/r', rRoute);
console.debug("[DEBUG] Mounted route '/r' (rRoute)");
app.use('/api/generate', generatorRoute);
console.debug("[DEBUG] Mounted route '/api/generate' (generatorRoute)");
app.use('/j', jRoute);
console.debug("[DEBUG] Mounted route '/j' (jRoute)");
app.use('/api/shorten', shortenRoute);
console.debug("[DEBUG] Mounted route '/api/shorten' (shortenRoute)");

// 提供 public 資料夾中的靜態檔案 (例如 index.html、rescue-stats.html 等)
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
console.debug(`[DEBUG] Serving static files from: ${publicPath}`);

// 全域錯誤處理 Middleware (可選，方便 debug)
app.use((err, req, res, next) => {
    console.error("[DEBUG] Error encountered:", err);
    res.status(500).json({ error: "Internal Server Error" });
});

// 啟動服務
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.debug(`[DEBUG] Server listening on port ${PORT} at ${new Date().toISOString()}`);
});
