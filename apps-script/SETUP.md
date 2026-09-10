# Apps Script Drive relay 최초 설정

이 작업은 한 번만 합니다. 설정이 끝나면 Google Drive OAuth refresh token 갱신은 필요하지 않습니다.

## 1. Apps Script 만들기

1. https://script.google.com 에서 새 프로젝트를 만듭니다.
2. 프로젝트 이름 예: `auto-sort-drive-relay`
3. 기본 `Code.gs` 내용을 모두 지우고 이 저장소의 `apps-script/Code.gs` 전체를 붙여넣습니다.
4. 저장합니다.

## 2. 중계용 비밀키 만들기

Cloud Shell에서 아래를 실행합니다.

```bash
RELAY_KEY=$(openssl rand -hex 32)
printf '%s\n' "$RELAY_KEY"
```

표시된 값을 Apps Script의 **프로젝트 설정 → 스크립트 속성**에 다음과 같이 등록합니다.

- 속성: `RELAY_KEY`
- 값: 위에서 생성한 값

이 값은 공개하거나 GitHub에 커밋하지 않습니다.

## 3. Apps Script 웹앱 배포

1. 오른쪽 위 **배포 → 새 배포**
2. 유형: **웹 앱**
3. 실행 사용자: **나**
4. 액세스 권한: **모든 사용자(Anyone)**
5. 배포 후 Google Drive 권한을 승인합니다.
6. 생성된 `/exec` 웹앱 URL을 복사합니다.

Cloud Run이 Google 로그인 없이 호출해야 하므로 액세스 권한은 `모든 사용자`여야 합니다. 실제 업로드 요청은 별도의 `RELAY_KEY`로 검증합니다.

## 4. Secret Manager에 URL과 비밀키 저장

같은 Cloud Shell 세션에서 다음을 실행합니다. `WEB_APP_URL`에는 방금 받은 `/exec` URL을 붙여넣습니다.

```bash
gcloud config set project auto-sort-507309

read -p "Apps Script /exec URL: " WEB_APP_URL

printf '%s' "$WEB_APP_URL" | gcloud secrets create apps-script-web-app-url --data-file=- 2>/dev/null || \
printf '%s' "$WEB_APP_URL" | gcloud secrets versions add apps-script-web-app-url --data-file=-

printf '%s' "$RELAY_KEY" | gcloud secrets create apps-script-relay-key --data-file=- 2>/dev/null || \
printf '%s' "$RELAY_KEY" | gcloud secrets versions add apps-script-relay-key --data-file=-

unset WEB_APP_URL RELAY_KEY
```

이미 Secret이 존재하면 자동으로 새 버전을 추가합니다.

## 5. Cloud Run 서비스 계정에 Secret 읽기 권한 확인

현재 런타임 서비스 계정이 Secret Manager 접근 권한이 없다면 아래를 실행합니다.

```bash
RUNTIME_SA=$(gcloud run services describe site-photo-uploader \
  --region asia-northeast3 \
  --format='value(spec.template.spec.serviceAccountName)')

if [ -z "$RUNTIME_SA" ]; then
  PROJECT_NUMBER=$(gcloud projects describe auto-sort-507309 --format='value(projectNumber)')
  RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

gcloud secrets add-iam-policy-binding apps-script-web-app-url \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role='roles/secretmanager.secretAccessor'

gcloud secrets add-iam-policy-binding apps-script-relay-key \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role='roles/secretmanager.secretAccessor'
```

## 6. Cloud Run에 새 중계 설정 적용

```bash
gcloud run services update site-photo-uploader \
  --region asia-northeast3 \
  --update-secrets APPS_SCRIPT_WEB_APP_URL=apps-script-web-app-url:latest,APPS_SCRIPT_RELAY_KEY=apps-script-relay-key:latest \
  --update-env-vars IMAGE_PROCESSING_MODE=jpeg,IMAGE_MAX_EDGE=2560,IMAGE_JPEG_QUALITY=80,APPS_SCRIPT_TIMEOUT_MS=120000,APPS_SCRIPT_MAX_ENCODED_BYTES=41943040
```

그 뒤 최신 백엔드 코드를 Cloud Run에 배포합니다. 저장소의 `Deploy backend to Cloud Run` GitHub Actions workflow를 수동 실행해도 됩니다.

## 7. 확인

Health check:

```bash
curl -s https://site-photo-uploader-849431387447.asia-northeast3.run.app/health
```

새 버전이면 응답에 다음이 포함됩니다.

```json
"driveTransport":"apps-script"
```

실제 사진 1장을 업로드한 뒤 성공 로그를 확인합니다.

```bash
gcloud logging read \
'resource.type="cloud_run_revision"
AND resource.labels.service_name="site-photo-uploader"
AND (jsonPayload.event="APPS_SCRIPT_DRIVE_UPLOAD" OR jsonPayload.event="CLASSIFICATION_REQUEST_FAILED")' \
--freshness=15m \
--limit=50 \
--order=desc \
--format="table(timestamp,jsonPayload.event,jsonPayload.siteName,jsonPayload.error,jsonPayload.duplicate)"
```

`APPS_SCRIPT_DRIVE_UPLOAD`이 나오고 Drive에 사진이 생성되면 완료입니다.

## 8. 기존 OAuth 정리

Apps Script 방식의 정상 업로드를 확인한 뒤에만 기존 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` Cloud Run 환경/Secret 연결을 제거할 수 있습니다. Secret 자체를 바로 삭제할 필요는 없습니다.
