/**
 * The fs system's client renderers (Vue components typed by the contract). Owner: the fs lane, with the web lane's
 * chat providing the runtime. Renderers are added here as `.vue` files: `fns.bash`, `attachments.diff`, `inputs.Entry`.
 */
import { client } from '@harness/sdk';
import { fs } from '../shared/index.ts';

export default client(fs, {});
