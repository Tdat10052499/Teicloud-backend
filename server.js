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
        // Lấy tên project do CLI gửi lên (nếu không có thì mặc định là teicloud-app)
        const projectName = req.body.projectName || 'teicloud-app';
        
        console.log(`📦 Đang giải nén code cho dự án: ${projectName}...`);
        if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
        
        const zip = new admZip(zipPath);
        zip.extractAllTo(extractPath, true);

        console.log('⚙️ Đang tự động tiêm cấu hình GitHub Actions...');
        const githubDir = path.join(extractPath, '.github', 'workflows');
        fs.ensureDirSync(githubDir);

        // Chèn động (dynamic) tên project vào file deploy.yml
        const workflowContent = 
`name: Deploy ${projectName}
on:
  push:
    branches:
      - production

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Auto-create Cloudflare Project (if not exists)
        run: |
          curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/\${{ secrets.CLOUDFLARE_ACCOUNT_ID }}/pages/projects" \\
               -H "Authorization: Bearer \${{ secrets.CLOUDFLARE_API_TOKEN }}" \\
               -H "Content-Type: application/json" \\
               -d '{"name":"${projectName}","production_branch":"production"}'

      - name: Deploy to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy . --project-name=${projectName}`;
          //Chú ý dòng trên cùng: Tên project đã trở thành biến động!

        fs.writeFileSync(path.join(githubDir, 'deploy.yml'), workflowContent);

        console.log('🚀 Đang khởi tạo Git và đẩy lên GitHub Repo Teicloud...');
        const git = simpleGit(extractPath);
        
        await git.init();
        await git.addConfig('user.name', 'TeiCloud System');
        await git.addConfig('user.email', 'bot@teicloud.com');
        await git.addRemote('origin', remoteUrl);
        await git.checkoutLocalBranch('production');
        await git.add('.');
        
        // Cập nhật lời nhắn commit để biết đang deploy dự án nào
        await git.commit(`Tự động Deploy dự án [${projectName}] lúc: ${new Date().toLocaleString()}`);
        
        await git.push('origin', 'production', {'--force': null});

        console.log(`✅ Đã đẩy code dự án ${projectName} thành công lên GitHub!`);
        res.status(200).send({ 
            message: `Deploy thành công! Đang tiến hành build website cho [${projectName}].`,
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