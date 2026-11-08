/**
 * The models module's factory. Until the hub-platform lane builds it, every service answers `NOT_BUILT`.
 */
import { notBuiltService } from '../boot/not-built.ts';
import type { ModuleFactory } from '../boot/index.ts';
import type { ModelGateway, ModelRoles } from './index.ts';

/** Builds the models module. */
export const modelsModule: ModuleFactory<'models'> = () => ({
  services: {
    roles: notBuiltService<ModelRoles>('models.roles'),
    gateway: notBuiltService<ModelGateway>('models.gateway'),
  },
});
