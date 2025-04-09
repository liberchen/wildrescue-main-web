const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

// 原有的路由
const rRoute = require('./routes/r');           // 轉址功能
const generatorRoute = require('./routes/generator'); // 加密連結產生器

// 新增 j.js 路由 (負責解密並轉址，並處理熱門社群 deep link 備援)
const jRoute = require('./routes/j');

const app = express();
const PORT = process.env.PORT || 3000;

// 使用 body-parser 解析 JSON 請求
app.use(bodyParser.json());

// Debug middleware (可選)
app.use((req, res, next) => {
    console.log(`[DEBUG] ${req.method} ${req.url}`);
    next();
});

// 掛載路由
app.use('/r', rRoute);
app.use('/api/generate', generatorRoute);
app.use('/j', jRoute);  // 新增的 j.js 路由

// 提供 public 資料夾中的靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
