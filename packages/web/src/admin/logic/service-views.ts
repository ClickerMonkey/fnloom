/**
 * Build 9: what the pages of a fleet of remote services (MCP servers, API services) hand their shared components: a
 * row of the fleet's list (`ServiceRows`) and a fact about one service (`FactList`).
 */
import type { RouteLocationRaw } from 'vue-router';
import type { StatusLook } from './systems.ts';

/** One service as its row in the fleet's list shows it. */
export interface ServiceRow {
  readonly key: string;
  readonly to: RouteLocationRaw;
  readonly label: string;
  readonly look: StatusLook;
  readonly where: string;
  readonly detail: string;
  /** A warning badge (tools mapped loosely). */
  readonly warning?: string | undefined;
  /** Its figures (what it mirrors). */
  readonly figures?: string | undefined;
}

/** One fact about a service (its URL, sign-in, limits) as a label and value; a value that is code is drawn as code. */
export interface Fact {
  readonly label: string;
  readonly value: string;
  /** More, on hover (a full time). */
  readonly title?: string | undefined;
  readonly code?: boolean | undefined;
}
