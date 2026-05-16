import { test, expect, Page } from '@playwright/test'

/**
 * E2E — Language switcher in the main shell (header). Client no longer hosts /login.
 */

async function openLanguageMenu(page: Page) {
  await page.getByRole('button', { name: 'Language' }).click()
}

async function chooseLocaleFromMenu(page: Page, label: string) {
  await openLanguageMenu(page)
  await page.getByRole('button', { name: label }).click()
}

test.describe('i18n Language Switcher', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies()
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Language' })).toBeVisible({ timeout: 60_000 })
  })

  test('header language control is visible on dashboard', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Language' })).toBeVisible()
  })

  test('language menu lists all locales', async ({ page }) => {
    await openLanguageMenu(page)
    const labels = ['English', '中文', '日本語', '한국어', 'Español', 'Français', 'Deutsch', 'Português', 'Русский', 'العربية']
    for (const label of labels) {
      await expect(page.getByRole('button', { name: label })).toBeVisible()
    }
  })

  test('switching to English shows English nav where applicable', async ({ page }) => {
    await chooseLocaleFromMenu(page, 'English')
    await expect(page.getByRole('button', { name: 'Language' })).toBeVisible()
  })

  test('Chinese locale from menu applies after reload', async ({ page }) => {
    await chooseLocaleFromMenu(page, '中文')
    await expect(page.getByRole('button', { name: 'Language' })).toBeVisible()
    await page.reload({ waitUntil: 'load' })
    const cookies = await page.context().cookies()
    expect(cookies.some((c) => c.name === 'NEXT_LOCALE' && c.value === 'zh')).toBeTruthy()
  })

  test('Spanish locale from menu sets cookie', async ({ page }) => {
    await chooseLocaleFromMenu(page, 'Español')
    const cookies = await page.context().cookies()
    expect(cookies.some((c) => c.name === 'NEXT_LOCALE' && c.value === 'es')).toBeTruthy()
  })
})
