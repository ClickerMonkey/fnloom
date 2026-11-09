/** Every e2e scenario. Add a scenario file per UI feature and list it here. */
import type { Scenario } from '../harness.ts';
import { adminBrowsers, adminRules, adminSystems } from './admin.ts';
import { build4 } from './build4.ts';
import { build5 } from './build5.ts';
import { database } from './database.ts';
import { connect } from './connect.ts';
import { chat } from './chat.ts';
import { design } from './design.ts';
import { inbox } from './inbox.ts';
import { settings } from './settings.ts';
import { shell } from './shell.ts';
import { signIn } from './sign-in.ts';

export const scenarios: readonly Scenario[] = [signIn, shell, inbox, settings, design, chat, adminSystems, adminRules, adminBrowsers, build4, build5, database, connect];
