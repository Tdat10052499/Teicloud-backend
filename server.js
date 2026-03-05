const express = require('express');
const cors = require('cors'); // Đã gộp lại 1 lần
const { Octokit } = require('@octokit/rest');
const multer = require('multer');
const admZip = require('adm-zip');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs-extra');
require('dotenv').config();

const app = express();

// --- Cấu hình Middleware ---
app.use(cors()); // Cho phép Frontend truy cập
app.use(express.json());

// Cấu hình nơi lưu file zip tạm thời
const upload = multer({ dest: 'uploads/' });

// Lấy thông tin từ file .env
const { GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO, PORT } = process.env;

// Khởi tạo Octokit để làm việc với GitHub API
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Tạo URL chứa Token để tự động đẩy code lên GitHub
const remoteUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${GITHUB_REPO}.git`;

// --- ROUTE 1: XỬ LÝ UPLOAD VÀ ĐẨY CODE LÊN GITHUB ---
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send({ error: 'Không tìm thấy file upload' });

    const zipPath = req.file.path;
    const extractPath = path.join(__dirname, 'temp_workspace');

    try {
        const projectName = req.body.projectName || 'teicloud-app';
        
        console.log(`📦 Đang giải nén code cho dự án: ${projectName}...`);
        if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
        
        const zip = new admZip(zipPath);
        zip.extractAllTo(extractPath, true);

        console.log('⚙️ Đang tự động tiêm cấu hình GitHub Actions...');
        const githubDir = path.join(extractPath, '.github', 'workflows');
        fs.ensureDirSync(githubDir);

        // Nội dung file deploy.yml (Tự động tạo project Cloudflare và deploy)
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

        fs.writeFileSync(path.join(githubDir, 'deploy.yml'), workflowContent);

        console.log('🚀 Đang khởi tạo Git và đẩy lên GitHub Repo Teicloud...');
        const git = simpleGit(extractPath);
        
        await git.init();
        await git.addConfig('user.name', 'TeiCloud System');
        await git.addConfig('user.email', 'bot@teicloud.com');
        await git.addRemote('origin', remoteUrl);
        await git.checkoutLocalBranch('production');
        await git.add('.');
        
        await git.commit(`Tự động Deploy dự án [${projectName}] lúc: ${new Date().toLocaleString()}`);
        await git.push('origin', 'production', {'--force': null});

        console.log(`✅ Đã đẩy code dự án ${projectName} thành công lên GitHub!`);
        res.status(200).send({ 
            message: `Deploy thành công! Đang tiến hành build website cho [${projectName}].`,
            projectName: projectName
        });

    } catch (error) {
        console.error('❌ Lỗi hệ thống:', error);
        res.status(500).send({ error: 'Quá trình xử lý thất bại.', detail: error.message });
    } finally {
        if (fs.existsSync(zipPath)) fs.removeSync(zipPath);
        if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
    }
});

// --- ROUTE 2: KIỂM TRA TRẠNG THÁI DEPLOY (DÙNG CHO DASHBOARD) ---
app.get('/status/:projectName', async (req, res) => {
    try {
        const { projectName } = req.params;

        // Truy vấn GitHub API để lấy trạng thái Workflow mới nhất
        const { data } = await octokit.actions.listWorkflowRunsForRepo({
            owner: GITHUB_USERNAME,
            repo: GITHUB_REPO,
            per_page: 1
        });

        if (data.workflow_runs.length === 0) {
            return res.json({ status: 'queued' });
        }

        const latestRun = data.workflow_runs[0];

        res.json({
            status: latestRun.status,       // in_progress, completed, queued
            conclusion: latestRun.conclusion, // success, failure, null
            url: `https://${projectName}.pages.dev`
        });

    } catch (error) {
        console.error("Lỗi lấy trạng thái GitHub:", error);
        res.status(500).json({ error: "Không thể lấy trạng thái từ GitHub" });
    }
});

// Khởi động Server
const port = PORT || 3000;
app.listen(port, () => {
    console.log(`🔥 TeiCloud Backend đang chạy tại port ${port}`);
});