const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 檢查 og-preview.png 是否存在
const ogImagePath = path.join(__dirname, 'public', 'images', 'og-preview.png');
if (fs.existsSync(ogImagePath)) {
    console.log(`[DEBUG] Found og-preview.png at ${ogImagePath}`);
} else {
    console.log(`[DEBUG] og-preview.png NOT FOUND at ${ogImagePath}`);
}

// Debug middleware：紀錄每個請求（包含靜態檔案請求）
app.use((req, res, next) => {
    console.log(`[DEBUG] ${req.method} ${req.url}`);
    next();
});

// 如果特別想記錄 /images 的請求，也可以這樣做
app.use('/images', (req, res, next) => {
    console.log(`[DEBUG] Requesting image: ${req.originalUrl}`);
    next();
});

// 提供 public 資料夾中的靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

// 其他路由設定，例如 redirect 或 r 路由
const rRoute = require('./routes/r');
app.use('/r', rRoute);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
