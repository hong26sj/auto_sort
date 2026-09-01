import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');

const port = 8085;
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const scope = ['https://www.googleapis.com/auth/drive'];
const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope });

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, redirectUri);
    if (u.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
    const code = u.searchParams.get('code');
    if (!code) throw new Error(u.searchParams.get('error') || 'Authorization code missing');
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('인증 완료. 이 창을 닫고 터미널로 돌아가세요.');
    console.log('\n인증 완료. 아래 값을 backend/.env에 저장하세요.\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token || ''}`);
    console.log('\nRefresh Token이 비어 있으면 기존 앱 권한을 취소한 뒤 다시 실행하세요.');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`인증 실패: ${e.message}`);
    console.error(e);
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('브라우저에서 아래 URL을 여세요:\n');
  console.log(url);
});
