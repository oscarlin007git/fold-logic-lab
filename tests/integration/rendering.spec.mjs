import { test, expect } from "@playwright/test";

test.describe("integration: rendered puzzle diagrams", () => {
  test("loads five labelled options and keeps every rendered line inside the paper square", async ({ page }) => {
    await page.goto("/index.html");
    await expect(page.locator("#answer-grid .answer-option")).toHaveCount(5);
    // Opening is a true diagonal or local-corner crease, never a fake label.
    const openingFold = await page.locator("#fold-strip .fold-stage").first().locator(".fold-diagram-frame > svg .fold-crease").first().evaluate(line => ({
      x1: line.getAttribute("x1"), y1: line.getAttribute("y1"), x2: line.getAttribute("x2"), y2: line.getAttribute("y2")
    }));
    expect(openingFold.x1).not.toEqual(openingFold.x2);
    expect(openingFold.y1).not.toEqual(openingFold.y2);
    await expect(page.locator("#answer-grid .option-label")).toHaveText(["1", "2", "3", "4", "5"]);

    // Exercise multiple generated questions. The DOM-level geometry check covers
    // the exact SVG strings used by the live browser renderer, not a duplicate.
    for (let question = 0; question < 12; question += 1) {
      if (question) await page.getByRole("button", { name: /換一題/ }).click();
      await expect(page.locator("#answer-grid .answer-option")).toHaveCount(5);
      const result = await page.locator("#answer-grid svg.crease-board").evaluateAll(svgs => svgs.map(svg => {
        const outline = svg.querySelector(".outline").getBBox();
        const clip = svg.querySelector("clipPath rect");
        const paths = [...svg.querySelectorAll(".option-crease")].map(path => {
          const box = path.getBBox();
          const epsilon = 0.02; // SVG getBBox() can introduce tiny float noise at an exact 92 edge.
          return {
            d: path.getAttribute("d"),
            className: path.getAttribute("class"),
            within: box.x >= outline.x - epsilon && box.y >= outline.y - epsilon &&
              box.x + box.width <= outline.x + outline.width + epsilon &&
              box.y + box.height <= outline.y + outline.height + epsilon
          };
        });
        return {
          hasClip: clip?.getAttribute("x") === "9" && clip?.getAttribute("y") === "9" &&
            clip?.getAttribute("width") === "82" && clip?.getAttribute("height") === "82",
          paths,
          styles: [...svg.querySelectorAll(".option-crease")].map(path => {
            const style = getComputedStyle(path);
            return `${style.stroke}|${style.strokeWidth}|${style.strokeDasharray}|${style.strokeLinecap}`;
          }),
          ambiguousLines: svg.querySelectorAll(".crease, .grid, .axis, .center-dot").length
        };
      }));
      expect(result).toHaveLength(5);
      for (const svg of result) {
        expect(svg.hasClip).toBeTruthy();
        expect(svg.paths.length).toBeGreaterThan(0);
        expect(svg.paths.every(path => path.className === "option-crease")).toBeTruthy();
        expect(new Set(svg.styles).size).toBe(1);
        expect(svg.ambiguousLines).toBe(0);
        expect(svg.paths.every(path => path.within), `overflow path: ${svg.paths.filter(path => !path.within).map(path => path.d).join(", ")}`).toBeTruthy();
      }
    }
  });

  test("difficulty selector generates structurally different fold programs rather than a fixed bank", async ({ page }) => {
    await page.goto("/index.html");
    await page.getByRole("button", { name: "開啟偏好設定" }).click();
    const select = page.locator("#difficulty-select");

    await select.selectOption("starter");
    await expect(page.locator("#fold-strip .fold-stage")).toHaveCount(4);
    await expect(page.locator("#category-tag")).toContainText("起步");
    const starterCreases = await page.locator("#answer-grid .option-crease").count();

    await select.selectOption("challenge");
    await expect(page.locator("#fold-strip .fold-stage")).toHaveCount(6);
    await expect(page.locator("#category-tag")).toContainText("菁英");
    const challengeCreases = await page.locator("#answer-grid .option-crease").count();
    expect(challengeCreases).toBeGreaterThan(starterCreases);
    const challengeWidth = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, width: document.documentElement.scrollWidth }));
    expect(challengeWidth.width).toBeLessThanOrEqual(challengeWidth.viewport + 1);

    const seedBefore = await page.locator("#seed-label").textContent();
    const patternBefore = await page.locator("#answer-grid .answer-option").first().locator(".option-crease").evaluateAll(paths => paths.map(path => path.getAttribute("d")).join("|"));
    await page.getByRole("button", { name: /換一題/ }).click();
    await expect(page.locator("#seed-label")).not.toHaveText(seedBefore);
    const patternAfter = await page.locator("#answer-grid .answer-option").first().locator(".option-crease").evaluateAll(paths => paths.map(path => path.getAttribute("d")).join("|"));
    expect(patternAfter).not.toEqual(patternBefore);
  });

  test("public seed code replays difficulty, fold program, and answer order exactly", async ({ page }) => {
    await page.goto("/index.html");
    const publicCode = (await page.locator("#seed-label").textContent()).replace(/^#\s*/, "");
    const before = await page.locator("#answer-grid .answer-option").evaluateAll(options => options.map(option => ({
      label: option.querySelector(".option-label").textContent,
      paths: [...option.querySelectorAll(".grid, .crease")].map(path => path.getAttribute("d"))
    })));

    await page.getByRole("button", { name: /換一題/ }).click();
    await page.getByRole("button", { name: "開啟偏好設定" }).click();
    await page.locator("#seed-input").fill(publicCode);
    await page.locator("#seed-form").press("Enter");

    await expect(page.locator("#seed-label")).toHaveText(`# ${publicCode}`);
    await expect(page.locator("#seed-status")).toContainText("完全一致");
    const after = await page.locator("#answer-grid .answer-option").evaluateAll(options => options.map(option => ({
      label: option.querySelector(".option-label").textContent,
      paths: [...option.querySelectorAll(".grid, .crease")].map(path => path.getAttribute("d"))
    })));
    expect(after).toEqual(before);
  });

  test("optional fold-colour mode preserves each earlier fold colour during step-by-step explanation", async ({ page }) => {
    await page.goto("/index.html");
    await page.getByRole("button", { name: "卡住了？逐步查看" }).click();
    await page.locator("#reveal-dialog").getByRole("button", { name: /開始逐步展開/ }).click();
    await expect(page.locator("#solution-section")).toBeVisible();
    // Progressive disclosure: step 1 must contain only what step 1 created;
    // future folds cannot be shown as faint preview paths.
    await expect(page.locator("#solution-visual .pending")).toHaveCount(0);
    const pathsAtFirstStep = await page.locator("#solution-visual .grid, #solution-visual .crease").count();
    await expect(page.locator("#color-legend")).toBeHidden();
    await expect(page.locator("#solution-visual .fold-color-1")).toHaveCount(0);

    await page.locator("#step-colors").check();
    await expect(page.locator("#color-legend")).toBeVisible();
    await expect(page.locator("#color-legend")).toContainText("第 1 折");
    await expect(page.locator("#solution-visual .fold-color-1")).toHaveCount(1);

    await page.locator("#next-step").click();
    await expect(page.locator("#solution-visual .pending")).toHaveCount(0);
    expect(await page.locator("#solution-visual .grid, #solution-visual .crease").count()).toBeGreaterThan(pathsAtFirstStep);
    await expect(page.locator("#color-legend")).toContainText("第 2 折");
    await expect(page.locator("#color-legend")).toContainText("本步新增");
    expect(await page.locator("#solution-visual .fold-color-1").count()).toBeGreaterThan(0);
    expect(await page.locator("#solution-visual .fold-color-2").count()).toBeGreaterThan(0);
    const colours = await page.locator("#solution-visual .fold-color-1, #solution-visual .fold-color-2").evaluateAll(paths => [...new Set(paths.map(path => getComputedStyle(path).stroke))]);
    expect(colours.length).toBeGreaterThanOrEqual(2);

    await page.locator("#step-colors").uncheck();
    await expect(page.locator("#color-legend")).toBeHidden();
    await expect(page.locator("#solution-visual [class*='fold-color-']")).toHaveCount(0);

    await page.locator("#focus-new-fold").check();
    await expect(page.locator("#color-legend")).toContainText("本步新增（聚焦）");
    await expect(page.locator("#color-legend")).toContainText("先前摺痕（淡化）");
    expect(await page.locator("#solution-visual .focus-new").count()).toBeGreaterThan(0);
    expect(await page.locator("#solution-visual .fold-muted").count()).toBeGreaterThan(0);

    await page.locator("#focus-new-fold").uncheck();
    await expect(page.locator("#color-legend")).toBeHidden();
    await expect(page.locator("#solution-visual .focus-new, #solution-visual .fold-muted")).toHaveCount(0);
  });

  test("every post-fold card visibly shows paper A stacked over stationary paper B", async ({ page }) => {
    await page.goto("/index.html");
    const cards = page.locator("#fold-strip .fold-stage");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(4);
    // Every small diagram has an on-hover / keyboard-focus magnifier. The
    // preview uses a separate SVG instance so its marker IDs cannot collide.
    const firstPreview = cards.first().locator(".fold-zoom-preview");
    await expect(firstPreview.locator("svg")).toHaveCount(1);
    await expect(firstPreview).toBeHidden();
    await cards.first().hover();
    await expect(firstPreview).toBeVisible();
    expect(await firstPreview.locator("svg").getAttribute("data-stage-scale")).toEqual(
      await cards.first().locator(":scope > figure > .fold-diagram-frame > svg").getAttribute("data-stage-scale")
    );

    // A sequence is a fixed visual timeline: captions may wrap, but they may
    // never move the diagram or arrow row. All diagram frames and captions use
    // reserved layout slots.
    const slotLayout = await cards.evaluateAll(stages => stages.map(stage => {
      const frame = stage.querySelector('.fold-diagram-frame').getBoundingClientRect();
      const caption = stage.querySelector('figcaption').getBoundingClientRect();
      const arrow = getComputedStyle(stage, '::after');
      return { frameTop: frame.top, frameBottom: frame.bottom, captionTop: caption.top, arrowTop: arrow.top };
    }));
    ["frameTop", "frameBottom", "captionTop"].forEach(key => {
      const values = slotLayout.map(item => item[key]);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    });

    // Card 1 establishes B's fixed lower-left reference. Every later card uses
    // that same B anchor, then draws A over it; no per-card B drift is allowed.
    const bBounds = [];
    for (let index = 1; index < count; index += 1) {
      const diagram = cards.nth(index).locator(":scope > figure > .fold-diagram-frame > svg");
      expect(await diagram.locator(".under-paper[data-paper-layer='B-under']").count()).toBeGreaterThan(0);
      expect(await diagram.locator(".top-paper[data-paper-layer='A-top']").count()).toBeGreaterThan(0);
      await expect(diagram).toHaveAttribute("aria-label", /B 紙包上方顯示 A 的實際落點/);
      const layerFills = {
        base: await diagram.locator(".under-paper").first().getAttribute("fill"),
        top: await diagram.locator(".top-paper").first().getAttribute("fill")
      };
      expect(layerFills.base).not.toEqual(layerFills.top);
      const layerTransforms = await diagram.locator(".under-paper, .top-paper").evaluateAll(paths => [...new Set(paths.map(path => path.getAttribute("transform") || ""))]);
      expect(layerTransforms).toEqual([""]);
      await expect(diagram).toHaveAttribute("data-stage-scale", "76.00000");
      bBounds.push(await diagram.locator(".under-paper").evaluate(path => {
        const box = path.getBBox();
        return { left: box.x, bottom: box.y + box.height, maxDimension: Math.max(box.width, box.height) };
      }));
    }
    const startingB = await cards.first().locator(":scope > figure > .fold-diagram-frame > svg .single-sheet").evaluate(sheet => {
      const box = sheet.getBBox();
      return { left: box.x, bottom: box.y + box.height, maxDimension: Math.max(box.width, box.height) };
    });
    [...bBounds, startingB].forEach(bounds => {
      expect(Math.abs(bounds.left - 12)).toBeLessThanOrEqual(.02);
      expect(Math.abs(bounds.bottom - 88)).toBeLessThanOrEqual(.02);
      expect(bounds.maxDimension).toBeLessThanOrEqual(76.02);
      expect(bounds.maxDimension).toBeGreaterThan(4);
    });
    // The reference puzzle communicates with shapes and arrows only. Decorative
    // numeric labels inside a folding card would leak irrelevant information.
    await expect(page.locator("#fold-strip svg text")).toHaveCount(0);
  });

  test("the responsive desktop document has no horizontal overflow and all cards have visible SVG bounds", async ({ page }) => {
    await page.goto("/index.html");
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll("#answer-grid .answer-option")].map(card => {
        const cardBox = card.getBoundingClientRect();
        const svgBox = card.querySelector("svg").getBoundingClientRect();
        return { cardBox, svgBox };
      })
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
    layout.cards.forEach(({ cardBox, svgBox }) => {
      expect(svgBox.width).toBeGreaterThan(40);
      expect(svgBox.height).toBeGreaterThan(40);
      expect(svgBox.left).toBeGreaterThanOrEqual(cardBox.left);
      expect(svgBox.right).toBeLessThanOrEqual(cardBox.right + 1);
    });
  });

  test("mobile layout keeps five usable answer cards and no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/index.html");
    await page.getByRole("button", { name: "開啟偏好設定" }).click();
    await page.locator("#difficulty-select").selectOption("challenge");
    await expect(page.locator("#fold-strip .fold-stage")).toHaveCount(6);
    await expect(page.locator("#answer-grid .answer-option")).toHaveCount(5);
    const mobile = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll("#answer-grid .answer-option")].map(card => {
        const box = card.getBoundingClientRect();
        const svg = card.querySelector("svg").getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, svgWidth: svg.width };
      })
    }));
    expect(mobile.documentWidth).toBeLessThanOrEqual(mobile.viewport + 1);
    mobile.cards.forEach(card => {
      expect(card.left).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(mobile.viewport + 1);
      expect(card.width).toBeGreaterThan(120);
      expect(card.svgWidth).toBeGreaterThan(100);
    });
  });
});
