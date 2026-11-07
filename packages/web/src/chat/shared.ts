/**
 * The chat's own Vue and SDK, handed to systems' client builds (which keep both external) before the first one
 * loads. Imported lazily, so the app's first page doesn't carry the SDK.
 */
import * as sdk from '@harness/sdk';
import { shareModules } from '@harness/sdk/client';
import * as vue from 'vue';

/** Share the chat's modules with system builds. */
export function shareChatModules(): void {
  shareModules({ vue, sdk });
}
