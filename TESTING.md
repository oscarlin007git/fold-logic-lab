# 品質驗證紀錄

最後完整執行：**2026-07-25**（Chromium / Playwright）

```text
npm test

Unit tests:       10 passed
Integration tests: 7 passed
End-to-end tests:  2 passed
────────────────────────────
Total:            19 passed / 0 failed
```

## 測試分層與涵蓋範圍

### 1. Unit tests — `tests/unit/svg-geometry.test.mjs`

以 Node 原生 `node:test` 驗證幾何與題庫資料：

- SVG 直線路徑座標解析器能正確讀取 M / L / H / V 指令。
- 明確防止舊問題：`97` 是紙張範圍 `8–92` 外的座標，測試必定失敗。
- `paper-fold-engine.js` 的單折案例驗證：折線、移動側反射、每一步面片歷史、折後紙張外形與座標回映皆正確。
- 相接且共線的摺痕片段必須合併為一條連續線；真正有空隙的片段不可被錯誤橋接。
- 所有正式摺痕、5 個候選圖、逐步解答軸線皆在方紙邊界內。
- 同一個 seed 必須完全重現同一題；每個難度各取 50 個 seed，至少 45 個必須產生不同的摺痕圖，防止退化成固定小題庫。
- 所有公開題目都必須以真正的對角折或局部角落折開場；前者的第一條操作為對角線，後者的折軸必須是角落到內部點的垂直平分線，不能只用標示偽裝。50 個 seed 中每個難度至少要產生兩種可用的折法語法（diagonal cascade、kite cascade、gate roof、corner roof、mixed direction 中至少兩種），並維持至少 44 個不同摺痕圖。
- 公開生成的 50 個 seed 必須實際涵蓋上→下、下→上、左→右、右→左、角落→內部點，以及 1/2、1/3、1/4 比例。
- 每個角落折後，A 頂層面積不得超過折前紙包面積的 30%；這可防止局部角片被錯畫／錯算成整個側邊傾斜的梯形。
- 同一題目碼的 deterministic shuffle 必須重現相同選項順序，並保留全部 5 個選項。
- 每一題的正解都重新以真實折疊操作送入模擬器計算，並與顯示的正解選項逐線比對；不允許用另一張手畫圖當答案。
- 150 個程序化題目（3 種難度 × 50 seeds）的 5 個選項皆必須不同、都在方紙內，且每一個干擾選項的可見摺痕段數必須與正解相同；每個誤答都必須標記為完整錯誤折紙程式或大範圍錯誤鏡射。每個誤答與正解的對稱平均線段距離至少 7 SVG units，任兩個誤答至少 4.5 SVG units，禁止細微格位差的近似選項。
- 難度必須在結構上區隔：起步 3 折／最多 8 層、進階 4 折／最多 16 層與偏心軸、菁英 5 折／最多 32 層與雙重偏心軸。

### 2. Integration tests — `tests/integration/rendering.spec.mjs`

以 Playwright 載入真正的 `index.html`、`app.js`、`puzzle-data.js` 與 `paper-fold-engine.js`：

- 連續重新產生 12 題，逐張檢查瀏覽器實際繪出的所有 `.option-crease` SVG 路徑均不超出 `.outline` 方紙；每一張選項內線的計算後 stroke、粗細、dash pattern 與 linecap 必須完全一致。選項不得含 `.grid`、`.crease`、`.axis` 或中心點等會造成額外線條語意的元素。
- 首頁示範題的第一條折軸必須是對角線；切換起步／菁英難度後，驗證折紙卡數從 4 張提升為 6 張、菁英摺痕數更多；再換一題時 seed 與實際 SVG 路徑都必須改變。
- 把顯示中的公開題目碼輸入「重現題目」後，驗證難度、題目碼、每個選項的所有 SVG 路徑與選項順序都完全還原。
- 逐步解析第 1 步不得渲染任何未來摺痕（含淡化 preview）；按下一步後已顯示路徑數必須增加。
- 勾選「依折序上色」後，驗證本步與先前折線都保留不同色碼、圖例標示本步新增／先前折線；取消勾選後，所有色碼 class 與圖例必須移除。再勾選「聚焦本步新增」，驗證本步採高對比 class、先前折線採淡化 class，並在取消後完全還原。
- 驗證每一張紙都有 `clipPath` 作為第二層渲染防線，圓角筆觸不可能越過黑色紙張邊界。
- 對每一張完成折紙狀態圖建立疊層契約：第 1 張之外的每一圖都必須同時存在 B 底層與 A 頂層；兩層需使用同一座標框，A 必須覆在 B 上。B 的左邊與下邊必須固定在 `(12, 88)` 基準點，所有卡片必須使用固定的 `76.00000` 世界尺度，且折後紙包只能小於或等於原始紙張尺寸（不可為了填滿卡片而變形／放大）。每張圖還必須有可操作的 hover/focus 放大預覽。Sequence 的圖像框、圖像底部與 caption 起始位置必須固定，不可因 caption 換行把圖片擠壓或讓箭頭漂移。所有折紙 SVG 都不得輸出文字或數字，避免把層數等解題以外資訊洩漏到題目上。
- 驗證五個選項標示完整且順序為 1–5。
- 驗證桌面沒有水平捲動，SVG 實際顯示在選項卡內。
- 以 390px 行動裝置寬度重跑，驗證五張卡片仍可見、可用，且不產生水平捲動。

### 3. E2E tests — `tests/e2e/learner-flow.spec.mjs`

模擬使用者完整操作：

- 點選預測 → 檢查 → 正確或錯誤分支 → 進入 4 步解答 → 完成。
- 鍵盤方向鍵切換答案、展開提示、開啟「卡住了？逐步查看」對話框，並確認正解與解答區出現。

## 執行方式

```bash
npm install
npx playwright install chromium
npx playwright install-deps chromium  # Linux 首次使用 Playwright 時需要
npm test
```

也可以分開執行：

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

> Playwright 的 HTML 報告會產生在 `playwright-report/`；失敗時則保留 trace 與截圖在 `test-results/`，方便定位問題。
