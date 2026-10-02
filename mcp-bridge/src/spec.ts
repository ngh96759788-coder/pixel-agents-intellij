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

/** §3 5h 윈도우 합산의 버킷별 가중치. 가중치 없이 더하면 합계의 98.8%가
 *  cache read 라서(실측) 리미트 잔여량과 거의 무관한 숫자가 된다. 값은
 *  공개 과금 배수이고 webview 의 `estimateCost()` 가 쓰는 것과 같다.
 *  Kotlin `Constants.QUOTA_WEIGHT_*` 와 같은 값을 유지할 것. */
export const QUOTA_WEIGHTS = {
  input_tokens: 1.0,
  cache_creation_input_tokens: 1.25,
  cache_read_input_tokens: 0.10,
  output_tokens: 1.0,
} as const

/** §3 토큰 budget 기본값. env `PIXEL_OFFICE_5H_TOKEN_BUDGET`로 override.
 *  Anthropic이 공개 plan budget을 안 줘서 추정치이고, 표시는 절대 토큰
 *  ("N / 5h")이라 분모 부정확성이 사용자에게 직접 영향 주지 않는다. */
export const DEFAULT_5H_TOKEN_BUDGET = 1_000_000

/** §3 Desktop `plan-usage-history.json` 표본을 실제 5h 사용률로 믿는 최대 나이.
 *  Desktop 표본 간격 실측 15분 + 여유 5분. CLI statusline 값에는 나이 제한이
 *  없고 `resets_at`이 지나면 버린다. Kotlin `Constants.DESKTOP_USAGE_SAMPLE_MAX_AGE_MS`
 *  와 같은 값을 유지할 것. */
export const DESKTOP_USAGE_SAMPLE_MAX_AGE_MS = 20 * 60 * 1000
