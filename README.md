# 영산강권역 소규모감시망 현장사진 자동분류 업로더

작업자는 GitHub Pages에서 원본 사진을 선택해 업로드합니다. 브라우저가 GCS로 직접 전송하고, Cloud Tasks가 사진별 처리를 예약합니다. Cloud Run은 사진 EXIF의 GPS/촬영일을 읽고 등록 지점 반경 300m 기준으로 현장을 판정한 뒤, 긴 변 최대 2560px / JPEG 품질 80으로 처리합니다. 최종 파일은 Google Apps Script 웹앱을 통해 Google Drive의 `지점명/촬영일` 폴더에 저장됩니다.

## 구성

- `frontend/` GitHub Pages 정적 프론트
- `backend/` Google Cloud Run Node.js 백엔드
- `backend/config/sites.json` WGS84 좌표 10개 지점
- `apps-script/Code.gs` Google Drive 저장 중계 웹앱
- GCS: 업로드 원본 임시 보관
- Cloud Tasks: 사진별 비동기 처리
- Google Drive: 최종 사진 저장

## 처리 흐름

`브라우저 → GCS → Cloud Tasks → Cloud Run(EXIF/GPS 분류 + 이미지 처리) → Apps Script → Google Drive → GCS 원본 삭제`

Google Drive OAuth refresh token은 더 이상 정상 운영 경로에서 사용하지 않습니다. Apps Script 웹앱이 사용자 Google 계정 권한으로 Drive 저장을 담당합니다.

## 현재 정책

- 업로드 당시 스마트폰 위치: 사용 안 함
- 현장 QR: 사용 안 함
- 업체별 링크: 사용 안 함
- GPS 없는 사진: `미분류`
- 등록 지점에서 300m 초과 사진: `미분류`
- 촬영일: EXIF DateTimeOriginal → CreateDate → ModifyDate, 없으면 `촬영일미확인`
- 이미지 처리: `IMAGE_PROCESSING_MODE=jpeg`
- 긴 변 최대: `IMAGE_MAX_EDGE=2560`
- JPEG 품질: `IMAGE_JPEG_QUALITY=80`
- Apps Script에는 사진 1장씩 Base64 POST
- Apps Script relay 기본 Base64 허용 상한: 40 MiB
- Drive 저장 성공 후에만 GCS 원본 삭제
- 동일 GCS 객체 재시도 시 결정적 파일명 + Drive 파일명 확인으로 중복 저장 방지
- 별도 DB: 없음

## 현재 연결 대상 Google Drive

- 루트 폴더 ID: `1zrvLjuogEAC1fwgqxlU9kGhVVmDEufoz`
- 폴더명: `영산강권역 소규모감시망 시공사진`

## Apps Script 최초 설정

`apps-script/SETUP.md`를 따라 Apps Script 웹앱을 한 번 배포하고, Cloud Run에 `APPS_SCRIPT_WEB_APP_URL` 및 `APPS_SCRIPT_RELAY_KEY`를 설정합니다.
