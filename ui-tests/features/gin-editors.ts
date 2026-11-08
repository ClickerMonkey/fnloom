/**
 * The gin editors and viewers (build 2 design 3.15) on the design page: the value, type and expression components,
 * each as an editor beside its viewer. Editing a value updates its viewer, adding a field to the type shows it in the
 * type's viewer, and an expression shows what it gives. At a desktop, a tall tablet and a phone, in light and dark.
 */
import { BUILD_2_VIEWPORTS, check, feature, inEachScheme, open, settle, show, tid } from '../kit.ts';

export default feature({
  id: 'gin-editors', ref: 'build-2 3.15', title: 'Gin editors and viewers', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page } = ctx;
    await inEachScheme(ctx, async (shot) => {
      await open(ctx, '/design/gin', tid('design-gin'));
      await shot('value');

      // a value typed into the editor shows in the viewer beside it
      const path = `${tid('design-value-edit')} [data-path="path"] input`;
      await page.click(path, { count: 3 });
      await page.type(path, 'docs/edited.md');
      await page.waitForFunction(() => document.querySelector('[data-testid="design-value-view"]')?.textContent.includes('docs/edited.md') === true, { timeout: 5_000 });
      await show(page, tid('design-value-view'));
      await shot('value-edited');

      // a field added in the type editor shows in the type's viewer
      await show(page, tid('design-type-edit'));
      await shot('type');
      const before = await page.$$eval(`${tid('design-type-view')} [data-field]`, (els) => els.length);
      await page.click(`${tid('design-type-edit')} [data-testid="gin-type-add-field"]`);
      await page.waitForFunction((count) => document.querySelectorAll('[data-testid="design-type-view"] [data-field]').length > count, { timeout: 5_000 }, before);
      await show(page, tid('design-type-view'));
      await shot('type-added');

      // the expression editor and viewer, with what the expression gives
      await show(page, tid('design-expr-edit'));
      const gives = await page.$eval(`${tid('design-expr-view')} [data-testid="gin-expr-type"]`, (el) => el.textContent.trim());
      check(gives !== '' && gives !== '—', `the expression says what it gives (got "${gives}")`);
      await shot('expression');
      await show(page, tid('design-expr-view'));
      await settle(page);
      await shot('expression-view');
    });
  },
});
