# 영산강권역 소규모감시망 현장사진 자동분류 업로더

작업자는 GitHub Pages에서 원본 사진을 선택해 업로드합니다. Cloud Run 백엔드가 사진 EXIF의 GPS/촬영일을 읽고, 등록 지점 반경 300m 기준으로 현장을 판정하여 Google Drive의 `지점명/촬영일` 폴더에 저장합니다.

## 구성

- `frontend/` GitHub Pages 정적 프론트
- `backend/` Google Cloud Run Node.js 백엔드
- `backend/config/sites.json` 업로드된 WGS84 좌표 10개 지점
- Google Drive: 최종 사진 저장

## 현재 정책

- 업로드 당시 스마트폰 위치: 사용 안 함
- 현장 QR: 사용 안 함
- 업체별 링크: 사용 안 함
- GPS 없는 사진: `미분류`
- 등록 지점에서 300m 초과 사진: `미분류`
- 촬영일: EXIF DateTimeOriginal → CreateDate → ModifyDate, 없으면 `촬영일미확인`
- 이미지 압축: **기본 비활성화 (`IMAGE_PROCESSING_MODE=original`)**
- 압축 후보 기능은 구현되어 있으며 실제 현장사진 테스트 후 `jpeg`로 전환
- 별도 DB: 없음. Drive 폴더 + 파일 appProperties만 사용

## 현재 연결 대상 Google Drive

- 루트 폴더 ID: `1zrvLjuogEAC1fwgqxlU9kGhVVmDEufoz`
- 폴더명: `영산강권역 소규모감시망 시공사진`
