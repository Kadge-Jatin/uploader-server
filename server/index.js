const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Octokit } = require('@octokit/rest');
const { v4: uuidv4 } = require('uuid');
const upload = multer();
const app = express();
app.use(cors());
app.use(express.json());

const OWNER = process.env.REPO_OWNER;
const REPO = process.env.REPO_NAME;
const TOKEN = process.env.GITHUB_TOKEN;

if (!OWNER || !REPO || !TOKEN) {
  console.error('Missing REPO_OWNER, REPO_NAME, or GITHUB_TOKEN env vars.');
  process.exit(1);
}

const octokit = new Octokit({ auth: TOKEN });

app.get('/', (req, res) => res.send('GitHub uploader running'));

app.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const files = req.files || [];
    const bgName = req.body && req.body.bg ? String(req.body.bg) : null;
    const useDefaultMusic = req.body && req.body.useDefaultMusic === 'true';
    const sender = req.body && req.body.sender ? String(req.body.sender).slice(0, 200) : '';
    const receiver = req.body && req.body.receiver ? String(req.body.receiver).slice(0, 200) : '';
    const message = req.body && req.body.message ? String(req.body.message).slice(0, 2000) : '';
    const theme = req.body && req.body.theme ? String(req.body.theme).slice(0, 100) : '';
    
    if (!files.length && !useDefaultMusic) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    const id = uuidv4().replace(/-/g, '');
    const repoInfo = await octokit.repos.get({ owner: OWNER, repo: REPO });
    const branch = repoInfo.data.default_branch || 'main';
    const rawBase = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${branch}/`;
    const uploaded = [];
    
    for (const f of files) {
      const name = (f.originalname || 'file').replace(/^\/+/, '');
      const path = `uploads/${id}/${name}`;
      const contentBase64 = f.buffer.toString('base64');
      
      await octokit.repos.createOrUpdateFileContents({
        owner: OWNER,
        repo: REPO,
        path,
        message: `Add uploaded file ${path}`,
        content: contentBase64,
        branch
      });
      
      uploaded.push({
        name,
        path,
        url: rawBase + `uploads/${id}/` + encodeURIComponent(name)
      });
    }
    
    let background = null;
    
    if (useDefaultMusic) {
      background = {
        name: 'music.mp3',
        url: `https://${OWNER}.github.io/${REPO}/music.mp3`
      };
    } else if (bgName) {
      const match = uploaded.find(u => u.name === bgName);
      if (match) background = { name: match.name, url: match.url };
    }
    
    const shareObj = {
      id,
      created_at: new Date().toISOString(),
      sender: sender || undefined,
      receiver: receiver || undefined,
      message: message || undefined,
      theme: theme || undefined,
      files: uploaded
    };
    
    if (background) shareObj.background = background;
    
    const sharePath = `shares/${id}.json`;
    const shareContentBase64 = Buffer.from(JSON.stringify(shareObj, null, 2)).toString('base64');
    
    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER,
      repo: REPO,
      path: sharePath,
      message: `Add share descriptor ${sharePath}`,
      content: shareContentBase64,
      branch
    });
    
    const pagesURL = `https://${OWNER}.github.io/${REPO}/view.html?share=${id}`;
    return res.json({ id, pagesURL, share: shareObj });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Uploader listening on ${PORT}`));
