/** Every UI feature, in the order `npm run ui-tests` runs them (signing in first, the slow model turns last). */
import type { Feature } from '../kit.ts';
import accessibility from './accessibility.ts';
import adminActorSettings from './admin-actor-settings.ts';
import adminLimits from './admin-limits.ts';
import adminLlm from './admin-llm.ts';
import adminModels from './admin-models.ts';
import adminPolicies from './admin-policies.ts';
import adminResources from './admin-resources.ts';
import adminRuns from './admin-runs.ts';
import adminSystem from './admin-system.ts';
import adminSystems from './admin-systems.ts';
import approvals from './approvals.ts';
import budget from './budget.ts';
import chatShell from './chat-shell.ts';
import commands from './commands.ts';
import composer from './composer.ts';
import header from './header.ts';
import inbox from './inbox.ts';
import invoke from './invoke.ts';
import liveRuns from './live-runs.ts';
import markdown from './markdown.ts';
import mentions from './mentions.ts';
import pairing from './pairing.ts';
import messageActions from './message-actions.ts';
import messageDetails from './message-details.ts';
import motion from './motion.ts';
import people from './people.ts';
import reasoning from './reasoning.ts';
import renderers from './renderers.ts';
import responsive from './responsive.ts';
import runCards from './run-cards.ts';
import runDrawer from './run-drawer.ts';
import reconnect from './reconnect.ts';
import scrolling from './scrolling.ts';
import sessionSettings from './session-settings.ts';
import settings from './settings.ts';
import shortcuts from './shortcuts.ts';
import signIn from './sign-in.ts';
import states from './states.ts';
import streaming from './streaming.ts';
import suggestions from './suggestions.ts';
import themes from './themes.ts';
import timestamps from './timestamps.ts';
import turnTree from './turn-tree.ts';
import undo from './undo.ts';
import uploads from './uploads.ts';
import urlState from './url-state.ts';

export const FEATURES: readonly Feature[] = [
  signIn, chatShell, urlState, responsive, header, themes, motion, scrolling, markdown, messageActions, messageDetails, reasoning, timestamps,
  runCards, runDrawer, turnTree, renderers, composer, mentions, commands, suggestions, people, budget, sessionSettings, shortcuts, accessibility,
  inbox, settings, invoke, liveRuns, uploads, undo, reconnect, states,
  adminSystems, pairing, adminSystem, adminModels, adminLimits, adminPolicies, adminActorSettings, adminRuns, adminLlm, adminResources,
  streaming, approvals,
];
