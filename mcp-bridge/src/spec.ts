/**
 * BEHAVIOR_SPEC 값의 single source of truth.
 *
 * 같은 임계값을 두 파일에 직접 쓰면 한쪽만 갱신되는 drift가 일어난다.
 * 과거에 sweeper 임계값을 15s/5min 등으로 멋대로 바꾼 회귀가 반복된 핵심
 * 이유였다. 모든 spec-derived 상수는 여기에서 export하고, 다른 모듈은
 * literal을 박지 말고 이 파일에서 import한다.
 *
 * 값을 바꿔야 한다면 BEHAVIOR_SPEC.md를 먼저 갱신하고 사용자 sign-off를
 * 받은 뒤 이 파일을 수정하라. 거꾸로 가지 마라.
 */

/** §2 lifecycle — sub-agent 캐릭터가 침묵한 뒤 despawn까지 30초. */
export const DESPAWN_SUB_MS = 30_000

/** §2 lifecycle — main 캐릭터가 침묵한 뒤 despawn까지 60초. */
export const DESPAWN_MAIN_MS = 60_000

/** §2 sweeper 스캔 주기. 임계값에 비해 충분히 조밀해서 ±5초 안에 잡힌다. */
export const SWEEPER_INTERVAL_MS = 5_000

/** §3 HUD 5h rolling token-window 길이. */
export const QUOTA_WINDOW_MS = 5 * 3600 * 1000

/** §3 quotaWindow 재계산 주기 (분당). */
export const QUOTA_TICK_MS = 60_000

/** §3 토큰 budget 기본값. env `PIXEL_OFFICE_5H_TOKEN_BUDGET`로 override.
 *  Anthropic이 공개 plan budget을 안 줘서 추정치이고, 표시는 절대 토큰
 *  ("N / 5h")이라 분모 부정확성이 사용자에게 직접 영향 주지 않는다. */
export const DEFAULT_5H_TOKEN_BUDGET = 1_000_000
