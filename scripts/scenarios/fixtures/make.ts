/**
 * The scenario fixtures, made once into `.harness-test/scenarios/fixtures/` (and again with `--fixtures`): the files a
 * person attaches (a receipt photo, a school letter, three car insurance quotes, a bank statement as PDF and CSV), and
 * a fake home folder (Documents, Pictures with photos, a cluttered Downloads, a few old files) that each repetition
 * copies as the fs system's root. Pictures and PDFs are drawn as HTML and rendered with Puppeteer.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import type { FixtureFile } from '../cases.ts';
import { HOUSE, PHOTOS, RECEIPT, SCHOOL_LETTER, QUOTES, STATEMENT, statementCsv, type Quote } from './content.ts';

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
};

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
  return Object.values(FIXTURES).every((entry) => existsSync(join(folder, entry.path))) && existsSync(join(folder, HOME_TEMPLATE, 'Pictures'));
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

/** Make every fixture into `folder`, replacing what is there. */
export async function makeFixtures(folder: string): Promise<void> {
  rmSync(folder, { recursive: true, force: true });
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
  } finally {
    await browser.close();
  }
}
