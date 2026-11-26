/**
 * What the fixtures say: the receipt's lines, the school letter, the three quotes, the bank statement, the photos and
 * the rest of the fake home folder. Kept apart from the drawing (`make.ts`) so the facts a judge may check are in one
 * place.
 */

const cents = (value: number): number => Math.round(value * 100) / 100;

const RECEIPT_ITEMS = [
  { name: 'KRO 2% MILK GAL', price: 3.49 }, { name: 'PRIVATE SEL BREAD', price: 2.99 }, { name: 'BANANAS 2.8 LB', price: 1.87 },
  { name: 'CHKN BRST BNLS', price: 11.42 }, { name: 'KRO EGGS 18CT', price: 4.29 }, { name: 'KRO CHEDDAR 8OZ', price: 3.99 },
  { name: 'HONEYCRISP APPLES', price: 5.98 }, { name: 'PENNE 2 @ 1.25', price: 2.5 }, { name: 'RAGU SAUCE', price: 2.29 },
  { name: 'CHEERIOS 18OZ', price: 4.99 }, { name: 'YOPLAIT 10PK', price: 5.0 }, { name: 'BROCCOLI CROWNS', price: 2.48 },
  { name: 'GRND BEEF 80/20', price: 7.99 }, { name: 'SIMPLY OJ 52OZ', price: 3.79 }, { name: 'BOUNTY PPR TWL T', price: 8.99 },
] as const;
const RECEIPT_SUBTOTAL = cents(RECEIPT_ITEMS.reduce((sum, item) => sum + item.price, 0));
// food is not taxed in Ohio; the paper towels are (7.5% in Franklin County)
const RECEIPT_TAX = cents(8.99 * 0.075);

export const RECEIPT = {
  store: 'Kroger #0943 Clintonville', address: '3417 N High St, Columbus OH 43214', when: '11/19/2026 6:42 PM',
  items: RECEIPT_ITEMS, subtotal: RECEIPT_SUBTOTAL, tax: RECEIPT_TAX, total: cents(RECEIPT_SUBTOTAL + RECEIPT_TAX),
} as const;

/** The school letter, as blocks: `# ` a heading, `- ` lines a list, else a paragraph. */
export const SCHOOL_LETTER = [
  'November 17, 2026',
  'Dear Third Grade Families,',
  'What a busy fall it has been! Our students have been working hard on multiplication and on their "Ohio Animals" research projects, and we are so proud of them. Thank you to everyone who came to the Fall Festival.',
  '# Field trip to COSI — Friday, December 11',
  'Third grade will visit COSI for the day. Please return the signed permission slip (page 2, sent home in the red folder) and $8.00 cash or check made out to "Indianola PTO" by Friday, December 4. We need four parent chaperones; if you can come, write it on the slip. Students need a packed, nut-free lunch that day.',
  '# Parent–teacher conferences',
  'Conferences are Tuesday, December 8 and Thursday, December 10, from 3:45 to 7:00 PM. Please sign up for a 15-minute slot on the ParentSquare app by Tuesday, December 1. If no time works, email Mrs. Okafor at aokafor@columbus.k12.oh.us.',
  '# Picture retake day',
  'Retakes are Wednesday, December 9, in the morning. Only students whose families want new pictures need to take part; return the original picture packet that day.',
  '# Also coming up',
  '- Canned food drive through December 11 (optional; bring cans to the front office)\n- Pajama reading day, Friday, December 18\n- Winter break: December 21 through January 1; school starts again Monday, January 4',
  'As always, thank you for all you do at home. Keep up the nightly reading — 20 minutes a night makes a big difference!',
  'Warmly,\nMrs. Adaeze Okafor and Mr. Tom Riley, Third Grade Team',
] as const;

/** One car insurance quote. */
export interface Quote {
  readonly company: string;
  readonly color: string;
  readonly number: string;
  readonly date: string;
  readonly total: string;
  readonly monthly: string;
  readonly coverages: ReadonlyArray<readonly [string, string, string]>;
  readonly notes: readonly string[];
}

export const QUOTES: readonly [Quote, Quote, Quote] = [
  {
    company: 'Progressive', color: '#0e5aa7', number: 'PG-88213-OH', date: 'November 12, 2026', total: '$742.00', monthly: 'or $127.83/month with a $25 fee',
    coverages: [
      ['Bodily injury liability', '$100,000 / $300,000', '$248.00'], ['Property damage liability', '$100,000', '$121.00'],
      ['Uninsured/underinsured motorist', '$100,000 / $300,000', '$58.00'], ['Collision (both vehicles)', '$500 deductible', '$196.00'],
      ['Comprehensive (both vehicles)', '$500 deductible', '$87.00'], ['Roadside assistance', 'Included', '$12.00'], ['Rental reimbursement', 'Not included', '$0.00'],
    ],
    notes: ['Includes a multi-car discount and a paperless discount.', 'Price assumes Snapshot is used; it may go up or down after the first policy period.'],
  },
  {
    company: 'State Farm', color: '#d0021b', number: 'SF-4471902', date: 'November 13, 2026', total: '$689.50', monthly: 'or $114.92/month',
    coverages: [
      ['Bodily injury liability', '$50,000 / $100,000', '$201.00'], ['Property damage liability', '$50,000', '$98.50'],
      ['Uninsured motorist', '$50,000 / $100,000', '$41.00'], ['Collision (both vehicles)', '$1,000 deductible', '$221.00'],
      ['Comprehensive (both vehicles)', '$1,000 deductible', '$98.00'], ['Emergency road service', 'Included', '$30.00'], ['Rental car', 'Not included', '$0.00'],
    ],
    notes: ['Bundle with home insurance for an extra 12% off.', 'Drive Safe & Save discount applied.'],
  },
  {
    company: 'Erie Insurance', color: '#00447c', number: 'ERIE-Q-20261114-77', date: 'November 14, 2026', total: '$805.00', monthly: 'or $134.17/month',
    coverages: [
      ['Bodily injury liability', '$250,000 / $500,000', '$286.00'], ['Property damage liability', '$100,000', '$118.00'],
      ['Uninsured/underinsured motorist', '$250,000 / $500,000', '$71.00'], ['Collision (both vehicles)', '$500 deductible', '$189.00'],
      ['Comprehensive (both vehicles)', '$250 deductible', '$93.00'], ['Roadside', 'Included', '$18.00'], ['Rental reimbursement', '$30/day, 30 days', '$30.00'],
    ],
    notes: ['Includes Erie Rate Lock: the price only changes if you add a car, a driver or change address.', 'First accident forgiveness included.'],
  },
];

/** One statement line: a withdrawal is negative. */
interface StatementRow {
  readonly date: string;
  readonly description: string;
  readonly amount: number;
  readonly balance: number;
}

const OPENING = 4218.37;
const STATEMENT_LINES: ReadonlyArray<readonly [string, string, number]> = [
  ['10/01', 'MORTGAGE PMT ROCKET MTG', -1650], ['10/01', 'NETFLIX.COM', -15.49], ['10/02', 'PAYROLL DEPOSIT OHIOHEALTH', 3100],
  ['10/03', 'KROGER #0943 COLUMBUS OH', -168.22], ['10/04', 'SPOTIFY USA', -16.99], ['10/05', 'AEP OHIO ELECTRIC', -142.18],
  ['10/06', 'SHELL OIL 5741 COLUMBUS', -48.6], ['10/07', 'DISNEY PLUS', -13.99], ['10/08', 'ALDI 72031 COLUMBUS', -64.35],
  ['10/09', 'HULU 877-8244858', -9.99], ['10/10', 'HONDA FINANCIAL SVCS', -380], ['10/10', 'COLUMBIA GAS OF OHIO', -61.4],
  ['10/11', 'KROGER #0943 COLUMBUS OH', -181.07], ['10/12', 'PLANET FITNESS CLUB FEE', -45], ['10/13', 'AMAZON PRIME*2K4', -14.99],
  ['10/14', 'CHIPOTLE 2214', -38.45], ['10/15', 'PELOTON MEMBERSHIP', -12.99], ['10/16', 'PAYROLL DEPOSIT OHIOHEALTH', 3100],
  ['10/17', 'NYTIMES DIGITAL', -4], ['10/18', 'KROGER #0943 COLUMBUS OH', -159.8], ['10/19', 'COLUMBUS WATER & SEWER', -88.12],
  ['10/20', 'YMCA YOUTH SOCCER', -95], ['10/21', 'SPECTRUM INTERNET', -79.99], ['10/22', 'TARGET 00123 COLUMBUS', -73.18],
  ['10/24', 'SHELL OIL 5741 COLUMBUS', -51.2], ['10/25', 'KROGER #0943 COLUMBUS OH', -176.44], ['10/27', 'VERIZON WIRELESS', -142.5],
  ['10/28', 'RAISING CANES 0412', -32.17], ['10/30', 'TRANSFER TO SAVINGS ****8812', -400], ['10/31', 'INTEREST PAID', 0.42],
];

const rows: StatementRow[] = [];
let balance = OPENING;
for (const [date, description, amount] of STATEMENT_LINES) {
  balance = cents(balance + amount);
  rows.push({ date: `${date}/2026`, description, amount, balance });
}

export const STATEMENT = { opening: OPENING, closing: balance, rows } as const;

/** The statement as the bank's CSV download. */
export function statementCsv(): string {
  const quote = (text: string): string => `"${text.replace(/"/g, '""')}"`;
  return ['Date,Description,Amount,Running Balance', ...rows.map((row) => `${row.date},${quote(row.description)},${row.amount.toFixed(2)},${row.balance.toFixed(2)}`)].join('\n') + '\n';
}

/** The photos in Pictures: what each shows, when it was taken (its file time) and its colors. */
export const PHOTOS = [
  { name: 'IMG_2041.JPG', what: 'Emma at the beach, Outer Banks', taken: '2025-06-18T15:20:00', sky: '#79c2ff, #d8f0ff', ground: '#e9d6a4' },
  { name: 'IMG_2058.JPG', what: 'Sandcastle with Leo', taken: '2025-06-19T10:05:00', sky: '#8fd0ff, #f2fbff', ground: '#dcc48c' },
  { name: 'IMG_2320.JPG', what: 'First day of school', taken: '2025-08-20T07:45:00', sky: '#a5d8ff, #ffffff', ground: '#6fae5b' },
  { name: 'IMG_2577.JPG', what: 'Halloween: a dinosaur and a witch', taken: '2025-10-31T18:30:00', sky: '#2b2a4c, #8e5a8b', ground: '#3b2f2f' },
  { name: 'IMG_2890.JPG', what: 'Snow day sledding', taken: '2026-01-11T13:10:00', sky: '#cfd8e3, #ffffff', ground: '#f4f7fb' },
  { name: 'IMG_3102.JPG', what: 'Grandma Linda\'s garden', taken: '2026-05-09T11:00:00', sky: '#9ed6ff, #e6f6ff', ground: '#4f9a3c' },
  { name: 'IMG_3150.JPG', what: 'Leo\'s 6th birthday cake', taken: '2026-05-23T17:40:00', sky: '#ffd6e0, #fff4f7', ground: '#c98f5a' },
  { name: 'PXL_20260704_211500.jpg', what: 'Fireworks at Red, White & Boom', taken: '2026-07-04T22:15:00', sky: '#0b1030, #3a2a6a', ground: '#1a1a24' },
  { name: 'Screenshot 2026-09-02 081233.png.jpg', what: 'Screenshot: soccer schedule', taken: '2026-09-02T08:12:33', sky: '#f0f0f0, #ffffff', ground: '#dddddd' },
  { name: 'IMG_3488.JPG', what: 'Apple picking at Lynd Fruit Farm', taken: '2026-10-03T14:25:00', sky: '#ffcf8a, #fff1d6', ground: '#8a6a2f' },
] as const;

/** A file of the home folder other than the pictures: its path, content and modified time. */
export interface HouseFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly modified: string;
}

/** Bytes standing in for a program installer (no one runs it). */
const installer = (name: string): Uint8Array => new TextEncoder().encode(`MZ fake installer for ${name} (a scenario fixture)\n`.padEnd(4096, '\0'));

export const HOUSE: readonly HouseFile[] = [
  { path: 'Documents/Taxes/2025 tax notes.txt', content: 'W-2s: OhioHealth (Alex), Columbus City Schools (Sara)\nMortgage interest form 1098 from Rocket\nDaycare receipts: none this year\nCharity: $640 total (receipts in the blue folder)\n', modified: '2026-03-02T20:15:00' },
  { path: 'Documents/House/furnace and AC.txt', content: 'Furnace: Carrier 59SC5, installed 2014\nAC: Trane XR13, installed 2011\nFilter size: 16x25x1\nHVAC guy: Buckeye Heating, (614) 555-0142\n', modified: '2025-11-08T09:30:00' },
  { path: 'Documents/Kids/Emma soccer schedule fall 2026.txt', content: 'Saturdays 9:00 AM, Whetstone Park field 3\nSep 12 - Nov 7\nSnack sign-up: Oct 10 (us)\n', modified: '2026-08-28T19:00:00' },
  { path: 'Documents/Kids/Leo allergy action plan.txt', content: 'Leo Parker - peanut allergy (severe)\nEpiPen Jr in backpack and nurse\'s office\nSymptoms: hives, swelling, coughing - give EpiPen, call 911\nDr. Nguyen, Nationwide Children\'s: (614) 555-0199\n', modified: '2026-08-15T12:00:00' },
  { path: 'Documents/Recipes/Grandma Linda lasagna.txt', content: 'Lasagna (Grandma Linda)\n1 lb Italian sausage, 1 jar marinara, 15 oz ricotta, 1 egg, 2 cups mozzarella, 1/2 cup parmesan, 12 noodles\n375F for 45 min covered, 15 uncovered\n', modified: '2024-12-20T16:00:00' },
  { path: 'Documents/resume - Alex Parker 2019.txt', content: 'Alex Parker\nIT Project Coordinator, OhioHealth (2016 - present)\n', modified: '2019-04-11T21:00:00' },
  { path: 'Downloads/ChromeSetup.exe', content: installer('Chrome'), modified: '2024-02-03T10:00:00' },
  { path: 'Downloads/ZoomInstaller.exe', content: installer('Zoom'), modified: '2023-09-14T08:00:00' },
  { path: 'Downloads/ZoomInstaller (1).exe', content: installer('Zoom'), modified: '2024-05-21T08:00:00' },
  { path: 'Downloads/SpotifySetup.exe', content: installer('Spotify'), modified: '2025-01-05T19:00:00' },
  { path: 'Downloads/tax_return_2023.pdf.txt', content: 'Federal return 2023 (scenario stand-in)\n', modified: '2024-04-10T22:00:00' },
  { path: 'Downloads/tax_return_2023 (1).pdf.txt', content: 'Federal return 2023 (scenario stand-in)\n', modified: '2024-04-10T22:01:00' },
  { path: 'Downloads/invoice-8812.txt', content: 'Buckeye Heating invoice 8812: furnace tune-up $129.00, paid 11/08/2025\n', modified: '2025-11-08T15:00:00' },
  { path: 'Downloads/coupons-kroger-week47.txt', content: 'Digital coupons, week 47\n', modified: '2026-11-17T07:30:00' },
  { path: 'Downloads/old-photos-backup-2018.zip', content: new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]), modified: '2018-12-30T11:00:00' },
  { path: 'Downloads/Untitled document.txt', content: '', modified: '2025-07-02T13:00:00' },
  { path: 'Desktop/New folder/notes.txt', content: 'call about the gutters\n', modified: '2022-10-01T10:00:00' },
  { path: 'Desktop/old printer driver.exe', content: installer('HP printer driver'), modified: '2020-01-15T09:00:00' },
];

// ── The second set's fixtures (cases 41-80) ──

/** The power company's usage history, 24 months: about the same use, a higher price per kWh from June 2026. */
export const ELECTRIC_BILLS: ReadonlyArray<readonly [string, string, number, number]> = [
  ['2024-11-21', 'Oct 22 - Nov 20, 2024', 720, 112.4], ['2024-12-20', 'Nov 21 - Dec 19, 2024', 910, 138.95], ['2025-01-22', 'Dec 20 - Jan 21, 2025', 1040, 157.3],
  ['2025-02-20', 'Jan 22 - Feb 19, 2025', 930, 141.1], ['2025-03-21', 'Feb 20 - Mar 20, 2025', 780, 119.85], ['2025-04-21', 'Mar 21 - Apr 20, 2025', 640, 100.2],
  ['2025-05-21', 'Apr 21 - May 20, 2025', 690, 107.15], ['2025-06-20', 'May 21 - Jun 19, 2025', 1010, 151.6], ['2025-07-22', 'Jun 20 - Jul 21, 2025', 1240, 183.9],
  ['2025-08-21', 'Jul 22 - Aug 20, 2025', 1190, 177.05], ['2025-09-19', 'Aug 21 - Sep 18, 2025', 880, 134.2], ['2025-10-21', 'Sep 19 - Oct 20, 2025', 700, 109.6],
  ['2025-11-20', 'Oct 21 - Nov 19, 2025', 735, 115.1], ['2025-12-19', 'Nov 20 - Dec 18, 2025', 925, 142.3], ['2026-01-21', 'Dec 19 - Jan 20, 2026', 1065, 162.75],
  ['2026-02-19', 'Jan 21 - Feb 18, 2026', 950, 146.2], ['2026-03-20', 'Feb 19 - Mar 19, 2026', 770, 120.4], ['2026-04-21', 'Mar 20 - Apr 20, 2026', 655, 104.1],
  ['2026-05-20', 'Apr 21 - May 19, 2026', 700, 110.9], ['2026-06-19', 'May 20 - Jun 18, 2026', 1030, 171.45], ['2026-07-21', 'Jun 19 - Jul 20, 2026', 1265, 209.8],
  ['2026-08-20', 'Jul 21 - Aug 19, 2026', 1210, 201.35], ['2026-09-18', 'Aug 20 - Sep 17, 2026', 895, 150.6], ['2026-10-20', 'Sep 18 - Oct 19, 2026', 715, 121.95],
];

/** The usage history as the power company's CSV download. */
export function electricCsv(): string {
  return ['Bill Date,Service Period,kWh Used,Amount Due', ...ELECTRIC_BILLS.map(([date, period, kwh, amount]) => `${date},"${period}",${kwh},${amount.toFixed(2)}`)].join('\n') + '\n';
}

/** The neighborhood guidelines, as blocks: `# ` a heading, else a paragraph. Three pages or so. */
export const HOA_GUIDELINES = [
  '# Glen Echo Ravine Homeowners Association — Community Guidelines',
  'Adopted by the Board of Trustees, March 2019; amended January 2024. These guidelines apply to every lot in the Glen Echo Ravine subdivision. Where they are stricter than the City of Columbus code, these guidelines apply.',
  '# Section 1. Architectural Review',
  '1.1 Any new structure, addition, fence, shed, deck, pool or change of exterior color needs written approval from the Architectural Review Committee (ARC) before work begins.',
  '1.2 Submit the ARC Request Form (on the association website or from the secretary) with a site sketch showing the structure and its distance from each lot line, at least 30 days before work is to start. The ARC answers within 30 days; no answer is not an approval.',
  '1.3 Work started without approval may have to be removed at the owner\'s cost.',
  '# Section 2. Fences',
  '2.1 Backyard fences may be up to 6 feet tall. Fences in front of the house may be up to 4 feet tall and must be at least 50% open (picket or rail).',
  '2.2 Chain-link fences are not allowed in front yards. The finished side faces out.',
  '# Section 3. Sheds and Accessory Buildings',
  '3.1 One shed or accessory building is allowed per lot, in the rear yard only.',
  '3.2 A shed may be no larger than 120 square feet in floor area and no taller than 10 feet at its highest point.',
  '3.3 A shed must be set back at least 5 feet from every lot line, and may not sit in a utility easement.',
  '3.4 Siding and roof colors must match or complement the house. Metal sheds must be screened from the street by plantings or a fence.',
  '3.5 Sheds need ARC approval under Section 1 even when no city permit is needed.',
  '# Section 4. Trash and Recycling',
  '4.1 Containers must be kept out of view from the street except on collection day. They may be put at the curb after 6:00 PM the evening before and must be put away by 8:00 PM on collection day.',
  '# Section 5. Holiday Decorations',
  '5.1 Holiday lights and decorations may be displayed from November 15 to January 15.',
  '# Section 6. Vehicles and Parking',
  '6.1 Boats, campers, trailers and RVs may be parked in a driveway for no more than 48 hours in a row. Vehicles may not be parked on lawns.',
  '# Section 7. Lawns and Landscaping',
  '7.1 Lawns must be kept under 8 inches. Dead trees must be removed within 60 days of notice.',
  '7.2 Vegetable gardens are allowed in rear yards only.',
  '# Section 8. Pets',
  '8.1 Dogs must be on a leash outside the owner\'s lot. Owners must pick up after their pets.',
  '# Section 9. Dues',
  '9.1 Annual dues are $240 per lot, due March 1. A $25 late fee applies after April 1.',
  '# Section 10. Violations',
  '10.1 After a written notice, an owner has 30 days to correct a violation. Continued violations may be fined $50 per month.',
  'Questions: Glen Echo Ravine HOA, P.O. Box 14213, Columbus, OH 43214 · secretary@glenechoravine.org',
] as const;

/** The PTO meeting notes, as someone typed them during the meeting. */
export const PTO_NOTES = `Indianola PTO - general meeting - Tues Nov 17 2026, 7pm, library
present: Jen K (pres), Marcus (treas), Mrs. Okafor, ~14 parents

- Treasurer: balance $3,412.18. fall festival made $1,960 after costs!!
- VOTE: $600 for new playground balls + jump ropes -> approved (12 yes, 1 no)
- Book fair Dec 7-11 in the library. need volunteers for 2-hr shifts, sign-up on ParentSquare
- Bake sale Fri Dec 5 at pickup (3:30). sign ups so far:
    Priya M - brownies 2 doz
    Alex P - cookies 2 doz (drop at front office by 8am that day)
    Dana R - rice krispie treats
    still need someone for gluten free stuff
- Spirit wear orders due Dec 1 (hoodies $28, tees $15)
- Mrs Okafor: COSI trip Dec 11 still needs 2 more chaperones
- new idea: winter family movie night in Jan? Jen to check w/ principal
- next meeting Tues Jan 12, 7pm, library
`;

/** The fridge whiteboard: what is written, in order; `done` lines are crossed out. */
export const WHITEBOARD: ReadonlyArray<{ readonly text: string; readonly done?: boolean }> = [
  { text: 'call plumber - kitchen drip' }, { text: 'Emma field trip $8 + slip' }, { text: 'cat litter' }, { text: 'dish soap', done: true },
  { text: 'return library books' }, { text: 'oil change CR-V' }, { text: 'wrapping paper' }, { text: 'Leo haircut Sat' },
];

/** The holiday card address list (with duplicates written a little differently, and one name at two addresses). */
export const CARD_LIST: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['Bob & Karen Miller', '1220 Oakland Park Ave', 'Columbus', 'OH', '43224'],
  ['Linda Parker', '45 Elm St', 'Dayton', 'OH', '45402'],
  ['Joan Whitaker', '312 Maple Ave', 'Zanesville', 'OH', '43701'],
  ['The Hendersons', '88 Weisheimer Rd', 'Columbus', 'OH', '43214'],
  ['Tom & Jess Riley', '2750 Neil Ave', 'Columbus', 'OH', '43202'],
  ['Mike & Dana Parker', '9 Brookside Ct', 'Cincinnati', 'OH', '45208'],
  ['Robert and Karen Miller', '1220 Oakland Park Avenue', 'Columbus', 'OH', '43224'],
  ['Rachel & Steve Burke', '4410 Shawnee Trl', 'Toledo', 'OH', '43615'],
  ['Sam Chen', '600 W 5th Ave Apt 3B', 'Columbus', 'OH', '43201'],
  ['Linda Parker', '45 Elm Street', 'Dayton', 'OH', '45402'],
  ['The Nguyen Family', '127 Glencoe Rd', 'Columbus', 'OH', '43214'],
  ['Joan Whitaker', '1906 Lakeview Dr', 'Sarasota', 'FL', '34231'],
  ['Tom and Jessica Riley', '2750 Neil Avenue', 'Columbus', 'OH', '43202'],
  ['Dave & Priya Kowalski', '3519 Olentangy Blvd', 'Columbus', 'OH', '43214'],
];

/** The card list as a CSV. */
export function cardListCsv(): string {
  return ['Name,Street,City,State,ZIP', ...CARD_LIST.map((row) => row.map((cell) => (cell.includes(',') ? `"${cell}"` : cell)).join(','))].join('\n') + '\n';
}

/** The two budget spreadsheets in Documents/Budget: Alex's and Sara's edit of it. */
const BUDGET_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['Mortgage', 1650], ['Car payment', 380], ['Groceries', 800], ['Utilities', 300], ['Gas for cars', 200], ['Kids activities', 150],
  ['Subscriptions', 100], ['Eating out', 200], ['Savings', 500], ['Vacation fund', 250],
];
const SARA_CHANGES: Readonly<Record<string, number>> = { Groceries: 900, Subscriptions: 60, 'Eating out': 150 };
const budgetCsv = (rows: ReadonlyArray<readonly [string, number]>): string => ['Category,Monthly', ...rows.map(([what, amount]) => `${what},${amount}`), `Total,${rows.reduce((sum, [, amount]) => sum + amount, 0)}`].join('\n') + '\n';
export const BUDGET_ALEX = budgetCsv(BUDGET_ROWS);
export const BUDGET_SARA = budgetCsv([...BUDGET_ROWS.map(([what, amount]): readonly [string, number] => [what, SARA_CHANGES[what] ?? amount]), ['Christmas gifts', 150]]);

/** A scanned page: its file in Documents/Scans, its heading and its lines. */
export interface Scan {
  readonly name: string;
  readonly heading: string;
  readonly lines: readonly string[];
  readonly modified: string;
}

export const SCANS: readonly Scan[] = [
  { name: 'scan0001.pdf', heading: 'Clintonville Animal Hospital — Invoice', modified: '2026-10-14T17:20:00', lines: ['Invoice #CAH-55102 · October 14, 2026', 'Client: Alex Parker · Patient: Biscuit (cat, 7 yrs)', 'Annual exam — $62.00', 'FVRCP vaccine — $34.50', 'Rabies vaccine (3 yr) — $38.00', 'Thyroid blood panel — $52.00', 'Total: $186.50 · Paid VISA ****4417'] },
  { name: 'scan0002.pdf', heading: 'Ohio Bureau of Motor Vehicles — Registration', modified: '2026-03-25T12:05:00', lines: ['Vehicle registration certificate', 'Owner: Alex Parker, Columbus OH 43214', '2019 Honda CR-V EX', 'Plate: JKT 4821', 'Valid through: 03/22/2027'] },
  { name: 'scan0003.pdf', heading: 'Indianola Informal K-8 — Progress Report', modified: '2026-11-06T20:40:00', lines: ['Student: Emma Parker · Grade 3 · Quarter 1, 2026-27', 'Reading: Meets expectations', 'Math: Exceeds expectations', 'Science: Meets expectations', 'Teacher comment: Emma is a kind classmate and a careful reader. Keep up the nightly reading! — Mrs. Okafor'] },
  { name: 'scan0004.pdf', heading: 'Lowe\'s Protection Plan — Certificate', modified: '2024-06-02T15:10:00', lines: ['Plan #LPP-7718230 · Purchased June 2, 2024', 'Product: Samsung washer WF45T6000AW', 'Coverage: 5 years parts and labor, ends June 1, 2029', 'To file a claim call 1-866-217-5550'] },
];

/** The dishwasher manual in Documents/House, as blocks (the model number is on its first page). */
export const DISHWASHER_MANUAL = [
  '# Bosch 500 Series Dishwasher — Use and Care Manual',
  'Model: SHPM65Z55N · Serial: FD 9907 00123',
  'Please write the model and serial numbers above in this manual and keep it with your receipt. You will need them when you order parts or call for service.',
  '# Safety',
  'Read all instructions before using the dishwasher. Use only detergents and rinse agents made for household dishwashers. Do not wash plastic items unless they are marked dishwasher safe.',
  '# Loading',
  'Load glasses and cups in the upper rack, plates and pots in the lower rack, and silverware handles down in the basket. Make sure the spray arms can turn freely.',
  '# Cleaning the filter',
  'Twist the cylindrical filter at the bottom of the tub counterclockwise, lift it out, rinse it under running water and put it back. Clean it once a month.',
  '# Parts and service',
  'Order genuine parts at 1-800-944-2904. Have your model number (on this page and on the label at the top edge of the door) ready.',
] as const;

/** Text files added to the fake home for the second set (beside `HOUSE`); the scans and the manual are PDFs drawn in make.ts. */
export const HOUSE_2: readonly HouseFile[] = [
  { path: 'Documents/Budget/budget 2026.csv', content: BUDGET_ALEX, modified: '2026-01-04T19:30:00' },
  { path: 'Documents/Budget/budget 2026 - Sara.csv', content: BUDGET_SARA, modified: '2026-11-15T21:10:00' },
  { path: 'Desktop/Passport renewal - confirmation.txt', content: 'U.S. Department of State - online passport renewal\nApplicant: Alex Parker\nApplication number: OPR-2026-1183-4471\nSubmitted November 3, 2026. Keep this number to check your status.\n', modified: '2026-11-03T21:45:00' },
  { path: 'Desktop/funny cat video link.txt', content: 'the one where the cat falls off the counter lol\n', modified: '2025-02-14T20:00:00' },
];
