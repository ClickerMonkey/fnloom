/**
 * The third set (ids 81-84, docs/plans/scenarios-3-2026-11-26.md): can a chat write a harness system of its own, get
 * it installed and then use it? Phil, 2026-11-26: "I do want to know if a chat can create a custom system and get it
 * installed". Three cases want a new add-on (one with stored data and a few fns, one with a page of its own, one
 * changed after it is in use, as an update of its own install that keeps its data), and one asks for something the
 * app's own data and saved queries already do, so building an add-on there is the wrong answer (restraint).
 *
 * The words stay as plain and vague as the other sets' (never a system, a fn, the SDK, a folder or code): the person
 * asks for "my own little app in here". Every case `needs` the authoring workspace (an fs folder in the harness
 * checkout where a system builds, `rep.ts`), plays alone (`household`: it installs a system on the rep's stack, which
 * the runner removes after the case), and has its own limits: building takes many tool calls and minutes per turn.
 * `authoring` says what the hard checks expect of the hub's systems (`checks.ts` `authoringChecks`).
 */
import type { Case, CaseLimits } from './cases.ts';

/** The authoring workspace, for every case of this set. */
const AUTHORING = ['authoring'] as const;

/**
 * Building a system is the longest thing a chat does: reading the guide, writing a dozen files, an install that
 * typechecks, bundles and runs the folder's tests before its card, fixing what the build says, and the card. So a turn
 * may take 20 minutes, the person may answer up to 12 times (a few "yes, go ahead" while it works), and a case stops
 * after an hour (an update case, which builds twice, after 90 minutes) or once its model cost passes $3.
 */
const BUILDING: CaseLimits = { turnTimeout: 1_200_000, personTurns: 12, caseTimeout: 3_600_000, costCap: 3 };

export const THIRD_CASES: readonly Case[] = [
  {
    id: 81, group: 'Its own add-ons', title: 'My own blood pressure log',
    steps: [
      { say: 'Can you make me my own little app in here for my blood pressure? I want to tell you my numbers whenever I take them and be able to ask you how I\'ve been doing.', followUps: 9 },
      { say: 'Just took it: 128 over 82, pulse 71.', newChat: true, followUps: 1 },
      { say: 'How have I been doing this week?', followUps: 1 },
    ],
    good: 'Builds an add-on of its own for the readings (somewhere they are kept, a way to add one, a way to sum them up), gets it installed with the person\'s yes and says when it is ready; then, in the later chat, adds the new reading through it and answers how the week went from the readings it kept (the ones told while setting it up and the new one), with real numbers, not made up.',
    notes: 'authoring a system: fs/system-authoring (/new-system) and its guide, the template, fs/install_system and its admin card; the new system\'s own fns used in the later chat (found with hub/fns_search, loaded with hub/fns_load), its readings kept (ctx.data records or its data folder). The runner goes live with the installed system as the admin does on the review page.',
    facts: [
      'Your doctor asked you to keep an eye on your blood pressure for a month.',
      'Readings so far this week: Monday 132 over 85, pulse 74; Wednesday 126 over 80, pulse 70; Thursday 135 over 88, pulse 77.',
      'You are happy for it to set things up and install them; you say yes when it asks.',
    ],
    wants: 'Your own place for your blood pressure readings that you can add to and ask about, really working.',
    needs: AUTHORING, household: true, authoring: 'new', limits: BUILDING,
  },
  {
    id: 82, group: 'Its own add-ons', title: 'Birds at the feeder, on a page',
    steps: [
      { say: 'We keep seeing all kinds of birds at our feeder. Can you make me something where I tell you what we saw, and there\'s a page I can open to look at all of them?', followUps: 9 },
      { say: 'This morning we saw a cardinal and two blue jays.', newChat: true, followUps: 1 },
      { say: 'Where do I go to see the page with our birds?', followUps: 1 },
    ],
    good: 'Builds an add-on with a page of its own that lists the sightings, gets it installed with the person\'s yes, adds the morning\'s sightings through it in the later chat, and tells them where the page is (where it shows in the app\'s menu, or its address); the page is really there and lists what was told.',
    notes: 'authoring a system with a page (`pages` in its contract, drawn by a component its client build exports), fs/install_system and its admin card, the system\'s fns used in the later chat. The runner goes live with it as the admin does on the review page; the page is listed by the hub (systemPages) only once it is live with its client build.',
    facts: [
      'Last weekend you saw a downy woodpecker and a goldfinch.',
      'Your daughter likes to look at the list of birds.',
      'You are happy for it to set things up and install them; you say yes when it asks.',
    ],
    wants: 'A page you can open that shows every bird you\'ve told it about.',
    needs: AUTHORING, household: true, authoring: 'page', limits: BUILDING,
  },
  {
    id: 83, group: 'Its own add-ons', title: 'Weekend chores count double',
    steps: [
      { say: 'Can you make me my own little app for the kids\' chores? Each chore earns points and I want to know who\'s ahead.', followUps: 9 },
      { say: 'Emma emptied the dishwasher, that\'s 2 points. Leo fed the cat, 1 point.', newChat: true, followUps: 1 },
      { say: 'Can you change the chore app so it also keeps which day each chore was done, and so anything done on a weekend counts double?', newChat: true, followUps: 9 },
      { say: 'Emma raked leaves on Saturday, that\'s 3 points. Who\'s ahead now?', followUps: 1 },
    ],
    good: 'Changes the add-on it made in place (a new version of the same one, approved with the person\'s yes, keeping the chores already logged), not a second add-on; then logs Saturday\'s raking at double points and says Emma is ahead, 8 to Leo\'s 1 (2 plus 6, against 1).',
    notes: 'authoring a system, then changing it: fs/install_system again on the same folder updates its own install (the same instance and key, its data kept), with the change on the card; the system\'s fns used before and after. The runner goes live with the first version and approves the update\'s pending review as the admin does on the review page.',
    facts: [
      'The kids are Emma and Leo.',
      'You are happy for it to set things up, change them and install them; you say yes when it asks.',
      'Saturday\'s chore was the one this weekend; the earlier two were on weekdays.',
    ],
    wants: 'The same chore app, now counting weekend chores double, with the chores already logged still there.',
    needs: AUTHORING, household: true, authoring: 'update', limits: { ...BUILDING, caseTimeout: 5_400_000, personTurns: 16 },
  },
  {
    id: 84, group: 'Its own add-ons', title: 'Whose turn to pick the movie',
    steps: [
      { say: 'We do family movie night every Friday and take turns picking. Can you keep track of what we watched and who picked, so we know whose turn it is?', followUps: 3 },
      { say: 'Last night we watched Paddington and Leo picked. Whose turn is it next?', newChat: true, followUps: 1 },
    ],
    good: 'Keeps the movie nights with what the app already has (a saved list or table, maybe a saved way to ask whose turn it is) and does not write and install a new add-on for something this small; in the later chat it logs Paddington as Leo\'s pick and says it is Alex\'s turn next.',
    notes: 'restraint: the database system (a table and a kept query) or memory fits; fs/install_system should not run. The authoring workspace is there, so building a system is possible but not needed.',
    facts: [
      'You take turns in this order: you (Alex), Sara, Emma, Leo, then around again.',
      'Two weeks ago Sara picked Moana; last week Emma picked Inside Out.',
      'You don\'t care how it keeps the list, as long as it works; if it asks, whatever is simplest.',
    ],
    wants: 'To know whose turn it is to pick, now and next time.',
    needs: AUTHORING, household: true, authoring: 'none', limits: { ...BUILDING, personTurns: 6 },
  },
];
