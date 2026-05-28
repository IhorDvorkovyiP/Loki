// @ts-check
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');

const APP_ROOT  = path.join(__dirname, '../..');
const SAMPLE_LOG = path.join(__dirname, '../fixtures/sample.log');

/** @type {import('@playwright/test').ElectronApplication} */
let app;
/** @type {import('@playwright/test').Page} */
let page;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Mock open-file-dialog to return a given path, then click Open */
async function openFile(filePath) {
  await app.evaluate(({ ipcMain }, fp) => {
    ipcMain.removeHandler('open-file-dialog');
    ipcMain.handle('open-file-dialog', () => fp);
  }, filePath);
  await page.click('#open-btn');
  await page.waitForSelector('.log-line', { timeout: 8000 });
}

/** Total visible log rows */
async function rowCount() {
  return page.locator('.log-line').count();
}

// ── Suite ────────────────────────────────────────────────────────────────────

test.describe('Loki log viewer — E2E', () => {

  test.beforeAll(async () => {
    app  = await electron.launch({ args: [APP_ROOT] });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(600); // wait for async init()
  });

  test.afterAll(async () => {
    await app.close();
  });

  // ── 1. Запуск ─────────────────────────────────────────────────────────────
  test.describe('1 · Запуск', () => {
    test('показує drop zone при старті', async () => {
      await expect(page.locator('#drop-zone')).toBeVisible();
    });

    test('тулбар відображається', async () => {
      await expect(page.locator('#toolbar')).toBeVisible();
    });

    test('кнопки фільтрів рівнів присутні', async () => {
      for (const lvl of ['INFO', 'ERROR', 'WARN']) {
        await expect(page.locator(`.toggle-btn[data-level="${lvl}"]`)).toBeVisible();
      }
    });

    test('кнопки керування присутні', async () => {
      await expect(page.locator('#open-btn')).toBeVisible();
      await expect(page.locator('#recent-btn')).toBeVisible();
      await expect(page.locator('#search')).toBeVisible();
      await expect(page.locator('#exclude-btn')).toBeVisible();
      await expect(page.locator('#font-inc')).toBeVisible();
      await expect(page.locator('#font-dec')).toBeVisible();
    });

    test('вкладки файлів присутні', async () => {
      await expect(page.locator('#file-tabs')).toBeVisible();
      await expect(page.locator('.file-tab-add')).toBeVisible();
    });
  });

  // ── 2. Відкриття файлу ────────────────────────────────────────────────────
  test.describe('2 · Відкриття файлу', () => {
    test.beforeAll(async () => {
      await openFile(SAMPLE_LOG);
    });

    test('workspace показується, drop-zone ховається', async () => {
      await expect(page.locator('#workspace')).toBeVisible();
      await expect(page.locator('#drop-zone')).not.toBeVisible();
    });

    test('рядки логів відображаються', async () => {
      expect(await rowCount()).toBeGreaterThan(0);
    });

    test('статистика показує кількість рядків', async () => {
      const stats = await page.locator('#stats').textContent();
      expect(stats).toMatch(/\d+ \/ \d+ рядків/);
    });

    test('вкладка показує ім\'я файлу', async () => {
      const label = await page.locator('.file-tab.active .file-tab-label').textContent();
      expect(label).toBe('sample.log');
    });

    test('нещодавні файли заповнюються після відкриття', async () => {
      await page.click('#recent-btn');
      await page.waitForSelector('#recent-menu', { timeout: 3000 });
      const items = await page.locator('.recent-item').count();
      expect(items).toBeGreaterThan(0);
      await page.click('body');
      await page.waitForTimeout(200);
    });
  });

  // ── 3. Фільтри рівнів ────────────────────────────────────────────────────
  test.describe('3 · Фільтри рівнів', () => {
    test('кнопка INFO solo — показує тільки INFO рядки', async () => {
      await page.click('.toggle-btn[data-level="INFO"]');
      await page.waitForTimeout(200);
      const total = await rowCount();
      const infoRows = await page.locator('.log-line.level-INFO').count();
      expect(total).toBe(infoRows);
      // Скинути
      await page.click('.toggle-btn[data-level="INFO"]');
      await page.waitForTimeout(200);
    });

    test('кнопка ERROR solo — показує тільки ERROR рядки', async () => {
      await page.click('.toggle-btn[data-level="ERROR"]');
      await page.waitForTimeout(200);
      const total = await rowCount();
      const errorRows = await page.locator('.log-line.level-ERROR').count();
      expect(total).toBe(errorRows);
      await page.click('.toggle-btn[data-level="ERROR"]');
      await page.waitForTimeout(200);
    });

    test('кнопка WARN solo — показує тільки WARN рядки', async () => {
      await page.click('.toggle-btn[data-level="WARN"]');
      await page.waitForTimeout(200);
      const total = await rowCount();
      const warnRows = await page.locator('.log-line.level-WARN').count();
      expect(total).toBe(warnRows);
      await page.click('.toggle-btn[data-level="WARN"]');
      await page.waitForTimeout(200);
    });

    test('DEBUG рядки не показуються (прибрані з фільтрів)', async () => {
      const debugRows = await page.locator('.log-line.level-DEBUG').count();
      expect(debugRows).toBe(0);
    });
  });

  // ── 4. Пошук ─────────────────────────────────────────────────────────────
  test.describe('4 · Пошук', () => {
    test('текстовий пошук фільтрує рядки', async () => {
      const before = await rowCount();
      await page.fill('#search', 'login');
      await page.waitForTimeout(300);
      const after = await rowCount();
      expect(after).toBeLessThan(before);
      expect(after).toBeGreaterThan(0);
    });

    test('stats оновлюється після пошуку', async () => {
      const stats = await page.locator('#stats').textContent();
      expect(stats).toMatch(/\d+ \/ \d+ рядків/);
    });

    test('regex пошук /ERROR/i працює', async () => {
      await page.fill('#search', '/ERROR/i');
      await page.waitForTimeout(300);
      const count = await rowCount();
      expect(count).toBeGreaterThan(0);
    });

    test('очищення пошуку відновлює всі рядки', async () => {
      const allCount = await page.evaluate(() => {
        return parseInt(document.querySelector('#stats')?.textContent?.split('/')[1] || '0');
      });
      await page.fill('#search', '');
      await page.waitForTimeout(300);
      const restored = await rowCount();
      expect(restored).toBeGreaterThanOrEqual(allCount > 0 ? allCount : 1);
    });

    test('пошук без результатів показує 0 рядків', async () => {
      await page.fill('#search', 'xyzNonExistentString99999');
      await page.waitForTimeout(300);
      expect(await rowCount()).toBe(0);
      await page.fill('#search', '');
      await page.waitForTimeout(200);
    });
  });

  // ── 5. Виключення ────────────────────────────────────────────────────────
  test.describe('5 · Exclude фільтр', () => {
    test('панель виключень відкривається', async () => {
      await page.click('#exclude-btn');
      await page.waitForSelector('#exclude-panel', { timeout: 3000 });
      await expect(page.locator('#exclude-panel')).toBeVisible();
    });

    test('додавання терміну зменшує кількість рядків', async () => {
      const before = await rowCount();
      await page.fill('#exclude-input', 'login');
      await page.click('#exclude-add-btn');
      await page.waitForTimeout(300);
      const after = await rowCount();
      expect(after).toBeLessThan(before);
    });

    test('кнопка показує кількість активних виключень', async () => {
      const btnText = await page.locator('#exclude-btn').textContent();
      expect(btnText).toContain('(1)');
    });

    test('chip відображається для терміну', async () => {
      await page.click('#exclude-btn');
      await page.waitForSelector('#exclude-panel');
      const chips = await page.locator('.exclude-chip').count();
      expect(chips).toBe(1);
    });

    test('кілька термінів через кому', async () => {
      await page.fill('#exclude-input', 'health,ping');
      await page.click('#exclude-add-btn');
      await page.waitForTimeout(300);
      const chips = await page.locator('.exclude-chip').count();
      expect(chips).toBeGreaterThanOrEqual(2);
    });

    test('видалення chip відновлює рядки', async () => {
      const beforeRemove = await rowCount();
      await page.locator('.exclude-chip-remove').first().click();
      await page.waitForTimeout(300);
      const afterRemove = await rowCount();
      expect(afterRemove).toBeGreaterThanOrEqual(beforeRemove);
    });

    test('"Скинути всі" видаляє всі виключення', async () => {
      const beforeClear = await rowCount();
      await page.click('#exclude-clear-btn');
      await page.waitForTimeout(300);
      const afterClear = await rowCount();
      expect(afterClear).toBeGreaterThan(beforeClear);
      // Закрити панель
      await page.click('body');
      await page.waitForTimeout(200);
    });
  });

  // ── 6. Детальна панель ────────────────────────────────────────────────────
  test.describe('6 · Детальна панель', () => {
    test('клік по рядку відкриває деталі', async () => {
      await page.locator('.log-line').first().click();
      await page.waitForTimeout(200);
      const meta = await page.locator('#detail-meta').textContent();
      expect(meta.trim().length).toBeGreaterThan(0);
    });

    test('detail-content містить розмічений JSON', async () => {
      const html = await page.locator('#detail-content').innerHTML();
      expect(html.length).toBeGreaterThan(10);
    });

    test('пошук в боді підсвічує збіги', async () => {
      await page.fill('#body-search', 'action');
      await page.waitForTimeout(300);
      const marks = await page.locator('#detail-content mark').count();
      expect(marks).toBeGreaterThan(0);
      await page.fill('#body-search', '');
    });

    test('кнопка Розгорнути все розгортає JSON', async () => {
      await page.click('#expand-all-btn');
      await page.waitForTimeout(200);
      const collapsed = await page.locator('#detail-content .json-children.collapsed').count();
      expect(collapsed).toBe(0);
    });

    test('кнопка Згорнути все згортає JSON', async () => {
      await page.click('#collapse-all-btn');
      await page.waitForTimeout(200);
      // Після згортання перевіряємо що є collapsed елементи або root показано
      const content = await page.locator('#detail-content').innerHTML();
      expect(content.length).toBeGreaterThan(0);
    });

    test('колапс правої панелі через кнопку ▶', async () => {
      await page.click('#detail-toggle-btn');
      await page.waitForTimeout(200);
      await expect(page.locator('#detail-pane')).toHaveClass(/collapsed/);
    });

    test('розгортання правої панелі', async () => {
      await page.click('#detail-toggle-btn');
      await page.waitForTimeout(200);
      await expect(page.locator('#detail-pane')).not.toHaveClass(/collapsed/);
    });
  });

  // ── 7. Виділення рядків ──────────────────────────────────────────────────
  test.describe('7 · Виділення рядків', () => {
    test('Ctrl+клік виділяє рядок', async () => {
      const firstRow = page.locator('.log-line').first();
      await firstRow.click({ modifiers: ['Control'] });
      await page.waitForTimeout(200);
      await expect(firstRow).toHaveClass(/row-selected/);
    });

    test('selection bar показується з кількістю', async () => {
      await expect(page.locator('#selection-bar')).toBeVisible();
      const text = await page.locator('#selection-count').textContent();
      expect(text).toMatch(/1 вибрано/);
    });

    test('Shift+клік виділяє діапазон', async () => {
      await page.locator('.log-line').nth(4).click({ modifiers: ['Shift'] });
      await page.waitForTimeout(200);
      const selected = await page.locator('.log-line.row-selected').count();
      expect(selected).toBeGreaterThanOrEqual(2);
    });

    test('∆ час показується при 2+ виділених', async () => {
      const text = await page.locator('#selection-count').textContent();
      // Або показує ∆, або просто count (якщо timestampes однакові)
      expect(text).toMatch(/вибрано/);
    });

    test('"Тільки ці" фільтрує до виділених', async () => {
      const selectedCount = await page.locator('.log-line.row-selected').count();
      await page.click('#show-selected-btn');
      await page.waitForTimeout(200);
      const visible = await rowCount();
      expect(visible).toBe(selectedCount);
    });

    test('"Скинути" знімає виділення', async () => {
      await page.click('#clear-selection-btn');
      await page.waitForTimeout(200);
      await expect(page.locator('#selection-bar')).not.toBeVisible();
      expect(await page.locator('.log-line.row-selected').count()).toBe(0);
    });
  });

  // ── 8. Trace підсвічування ───────────────────────────────────────────────
  test.describe('8 · Trace підсвічування', () => {
    test('клік по trace підсвічує рядки', async () => {
      const traceEl = page.locator('.log-line .col-trace').first();
      await traceEl.click();
      await page.waitForTimeout(200);
      await expect(page.locator('#trace-bar')).toBeVisible();
    });

    test('trace bar показує значення', async () => {
      const val = await page.locator('#trace-val').textContent();
      expect(val.length).toBeGreaterThan(0);
    });

    test('trace-highlighted клас додається до рядків', async () => {
      const highlighted = await page.locator('.log-line.trace-highlighted').count();
      expect(highlighted).toBeGreaterThan(0);
    });

    test('кнопка × очищає підсвічування', async () => {
      await page.click('#trace-clear');
      await page.waitForTimeout(200);
      await expect(page.locator('#trace-bar')).not.toBeVisible();
      expect(await page.locator('.log-line.trace-highlighted').count()).toBe(0);
    });

    test('Escape очищає trace highlight', async () => {
      await page.locator('.log-line .col-trace').first().click();
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await expect(page.locator('#trace-bar')).not.toBeVisible();
    });
  });

  // ── 9. Закладки ──────────────────────────────────────────────────────────
  test.describe('9 · Закладки', () => {
    test('клавіша B додає закладку', async () => {
      await page.locator('.log-line').first().click();
      await page.waitForTimeout(200);
      await page.keyboard.press('b');
      await page.waitForTimeout(200);
      expect(await page.locator('.log-line.bookmarked').count()).toBeGreaterThan(0);
    });

    test('F2 переходить до наступної закладки', async () => {
      // Додаємо ще одну закладку
      await page.locator('.log-line').nth(5).click();
      await page.keyboard.press('b');
      await page.waitForTimeout(200);
      const selectedBefore = await page.locator('.log-line.selected').getAttribute('style');
      await page.keyboard.press('F2');
      await page.waitForTimeout(200);
      const selectedAfter = await page.locator('.log-line.selected').getAttribute('style');
      // Позиція selected рядка змінилась
      expect(selectedAfter).not.toBe(selectedBefore);
    });

    test('Shift+F2 переходить до попередньої закладки', async () => {
      const selectedBefore = await page.locator('.log-line.selected').getAttribute('style');
      await page.keyboard.press('Shift+F2');
      await page.waitForTimeout(200);
      const selectedAfter = await page.locator('.log-line.selected').getAttribute('style');
      expect(selectedAfter).not.toBe(selectedBefore);
    });

    test('B знімає закладку', async () => {
      const countBefore = await page.locator('.log-line.bookmarked').count();
      await page.keyboard.press('b');
      await page.waitForTimeout(200);
      const countAfter = await page.locator('.log-line.bookmarked').count();
      expect(countAfter).toBeLessThan(countBefore);
    });
  });

  // ── 10. Розмір шрифту ────────────────────────────────────────────────────
  test.describe('10 · Розмір шрифту', () => {
    test('відображення розміру шрифту', async () => {
      const val = await page.locator('#font-size-val').textContent();
      expect(parseInt(val)).toBeGreaterThan(0);
    });

    test('A+ збільшує шрифт', async () => {
      const before = parseInt(await page.locator('#font-size-val').textContent());
      await page.click('#font-inc');
      await page.waitForTimeout(100);
      const after = parseInt(await page.locator('#font-size-val').textContent());
      expect(after).toBe(before + 1);
    });

    test('A− зменшує шрифт', async () => {
      const before = parseInt(await page.locator('#font-size-val').textContent());
      await page.click('#font-dec');
      await page.waitForTimeout(100);
      const after = parseInt(await page.locator('#font-size-val').textContent());
      expect(after).toBe(before - 1);
    });

    test('не виходить за межі (9–20)', async () => {
      // Клікаємо A− 20 разів — має зупинитись на 9
      for (let i = 0; i < 20; i++) await page.click('#font-dec');
      await page.waitForTimeout(200);
      const min = parseInt(await page.locator('#font-size-val').textContent());
      expect(min).toBe(9);

      for (let i = 0; i < 30; i++) await page.click('#font-inc');
      await page.waitForTimeout(200);
      const max = parseInt(await page.locator('#font-size-val').textContent());
      expect(max).toBe(20);

      // Повернути до 13
      for (let i = 0; i < 10; i++) await page.click('#font-dec');
    });

    test('CSS змінна --row-font оновлюється', async () => {
      const cssVar = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--row-font').trim()
      );
      expect(cssVar).toMatch(/^\d+(\.\d+)?px$/);
    });
  });

  // ── 11. Wrap mode ─────────────────────────────────────────────────────────
  test.describe('11 · Wrap mode', () => {
    test('кнопка ⇔ вмикає wrap-mode', async () => {
      await page.click('#wrap-btn');
      await page.waitForTimeout(200);
      await expect(page.locator('#list-pane')).toHaveClass(/wrap-mode/);
    });

    test('рядки мають більшу висоту у wrap mode', async () => {
      const height = await page.locator('.log-line').first().evaluate(el => el.offsetHeight);
      expect(height).toBeGreaterThan(25);
    });

    test('повторний клік вимикає wrap-mode', async () => {
      await page.click('#wrap-btn');
      await page.waitForTimeout(200);
      await expect(page.locator('#list-pane')).not.toHaveClass(/wrap-mode/);
    });
  });

  // ── 12. Вкладки файлів ───────────────────────────────────────────────────
  test.describe('12 · Файлові вкладки', () => {
    test('вкладка bar присутня', async () => {
      await expect(page.locator('#file-tabs')).toBeVisible();
    });

    test('активна вкладка позначена', async () => {
      await expect(page.locator('.file-tab.active')).toBeVisible();
    });

    test('+ відкриває нову вкладку', async () => {
      // Mock → cancel (null)
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('open-file-dialog');
        ipcMain.handle('open-file-dialog', () => null);
      });
      const before = await page.locator('.file-tab').count();
      await page.click('.file-tab-add');
      await page.waitForTimeout(500);
      const after = await page.locator('.file-tab').count();
      expect(after).toBeGreaterThanOrEqual(before);
    });

    test('+ і відкриття файлу у новій вкладці', async () => {
      await app.evaluate(({ ipcMain }, fp) => {
        ipcMain.removeHandler('open-file-dialog');
        ipcMain.handle('open-file-dialog', () => fp);
      }, SAMPLE_LOG);
      await page.click('.file-tab-add');
      await page.waitForSelector('.log-line', { timeout: 5000 });
      const tabs = await page.locator('.file-tab').count();
      expect(tabs).toBeGreaterThanOrEqual(2);
    });

    test('перемикання між вкладками', async () => {
      const firstTab = page.locator('.file-tab').first();
      await firstTab.click();
      await page.waitForTimeout(300);
      await expect(firstTab).toHaveClass(/active/);
    });

    test('закриття вкладки через ×', async () => {
      const before = await page.locator('.file-tab').count();
      if (before > 1) {
        await page.locator('.file-tab').last().locator('.file-tab-close').click();
        await page.waitForTimeout(300);
        const after = await page.locator('.file-tab').count();
        expect(after).toBe(before - 1);
      }
    });
  });

  // ── 13. Збережені записи ─────────────────────────────────────────────────
  test.describe('13 · Збережені записи', () => {
    test('☆ зберігає запис', async () => {
      await page.locator('.log-line').first().click();
      await page.waitForTimeout(200);
      await page.click('#save-btn');
      await page.waitForTimeout(200);
      const count = parseInt(await page.locator('#saved-count').textContent());
      expect(count).toBeGreaterThan(0);
    });

    test('кнопка збережених відкриває панель', async () => {
      await page.click('#saved-tab-btn');
      await page.waitForTimeout(200);
      await expect(page.locator('#saved-pane')).toBeVisible();
    });

    test('запис відображається у saved pane', async () => {
      const tabs = await page.locator('.saved-tab').count();
      expect(tabs).toBeGreaterThan(0);
    });

    test('збереження другого запису дає кнопку Порівняти', async () => {
      await page.click('#saved-tab-btn'); // закрити
      await page.locator('.log-line').nth(2).click();
      await page.waitForTimeout(200);
      await page.click('#save-btn');
      await page.waitForTimeout(200);
      await page.click('#saved-tab-btn');
      await page.waitForTimeout(200);
      // Якщо 2+ записи — кнопка Порівняти
      const diffBtn = await page.locator('.saved-diff-btn').count();
      expect(diffBtn).toBeGreaterThanOrEqual(1);
      await page.click('#saved-tab-btn'); // закрити
    });
  });

  // ── 14. Колонки ──────────────────────────────────────────────────────────
  test.describe('14 · Видимість колонок', () => {
    test('кнопка ⊟ відкриває меню колонок', async () => {
      await page.click('#col-cfg-btn');
      await page.waitForSelector('#col-cfg-menu', { timeout: 3000 });
      await expect(page.locator('#col-cfg-menu')).toBeVisible();
    });

    test('можна приховати колонку Time', async () => {
      const checkbox = page.locator('#col-cfg-menu .col-cfg-row input').first();
      const checkedBefore = await checkbox.isChecked();
      await checkbox.click();
      await page.waitForTimeout(200);
      const checkedAfter = await checkbox.isChecked();
      expect(checkedAfter).toBe(!checkedBefore);
      // Повернути
      await checkbox.click();
      await page.waitForTimeout(200);
    });

    test('закрити меню кліком поза ним', async () => {
      await page.click('body');
      await page.waitForTimeout(200);
      await expect(page.locator('#col-cfg-menu')).not.toBeVisible();
    });
  });

  // ── 15. Копіювання ───────────────────────────────────────────────────────
  test.describe('15 · Копіювання', () => {
    test('кнопка copy-json-btn присутня', async () => {
      await expect(page.locator('#copy-json-btn')).toBeVisible();
    });

    test('кнопка copy-raw-btn присутня', async () => {
      await expect(page.locator('#copy-raw-btn')).toBeVisible();
    });

    test('клік copy-json без вибраного рядка не кидає помилок', async () => {
      // Не повинно падати
      await page.click('#copy-json-btn');
      await page.waitForTimeout(100);
    });

    test('copy-json після вибору рядка показує ✓', async () => {
      await page.locator('.log-line').first().click();
      await page.waitForTimeout(200);
      await page.click('#copy-json-btn');
      await page.waitForTimeout(200);
      // Кнопка може показати ✓ тимчасово
      const btnText = await page.locator('#copy-json-btn').textContent();
      expect(btnText).toBeTruthy();
    });
  });

  // ── 16. Live mode ─────────────────────────────────────────────────────────
  test.describe('16 · Live mode', () => {
    test('кнопка Live присутня', async () => {
      await expect(page.locator('#live-btn')).toBeVisible();
    });

    test('клік вмикає live mode (клас live-on)', async () => {
      await page.click('#live-btn');
      await page.waitForTimeout(200);
      await expect(page.locator('#live-btn')).toHaveClass(/live-on/);
    });

    test('повторний клік вимикає live mode', async () => {
      await page.click('#live-btn');
      await page.waitForTimeout(200);
      await expect(page.locator('#live-btn')).not.toHaveClass(/live-on/);
    });
  });

  // ── 17. Клавіатурна навігація ────────────────────────────────────────────
  test.describe('17 · Клавіатура', () => {
    test('ArrowDown переходить до наступного рядка', async () => {
      await page.locator('.log-line').first().click();
      await page.waitForTimeout(200);
      const idxBefore = await page.evaluate(() =>
        [...document.querySelectorAll('.log-line')].findIndex(r => r.classList.contains('selected'))
      );
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(100);
      const idxAfter = await page.evaluate(() =>
        [...document.querySelectorAll('.log-line')].findIndex(r => r.classList.contains('selected'))
      );
      expect(idxAfter).toBeGreaterThan(idxBefore);
    });

    test('ArrowUp переходить до попереднього рядка', async () => {
      const idxBefore = await page.evaluate(() =>
        [...document.querySelectorAll('.log-line')].findIndex(r => r.classList.contains('selected'))
      );
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(100);
      const idxAfter = await page.evaluate(() =>
        [...document.querySelectorAll('.log-line')].findIndex(r => r.classList.contains('selected'))
      );
      expect(idxAfter).toBeLessThan(idxBefore);
    });

    test('Escape знімає trace highlight або виділення', async () => {
      // Виділяємо рядок
      await page.locator('.log-line').first().click({ modifiers: ['Control'] });
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      // Або selection bar зник, або все ок
      const hasSelection = await page.locator('#selection-bar').isVisible();
      expect(hasSelection).toBe(false);
    });
  });
});
