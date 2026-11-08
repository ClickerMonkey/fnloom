/**
 * The resources module's factory. Until the resources lane builds it, every service answers `NOT_BUILT`.
 */
import { notBuiltService } from '../boot/not-built.ts';
import type { ModuleFactory } from '../boot/index.ts';
import type { ContextLibrary, FormService, MessageContent, ResourceLibrary, ResourceReader } from './index.ts';

/** Builds the resources module. */
export const resourcesModule: ModuleFactory<'resources'> = () => ({
  services: {
    library: notBuiltService<ResourceLibrary>('resources.library'),
    forms: notBuiltService<FormService>('resources.forms'),
    reader: notBuiltService<ResourceReader>('resources.reader'),
    content: notBuiltService<MessageContent>('resources.content'),
    context: notBuiltService<ContextLibrary>('resources.context'),
  },
});
