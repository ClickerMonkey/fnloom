import { describe, expect, it } from 'vitest';
import { ClaimTemplate, fillClaims } from './claims.ts';
import { FnDecl, KindDescription } from './manifest.ts';

describe('fillClaims', () => {
  it('fills a claim from the call args, a dotted path and a list item too', () => {
    expect(fillClaims(['file:{args.path}'], { path: 'src/app.ts' })).toEqual(['file:src/app.ts']);
    expect(fillClaims(['row:{args.where.id}'], { where: { id: 7 } })).toEqual(['row:7']);
    expect(fillClaims(['first:{args.paths.0}'], { paths: ['a', 'b'] })).toEqual(['first:a']);
    expect(fillClaims(['*'], {})).toEqual(['*']);
  });

  it('gives one claim per item of a list, and one per combination of two lists', () => {
    expect(fillClaims(['file:{args.paths}'], { paths: ['a', 'b', 'a'] })).toEqual(['file:a', 'file:b']);
    expect(fillClaims(['{args.db}.{args.tables}'], { db: 'main', tables: ['users', 'orders'] })).toEqual(['main.users', 'main.orders']);
    expect(fillClaims(['{args.a}{args.b}'], { a: [1, 2], b: ['x', 'y'] })).toEqual(['1x', '1y', '2x', '2y']);
  });

  it('uses a fallback for an arg left out, and claims nothing for one without a fallback', () => {
    expect(fillClaims(['dir:{args.cwd|.}'], {})).toEqual(['dir:.']);
    expect(fillClaims(['dir:{args.cwd|.}'], { cwd: 'web' })).toEqual(['dir:web']);
    expect(fillClaims(['dir:{args.cwd}', 'file:{args.path}'], { path: 'a' })).toEqual(['file:a']);
    expect(fillClaims(['file:{args.paths}'], { paths: [] })).toEqual([]);
    expect(fillClaims(['file:{args.path}'], { path: '' })).toEqual([]);
  });

  it('says an object as JSON, and keeps each claim once in the order declared', () => {
    expect(fillClaims(['range:{args.range}'], { range: { from: 1, to: 2 } })).toEqual(['range:{"from":1,"to":2}']);
    expect(fillClaims(['b:{args.x}', 'a:{args.x}', 'b:{args.x}'], { x: true })).toEqual(['b:true', 'a:true']);
  });
});

describe('claim templates on the wire', () => {
  it('accepts tokens that read the args, and refuses any other token', () => {
    expect(ClaimTemplate.safeParse('file:{args.path}').success).toBe(true);
    expect(ClaimTemplate.safeParse('*').success).toBe(true);
    const refused = ClaimTemplate.safeParse('file:{output.path}');
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toMatch(/reads only its call's args/);
    expect(ClaimTemplate.safeParse('').success).toBe(false);
  });

  it('travels on a fn declaration and on a kind\'s description', () => {
    const decl = FnDecl.shape.parallelClaims.parse(['file:{args.path}']);
    expect(decl).toEqual(['file:{args.path}']);
    expect(FnDecl.shape.dynamicClaims.parse(true)).toBe(true);
    expect(KindDescription.shape.parallelClaims.safeParse(['table:{fn}']).success).toBe(false);
  });
});
