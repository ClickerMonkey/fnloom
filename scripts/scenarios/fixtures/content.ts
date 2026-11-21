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
interface HouseFile {
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
