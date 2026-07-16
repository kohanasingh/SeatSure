import { expect, test } from '@playwright/test';

// The Phase 6 end-to-end proof: a brand-new user registers, browses the
// seeded events, books a GENERAL-admission ticket through the mock checkout,
// and sees it CONFIRMED in /bookings.

const GA_EVENT = 'Summer Music Festival'; // seeded GENERAL event, capacity 500

test('register → browse → book a GA ticket → see it in /bookings', async ({ page }) => {
  const email = `e2e-${Date.now()}@playwright.test`;

  // register
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

  // browse to the GA event
  await page.goto('/');
  await page.getByRole('link', { name: new RegExp(GA_EVENT) }).click();
  await expect(page.getByRole('heading', { name: GA_EVENT })).toBeVisible();
  await expect(page.locator('[data-remaining]')).toContainText('remaining');

  // book 2 tickets
  await page.getByRole('button', { name: '+' }).click();
  await expect(page.locator('[data-qty]')).toHaveText('2');
  await page.getByRole('button', { name: 'Book tickets' }).click();

  // mock checkout
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await page.getByLabel('Name on card').fill('E2E Tester');
  await page.getByLabel('Card number (mock)').fill('4242 4242 4242 4242');
  await page.getByRole('button', { name: /^Pay/ }).click();

  // pending → confirmed (direct path confirms on the first status poll)
  await expect(page.locator('[data-status="confirmed"]')).toBeVisible({ timeout: 15_000 });

  // the booking shows up in /bookings as CONFIRMED
  await page.getByRole('link', { name: 'View my bookings' }).click();
  const row = page.locator('li', { hasText: GA_EVENT }).first();
  await expect(row).toContainText('2 tickets');
  await expect(row).toContainText('CONFIRMED');
});
