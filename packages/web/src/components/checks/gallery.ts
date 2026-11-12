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

/** The theme a gallery shows its shots in. */
export type PreviewTheme = (typeof THEMES)[number];

/** A state's shots in one theme, phone first, each with its image link when the hub gave one. */
export function shotsIn(state: PreviewState, theme: PreviewTheme, urls: Readonly<Record<string, string>>): Array<{ readonly shot: PreviewShot; readonly url: string | undefined }> {
  return state.shots.filter((shot) => shot.theme === theme).map((shot) => ({ shot, url: urls[shot.image.hash] }));
}

/** One line saying which sizes and themes a component was shot in: "phone and desktop, light and dark". */
export function shotSummary(group: PreviewGroup): string {
  const all = group.states.flatMap((state) => state.shots);
  const viewports = PREVIEW_VIEWPORTS.filter((viewport) => all.some((shot) => shot.viewport === viewport));
  const themes = THEMES.filter((theme) => all.some((shot) => shot.theme === theme));
  return `${viewports.join(' and ')}, ${themes.join(' and ')}`;
}
