/** The rc.3 host supplies this owner share on both add-provider drafts and saved provider rows. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
export interface ModelProviderCardOwner {
  provider: { readonly provider: string }
  configured: boolean
  keyConfigured: boolean
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.models.provider-card': { kind: 'keyed'; scope: 'root'; owner: ModelProviderCardOwner }
  }
}
