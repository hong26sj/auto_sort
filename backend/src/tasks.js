import { google } from 'googleapis';

function getTaskConfig() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  const location = process.env.TASK_LOCATION || 'asia-northeast3';
  const queue = process.env.TASK_QUEUE || 'photo-classification';
  const targetBaseUrl = (process.env.TASK_TARGET_URL || '').replace(/\/$/, '');
  const taskCode = process.env.TASK_CODE || process.env.UPLOAD_CODE || '';

  if (!projectId) throw new Error('GOOGLE_CLOUD_PROJECT is not configured.');
  if (!targetBaseUrl) throw new Error('TASK_TARGET_URL is not configured.');
  if (!taskCode) throw new Error('TASK_CODE or UPLOAD_CODE is not configured.');

  return { projectId, location, queue, targetBaseUrl, taskCode };
}

export async function enqueuePhotoClassification(payload) {
  const { projectId, location, queue, targetBaseUrl, taskCode } = getTaskConfig();
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const cloudtasks = google.cloudtasks({ version: 'v2', auth });
  const parent = cloudtasks.projects.locations.queues.getRootUrl
    ? `projects/${projectId}/locations/${location}/queues/${queue}`
    : `projects/${projectId}/locations/${location}/queues/${queue}`;

  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  const response = await cloudtasks.projects.locations.queues.tasks.create({
    parent,
    requestBody: {
      task: {
        httpRequest: {
          httpMethod: 'POST',
          url: `${targetBaseUrl}/api/process-photo`,
          headers: {
            'Content-Type': 'application/json',
            'X-Task-Code': taskCode
          },
          body
        }
      }
    }
  });
  return response.data;
}
