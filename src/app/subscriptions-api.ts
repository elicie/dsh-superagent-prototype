/** Credential-free subscription login views shared by the host and model settings extension. */
const VERIFICATION_ORIGINS = new Set(['https://accounts.x.ai', 'https://auth.x.ai'])
/** xAI issues device challenges at auth.x.ai and sends people to accounts.x.ai for approval. */
export function verificationLink(value: string | undefined): string | undefined {
  if (!value || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && VERIFICATION_ORIGINS.has(url.origin) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
export type SubscriptionPhase = 'pending' | 'authorized' | 'cancelled' | 'expired' | 'failed'
export const SUBSCRIPTION_ERRORS = ['unavailable', 'denied', 'expired', 'network', 'unsupported', 'conflict', 'api-key'] as const
export type SubscriptionError = typeof SUBSCRIPTION_ERRORS[number]
export interface SubscriptionAttempt {
  id: string
  phase: SubscriptionPhase
  expiresAt: string
  code?: string
  verificationUri?: string
  error?: SubscriptionError
}
export interface SubscriptionView {
  available: boolean
  writable: boolean
  connected: boolean
  busy: boolean
  credential: 'subscription' | 'api-key' | 'none'
  route: 'unconfigured' | 'subscription' | 'api-key' | 'custom'
  revision?: number
  canActivate: boolean
  activationBlocked?: 'inherited-api-key'
  attempt?: SubscriptionAttempt
}
