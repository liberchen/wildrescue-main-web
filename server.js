const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// 設定 public 資料夾為靜態資源目錄
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
