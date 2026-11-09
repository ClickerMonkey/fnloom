/** The props of this system's query visuals: the SDK's visual view, with this system's client. */
import type { VisualView, WithSystem } from '@harness/sdk';
import type { DatabaseContract } from '../shared/index.ts';

/** What a query visual is drawn with. */
export type VisualProps = VisualView & WithSystem<DatabaseContract['defs']>;
