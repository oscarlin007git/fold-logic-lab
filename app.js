/*
  Fold Logic Lab
  A dependency-free practice app. Puzzle families are deliberately parameterised
  so a new question can shuffle the answer position and mirror the geometry.
*/

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

import { cloneSegments, generateFoldPuzzle, shuffleWithSeed } from "./puzzle-data.js";
import { applyMatrix, clipPolygon, lineSegmentInPolygon, reflectionMatrix } from "./paper-fold-engine.js";

const STORAGE_KEY = "fold-logic-lab-stats-v1";
const defaultStats = { solved: 0, correct: 0, currentStreak: 0, bestStreak: 0 };
let stats = loadStats();
let currentPuzzle = null;
let selectedIndex = null;
let hasRecordedAttempt = false;
let solutionStep = 0;
let unlockedStep = 0;
let useStepColors = false;
let focusNewFold = false;
let currentDifficulty = "standard";

const el = {
  foldStrip: $("#fold-strip"), answerGrid: $("#answer-grid"), answerForm: $("#answer-form"),
  selectionStatus: $("#selection-status"), submit: $("#submit-answer"), feedback: $("#feedback"),
  hint: $("#hint-box"), hintButton: $("#hint-button"), category: $("#category-tag"), seed: $("#seed-label"),
  solution: $("#solution-section"), visual: $("#solution-visual"), stepLabel: $("#step-label"),
  stepTitle: $("#step-title"), stepDescription: $("#step-description"), ruleText: $("#rule-text"),
  dots: $("#step-dots"), previous: $("#previous-step"), next: $("#next-step"), showAll: $("#show-all"),
  colorToggle: $("#step-colors"), focusToggle: $("#focus-new-fold"), colorLegend: $("#color-legend"),
  solutionFooter: $("#solution-footer"), resultBadge: $("#result-badge"),
  streak: $("#streak-number"), accuracy: $("#accuracy-number"), progress: $("#progress-fill"),
  sessionMessage: $("#session-message"), solved: $("#solved-count"), correct: $("#correct-count"), best: $("#best-streak"),
  dialog: $("#reveal-dialog"), difficulty: $("#difficulty-select"), settings: $("#settings-panel"), settingsTrigger: $(".settings-trigger"),
  seedForm: $("#seed-form"), seedInput: $("#seed-input"), seedStatus: $("#seed-status")
};

function loadStats() {
  try { return { ...defaultStats, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
  catch { return { ...defaultStats }; }
}
function saveStats() { localStorage.setItem(STORAGE_KEY, JSON.stringify(stats)); }
function renderStats() {
  const accuracy = stats.solved ? Math.round((stats.correct / stats.solved) * 100) : null;
  el.streak.textContent = stats.currentStreak;
  el.accuracy.textContent = accuracy === null ? "—" : `${accuracy}%`;
  el.progress.style.width = `${Math.min(stats.currentStreak * 10, 100)}%`;
  el.sessionMessage.textContent = stats.solved === 0
    ? "從第一題開始，建立你的空間感。"
    : stats.currentStreak > 1 ? `很穩！目前連續答對 ${stats.currentStreak} 題。` : "每一題都是把規則變成直覺的機會。";
  el.solved.textContent = stats.solved;
  el.correct.textContent = stats.correct;
  el.best.textContent = stats.bestStreak;
}

function randomInt(max) {
  if (window.crypto?.getRandomValues) {
    const values = new Uint32Array(1); window.crypto.getRandomValues(values); return values[0] % max;
  }
  return Math.floor(Math.random() * max);
}
const DIFFICULTY_SEED_CODE = Object.freeze({ starter: "S", standard: "N", challenge: "X" });
const SEED_CODE_DIFFICULTY = Object.freeze(Object.fromEntries(Object.entries(DIFFICULTY_SEED_CODE).map(([difficulty, code]) => [code, difficulty])));

function makeSeed() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  // 34^10 possible public seeds: effectively inexhaustible for practice while
  // still compact enough to copy, replay, or report in the UI.
  return Array.from({ length: 10 }, () => chars[randomInt(chars.length)]).join("");
}
function publicSeedCode(seed, difficulty = currentDifficulty) {
  return `FL-${DIFFICULTY_SEED_CODE[difficulty]}-${seed}`;
}
function parseSeedCode(value) {
  const normalized = value.trim().toUpperCase().replace(/^#\s*/, "");
  const match = normalized.match(/^(?:FL-)?([SNX])-([A-Z2-9]{4,20})$/);
  if (match) return { difficulty: SEED_CODE_DIFFICULTY[match[1]], seed: match[2], publicCode: `FL-${match[1]}-${match[2]}` };
  // A bare seed is convenient during development; it intentionally preserves
  // the currently selected difficulty, while displayed codes always encode it.
  if (/^[A-Z2-9]{4,20}$/.test(normalized)) return { difficulty: currentDifficulty, seed: normalized, publicCode: publicSeedCode(normalized) };
  return null;
}

function buildPuzzle({ requestedSeed = null } = {}) {
  const seed = requestedSeed || makeSeed();
  // Every public grammar begins with either a full diagonal or an actual local
  // corner fold. Do not force the opening family: the variety is intentional.
  const family = generateFoldPuzzle({ difficulty: currentDifficulty, seed });
  const options = shuffleWithSeed(family.candidates.map(candidate => ({
    id: `${family.id}-${candidate.id}`,
    isCorrect: candidate.kind === "correct",
    segments: cloneSegments(candidate.segments)
  })), `${currentDifficulty}:${seed}:option-order`);
  return { family, options, seed, publicCode: publicSeedCode(seed), correctIndex: options.findIndex(option => option.isCorrect) };
}

function svgWrap(content, label = "摺痕圖") {
  return `<svg class="crease-board" viewBox="0 0 100 100" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg"><title>${label}</title>${content}</svg>`;
}
let svgSequence = 0;
function renderPattern(pattern, { maxGroup = Infinity, highlightGroup = 0, axis = null, showPending = false, colorByFold = false, focusGroup = null, mode = "solution", label = "摺痕圖" } = {}) {
  const makePath = (segment, pending = false) => {
    // Answer choices are final crease patterns, not instructional diagrams.
    // One neutral dashed style prevents unsupported meanings such as fold age,
    // direction, or importance from leaking into the answer options.
    if (mode === "choice") return `<path class="option-crease" d="${segment.d}" />`;
    const family = segment.role === "base" ? "grid" : "crease";
    const colorIndex = ((segment.group - 1) % 5) + 1;
    const focusClass = focusGroup === null ? "" : segment.group === focusGroup ? "focus-new" : "fold-muted";
    return `<path class="${family} ${colorByFold ? `fold-color-${colorIndex}` : ""} ${focusClass} ${segment.group === highlightGroup && family === "crease" ? "recent" : ""} ${pending ? "pending" : ""}" d="${segment.d}" />`;
  };
  const visible = pattern.segments.filter(segment => segment.group <= maxGroup).map(segment => makePath(segment)).join("");
  const pending = showPending ? pattern.segments.filter(segment => segment.group > maxGroup).map(segment => makePath(segment, true)).join("") : "";
  const axisPath = mode === "choice" ? "" : axis ? `<path class="axis" d="${axis}" />` : "";
  const center = mode === "choice" ? "" : `<circle class="center-dot" cx="50" cy="50" r="1.8" />`;
  // Data validation guarantees coordinates are valid; clipping also prevents a
  // round stroke cap from ever bleeding outside the paper outline.
  const clipId = `paper-content-${++svgSequence}`;
  return svgWrap(`<defs><clipPath id="${clipId}"><rect x="9" y="9" width="82" height="82" /></clipPath></defs><rect class="outline" x="8" y="8" width="84" height="84" /><g clip-path="url(#${clipId})">${pending}${visible}${axisPath}${center}</g>`, label);
}

function foldSvg(family, stage, instance = "main") {
  const markerId = `fold-arrow-${family.id}-${stage}-${instance}`;
  const operation = family.operations[stage];
  const currentFaces = family.simulation.facesByStep[stage];
  const layerState = family.simulation.foldLayersByStep[stage];
  // One clean packet outline (B) plus one clean moved-flap outline (A). We
  // intentionally do not draw every underlying face boundary: those boundaries
  // are hidden layers, not visible folds, and were the source of the confusing
  // black fragments seen in earlier generated diagrams.
  const baseB = layerState.packetOutline;
  const topA = layerState.topOutline;
  const bounds = baseB.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x), maxX: Math.max(box.maxX, point.x),
    minY: Math.min(box.minY, point.y), maxY: Math.max(box.maxY, point.y)
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const scale = 76;
  const offsetX = 12 - bounds.minX * scale;
  const offsetY = 88 - bounds.maxY * scale;
  const scalePoint = point => ({ x: offsetX + point.x * scale, y: offsetY + point.y * scale });
  const pathFor = polygon => polygon.map((point, index) => {
    const scaled = scalePoint(point);
    return `${index ? "L" : "M"} ${scaled.x} ${scaled.y}`;
  }).join(" ") + " Z";
  let foldGuide = "";
  let stackedPaper;
  if (stage === 0) {
    stackedPaper = `<path class="folded-paper single-sheet" data-paper-layer="B-start" d="${pathFor(baseB)}" fill="#70aa7b" stroke="#17211d" stroke-width="2" stroke-linejoin="round"/>`;
  } else {
    // Draw packet B first. Then draw exactly one A outline in its actual landed
    // region. If A completely covers B, its translucent fill still indicates a
    // top flap without inventing internal edges.
    const aMarkup = topA.length >= 3
      ? `<path class="top-paper" data-paper-layer="A-top" d="${pathFor(topA)}" fill="#5d9b69" fill-opacity=".24" stroke="#17211d" stroke-width="2" stroke-linejoin="round"/>`
      : "";
    stackedPaper = `<g class="paper-stack" data-fold-result="${stage}"><path class="under-paper" data-paper-layer="B-under" d="${pathFor(baseB)}" fill="#70aa7b" stroke="#17211d" stroke-width="2" stroke-linejoin="round"/>${aMarkup}</g>`;
  }

  if (operation) {
    const candidateSegments = currentFaces
      .map(face => lineSegmentInPolygon(operation.line, face.polygon))
      .filter(Boolean);
    const segment = candidateSegments.sort((left, right) => {
      const length = pair => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
      return length(right) - length(left);
    })[0];
    if (segment) {
      const [start, end] = segment.map(scalePoint);
      const midpoint = { x: (segment[0].x + segment[1].x) / 2, y: (segment[0].y + segment[1].y) / 2 };
      const length = Math.hypot(operation.line.a, operation.line.b);
      const direction = { x: (operation.keepSide * operation.line.a) / length, y: (operation.keepSide * operation.line.b) / length };
      const arrowStart = scalePoint({ x: midpoint.x - direction.x * .23, y: midpoint.y - direction.y * .23 });
      const arrowEnd = scalePoint({ x: midpoint.x + direction.x * .04, y: midpoint.y + direction.y * .04 });
      foldGuide = `<line class="fold-crease" x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" fill="none" stroke="#f7df54" stroke-width="1.8" stroke-dasharray="3 2"/><line class="fold-motion-arrow" x1="${arrowStart.x}" y1="${arrowStart.y}" x2="${arrowEnd.x}" y2="${arrowEnd.y}" fill="none" stroke="#f7df54" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#${markerId})"/>`;
    }
  }

  const resultDescription = stage === 0 ? "；起始方紙" : "；B 紙包上方顯示 A 的實際落點";
  return `<svg viewBox="0 0 100 100" data-stage-scale="${scale.toFixed(5)}" role="img" aria-label="第 ${stage + 1} 圖：${family.stageNotes[stage]}${resultDescription}" xmlns="http://www.w3.org/2000/svg"><title>第 ${stage + 1} 圖：${family.stageNotes[stage]}${resultDescription}</title><defs><marker id="${markerId}" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5Z" fill="#f7df54" /></marker></defs>${stackedPaper}${foldGuide}</svg>`;
}

function sequenceFraction(fraction) {
  if (fraction === undefined) return "";
  if (Math.abs(fraction - .25) < .02) return "1/4";
  if (Math.abs(fraction - 1 / 3) < .03) return "1/3";
  if (Math.abs(fraction - .5) < .03) return "對半";
  return `${Math.round(fraction * 100)}%`;
}
function sequenceCaption(fold, index) {
  const operation = currentPuzzle.family.operations[index - 1];
  if (!operation) return fold;
  if (operation.motion === "角落→內部點") return `第 ${index} 折：角落折 ${sequenceFraction(operation.fraction)}`;
  if (operation.motion) return `第 ${index} 折：${operation.motion} ${sequenceFraction(operation.fraction)}`;
  return fold;
}

function renderFoldStrip() {
  const count = currentPuzzle.family.folds.length;
  el.foldStrip.style.setProperty("--fold-count", count);
  el.foldStrip.innerHTML = currentPuzzle.family.folds.map((fold, index) => `
    <article class="fold-stage" data-fold-stage="${index + 1}" tabindex="0" aria-label="${fold}；將游標移到圖上或以鍵盤聚焦可放大檢視">
      <figure><div class="fold-diagram-frame">${foldSvg(currentPuzzle.family, index, "main")}<div class="fold-zoom-preview" aria-hidden="true"><span>放大檢視</span>${foldSvg(currentPuzzle.family, index, "zoom")}</div></div><figcaption><span class="stage-number">${String(index + 1).padStart(2, "0")}</span><span class="stage-caption">${sequenceCaption(fold, index)}</span></figcaption></figure>
    </article>`).join("");
}
function renderOptions() {
  el.answerGrid.innerHTML = currentPuzzle.options.map((option, index) => `
    <button type="button" class="answer-option" role="radio" aria-checked="false" aria-label="選項 ${index + 1}" data-index="${index}">
      <span class="option-label">${index + 1}</span>${renderPattern(option, { mode: "choice", label: `選項 ${index + 1} 的完整摺痕圖；所有內線均採同一種虛線表示摺痕` })}<span class="option-cue" aria-hidden="true"></span>
    </button>`).join("");
  $$(".answer-option", el.answerGrid).forEach(button => {
    button.addEventListener("click", () => selectOption(Number(button.dataset.index)));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const count = currentPuzzle.options.length;
      const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
      selectOption((Number(button.dataset.index) + direction + count) % count);
      $$(".answer-option", el.answerGrid)[selectedIndex].focus();
    });
  });
}
function selectOption(index) {
  selectedIndex = index;
  $$(".answer-option", el.answerGrid).forEach((button, buttonIndex) => {
    const selected = buttonIndex === index;
    button.setAttribute("aria-checked", String(selected));
    // A wrong first attempt remains useful feedback, but disappears when the
    // learner deliberately tries a new prediction rather than being a spoiler.
    if (!el.solution.hidden) return;
    button.classList.remove("wrong", "correct");
    button.querySelector(".option-cue").textContent = "";
  });
  el.selectionStatus.textContent = `已選擇選項 ${index + 1}，可檢查你的推理。`;
  if (hasRecordedAttempt) el.submit.querySelector("span").textContent = "用這個選項再檢查";
}

function setLearningStage(index) {
  $$(".learning-steps li").forEach((step, stepIndex) => step.classList.toggle("current", stepIndex === index));
}
function recordAttempt(correct) {
  if (hasRecordedAttempt) return;
  hasRecordedAttempt = true;
  stats.solved += 1;
  if (correct) { stats.correct += 1; stats.currentStreak += 1; stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak); }
  else stats.currentStreak = 0;
  saveStats(); renderStats();
}
function gradeAnswer(event) {
  event.preventDefault();
  if (selectedIndex === null) {
    el.selectionStatus.textContent = "請先選一張摺痕圖，再檢查推理。";
    el.selectionStatus.style.color = "#bf4534";
    return;
  }
  el.selectionStatus.style.color = "";
  const correct = selectedIndex === currentPuzzle.correctIndex;
  const firstAttempt = !hasRecordedAttempt;
  recordAttempt(correct);
  const buttons = $$(".answer-option", el.answerGrid);
  buttons.forEach((button, index) => {
    button.classList.remove("correct", "wrong");
    button.querySelector(".option-cue").textContent = "";
    // Do not reveal the correct option after an incorrect prediction. This
    // preserves a genuine retry, or lets the learner choose the guided reveal.
    if (correct && index === selectedIndex) {
      button.classList.add("correct"); button.querySelector(".option-cue").textContent = "✓";
    }
    if (!correct && index === selectedIndex) {
      button.classList.add("wrong"); button.querySelector(".option-cue").textContent = "×";
    }
  });
  el.feedback.hidden = false;
  if (correct) {
    setLearningStage(2);
    el.feedback.className = "feedback";
    el.feedback.innerHTML = firstAttempt
      ? `<span><strong>答對了！</strong> 你抓到了關鍵位置。現在用倒序展開驗證，每一條線為什麼在那裡。</span><button class="feedback-action" data-open-solution>開始逐步驗證 →</button>`
      : `<span><strong>這次選對了！</strong> 你已用重試修正了交點位置；現在用倒序展開驗證規則。</span><button class="feedback-action" data-open-solution>開始逐步驗證 →</button>`;
    el.submit.disabled = true;
  } else {
    el.feedback.className = "feedback incorrect";
    el.feedback.innerHTML = `<span><strong>這次不對，但很接近。</strong> 注意斜線的交點或頂點落在哪一格；它們不會因為展開而任意移動。</span><button class="feedback-action" data-open-dialog>查看逐步解法</button>`;
    el.submit.querySelector("span").textContent = "換個選項再試";
  }
  $("[data-open-solution]", el.feedback)?.addEventListener("click", () => showSolution());
  $("[data-open-dialog]", el.feedback)?.addEventListener("click", openRevealDialog);
}

function renderSolution() {
  const family = currentPuzzle.family;
  const step = family.solution[solutionStep];
  const solutionPattern = { segments: cloneSegments(family.answerSegments) };
  const visibleGroup = Math.max(...step.revealGroups);
  el.visual.innerHTML = renderPattern(solutionPattern, {
    maxGroup: visibleGroup,
    highlightGroup: visibleGroup,
    axis: step.axis,
    // A worked solution is progressive disclosure: unrevealed folds must not
    // appear, even faintly, before the learner explicitly advances.
    showPending: false,
    colorByFold: useStepColors,
    focusGroup: focusNewFold ? visibleGroup : null,
    label: `解答第 ${solutionStep + 1} 步的展開圖`
  });
  el.stepLabel.textContent = `STEP 0${solutionStep + 1} / 0${family.solution.length}`;
  el.stepTitle.textContent = step.title;
  el.stepDescription.textContent = step.description;
  el.ruleText.textContent = step.rule;
  el.colorLegend.hidden = !(useStepColors || focusNewFold);
  if (useStepColors) {
    el.colorLegend.innerHTML = step.revealGroups.map(group => {
      const colorIndex = ((group - 1) % 5) + 1;
      const state = group === visibleGroup ? (focusNewFold ? "（本步聚焦）" : "（本步新增）") : (focusNewFold ? "（先前淡化）" : "（先前）");
      return `<span><i style="--fold-color:var(--fold-color-${colorIndex})"></i>第 ${group} 折 ${state}</span>`;
    }).join("");
  } else if (focusNewFold) {
    el.colorLegend.innerHTML = `<span><i style="--fold-color:var(--focus-fold)"></i>本步新增（聚焦）</span><span><i style="--fold-color:var(--muted-fold)"></i>先前摺痕（淡化）</span>`;
  } else {
    el.colorLegend.textContent = "";
  }
  el.dots.innerHTML = family.solution.map((_, index) => `<button type="button" class="step-dot ${index === solutionStep ? "active" : ""}" data-step="${index}" aria-label="查看第 ${index + 1} 步" ${index > unlockedStep ? "disabled" : ""}></button>`).join("");
  $$(".step-dot", el.dots).forEach(button => button.addEventListener("click", () => { solutionStep = Number(button.dataset.step); renderSolution(); }));
  el.previous.disabled = solutionStep === 0;
  el.next.disabled = solutionStep >= family.solution.length - 1;
  el.next.innerHTML = solutionStep >= family.solution.length - 1 ? "已完成 ✓" : `下一步 <span aria-hidden="true">→</span>`;
  el.showAll.textContent = unlockedStep >= family.solution.length - 1 ? "已顯示全部" : "顯示全部步驟";
  el.solutionFooter.innerHTML = solutionStep === family.solution.length - 1
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12 5 5L20 6" fill="none" stroke="#f3d851" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></svg><span><strong>完整圖已還原。</strong> 下次遇到晚一步的折，先數它穿過幾層紙，再找每一層的鏡像位置。</span>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6" fill="none" stroke="#f3d851" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg><span>先核對這一步折時有幾層紙，再按下一步揭示被複製出的摺痕。</span>`;
}
function showSolution() {
  el.solution.hidden = false;
  el.colorToggle.checked = useStepColors;
  el.focusToggle.checked = focusNewFold;
  // Once the learner explicitly opens the worked solution, identify the full
  // answer as a visual reference as well as explaining it step by step.
  $$(".answer-option", el.answerGrid).forEach((button, index) => {
    if (index === currentPuzzle.correctIndex) {
      button.classList.add("correct");
      button.querySelector(".option-cue").textContent = "✓";
    }
  });
  el.resultBadge.textContent = selectedIndex === currentPuzzle.correctIndex ? "推理正確 · 驗證中" : "逐步解析";
  el.submit.disabled = true;
  $("#reveal-solution").disabled = true;
  setLearningStage(2);
  solutionStep = 0; unlockedStep = 0;
  renderSolution();
  window.setTimeout(() => el.solution.scrollIntoView({ behavior: document.body.classList.contains("reduce-motion") ? "auto" : "smooth", block: "start" }), 50);
}
function goNextStep() {
  const maximum = currentPuzzle.family.solution.length - 1;
  if (solutionStep >= maximum) return;
  solutionStep += 1; unlockedStep = Math.max(unlockedStep, solutionStep); renderSolution();
}
function showAllSteps() { unlockedStep = currentPuzzle.family.solution.length - 1; solutionStep = unlockedStep; renderSolution(); }
function openRevealDialog() {
  if (typeof el.dialog.showModal === "function") el.dialog.showModal();
  else if (window.confirm("要查看逐步解答嗎？")) showSolution();
}

function newQuestion({ seed = null, replayed = false } = {}) {
  currentPuzzle = buildPuzzle({ requestedSeed: seed });
  selectedIndex = null; hasRecordedAttempt = false; solutionStep = 0; unlockedStep = 0;
  el.category.textContent = currentPuzzle.family.label;
  el.seed.textContent = `# ${currentPuzzle.publicCode}`;
  el.seedInput.value = currentPuzzle.publicCode;
  el.seedStatus.classList.remove("error");
  el.seedStatus.textContent = replayed ? "已依題目碼重現：難度、折法、選項順序完全一致。" : "複製此題目碼，之後可在這裡重現同一題。";
  el.hint.textContent = currentPuzzle.family.hint;
  el.hint.hidden = true; el.hintButton.setAttribute("aria-expanded", "false");
  el.feedback.hidden = true; el.feedback.textContent = ""; el.feedback.className = "feedback";
  el.solution.hidden = true;
  el.submit.disabled = false; $("#reveal-solution").disabled = false; el.submit.querySelector("span").textContent = "檢查我的推理";
  el.selectionStatus.style.color = ""; el.selectionStatus.textContent = "尚未選擇答案";
  setLearningStage(0); renderFoldStrip(); renderOptions();
  $("#practice").focus?.();
}

// Events
el.answerForm.addEventListener("submit", gradeAnswer);
el.hintButton.addEventListener("click", () => {
  const willShow = el.hint.hidden;
  el.hint.hidden = !willShow;
  el.hintButton.setAttribute("aria-expanded", String(willShow));
  el.hintButton.innerHTML = willShow ? `<span aria-hidden="true">✦</span> 收起提示` : `<span aria-hidden="true">✦</span> 給我一個提示`;
});
$("#new-question").addEventListener("click", newQuestion);
$("#reveal-solution").addEventListener("click", openRevealDialog);
el.previous.addEventListener("click", () => { if (solutionStep > 0) { solutionStep -= 1; renderSolution(); } });
el.next.addEventListener("click", goNextStep);
el.showAll.addEventListener("click", showAllSteps);
el.colorToggle.addEventListener("change", event => {
  useStepColors = event.target.checked;
  if (!el.solution.hidden) renderSolution();
});
el.focusToggle.addEventListener("change", event => {
  focusNewFold = event.target.checked;
  if (!el.solution.hidden) renderSolution();
});
el.dialog.addEventListener("close", () => { if (el.dialog.returnValue === "reveal") showSolution(); });
el.difficulty.addEventListener("change", event => { currentDifficulty = event.target.value; newQuestion(); });
el.seedForm.addEventListener("submit", event => {
  event.preventDefault();
  const parsed = parseSeedCode(el.seedInput.value);
  if (!parsed) {
    el.seedStatus.classList.add("error");
    el.seedStatus.textContent = "格式錯誤。請輸入例如 FL-N-ABCD234567，或 4–20 碼的裸 seed。";
    el.seedInput.focus();
    return;
  }
  currentDifficulty = parsed.difficulty;
  el.difficulty.value = currentDifficulty;
  newQuestion({ seed: parsed.seed, replayed: true });
});
$("#reset-record").addEventListener("click", () => {
  if (!window.confirm("要清除這台裝置上的練習紀錄嗎？")) return;
  stats = { ...defaultStats }; saveStats(); renderStats();
});
el.settingsTrigger.addEventListener("click", () => {
  const opening = el.settings.hidden;
  el.settings.hidden = !opening; el.settingsTrigger.setAttribute("aria-expanded", String(opening));
  if (opening) $("select", el.settings).focus();
});
$(".settings-close").addEventListener("click", () => { el.settings.hidden = true; el.settingsTrigger.setAttribute("aria-expanded", "false"); el.settingsTrigger.focus(); });
$("#reduced-motion").addEventListener("change", event => document.body.classList.toggle("reduce-motion", event.target.checked));
document.addEventListener("click", event => {
  if (!el.settings.hidden && !el.settings.contains(event.target) && !el.settingsTrigger.contains(event.target)) {
    el.settings.hidden = true; el.settingsTrigger.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !el.settings.hidden) { el.settings.hidden = true; el.settingsTrigger.setAttribute("aria-expanded", "false"); }
});

renderStats();
newQuestion();
