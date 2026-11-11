/**
 * The authoring guide's outline: its topics in the order an author follows (the folder and the contract, its parts,
 * the server, the run context, the client, packaging and testing), each with its prose file and the exports its
 * reference documents. `compose.ts` refuses an export no topic places, so a new SDK export breaks
 * `npm run docs:authoring -- --check` until it is placed here.
 */
import type { Topic } from './compose.ts';

/** The gin builder and its options, documented from `@aeye/gin` beside the SDK's own gin helpers. */
export const GIN_EXTERNALS = ['TypeBuilder', 'BoolOptions', 'NumOptions', 'TextOptions', 'ListOptions', 'DateOptions', 'TimestampOptions', 'ColorOptions', 'FieldOptions'] as const;

/** The guide's topics, in order. */
export const OUTLINE: readonly Topic[] = [
  { id: 'start', title: 'Start here', exports: [] },
  { id: 'folder', title: 'The system folder and the template', exports: [] },
  {
    id: 'contract',
    title: 'The contract',
    exports: ['system', 'SystemContract', 'SystemRefs', 'ContractShape', 'ContractSection', 'CONTRACT_SECTIONS', 'isSystemContract', 'EmptyContract', 'Merge', 'AnyContract', 'ConfigOf', 'SystemInfo', 'RegistryDef'],
  },
  {
    id: 'gin',
    title: 'Types with gin',
    exports: ['g', 'GinType', 'Infer', 'json', 'parseValue', 'encodeValue', 'wireType', 'referencesOf', 'loadTypes', 'LoadedTypes', 'ginOf', 'ginAs', 'toolArgsOf'],
    external: GIN_EXTERNALS,
  },
  {
    id: 'named-types',
    title: 'Named types and methods',
    exports: ['type', 'TypeDef', 'AnyTypeDef', 'ValueOf', 'NamingKeys', 'TypeRef', 'AnyTypeRef', 'Methods', 'MethodName', 'MethodArgs', 'MethodRefs', 'MethodImpl'],
  },
  {
    id: 'fns',
    title: 'Fns',
    exports: [
      'fn', 'FnInput', 'FnExampleOf', 'FnDef', 'AnyFnDef', 'FnTypes', 'NativeFnTypes', 'TypesOf', 'Deps', 'FnRef', 'AnyFnRef', 'FnValidators', 'ValidateCtx', 'PreviewCtx',
      'DEFAULT_STATUS', 'StatusTemplates', 'StatusForms', 'RunPhase', 'StatusInput', 'CheckedStatus', 'CheckedTemplate', 'OneTokens', 'ManyTokens', 'PathsOf', 'TokensOf',
    ],
  },
  {
    id: 'handlers-progress',
    title: 'Handlers and progress',
    exports: [
      'handler', 'HandlerDef', 'Handlers', 'HandlerFn', 'HandlerArgs', 'HandlersInRun', 'HasRequiredHandlers',
      'linear', 'steps', 'noProgress', 'progressDecl', 'ProgressDef', 'NoProgress', 'LinearProgress', 'StepsProgress', 'ProgressReporter', 'ProgressState',
    ],
  },
  { id: 'state-forms', title: 'Session state, forms and display', exports: ['SessionState'] },
  {
    id: 'outcomes',
    title: 'Outcomes: done, invalid input, failed, paused, cancelled, undo',
    exports: ['ResultBlock', 'ResultBlockType', 'ResultColumnInfo', 'ResultFn', 'NextPage', 'resultBlock', 'ResultBlockOptions', 'rendererFolder', 'RendererPlace', 'Outcome', 'Resume', 'Suspended', 'ACTIVE_RUN_STATUSES', 'SETTLED_RUN_STATUSES', 'isSettled', 'isUnsettled', 'ActiveRunStatus', 'SettledRunStatus'],
  },
  {
    id: 'kinds-agents',
    title: 'Kinds and agents',
    exports: [
      'kind', 'KindDef', 'KindImpl', 'KindEstimateInput', 'KindCheckCtx', 'KindRunCtx', 'KindRef', 'AnyKindRef', 'kindFn', 'KindFnInput', 'KindFnTypes', 'UntypedFn',
      'agent', 'AgentInput', 'AgentFnTypes', 'LlmPayload', 'LlmKind',
    ],
  },
  { id: 'settings-attachments', title: 'Settings and attachments', exports: ['setting', 'SettingDef', 'SettingRef', 'attachment', 'AttachmentDef', 'AttachmentRef'] },
  {
    id: 'context',
    title: 'Context and commands',
    exports: [
      'CONTEXT_FOLDER', 'readContextFolder', 'parseContextFile', 'ContextFile', 'ContextFolder', 'ContextFolderError', 'formatContextProblem', 'contextProblem', 'positionOf',
      'contextChange', 'watchContextFolder', 'ContextWatchEvents',
      'context', 'ContextInput', 'ContextDef', 'AnyContextDef', 'ContextImpl', 'ContextLinkDef', 'ContextLinkTarget', 'arg', 'ArgDef', 'ArgsOf', 'ContextRef', 'AnyContextRef'],
  },
  { id: 'hooks', title: 'Hooks', exports: ['hook', 'HookDef', 'HookImpl', 'HookContribution', 'hookBlock', 'HookRef', 'AnyHookRef'] },
  { id: 'mentions', title: 'Mentions', exports: ['mention', 'MentionDef', 'MentionImpl', 'MentionOption', 'MentionCtx', 'MentionRef'] },
  { id: 'actions', title: 'Actions', exports: ['action', 'ActionDef', 'ActionImpl', 'ActionCtx', 'ActionRef'] },
  { id: 'providers', title: 'Model providers', exports: ['provider', 'ProviderInput', 'ProviderDef', 'ProviderImpl', 'ProviderRef'] },
  {
    id: 'resources',
    title: 'Resources, embedders and sectioners',
    exports: ['ResourceProvider', 'embedder', 'EmbedderDef', 'EmbedderImpl', 'EmbedderRef', 'sectioner', 'SectionerDef', 'SectionerImpl', 'SectionerRef', 'sectionKeys'],
  },
  {
    id: 'hub',
    title: 'The hub contract',
    exports: [
      'hub', 'HubContract', 'ADMIN_ENDPOINTS', 'AdminFnName', 'HUB_READ_ENDPOINTS', 'HubReadFnName', 'HUB_WRITE_ENDPOINTS', 'HubWriteFnName', 'HUB_PERSON_ENDPOINTS', 'HubPersonFnName', 'HUB_EXPLORE_ENDPOINTS', 'HubExploreFnName', 'ADMIN_READ_ENDPOINTS', 'AdminReadFnName', 'FIND_KINDS',
      'LlmPayloadType', 'ModelChoiceType', 'ChatModeType', 'ContextorType', 'FnErrorType', 'StoredFn', 'SaveFnArgs', 'SAVE_FN_TAKEN',
    ],
  },
  {
    id: 'server',
    title: 'The server: serve and the implementation',
    exports: [
      'serve', 'ServeOptions', 'McpServe', 'mcpToolNameOf', 'RunningSystem', 'RunningStatus', 'SystemImpl', 'FnImpl', 'ConnectImpl', 'loggedHost', 'LoggedHost', 'systemFields', 'systemState', 'defaultStateFolder', 'SYSTEM_ENV', 'placeFolders', 'sdkEnv', 'SdkEnv',
      'RESTART_CODE', 'SystemHost', 'LinkHost', 'LinkHostDeps', 'SystemStopped', 'SystemPatch',
      'PairingDisplay', 'PairingShown', 'pairingDisplayFor', 'LogPairingDisplay', 'TerminalPairingDisplay', 'PAIRING_QR_MODES', 'PairingQrMode', 'codeBanner', 'terminalQr', 'QrRenderer',
    ],
  },
  {
    id: 'ctx',
    title: 'The run context and services',
    exports: [
      'FnCtx', 'Services', 'SystemCtx', 'SystemPlace', 'UndoCtx', 'AskerCtx', 'BudgetInfo', 'RunStatusView', 'Llm', 'ForwardModality', 'ModelInput', 'ModelOutput', 'Files', 'Resources', 'Types', 'Log',
      'Proposals', 'ProposeOptions', 'Decisions', 'DecideOptions', 'Fleets', 'FnSearch',
      'AiSource', 'hubAi', 'hubAiOf', 'hubModelId', 'roleModelId', 'aeyeModelOf', 'ModelLink', 'HubModelLink',
      'harnessAi', 'harnessAiOf', 'HarnessAi', 'HarnessProvider', 'HarnessProviderConfig', 'HarnessMetadata', 'HubLlm', 'HubLlmError', 'HubModels', 'HUB_MODEL', 'wireRequest',
    ],
  },
  { id: 'calling', title: 'Calling other fns', exports: ['Callers', 'Caller', 'CallOptions', 'FnCall', 'Settled', 'CallFailed', 'HandlerFailed'] },
  { id: 'lifecycle', title: 'Config, events, lifecycle and data', exports: ['Lifecycle', 'EventHandlers'] },
  {
    id: 'client',
    title: 'The client: renderers, inputs and resource views',
    exports: [
      'client', 'ClientRenderers', 'ClientModule', 'Renderer', 'FnView', 'FnViewOf', 'AttachmentView', 'AttachmentViewOf', 'InputView', 'InputViewOf', 'MentionView', 'ResourceView',
      'SystemClient', 'WithSystem', 'Delivery', 'ResourceViewerEntry', 'BareViewer', 'ResourceViewerMode', 'RESOURCE_VIEWER_MODES', 'RESOURCE_VIEWER', 'ResourceViewerProps', 'INPUT_ANSWERS', 'VALUE_EDITOR', 'ACCESS_INFO', 'SHARE_EDITOR', 'ShareEditorProps', 'InputAnswer', 'InputAnswers', 'ValueEditorProps', 'buildClient', 'BuildClientOptions', 'sharedModules', 'inlineCss', 'SHARED_IMPORTS',
      'AnyViews', 'WireViews', 'Mount', 'InputMount', 'VisualView', 'VisualEntry', 'VisualOption', 'VisualSource', 'VISUALS',
    ],
  },
  {
    id: 'packaging',
    title: 'Packaging: system.json, build, pack, install',
    exports: [
      'readPackageManifest', 'findPackageManifest', 'parsePackageManifest', 'checkPackage', 'packageProblems', 'PackageManifestError', 'builtPackageManifest',
      'packedPackageManifest', 'packageFileProblems', 'packageManifestText', 'BuiltEntries',
    ],
  },
  {
    id: 'testing',
    title: 'Testing',
    exports: ['FakeHub', 'FakeHubOptions', 'FakeProcess', 'TEST_USER', 'TEST_PLACE', 'NO_ASKS', 'HubBody', 'SystemBody', 'streamOf', 'liveEnv', 'liveModels', 'expectType', 'Equal', 'Simplify', 'MemoryKeyStore', 'MemoryJournal', 'FakeHubFns', 'KeptFn',
      'FakeModelLink', 'fakeHubAi', 'replyChunks', 'FakeModelOptions', 'FakeReply'],
  },
  { id: 'mistakes', title: 'Common mistakes', exports: [] },
  { id: 'examples', title: 'Worked examples', exports: [] },
  {
    id: 'internals',
    title: 'Runtime internals',
    reach: false,
    reference: true,
    exports: [
      'manifestOf', 'manifestBody', 'fnDecl', 'validationOf', 'providerDecl', 'canonicalJson', 'contractHash', 'sha256', 'ManifestOptions',
      'ProviderServer', 'ProviderServerParts', 'providerErrorKind',
      'KeyStore', 'FileKeyStore', 'StoredKeyPair', 'KEY_FILE', 'AUTO_PAIR_FILE', 'makeKeyPair', 'signNonce', 'verifyNonce', 'isPublicKey',
      'OutcomeJournal', 'FileJournal', 'contentHash', 'contentHasher', 'ContentHasher', 'StateConflict', 'LinkGap', 'InvalidValue',
      'LinkTransport', 'LinkSocket', 'WsLinkTransport', 'HubAccess', 'HubLink', 'NodeFiles', 'FilesFactory', 'FilesScope', 'fileUri', 'uriInstance', 'mimeOf', 'NodeProcess', 'ProcessControl',
      'NodeStarter', 'NodeStarterOptions', 'ProcessStarter', 'ProcessCommand', 'ProcessExit', 'SupervisedProcess', 'scrubbedEnv', 'BASIC_ENV', 'HARNESS_ENV_PREFIX', 'permissionArgs', 'ProcessGrants', 'CrashPolicy', 'CrashPolicyOptions', 'ExitDecision',
      'McpFace', 'McpLimits', 'readClientBundle', 'CLIENT_ENTRY', 'ClientBundle',
      'LlmWire', 'LlmWireOptions', 'LlmDescriptors', 'UNSENDABLE_CONTENT', 'messageFromWire', 'requestFromWire', 'isObjectSchema', 'descriptorsOf', 'applyDescriptors',
      'usageToWire', 'usageFromWire', 'chunkToWire', 'chunkFromWire', 'responseToWire',
      'addressVerdict', 'followRedirects', 'isLocalName', 'isPrivateAddress', 'systemLookup', 'REDIRECT_STATUSES', 'AddressRefusal', 'AddressRules', 'AddressVerdict',
      'FollowedResponse', 'HostLookup', 'RedirectOptions', 'RedirectProblems',
    ],
  },
  { id: 'core-types', title: 'Core types', exports: [], reference: true },
];
