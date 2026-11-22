import { expect, test } from "@playwright/test";

test("drag_peak_end_commits_once", async ({ page }) => {
  await page.goto("/examples/browser/");
  await expect(page.getByTestId("peak-area")).toHaveText("2.00 mAU·min");
  const handle = page.getByRole("button", { name: "Peak p1 right boundary" });
  const plot = page.locator(".u-over");
  const box = await plot.boundingBox();
  const right = await handle.boundingBox();
  if (!box || !right) throw new Error("Cannot find the chart and right handle");
  const y = right.y + right.height / 2;
  await page.mouse.move(right.x + right.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("peak-area")).toHaveText("1.75 mAU·min");
  await expect(page.getByTestId("revision")).toHaveText("1");
});

test("escape cancels a pointer edit and release commits nothing", async ({ page }) => {
  await page.goto("/examples/browser/");
  const handle = page.getByRole("button", { name: "Peak p1 right boundary" });
  const box = await handle.boundingBox();
  if (!box) throw new Error("Cannot find the right handle");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + box.height / 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByTestId("peak-area")).toHaveText("2.00 mAU·min");
  await expect(page.getByTestId("revision")).toHaveText("0");
});

test("active channel changes the integration units without adding duplicate handles", async ({ page }) => {
  await page.goto("/examples/browser/");
  const selected = page.getByRole("combobox", { name: "Curve" });
  await expect(selected.locator("option")).toHaveCount(2);
  await selected.selectOption({ label: "Conductivity" });
  await expect(page.getByTestId("peak-area")).toHaveText("10.00 mS/cm·min");
  await expect(page.locator("[data-peak-boundary]")).toHaveCount(2);
  await selected.selectOption({ label: "UV" });
  await expect(page.getByTestId("peak-area")).toHaveText("2.00 mAU·min");
  await expect(page.locator("[data-peak-boundary]")).toHaveCount(2);
});

test("print preview uses a real chart image and the current peak table", async ({ page }) => {
  await page.goto("/examples/browser/");
  await expect(page.getByTestId("peak-area")).toHaveText("2.00 mAU·min");
  await page.getByRole("button", { name: "Print preview" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const preview = page.frameLocator("#print-page");
  const image = preview.getByRole("img", { name: "Chromatogram" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(preview.getByRole("columnheader", { name: "Area [mAU·min]" })).toBeVisible();
  await expect(preview.getByRole("cell", { name: "2", exact: true })).toHaveCount(2);
});
