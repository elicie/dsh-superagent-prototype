# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Language

한국어 화면을 사용하려면 DeepSeek Harness의 **Settings → General → Language**(**설정 → 일반 → 언어**)에서 **한국어**를 선택하세요. Superagent 패널과 함께 사이드바, 대화 화면, 전체 설정, 플러그인·도구 화면을 한국어로 표시합니다. 공통 화면 번역은 DSH 0.2.1-rc.3 기준이며, 이후 추가된 문구와 한국어 메타데이터가 없는 패키지 이름은 영어로 표시될 수 있습니다. 사용자 메시지와 에이전트 프롬프트 원문은 유지됩니다.

## Grok subscription

**설정 → 모델 → 모델 제공업체 추가 → 외부 모델 제공업체**에서 제공업체 **xai**를 선택하면 **Grok 구독**이 나타납니다. **Grok으로 로그인**을 누르면 xAI 인증 창이 열립니다. 새 창에서 코드를 승인하세요. 팝업이 차단되면 **xAI 로그인 열기** 링크로 계속할 수 있습니다. 로그인 완료 후 **xAI 모델에 구독 사용**을 눌러 제공업체를 활성화하고, 판단·실행기 모델 또는 대화창 모델 선택기에서 Grok 모델을 선택합니다. DSH의 네이티브 OAuth·인증 정보 저장소를 사용하며 기존 API 키 설정은 유지합니다. 실제 이용 권한과 모델 호출은 로그인 후 확인해야 합니다. 자세한 인증·취소·로그아웃 및 배포 접근 제한은 [패널 안내](docs/005-panel.md#grok-subscription-sign-in)를 참고하세요.

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
