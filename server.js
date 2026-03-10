const express = require('express');
const cors = require('cors');
const { Octokit } = require('@octokit/rest');
const multer = require('multer');
const admZip = require('adm-zip');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs-extra');
require('dotenv').config();

// THÊM MỚI: Import và khởi tạo Supabase
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY // Hãy check kỹ tên biến này xem có khớp với file .env không
);

const app = express();

app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

const { GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_REPO, PORT } = process.env;
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const remoteUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${GITHUB_REPO}.git`;

// --- ROUTE 1: XỬ LÝ UPLOAD VÀ ĐẨY CODE LÊN GITHUB ---
app.post('/upload', upload.single('file'), async (req, res) => {
    // 1. KIỂM TRA TỆP TIN
    if (!req.file) return res.status(400).send({ error: 'Không tìm thấy file upload' });

    // 2. THÊM MỚI: BẮT VÀ XÁC THỰC TOKEN TỪ CLI
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ error: 'Từ chối truy cập: Thiếu Token xác thực' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    
    // Gọi Supabase để đổi Token lấy thông tin User
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
        return res.status(401).send({ error: 'Token không hợp lệ hoặc đã hết hạn' });
    }

    const zipPath = req.file.path;
    const extractPath = path.join(__dirname, 'temp_workspace');

    try {
        const projectName = req.body.projectName || 'teicloud-app';
        
        console.log(`👤 Người dùng [${user.email}] đang deploy dự án: ${projectName}`);
        if (fs.existsSync(extractPath)) fs.removeSync(extractPath);
        
        const zip = new admZip(zipPath);
        zip.extractAllTo(extractPath, true);

        console.log('⚙️ Đang tự động tiêm cấu hình GitHub Actions...');
        const githubDir = path.join(extractPath, '.github', 'workflows');
        fs.ensureDirSync(githubDir);

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

        // 3. THÊM MỚI: GHI SỔ DỰ ÁN VÀO CƠ SỞ DỮ LIỆU
        console.log('💾 Đang lưu thông tin dự án vào cơ sở dữ liệu...');
        
        // Mẹo nhỏ: In ra log để check xem Node.js đã nhận được khóa chưa (Che đi một nửa cho an toàn)
        const keyCheck = process.env.SUPABASE_SERVICE_KEY ? "🔑 Đã nhận Service Key" : "❌ THIẾU SERVICE KEY";
        console.log(keyCheck);

        const { error: dbError } = await supabase
            .from('projects') 
            .insert([
                {
                    name: projectName,
                    url: `https://${projectName}.pages.dev`,
                    status: 'active',
                    user_id: user.id
                }
            ]);

        if (dbError) {
            console.error('⚠️ Lỗi lưu Database:', dbError);
        } else {
            console.log('✅ Đã ghi sổ dự án thành công vào Supabase!');
        }

        console.log(`✅ Đã xử lý toàn tất dự án ${projectName}!`);
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

// --- ROUTE 2: KIỂM TRA TRẠNG THÁI DEPLOY ---
app.get('/status/:projectName', async (req, res) => {
    // ... (Phần code này giữ nguyên) ...
    try {
        const { projectName } = req.params;
        const { data } = await octokit.actions.listWorkflowRunsForRepo({
            owner: GITHUB_USERNAME,
            repo: GITHUB_REPO,
            per_page: 1
        });

        if (data.workflow_runs.length === 0) return res.json({ status: 'queued' });
        const latestRun = data.workflow_runs[0];

        res.json({
            status: latestRun.status,
            conclusion: latestRun.conclusion,
            url: `https://${projectName}.pages.dev`
        });

    } catch (error) {
        console.error("Lỗi lấy trạng thái GitHub:", error);
        res.status(500).json({ error: "Không thể lấy trạng thái từ GitHub" });
    }
});

const port = PORT || 3000;
app.listen(port, () => {
    console.log(`🔥 TeiCloud Backend đang chạy tại port ${port}`);
});