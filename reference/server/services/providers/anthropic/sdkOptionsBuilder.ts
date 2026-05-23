// Anthropic-specific options-builder for the SDK call.
//
// Re-exports the pure helpers that today live in
// `server/services/conversation/sdkOptions.ts`. Phase 3 will move the
// implementation into this module and reduce `sdkOptions.ts` to a thin
// re-export shim so existing imports keep working.

export {
  DEFAULT_PERMISSION_MODE,
  validateAndNormalizeOptions,
  mapOptionsToSDK,
  loadMcpConfig,
} from '../../conversation/sdkOptions.js';

export type { MapOptionsInput, SDKOptions, ValidateOptionsInput } from '../../conversation/sdkOptions.js';
