# 저장소 작업 규칙

## Git 원격 저장소와 PR

- 이 프로젝트의 기본 작업·게시 대상은 `origin`인 `https://github.com/elicie/dsh-superagent-prototype`입니다.
- `upstream`인 `https://github.com/deepseek-ai/dsh-superagent-prototype`은 원본 변경 사항을 가져와 비교하고 포크와 동기화할 때만 사용합니다.
- `upstream`에 PR을 생성하거나 코드·브랜치를 푸시하지 마세요. GitHub 웹 화면, CLI, API를 통한 작업에도 같은 규칙을 적용합니다.
- 원본에 이슈·댓글·리뷰를 게시하거나 원본을 그 밖의 게시 대상으로 사용하지 마세요. `upstream`은 읽기와 동기화 전용입니다.
- PR 생성이 별도로 승인되면 대상 저장소를 `elicie/dsh-superagent-prototype`으로 명시하세요. 예: `gh pr create --repo elicie/dsh-superagent-prototype ...`.
- 푸시·PR 생성·병합·게시 작업은 사용자가 해당 작업을 요청하거나 승인한 뒤 실행합니다. 이 규칙을 저장하라는 요청은 게시 승인이 아닙니다.
- 기본 Git 푸시와 GitHub CLI 대상은 `origin`으로 유지하고, `upstream`의 푸시 차단 설정을 유지하세요.
- 원본과 동기화할 때는 먼저 변경 내용을 확인하고 로컬의 미커밋 작업을 보존하세요. 로컬 기록을 덮어쓰거나 작업을 버리는 동작은 별도 승인 없이 수행하지 마세요.
