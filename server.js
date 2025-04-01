const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// 提供 public 資料夾中的靜態檔案
app.use(express.static('public'));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
