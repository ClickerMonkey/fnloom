/** A fixture package for the docs generator's tests: one of each kind of export it prints. */
import type { Color, Shape } from './core.ts';

/** Make a shape. */
export function shape(name: string): Shape;
/** Make a shape from points. */
export function shape(points: Shape['points'], name: string): Shape;
export function shape(first: string | Shape['points'], name = ''): Shape {
  return typeof first === 'string' ? { name: first, points: [] } : { name, points: first };
}

/** What a painter can do. */
export interface Painter<C extends Color = Color> {
  /** Paint a shape in a color. */
  paint(shape: Shape, color: C): void;
  readonly brushes: number;
}

/** A painter's mood. */
export type Mood = 'calm' | 'busy';

/** The default brush count. */
export const BRUSHES = 3;

/** The sizes, longest first. */
export const SIZES = ['large', 'medium', 'small'] as const;

/** A painter that remembers what it painted. */
export class Canvas implements Painter {
  /** The shapes painted so far. */
  readonly painted: Shape[] = [];
  readonly brushes = BRUSHES;
  readonly title: string;
  #secret = 0;
  private hidden = 1;

  /** Start empty. */
  constructor(title: string) {
    this.title = title;
  }

  paint(shape: Shape, _color: Color): void {
    this.#secret += this.hidden;
    this.painted.push(shape);
  }

  /** How many shapes. */
  get count(): number {
    return this.painted.length + this.#secret * 0;
  }
}

export { type Point } from './core.ts';
