/**
 * The component preview gallery's rules: a system's preview shots grouped by component, then by named state, each
 * state with the sizes and themes it was shot in, in the order the kit shoots them.
 */
import { PREVIEW_VIEWPORTS, type PreviewShot } from '@harness/core';

/** One named state of a component, with the shots taken of it. */
export interface PreviewState {
  readonly state: string;
  readonly shots: readonly PreviewShot[];
}

/** One component, with its states. */
export interface PreviewGroup {
  readonly component: string;
  readonly states: readonly PreviewState[];
}

const THEMES = ['light', 'dark'] as const;

/** Group shots by component and state, keeping the order components and states first appear in. */
export function previewGroups(shots: readonly PreviewShot[]): PreviewGroup[] {
  const groups = new Map<string, Map<string, PreviewShot[]>>();
  for (const shot of shots) {
    const states = groups.get(shot.component) ?? new Map<string, PreviewShot[]>();
    states.set(shot.state, [...(states.get(shot.state) ?? []), shot]);
    groups.set(shot.component, states);
  }
  const order = (shot: PreviewShot): number => PREVIEW_VIEWPORTS.indexOf(shot.viewport) * THEMES.length + THEMES.indexOf(shot.theme);
  return [...groups].map(([component, states]) => ({
    component,
    states: [...states].map(([state, list]) => ({ state, shots: [...list].sort((a, b) => order(a) - order(b)) })),
  }));
}
