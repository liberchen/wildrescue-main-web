const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

// 原有與新增的路由
const rRoute = require('./routes/r');               // 轉址功能
const generatorRoute = require('./routes/generator'); // 加密連結產生器
const jRoute = require('./routes/j');                 // 新增 j.js：解密並轉址（含熱門社群 deep link）
const shortenRoute = require('./routes/shorten');     // 新增 shorten API，用於產生短網址

const app = express();
const PORT = process.env.PORT || 3000;

// 使用 body-parser 解析 JSON 請求
app.use(bodyParser.json());

// Debug middleware (可選)
app.use((req, res, next) => {
    console.log(`[DEBUG] ${req.method} ${req.url}`);
    next();
});

// 掛載各 API 路由
app.use('/r', rRoute);
app.use('/api/generate', generatorRoute);
app.use('/j', jRoute);
app.use('/api/shorten', shortenRoute);  // 新增 shorten API 路由

// 提供 public 資料夾中的靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
