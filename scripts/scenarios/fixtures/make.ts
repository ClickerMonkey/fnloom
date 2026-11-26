/**
 * The scenario fixtures, made once into `.harness-test/scenarios/fixtures/` (and again with `--fixtures`): the files a
 * person attaches (a receipt photo, a school letter, three car insurance quotes, a bank statement as PDF and CSV; for
 * the second set an electric usage CSV, the neighborhood rules PDF, meeting notes, a whiteboard photo and a card
 * address list), and a fake home folder (Documents with two budget spreadsheets, four badly named scans and a
 * dishwasher manual, Pictures with photos, a cluttered Downloads, a Desktop, a few old files) that each repetition
 * copies as the fs system's root. Pictures and PDFs are drawn as HTML and rendered with Puppeteer.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import type { FixtureFile } from '../cases.ts';
import {
  cardListCsv, DISHWASHER_MANUAL, electricCsv, HOA_GUIDELINES, HOUSE, HOUSE_2, PHOTOS, PTO_NOTES, RECEIPT, SCANS, SCHOOL_LETTER, QUOTES, STATEMENT, statementCsv, WHITEBOARD,
  type Quote, type Scan,
} from './content.ts';

/** One attachable file: where it is under the fixtures folder and its type. */
export interface FixtureEntry {
  readonly path: string;
  readonly mime: string;
}

/** Each attachable file. */
export const FIXTURES: Readonly<Record<FixtureFile, FixtureEntry>> = {
  receipt: { path: 'files/kroger-receipt.jpg', mime: 'image/jpeg' },
  'school-letter': { path: 'files/Indianola-family-letter.pdf', mime: 'application/pdf' },
  'quote-a': { path: 'files/Progressive-quote.pdf', mime: 'application/pdf' },
  'quote-b': { path: 'files/state-farm-quote.jpg', mime: 'image/jpeg' },
  'quote-c': { path: 'files/Erie-Insurance-quote.pdf', mime: 'application/pdf' },
  'bank-statement-pdf': { path: 'files/BCB-statement-2026-10.pdf', mime: 'application/pdf' },
  'bank-statement-csv': { path: 'files/BCB-transactions-2026-10.csv', mime: 'text/csv' },
  // the second set's (41-80)
  'electric-bills': { path: 'files/AEP-usage-history.csv', mime: 'text/csv' },
  'hoa-guidelines': { path: 'files/Glen-Echo-Ravine-HOA-guidelines.pdf', mime: 'application/pdf' },
  'pto-notes': { path: 'files/PTO meeting notes Nov 17.txt', mime: 'text/plain' },
  whiteboard: { path: 'files/IMG_3561.jpg', mime: 'image/jpeg' },
  'card-list': { path: 'files/holiday card addresses.csv', mime: 'text/csv' },
};

/** The fake home's PDFs of the second set, under the home folder: the scans and the dishwasher manual. */
const HOME_PDFS: readonly string[] = [...SCANS.map((scan) => `Documents/Scans/${scan.name}`), 'Documents/House/Bosch dishwasher manual.pdf'];

/** The fake home folder, under the fixtures folder. */
export const HOME_TEMPLATE = 'home';

const page = (body: string, style = ''): string => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #222; } ${style}
</style></head><body>${body}</body></html>`;

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A PDF of letter pages. */
async function pdf(browser: Browser, html: string, file: string): Promise<void> {
  const tab = await browser.newPage();
  await tab.setContent(html, { waitUntil: 'load' });
  mkdirSync(dirname(file), { recursive: true });
  await tab.pdf({ path: file, format: 'letter', margin: { top: '0.6in', bottom: '0.6in', left: '0.7in', right: '0.7in' }, printBackground: true });
  await tab.close();
}

/** A JPEG of an HTML scene. */
async function jpeg(browser: Browser, html: string, file: string, size: { width: number; height: number }): Promise<void> {
  const tab = await browser.newPage();
  await tab.setViewport(size);
  await tab.setContent(html, { waitUntil: 'load' });
  mkdirSync(dirname(file), { recursive: true });
  await tab.screenshot({ path: file, type: 'jpeg', quality: 82 });
  await tab.close();
}

/** The receipt, as a phone photo: a slightly turned paper slip on a counter. */
function receiptHtml(): string {
  const lines = RECEIPT.items.map((item) => `<tr><td>${esc(item.name)}</td><td class="r">${item.price.toFixed(2)}</td></tr>`).join('');
  return page(`<div class="counter"><div class="slip">
    <div class="c b big">KROGER</div><div class="c">${esc(RECEIPT.store)}</div><div class="c">${esc(RECEIPT.address)}</div>
    <div class="c">${esc(RECEIPT.when)}</div><hr><table>${lines}</table><hr>
    <table><tr><td>SUBTOTAL</td><td class="r">${RECEIPT.subtotal.toFixed(2)}</td></tr><tr><td>TAX</td><td class="r">${RECEIPT.tax.toFixed(2)}</td></tr>
    <tr class="b"><td>TOTAL</td><td class="r">${RECEIPT.total.toFixed(2)}</td></tr><tr><td>VISA ****4417</td><td class="r">${RECEIPT.total.toFixed(2)}</td></tr></table>
    <hr><div class="c">FUEL POINTS EARNED: 136</div><div class="c">THANK YOU FOR SHOPPING KROGER</div></div></div>`, `
    .counter { width: 900px; height: 1200px; background: radial-gradient(circle at 30% 20%, #b9a58a, #6f5d48); display: flex; align-items: center; justify-content: center; }
    .slip { width: 470px; background: #fbfaf4; padding: 28px 30px; transform: rotate(-1.5deg); box-shadow: 8px 12px 30px rgba(0,0,0,.45); font-family: 'Courier New', monospace; font-size: 17px; }
    table { width: 100%; border-collapse: collapse; } td { padding: 2px 0; } .r { text-align: right; } .c { text-align: center; } .b { font-weight: bold; } .big { font-size: 34px; letter-spacing: 4px; }
    hr { border: none; border-top: 2px dashed #888; margin: 10px 0; }`);
}

function schoolLetterHtml(): string {
  return page(`<div class="head"><b>Indianola Informal K-8</b><br>251 E Weber Rd, Columbus, OH 43202 · (614) 365-5000</div>
    ${SCHOOL_LETTER.map((block) => (block.startsWith('# ') ? `<h2>${esc(block.slice(2))}</h2>` : block.startsWith('- ') ? `<ul>${block.split('\n').map((line) => `<li>${esc(line.slice(2))}</li>`).join('')}</ul>` : `<p>${esc(block)}</p>`)).join('')}`, `
    .head { border-bottom: 3px solid #1d4e89; padding-bottom: 8px; margin-bottom: 18px; color: #1d4e89; } h2 { color: #1d4e89; font-size: 17px; margin: 18px 0 6px; }
    p, li { font-size: 13.5px; line-height: 1.45; }`);
}

function quoteHtml(quote: Quote): string {
  const rows = quote.coverages.map(([what, limit, premium]) => `<tr><td>${esc(what)}</td><td>${esc(limit)}</td><td class="r">${esc(premium)}</td></tr>`).join('');
  return page(`<div class="brand" style="background:${quote.color}">${esc(quote.company)}</div>
    <h1>Auto insurance quote</h1><p>Quote #${esc(quote.number)} · Prepared ${esc(quote.date)} for Alex &amp; Sara Parker, 43214 Columbus OH</p>
    <p><b>Vehicles:</b> 2019 Honda CR-V EX · 2021 Toyota Sienna LE<br><b>Drivers:</b> Alex Parker (41), Sara Parker (39)</p>
    <table><tr><th>Coverage</th><th>Limit / deductible</th><th class="r">6-month premium</th></tr>${rows}</table>
    <p class="total">Total 6-month premium: <b>${esc(quote.total)}</b> &nbsp; (${esc(quote.monthly)})</p>
    <p class="fine">${quote.notes.map(esc).join('<br>')}</p>`, `
    .brand { color: #fff; font-size: 26px; font-weight: bold; padding: 14px 18px; border-radius: 6px; } h1 { font-size: 22px; margin: 18px 0 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; } th, td { border-bottom: 1px solid #ccc; padding: 7px 6px; font-size: 13px; text-align: left; } .r { text-align: right; }
    .total { font-size: 16px; margin-top: 16px; } .fine { font-size: 11.5px; color: #555; }`);
}

/** The second quote as a phone photo of a printout. */
function quotePhotoHtml(quote: Quote): string {
  return page(`<div class="desk"><div class="sheet">${quoteHtml(quote).replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, '')}</div></div>`, `
    .desk { width: 1100px; height: 1400px; background: linear-gradient(135deg, #3d4a57, #222a31); display: flex; align-items: center; justify-content: center; }
    .sheet { width: 820px; background: #fff; padding: 36px; transform: rotate(1deg); box-shadow: 10px 14px 40px rgba(0,0,0,.6); }
    .brand { color: #fff; font-size: 26px; font-weight: bold; padding: 14px 18px; } table { width: 100%; border-collapse: collapse; } th, td { border-bottom: 1px solid #ccc; padding: 7px 6px; font-size: 14px; text-align: left; }
    .r { text-align: right; } .total { font-size: 18px; } .fine { font-size: 12px; color: #555; }`);
}

function statementHtml(): string {
  const rows = STATEMENT.rows.map((row) => `<tr><td>${row.date}</td><td>${esc(row.description)}</td><td class="r">${row.amount < 0 ? (-row.amount).toFixed(2) : ''}</td><td class="r">${row.amount > 0 ? row.amount.toFixed(2) : ''}</td><td class="r">${row.balance.toFixed(2)}</td></tr>`).join('');
  return page(`<div class="brand">Buckeye Community Bank</div><p>Statement period: October 1 – October 31, 2026<br>Alex &amp; Sara Parker · Everyday Checking ****2290</p>
    <p>Beginning balance: $${STATEMENT.opening.toFixed(2)} · Ending balance: $${STATEMENT.closing.toFixed(2)}</p>
    <table><tr><th>Date</th><th>Description</th><th class="r">Withdrawals</th><th class="r">Deposits</th><th class="r">Balance</th></tr>${rows}</table>`, `
    .brand { font-size: 22px; font-weight: bold; color: #a3121d; border-bottom: 2px solid #a3121d; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; } th, td { border-bottom: 1px solid #ddd; padding: 4px 5px; font-size: 11px; text-align: left; } .r { text-align: right; } p { font-size: 12px; }`);
}

/** A photo: a simple scene with the caption a phone wouldn't add, so a picture reader has something to describe. */
function photoHtml(photo: (typeof PHOTOS)[number]): string {
  return page(`<div class="scene" style="background:linear-gradient(${photo.sky})"><div class="sun"></div><div class="ground" style="background:${photo.ground}"></div><div class="what">${esc(photo.what)}</div></div>`, `
    .scene { width: 1200px; height: 900px; position: relative; overflow: hidden; } .sun { position: absolute; width: 160px; height: 160px; border-radius: 50%; background: #ffe38a; top: 90px; right: 160px; }
    .ground { position: absolute; left: -10%; right: -10%; bottom: -120px; height: 420px; border-radius: 50% 50% 0 0; } .what { position: absolute; left: 40px; bottom: 40px; color: #fff; font-size: 44px; text-shadow: 0 2px 6px #000; }`);
}

/** A document of blocks (`# ` a heading, `- ` lines a list, else a paragraph) under a plain letterhead. */
function blocksHtml(blocks: readonly string[], color: string): string {
  return page(blocks.map((block) => (block.startsWith('# ') ? `<h2>${esc(block.slice(2))}</h2>` : block.startsWith('- ') ? `<ul>${block.split('\n').map((line) => `<li>${esc(line.slice(2))}</li>`).join('')}</ul>` : `<p>${esc(block)}</p>`)).join(''), `
    h2 { color: ${color}; font-size: 17px; margin: 20px 0 6px; border-bottom: 1px solid ${color}; padding-bottom: 3px; } h2:first-child { font-size: 22px; border-bottom-width: 3px; }
    p, li { font-size: 13.5px; line-height: 1.55; }`);
}

/** A scanned page: an off-white sheet, a little grey, a heading and its lines. */
function scanHtml(scan: Scan): string {
  return page(`<div class="sheet"><h1>${esc(scan.heading)}</h1>${scan.lines.map((line) => `<p>${esc(line)}</p>`).join('')}</div>`, `
    body { background: #f4f2ec; } .sheet { padding: 10px 4px; filter: grayscale(0.4) contrast(0.95); } h1 { font-size: 20px; border-bottom: 2px solid #333; padding-bottom: 6px; }
    p { font-size: 14px; line-height: 1.6; margin: 6px 0; }`);
}

/** The fridge whiteboard as a phone photo: marker handwriting, one line crossed out, a magnet or two. */
function whiteboardHtml(): string {
  const colors = ['#1b3a8c', '#1b3a8c', '#b3261e', '#1b3a8c', '#14692f', '#1b3a8c', '#b3261e', '#14692f'];
  const lines = WHITEBOARD.map((item, i) => `<div class="line" style="color:${colors[i % colors.length]};transform:rotate(${((i % 3) - 1) * 0.8}deg)">${item.done === true ? `<s>${esc(item.text)}</s>` : esc(item.text)}</div>`).join('');
  return page(`<div class="fridge"><div class="board"><div class="title">TO DO!!</div>${lines}<div class="magnet m1"></div><div class="magnet m2"></div></div></div>`, `
    .fridge { width: 900px; height: 1200px; background: linear-gradient(90deg, #d9dde2, #f3f5f7 40%, #c9ced4); display: flex; align-items: center; justify-content: center; }
    .board { position: relative; width: 640px; padding: 40px 46px 60px; background: #fdfdfb; border: 14px solid #b9bec5; border-radius: 8px; transform: rotate(-2deg); box-shadow: 6px 10px 26px rgba(0,0,0,.35); font-family: 'Segoe Print', 'Comic Sans MS', 'Bradley Hand', cursive; }
    .title { font-size: 46px; color: #b3261e; margin-bottom: 18px; } .line { font-size: 34px; margin: 14px 0; } s { text-decoration-thickness: 4px; }
    .magnet { position: absolute; width: 46px; height: 46px; border-radius: 50%; } .m1 { background: #f2b705; top: -22px; left: 60px; } .m2 { background: #2a9d8f; top: -22px; right: 80px; }`);
}

/** Write a file of the home folder with its modified time. */
function homeFile(root: string, path: string, content: string | Uint8Array, modified: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  const at = new Date(modified);
  utimesSync(file, at, at);
}

/** Whether the fixtures are there already. */
export function fixturesReady(folder: string): boolean {
  const home = [...HOUSE, ...HOUSE_2].map((entry) => entry.path).concat(HOME_PDFS);
  return Object.values(FIXTURES).every((entry) => existsSync(join(folder, entry.path))) && existsSync(join(folder, HOME_TEMPLATE, 'Pictures'))
    && home.every((path) => existsSync(join(folder, HOME_TEMPLATE, path)));
}

/**
 * The Chrome to draw with: Puppeteer's own when it is installed, else any Chrome in Puppeteer's cache (an older one
 * left by an earlier install does the job).
 */
async function chrome(): Promise<string | undefined> {
  if (existsSync(await puppeteer.executablePath())) { return undefined; }
  const cache = join(homedir(), '.cache', 'puppeteer', 'chrome');
  const found = existsSync(cache) ? readdirSync(cache).map((version) => join(cache, version, 'chrome-win64', 'chrome.exe')).find((path) => existsSync(path)) : undefined;
  return found;
}

/**
 * Make every fixture into `folder`. With `fresh` (the runner's `--fixtures`) the folder is emptied first; without it
 * (fixtures missing, such as after new ones were added) every fixture is written over what is there, so a run that is
 * reading the folder meanwhile never finds it gone.
 */
export async function makeFixtures(folder: string, fresh = false): Promise<void> {
  if (fresh) { rmSync(folder, { recursive: true, force: true }); }
  const executablePath = await chrome();
  const browser = await puppeteer.launch({ headless: true, ...(executablePath === undefined ? {} : { executablePath }) });
  try {
    await jpeg(browser, receiptHtml(), join(folder, FIXTURES.receipt.path), { width: 900, height: 1200 });
    await pdf(browser, schoolLetterHtml(), join(folder, FIXTURES['school-letter'].path));
    const [a, b, c] = QUOTES;
    await pdf(browser, quoteHtml(a), join(folder, FIXTURES['quote-a'].path));
    await jpeg(browser, quotePhotoHtml(b), join(folder, FIXTURES['quote-b'].path), { width: 1100, height: 1400 });
    await pdf(browser, quoteHtml(c), join(folder, FIXTURES['quote-c'].path));
    await pdf(browser, statementHtml(), join(folder, FIXTURES['bank-statement-pdf'].path));
    writeFileSync(join(folder, FIXTURES['bank-statement-csv'].path), statementCsv());

    const home = join(folder, HOME_TEMPLATE);
    for (const photo of PHOTOS) {
      const file = join(home, 'Pictures', photo.name);
      await jpeg(browser, photoHtml(photo), file, { width: 1200, height: 900 });
      const at = new Date(photo.taken);
      utimesSync(file, at, at);
    }
    // a copy of one photo left in Downloads, as phones do
    const dupe = PHOTOS[0];
    await jpeg(browser, photoHtml(dupe), join(home, 'Downloads', dupe.name.replace('.JPG', ' (1).JPG')), { width: 1200, height: 900 });
    for (const entry of HOUSE) { homeFile(home, entry.path, entry.content, entry.modified); }
    // the statement and a quote also sit in Downloads, where a browser saves them
    await pdf(browser, statementHtml(), join(home, 'Downloads', 'BCB-statement-2026-09.pdf'));
    await pdf(browser, quoteHtml(a), join(home, 'Downloads', 'Progressive-quote (2).pdf'));

    // the second set's (41-80): files to attach, and more of the home (budgets, scans, a manual, Desktop files)
    mkdirSync(join(folder, 'files'), { recursive: true });
    writeFileSync(join(folder, FIXTURES['electric-bills'].path), electricCsv());
    await pdf(browser, blocksHtml(HOA_GUIDELINES, '#2f5d3a'), join(folder, FIXTURES['hoa-guidelines'].path));
    writeFileSync(join(folder, FIXTURES['pto-notes'].path), PTO_NOTES);
    await jpeg(browser, whiteboardHtml(), join(folder, FIXTURES.whiteboard.path), { width: 900, height: 1200 });
    writeFileSync(join(folder, FIXTURES['card-list'].path), cardListCsv());
    for (const entry of HOUSE_2) { homeFile(home, entry.path, entry.content, entry.modified); }
    for (const scan of SCANS) {
      const file = join(home, 'Documents', 'Scans', scan.name);
      await pdf(browser, scanHtml(scan), file);
      const at = new Date(scan.modified);
      utimesSync(file, at, at);
    }
    const manual = join(home, 'Documents', 'House', 'Bosch dishwasher manual.pdf');
    await pdf(browser, blocksHtml(DISHWASHER_MANUAL, '#20385c'), manual);
    utimesSync(manual, new Date('2023-05-12T10:00:00'), new Date('2023-05-12T10:00:00'));
  } finally {
    await browser.close();
  }
}
