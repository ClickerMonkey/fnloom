/** A fixture "core" package: zod schemas with types inferred from them, as `@harness/core` writes them. */
import { z } from 'zod';

/** Where a point is. */
export const Point = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;

/** A named shape made of points. */
export const Shape = z.object({ name: z.string(), points: z.array(Point) });
export type Shape = z.infer<typeof Shape>;

/** A plain union, written by hand. */
export type Color = 'red' | 'green';

/** A helper of the core package: code, not a shape, so never documented as reached. */
export function area(shape: Shape): number {
  return shape.points.length;
}
