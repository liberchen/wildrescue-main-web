const express = require('express');
const path = require('path');
const rRoute = require('./routes/r'); // 引入新的 /r 路由
const app = express();
const PORT = process.env.PORT || 3000;

// 可選的 Debug middleware
app.use((req, res, next) => {
    console.log(`[DEBUG] ${req.method} ${req.url}`);
    next();
});

// 設置 /redirect 路由，專門處理自動跳轉與自訂 OG 預覽
app.use('/r', rRoute);

// 提供 public 資料夾中的靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
