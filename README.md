# Hiworks Mail Notifier (Userscript)

Hiworks 웹메일에서 **새 메일이 도착했을 때만**  
브라우저 알림으로 알려주는 Tampermonkey 사용자 스크립트입니다.

> ⚠️ 현재는 알파(Alpha) 단계이며, 개인 사용을 전제로 개발 중입니다.

---

## 주요 기능 (v0.x)

- 전체 메일함(all) 기준 **안읽음 메일 수 증가 감지**
- 새로 도착한 메일만 **중복 없이(dedupe)** 알림
- 알림 본문에 메일 **제목 / 발신자 요약**
- 알림 클릭 시 **해당 메일 상세 화면으로 바로 이동**
- 초기 실행 시 기존 메일로 인한 알림 폭탄 방지

---

## 동작 방식 요약

- Hiworks 내부 API(`/mbox/status`)를 감지해 새 메일 여부 판단
- 새 메일이 감지되면 최신 메일 목록을 조회
- 이미 알림을 보낸 메일은 로컬 저장소에 기록하여 재알림 방지

---

## 사용 환경

- Tampermonkey (Chrome / Edge / Firefox)
- Hiworks Web Mail  
  `https://mails.office.hiworks.com/*`

---

## 설치 방법

1. Tampermonkey 설치 및 기본 설정(작동하게 하려면 설정을 좀 많이 바꿔야되는데 여기서 설명하긴 귀찮)
2. 아래 URL을 열어 스크립트 설치  
   (배포용 raw URL 기입)

---

## 상태

- 개발 단계: **Alpha**
- API / UI 변경에 따라 동작이 깨질 수 있음

---
