/** The widgets system's server parts, for tests and other systems' tooling. */
export { createWidgetsImpl, type WidgetsDeps } from './impl.ts';
export { runWidget, TABLE_VISUAL, type WidgetHub, type WidgetRunInput, type WidgetSource } from './run.ts';
export { WidgetAuthoring, widgetAuthoring, type SourceDecl, type WidgetAuthoringDeps, type WidgetRequest } from './authoring.ts';
export { widgetsEnv, type WidgetsSettings } from './env.ts';
export { widgets } from '../shared/index.ts';
