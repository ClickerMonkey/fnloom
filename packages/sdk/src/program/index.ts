/**
 * `@harness/sdk/program`: the gin program runtime the `code` and `api` systems share (build 9 design §0.7 and §5): the
 * session artifact (`ProgramScope`), the validation pipeline (`checkProgram`), the scope-read walk (`programFacts`),
 * execution within limits (`runProgram`, `programEnv`), and the authoring tools both program-writing agents use on the
 * SDK's `authoringAgent` (`programTools`, `testTool`, `ProgramAuthoring`).
 */
export { programEnv, type ProgramSettings } from './env.ts';
export {
  ARGS_SCOPE, FNS_SCOPE, ProgramError, ProgramScope, checkProgram, fnCallText, fnCandidates, storedProgramScope, typeClosure, fnPath, programFacts, programLocals, runProgram, typeNamesIn,
  type NamedTypeDef, type ProgramCheck, type ProgramLookups, type ProgramExpectations, type ProgramFacts, type ProgramFn, type ProgramLocals, type ProgramRun,
} from './runtime.ts';
export { ProgramAuthoring, modeOf, previewText, programTools, testTool, type ProgramHost, type ProgramSession, type ProgramSignature } from './tools.ts';
export { hubProgramHost, kindCheckLookups, kindRunLookups, type AuthoringHub, type DeclaredFn, type KindRunHub } from './lookups.ts';
