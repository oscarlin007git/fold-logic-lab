import { test, expect } from "@playwright/test";

test.describe("end-to-end: learner practice flow", () => {
  test("a learner can predict, receive feedback, and reveal the answer one fold at a time", async ({ page }) => {
    await page.goto("/index.html");

    // Make a prediction using an actual interactive answer card.
    const firstOption = page.locator("#answer-grid .answer-option").first();
    await firstOption.click();
    await expect(firstOption).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#selection-status")).toContainText("已選擇選項 1");
    await page.getByRole("button", { name: /檢查我的推理/ }).click();
    await expect(page.locator("#feedback")).toBeVisible();

    // The first option can randomly be correct or incorrect. Both branches must
    // arrive at the same deliberate, step-by-step solution experience.
    const dialog = page.locator("#reveal-dialog");
    if (await page.locator("#feedback.incorrect").isVisible()) {
      await page.getByRole("button", { name: "查看逐步解法" }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /開始逐步展開/ }).click();
    } else {
      await page.getByRole("button", { name: /開始逐步驗證/ }).click();
    }

    const solution = page.locator("#solution-section");
    await expect(solution).toBeVisible();
    await expect(page.locator("#step-label")).toHaveText("STEP 01 / 04");
    await expect(page.locator("#previous-step")).toBeDisabled();
    await expect(page.locator("#next-step")).toContainText("下一步");

    await page.locator("#next-step").click();
    await expect(page.locator("#step-label")).toHaveText("STEP 02 / 04");
    await expect(page.locator("#previous-step")).toBeEnabled();
    await page.locator("#next-step").click();
    await expect(page.locator("#step-label")).toHaveText("STEP 03 / 04");
    await page.locator("#next-step").click();
    await expect(page.locator("#step-label")).toHaveText("STEP 04 / 04");
    await expect(page.locator("#next-step")).toBeDisabled();
    await expect(page.locator("#solution-footer")).toContainText("完整圖已還原");
  });

  test("keyboard selection, hint disclosure and the optional guided reveal are operable", async ({ page }) => {
    await page.goto("/index.html");
    const options = page.locator("#answer-grid .answer-option");
    await options.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(options.nth(1)).toBeFocused();

    const hintButton = page.locator("#hint-button");
    await expect(hintButton).toHaveAccessibleName(/給我一個提示/);
    await hintButton.click();
    await expect(page.locator("#hint-box")).toBeVisible();
    await expect(hintButton).toHaveAttribute("aria-expanded", "true");
    await expect(hintButton).toHaveAccessibleName(/收起提示/);

    await page.getByRole("button", { name: "卡住了？逐步查看" }).click();
    const dialog = page.locator("#reveal-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /開始逐步展開/ }).click();
    await expect(page.locator("#solution-section")).toBeVisible();
    await expect(page.locator("#answer-grid .answer-option.correct")).toHaveCount(1);
  });
});
