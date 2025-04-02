const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Debug middleware：紀錄每個請求
app.use((req, res, next) => {
    console.log(`[DEBUG] ${req.method} ${req.url}`);
    next();
});

// 設定 public 資料夾為靜態資源目錄
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
