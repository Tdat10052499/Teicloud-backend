const express = require('express');
const multer = require('multer');
const admZip = require('adm-zip');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

// Cấu hình nơi lưu file zip tạm thời
const upload = multer({ dest: 'uploads/' });

// Lấy thông tin từ file .env
const { GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO, PORT } = process.env;

// Tạo URL chứa Token để tự động đăng nhập GitHub
const remoteUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${GITHUB_REPO}.git`;

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send({ error: 'Không tìm thấy file upload' });

    const zipPath = req.file.path;
    const extractPath = path.join(__dirname, 'temp_workspace');

    try {
        console.log('📦 Đang giải nén code từ CLI...');
        // Dọn dẹp không gian làm việc cũ (nếu có)
        if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
        
        // Giải nén file Zip
        const zip = new admZip(zipPath);
        zip.extractAllTo(extractPath, true);

        console.log('🚀 Đang khởi tạo Git và đẩy lên GitHub Repo Teicloud...');
        const git = simpleGit(extractPath);
        
        // Các lệnh Git tự động
        await git.init();
        await git.addConfig('user.name', 'TeiCloud System');
        await git.addConfig('user.email', 'bot@teicloud.com');
        await git.addRemote('origin', remoteUrl);
        await git.add('.');
        await git.commit(`Tự động Deploy lúc: ${new Date().toLocaleString()}`);
        
        // Push đè (force) để GitHub thay thế hoàn toàn code cũ bằng code mới
        await git.push('origin', 'production', {'--force': null});

        console.log('✅ Đã đẩy code thành công lên GitHub!');
        res.status(200).send({ 
            message: 'Deploy thành công! TeiCloud đang tiến hành build website của bạn.',
            github_url: `https://github.com/${GITHUB_USERNAME}/${GITHUB_REPO}/actions`
        });

    } catch (error) {
        console.error('❌ Lỗi hệ thống:', error);
        res.status(500).send({ error: 'Quá trình xử lý thất bại.', detail: error.message });
    } finally {
        // Luôn dọn dẹp file rác sau khi xong việc để tiết kiệm dung lượng server
        if (fs.existsSync(zipPath)) fs.removeSync(zipPath);
        if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
    }
});

// Khởi động Server
const port = PORT || 3000;
app.listen(port, () => {
    console.log(`🔥 TeiCloud Backend đang mở cửa tại http://localhost:${port}`);
});