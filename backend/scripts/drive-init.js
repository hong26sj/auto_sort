import 'dotenv/config';
import { google } from 'googleapis';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required.');
}
const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth });
const name = process.argv.slice(2).join(' ') || '영산강권역 소규모감시망 시공사진';
const r = await drive.files.create({
  requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
  fields: 'id,name,webViewLink'
});
console.log(`\n생성 완료: ${r.data.name}`);
console.log(`GOOGLE_DRIVE_ROOT_FOLDER_ID=${r.data.id}`);
console.log(r.data.webViewLink || '');
