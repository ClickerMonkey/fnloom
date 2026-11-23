/**
 * The code system's implementation: the `program` kind (check, describe and run through the shared program runtime)
 * and `make_code` (the authoring agent in `authoring.ts`). Nothing is stored here: code fns, who may use them and their
 * versions are the hub's.
 */
import { CODE_KIND, CodeFnSpec, fnOfModelNameByRule, KindDescription, QualifiedName, splitName, type Json } from '@harness/core';
import { CallFailed, hub, sampleArgs, type FnCtx, type KindCheckCtx, type SystemImpl, type TypesOf } from '@harness/sdk';
import {
  ProgramError, calleesMode, checkProgram, hubProgramHost, kindCheckLookups, kindRunLookups, runProgram, storedProgramScope, type ProgramCheck, type ProgramLookups,
} from '@harness/sdk/program';
import { AuthoringError } from '@harness/sdk/server';
import type { CodeContract } from '../shared/index.ts';
import { CodeAuthoring, codeAuthoring, type EditedCode } from './authoring.ts';
import type { CodeSettings } from './env.ts';

/** Everything the implementation is built from. */
export interface CodeDeps {
  readonly settings: CodeSettings;
}

/** A stored payload checked in the world its lookups give: the scope and what the check found. */
async function checked(spec: CodeFnSpec, lookups: ProgramLookups): Promise<{ check: ProgramCheck; program: Awaited<ReturnType<typeof storedProgramScope>> }> {
  const program = await storedProgramScope({ types: [spec.args, spec.returns], programs: [spec.program] }, lookups);
  const check = checkProgram(program, spec.program, { args: spec.args, returns: spec.returns });
  return { check, program };
}

/** The payload's problems as the kind reports them: its args must be an obj, and its program must check. */
async function payloadProblems(spec: CodeFnSpec, ctx: KindCheckCtx): Promise<string[]> {
  if (spec.args.name !== 'obj') return ['args must be an obj type.'];
  return (await checked(spec, kindCheckLookups(ctx))).check.problems;
}

/** The fns a run of `make_code` calls. */
type MakeFns = FnCtx<TypesOf<CodeContract['defs']['fns']['make_code']>>['fns'];

/** The code fn `make_code` was asked to change, with its fns loaded and its signature declared. */
async function edited(name: string, fns: MakeFns): Promise<EditedCode | string> {
  // the hub reads a fn name the model wrote back at the boundary; the tools' spelling is read by the rule here too
  const fn = QualifiedName.safeParse(name.includes('/') ? name : fnOfModelNameByRule(name) ?? name);
  if (!fn.success) return `${name} is not a code fn's name: give it as your tools and search hits spell it.`;
  const stored = await fns.getFn({ fn: fn.data });
  const spec = CodeFnSpec.safeParse(stored.payload);
  if (stored.kind !== CODE_KIND || !spec.success) return `${name} is not a code fn, so make_code can't change it.`;
  return { fn: fn.data, spec: spec.data };
}

/** Build the code implementation. */
export function createCodeImpl(_deps: CodeDeps): SystemImpl<CodeContract['defs']> {
  return {
    fns: {
      make_code: {
        async run(args, ctx) {
          const editing = args.fn === undefined ? undefined : await edited(args.fn, ctx.fns);
          if (typeof editing === 'string') return ctx.fail('caller', editing);
          const getFn = async (fn: QualifiedName) => await ctx.fns.getFn({ fn });
          const state = new CodeAuthoring({
            host: hubProgramHost(ctx, getFn),
            deps: {
              getFn,
              saveFn: async (save) => {
                const saved = await ctx.fns.saveFn({
                  kind: CODE_KIND, name: save.name, description: save.description, instructions: `Asked for: ${args.request}`,
                  payload: save.payload, examples: save.examples, tags: ['code'], ...(save.replace ? { replace: true } : {}),
                });
                return { fn: saved.fn, version: saved.version };
              },
            },
            ...(editing === undefined ? {} : { editing }),
          });
          let request = args.request;
          if (editing !== undefined) {
            // the program being changed: its fns loaded and its types bound, so the agent edits it as it stands
            await state.preload({ types: [editing.spec.args, editing.spec.returns], programs: [editing.spec.program] });
            request = `${args.request}\n\nChange ${editing.fn} (keep its name ${splitName(editing.fn).local}). Its signature is declared: ${state.program.signature(editing.fn, editing.spec.args, editing.spec.returns)}. Its program: ${JSON.stringify(editing.spec.program)}`;
          }
          try {
            const { result } = await codeAuthoring.run(await ctx.ai(), request, state);
            ctx.log.info('code.authored', { fn: result.fn, reused: result.reused });
            return ctx.done(result);
          } catch (error) {
            if (!(error instanceof AuthoringError)) throw error;
            const last = error.problems.length === 0 ? '' : ` Its last problems: ${error.problems.join(' ')}`;
            return ctx.fail('caller', `No code fn was written: ${error.message}${last} Say more exactly what it should do.`);
          }
        },
      },
    },
    kinds: {
      program: {
        check: (payload, ctx) => payloadProblems(CodeFnSpec.parse(payload), ctx),
        async describe(payload, ctx) {
          const spec = CodeFnSpec.parse(payload);
          const lookups = kindCheckLookups(ctx);
          const { check } = await checked(spec, lookups);
          return KindDescription.parse({
            args: spec.args,
            returns: spec.returns,
            // the fns it calls, and hub/fns_get to read their signatures when it runs
            deps: check.calls.length === 0 ? [] : [...check.calls, hub.fns.fns_get.name],
            operations: { cancel: true, pause: false, undo: false, background: false },
            // its own work is free and only reads; calling fns, it does what the strongest of them does
            effects: check.calls.length === 0 ? { mode: 'read', free: true } : { mode: await calleesMode(check.calls, lookups) },
            // its args filled with sample values read off its schema
            examples: [{ args: sampleArgs(spec.args), note: 'Runs the program with sample values: use real ones.' }],
            ...(check.code === undefined ? {} : { readable: { language: 'ts', code: check.code } }),
          });
        },
        async run(payload, args, ctx) {
          const spec = CodeFnSpec.parse(payload);
          const { check, program } = await checked(spec, kindRunLookups(ctx));
          if (check.expr === undefined || check.problems.length > 0) return ctx.fail('fatal', `${ctx.run.fn} no longer checks: ${check.problems.join(' ')}`);
          try {
            const result = await runProgram({
              program, expr: check.expr, args: spec.args, returns: spec.returns, calls: check.calls, signal: ctx.signal,
              call: async (fn, input): Promise<Json> => ctx.call(fn, input),
            }, args);
            return ctx.done(result);
          } catch (error) {
            if (error instanceof CallFailed) return ctx.fail('caller', `A fn it calls failed: ${error.message}`);
            if (error instanceof ProgramError) return ctx.fail('caller', error.message);
            throw error;
          }
        },
      },
    },
  };
}
