(function () {
  "use strict";

  // --- Constants ---------------------------------------------------------
  const STORAGE_KEY = "moneygrace:v1";
  const SNAPSHOTS_KEY = "moneygrace:snapshots:v1";
  const PRINCIPLES_KEY = "moneygrace:principles:v1";
  const MAX_SNAPSHOTS = 12;
  const SCHEMA_VERSION = 2;
  const DEFAULT_BUDGET = 1_000_000;
  const APP_START_DATE = "2026-04-16";
  const APP_START_MONTH = "2026-04";
  const TESSERACT_URL =
    "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

  const RELATIONS = ["나", "가족", "직원", "지인", "모르는사람"];

  const PRESET_CATEGORIES = [
    "귀한 손님 대접",
    "동료 챙김",
    "선물 나눔",
    "간식 나눔",
    "좋은 공간 경험",
    "배움 · 책",
    "본인 훈련",
    "나를 사랑하기",
    "기타",
  ];

  const WHISPERS = [
    "망설이며 묻어두지 말 것.",
    "돈을 써본 적 없는 자는, 써야 할 때 망설인다.",
    "오늘, 누구의 얼굴에 웃음을 더할 것인가.",
    "좋은 식당을 아는 것도 훈련이다.",
    "귀한 손님을 어디로 모실지 아는 자가, 귀한 일을 한다.",
    "금액보다 마음의 결이 먼저 보인다.",
    "작은 간식 하나에도 사람은 녹는다.",
    "기쁘게 흘려보낸 돈은, 사람과 사람 사이의 다리가 된다.",
    "책임의 무게를 알려면, 맡겨진 것을 써봐야 한다.",
    "쓰지 못한 몫은 다음 달로 가지 않는다.",
  ];

  // --- State / Storage ---------------------------------------------------
  /** @typedef {"usual"|"step"|"challenge"} Stretch */
  /** @typedef {"none"|"bookmark"|"waste"} Mark */
  /** @typedef {""|"나"|"가족"|"직원"|"지인"|"모르는사람"} Relation */
  /** @typedef {{name:string, quantity?:number, price?:number}} ReceiptItem */
  /** @typedef {{id:string,date:string,time:string,amount:number,place:string,forWhom:string,relation:Relation,purpose:string,category:string,context:string,observation:string,learning:string,stretch:Stretch,mark:Mark,receiptText:string,receiptItems:ReceiptItem[],receiptImage:string}} Entry */
  /** @typedef {{budgets:Record<string,number>,entries:Entry[],reflections:Record<string,string>}} Store */

  /** @type {Store} */
  let store;
  let currentMonth = monthKey(new Date());
  let editingId = null;
  let searchQuery = "";
  /** @type {"all"|"bookmark"|"waste"|"challenge"} */
  let filterMode = "all";
  let lastRealMonth = "";
  let pendingReceiptText = "";
  /** @type {ReceiptItem[]} */
  let pendingReceiptItems = [];
  let pendingReceiptImage = "";
  /** @type {Promise<any>|null} */
  let tesseractPromise = null;

  function emptyStore() {
    return {
      schemaVersion: SCHEMA_VERSION,
      budgets: {},
      starts: {},
      entries: [],
      reflections: {},
    };
  }

  // 마이그레이션: 오래된 데이터에서 누락 필드만 채움. 기존 필드는 절대 삭제하지 않음.
  // 앞으로 스키마가 바뀌어도 알 수 없는 키는 그대로 보존한다.
  function migrate(parsed) {
    if (!parsed || typeof parsed !== "object") return emptyStore();
    const out = { ...emptyStore(), ...parsed };
    out.schemaVersion = SCHEMA_VERSION;
    out.budgets = { ...(parsed.budgets || {}) };
    out.starts = { ...(parsed.starts || {}) };
    out.reflections = { ...(parsed.reflections || {}) };
    out.entries = Array.isArray(parsed.entries)
      ? parsed.entries.map((e) => {
          if (!e || typeof e !== "object") return e;
          const base = {
            id: e.id || uid(),
            date: e.date || "",
            time: e.time || "",
            amount: Number(e.amount) || 0,
            place: e.place || "",
            forWhom: e.forWhom || "",
            relation: RELATIONS.includes(e.relation) ? e.relation : "",
            purpose: e.purpose || "",
            category: e.category || "기타",
            context: e.context || "",
            observation: e.observation || "",
            learning: e.learning || "",
            stretch:
              e.stretch === "challenge" || e.stretch === "step"
                ? e.stretch
                : "usual",
            mark:
              e.mark === "bookmark" || e.mark === "waste" ? e.mark : "none",
            receiptText: e.receiptText || "",
            receiptItems: Array.isArray(e.receiptItems) ? e.receiptItems : [],
            receiptImage: e.receiptImage || "",
          };
          // 미래에 추가될 알 수 없는 키는 스프레드로 보존
          return { ...e, ...base };
        })
      : [];
    return out;
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyStore();
      const parsed = JSON.parse(raw);
      return migrate(parsed);
    } catch (err) {
      console.warn("store load failed", err);
      // 손상된 데이터가 있더라도 overwrite 전에 마지막 원본을 따로 보관
      try {
        const corrupt = localStorage.getItem(STORAGE_KEY);
        if (corrupt)
          localStorage.setItem(
            STORAGE_KEY + ":corrupt:" + Date.now(),
            corrupt
          );
      } catch (_) {}
      return emptyStore();
    }
  }

  function loadSnapshots() {
    try {
      const raw = localStorage.getItem(SNAPSHOTS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function pushSnapshot(reason) {
    try {
      const list = loadSnapshots();
      const snap = {
        at: new Date().toISOString(),
        reason: reason || "auto",
        data: stripImagesFromStore(store),
      };
      list.unshift(snap);
      const trimmed = list.slice(0, MAX_SNAPSHOTS);
      localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(trimmed));
    } catch (err) {
      console.warn("snapshot save failed", err);
    }
  }

  // 스냅샷에서 이미지 필드를 제거해 용량을 대폭 줄인다.
  function stripImagesFromStore(src) {
    const cloned = JSON.parse(JSON.stringify(src));
    if (Array.isArray(cloned.entries)) {
      for (const e of cloned.entries) {
        if (e && e.receiptImage) e.receiptImage = "";
      }
    }
    return cloned;
  }

  function prunePastSnapshots() {
    try {
      const list = loadSnapshots();
      if (!list.length) return;
      const pruned = list.slice(0, MAX_SNAPSHOTS).map((s) => ({
        ...s,
        data: s && s.data ? stripImagesFromStore(s.data) : s && s.data,
      }));
      localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(pruned));
    } catch (err) {
      console.warn("prune snapshots failed", err);
      try {
        localStorage.removeItem(SNAPSHOTS_KEY);
      } catch (_) {}
    }
  }

  function clearAllSnapshots() {
    try {
      localStorage.removeItem(SNAPSHOTS_KEY);
      alert("자동 백업 스냅샷을 모두 정리했습니다.");
      updateSavedIndicator();
    } catch (err) {
      alert("정리에 실패했습니다: " + err.message);
    }
  }

  function estimateStorageSize() {
    try {
      const a = (localStorage.getItem(STORAGE_KEY) || "").length;
      const b = (localStorage.getItem(SNAPSHOTS_KEY) || "").length;
      return a + b; // UTF-16 approx, ×2 바이트
    } catch (_) {
      return 0;
    }
  }

  function saveStore(reason) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (err) {
      // 용량 부족 시 스냅샷을 덜어내서 자리를 만든 뒤 재시도
      try {
        const trimmed = loadSnapshots().slice(0, 5);
        localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(trimmed));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      } catch (e2) {
        console.error(e2);
        alert(
          "저장 공간이 부족합니다. JSON 내보내기로 백업을 먼저 받고 이전 기록을 일부 정리해 주세요."
        );
        return;
      }
    }
    pushSnapshot(reason);
    updateSavedIndicator();
  }

  // --- Date / formatting helpers -----------------------------------------
  function monthKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function monthPosition(key) {
    const now = monthKey(new Date());
    if (key < now) return "past";
    if (key > now) return "future";
    return "current";
  }

  function parseMonthKey(key) {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1);
  }

  function shiftMonth(key, delta) {
    const d = parseMonthKey(key);
    d.setMonth(d.getMonth() + delta);
    return monthKey(d);
  }

  function monthLabel(key) {
    const d = parseMonthKey(key);
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
  }

  function formatWon(n) {
    const v = Math.round(Number(n) || 0);
    return "₩" + v.toLocaleString("ko-KR");
  }

  function daysInMonth(key) {
    const d = parseMonthKey(key);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }

  function todayIndexInMonth(key) {
    const now = new Date();
    const [y, m] = key.split("-").map(Number);
    if (now.getFullYear() !== y || now.getMonth() + 1 !== m) {
      if (
        now.getFullYear() > y ||
        (now.getFullYear() === y && now.getMonth() + 1 > m)
      ) {
        return daysInMonth(key);
      }
      return 0;
    }
    return now.getDate();
  }

  function todayIsoLocal() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function resolveCategory(selectVal, customVal) {
    if (selectVal === "기타") {
      const custom = (customVal || "").trim();
      return custom || "기타";
    }
    return selectVal || "기타";
  }

  function syncCategoryCustom(form) {
    if (!form) return;
    const sel = form.querySelector('select[name="category"]');
    const custom = form.querySelector('input[name="categoryCustom"]');
    if (!sel || !custom) return;
    if (sel.value === "기타") {
      custom.hidden = false;
    } else {
      custom.hidden = true;
      custom.value = "";
    }
  }

  function presetForEntry(category) {
    if (PRESET_CATEGORIES.includes(category)) {
      return { select: category, custom: "" };
    }
    return { select: "기타", custom: category };
  }

  function uid() {
    return (
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    );
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // --- Selectors ---------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  /** @type {Record<string, HTMLElement>} */
  const el = {};

  function hydrateEls() {
    Object.assign(el, {
      monthLabel: $("#current-month"),
      prevMonth: $("#prev-month"),
      nextMonth: $("#next-month"),
      budget: $("#budget"),
      spent: $("#spent"),
      spentSub: $("#spent-sub"),
      remaining: $("#remaining"),
      remainingCard: $("#remaining-card"),
      remainingLabel: $("#remaining-label"),
      remainingSub: $("#remaining-sub"),
      stretchSummary: $("#stretch-summary"),
      editBudget: $("#edit-budget"),
      editStart: $("#edit-start"),
      progressBar: $("#progress-bar"),
      progressText: $("#progress-text"),
      paceMarker: $("#pace-marker"),
      paceText: $("#pace-text"),
      paceVerdict: $("#pace-verdict"),
      whisper: $("#whisper"),
      form: $("#expense-form"),
      list: $("#expense-list"),
      listTitle: $("#list-title"),
      count: $("#count"),
      empty: $("#empty"),
      reflection: $("#monthly-reflection"),
      reflectionSaved: $("#reflection-saved"),
      exportBtn: $("#export-btn"),
      importInput: $("#import-input"),
      clearMonth: $("#clear-month"),
      restoreBtn: $("#restore-btn"),
      clearSnapshots: $("#clear-snapshots"),
      savedIndicator: $("#saved-indicator"),
      dialog: $("#edit-dialog"),
      editForm: $("#edit-form"),
      searchInput: $("#search-input"),
      searchClear: $("#search-clear"),
      searchMeta: $("#search-meta"),
      restoreDialog: $("#restore-dialog"),
      restoreList: $("#restore-list"),
      restoreClose: $("#restore-close"),
      principlesBlock: $("#principles-block"),
      principlesLabel: $("#principles-label"),
      principlesDate: $("#principles-date"),
      principlesList: $("#principles-list"),
      principlesEdit: $("#principles-edit"),
      principlesDialog: $("#principles-dialog"),
      principlesForm: $("#principles-form"),
      reportBtn: $("#report-btn"),
      reportDialog: $("#report-dialog"),
      reportTitle: $("#report-title"),
      reportBody: $("#report-body"),
      reportPrint: $("#report-print"),
      reportCopy: $("#report-copy"),
      reportDownload: $("#report-download"),
      reportCsv: $("#report-csv"),
      reportClose: $("#report-close"),
      modeWrite: $("#mode-write"),
      modeRead: $("#mode-read"),
      receiptCamera: $("#receipt-camera"),
      receiptGallery: $("#receipt-gallery"),
      receiptStatus: $("#receipt-status"),
      receiptProgress: $("#receipt-progress"),
      receiptProgressBar: $("#receipt-progress-bar"),
      receiptProgressLabel: $("#receipt-progress-label"),
    });
  }

  // --- Core logic --------------------------------------------------------
  function budgetFor(key) {
    if (key in store.budgets) return store.budgets[key];
    return DEFAULT_BUDGET;
  }

  function startDayFor(key) {
    const v = store.starts && store.starts[key];
    const n = Number(v);
    const total = daysInMonth(key);
    if (!n || n < 1 || n > 31) {
      if (key === APP_START_MONTH) return 16; // 하드 락: 앱 시작일
      return 1;
    }
    return Math.min(n, total);
  }

  function entriesFor(key) {
    return store.entries
      .filter((e) => (e.date || "").startsWith(key))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  function totalFor(key) {
    return entriesFor(key).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  }

  function render() {
    renderHeader();
    renderSummary();
    renderList();
    renderReflection();
    refreshSuggestions();
  }

  function renderHeader() {
    el.monthLabel.textContent = monthLabel(currentMonth);
  }

  function renderSummary() {
    const budget = budgetFor(currentMonth);
    const spent = totalFor(currentMonth);
    const remaining = budget - spent;
    const count = entriesFor(currentMonth).length;
    const pos = monthPosition(currentMonth);

    el.budget.textContent = formatWon(budget);
    el.spent.textContent = formatWon(spent);
    el.spentSub.textContent = `${count}건의 기록`;
    el.remaining.textContent = formatWon(Math.max(0, remaining));

    const ratio = budget > 0 ? spent / budget : 0;
    const pct = Math.min(100, Math.max(0, ratio * 100));
    el.progressBar.style.width = pct + "%";
    el.progressBar.classList.remove("behind", "over");

    const totalDays = daysInMonth(currentMonth);
    const startDay = startDayFor(currentMonth);
    const total = Math.max(1, totalDays - startDay + 1);
    const todayRaw = todayIndexInMonth(currentMonth);
    const today =
      todayRaw === 0
        ? 0
        : todayRaw >= totalDays
        ? total
        : Math.max(0, todayRaw - startDay + 1);
    const expectedRatio = total > 0 ? Math.min(1, today / total) : 0;
    const expectedPct = expectedRatio * 100;
    el.paceMarker.style.left = expectedPct + "%";
    el.paceMarker.style.display =
      pos === "current" && today > 0 && today < total ? "block" : "none";

    el.progressText.textContent = `${Math.round(ratio * 100)}% 흘려보냄`;

    // ── 월 위치에 따른 라벨·서술 전환 ───────────────────────
    el.remainingCard.classList.remove("forfeited", "future");
    let verdict = "";
    let cls = "";

    if (pos === "past") {
      if (remaining > 0) {
        el.remainingLabel.textContent = "소멸된 몫";
        el.remainingCard.classList.add("forfeited");
        el.remainingSub.textContent =
          "이 달과 함께 사라진 몫 — 다음 달로 이월되지 않습니다";
        verdict = `소멸된 몫 ${formatWon(
          remaining
        )}. 이 달과 함께 묻혀 사라졌습니다.`;
        cls = "over";
      } else if (ratio >= 1) {
        el.remainingLabel.textContent = "넘어선 몫";
        el.remainingSub.textContent = "맡겨진 몫을 넘어 흘려보냈습니다";
        verdict = "맡겨진 몫을 넘어섰습니다. 이 달의 쓰임을 복기해 봅니다.";
        cls = "over";
      } else {
        el.remainingLabel.textContent = "남지 않은 몫";
        el.remainingSub.textContent = "맡겨진 몫을 모두 흘려보냈습니다";
        verdict = "이 달의 몫을 모두 흘려보내셨습니다.";
        cls = "good";
      }
      el.paceText.textContent = "이 달은 이미 마감되었습니다";
    } else if (pos === "future") {
      el.remainingLabel.textContent = "맡겨질 몫";
      el.remainingCard.classList.add("future");
      el.remainingSub.textContent = "아직 오지 않은 달의 몫입니다";
      verdict = "아직 오지 않은 달입니다. 이 달이 시작되면 다시 기록합니다.";
      cls = "";
      el.paceText.textContent = "아직 이 달이 시작되지 않았습니다";
    } else {
      el.remainingLabel.textContent = "아직 묶여있는 몫";
      const startNote = startDay > 1 ? ` (${startDay}일부터)` : "";
      el.paceText.textContent =
        today === 0
          ? "아직 이달이 시작되지 않았습니다"
          : today >= total
          ? "이달의 마지막 날입니다. 남은 몫은 오늘이 지나면 소멸합니다."
          : `오늘까지 기대되는 흐름 ${Math.round(expectedPct)}%${startNote}`;

      if (ratio >= 1) {
        verdict =
          "맡겨진 몫을 넘어 흘려보냈습니다. 이 달의 쓰임을 복기해 봅니다.";
        cls = "over";
        el.progressBar.classList.add("over");
        el.remainingSub.textContent = "맡겨진 몫을 넘어섰습니다";
      } else if (today > 0 && today < total) {
        const gap = expectedRatio - ratio;
        if (gap > 0.15) {
          verdict =
            "지금 흐름은 망설이는 쪽에 가깝습니다. 월말이 되면 남은 몫은 소멸합니다.";
          cls = "warn";
          el.progressBar.classList.add("behind");
        } else if (gap > 0.05) {
          verdict = "조금 뒤처졌습니다. 오늘은 누구를 위해 쓰시겠습니까?";
          cls = "warn";
          el.progressBar.classList.add("behind");
        } else if (gap < -0.2) {
          verdict = "앞서가는 흐름입니다. 쓰임의 결이 흔들리지 않도록.";
          cls = "good";
        } else {
          verdict = "충실한 걸음입니다.";
          cls = "good";
        }
        el.remainingSub.textContent =
          ratio >= 0.85
            ? "거의 다 흘려보냈습니다"
            : "월말이 되면 남은 몫은 소멸합니다";
      } else if (today >= total) {
        verdict = remaining > 0
          ? `오늘이 지나면 ${formatWon(remaining)}는 소멸됩니다. 끝까지 흘려보내세요.`
          : "맡겨진 몫을 모두 흘려보냈습니다.";
        cls = remaining > 0 ? "warn" : "good";
        el.remainingSub.textContent =
          remaining > 0
            ? "오늘이 지나면 소멸합니다"
            : "맡겨진 몫을 모두 흘려보냈습니다";
      } else {
        verdict = "이달의 훈련이 시작되었습니다.";
        el.remainingSub.textContent =
          "묻어두지 말 것 — 월말이면 남은 몫은 소멸합니다";
      }
    }

    el.paceVerdict.textContent = verdict;
    el.paceVerdict.className = "pace-verdict" + (cls ? " " + cls : "");

    const list = entriesFor(currentMonth);
    const tally = stretchTally(list);
    const markT = markTally(list);
    const prevList = entriesFor(shiftMonth(currentMonth, -1));
    const prevTally = stretchTally(prevList);

    if (list.length === 0) {
      el.stretchSummary.innerHTML = "이달의 걸음 — 아직 없음";
    } else {
      const stepParts = [];
      if (tally.challenge > 0)
        stepParts.push(`<span class="mark">도전 ${tally.challenge}회</span>`);
      if (tally.step > 0) stepParts.push(`한 걸음 ${tally.step}회`);
      if (tally.usual > 0) stepParts.push(`평소 ${tally.usual}회`);
      let line = "이달의 걸음 — " + stepParts.join(" · ");
      if (prevList.length > 0) {
        const arrow =
          tally.challenge > prevTally.challenge
            ? "↑"
            : tally.challenge < prevTally.challenge
            ? "↓"
            : "→";
        line += `  <span class="compare">지난달 도전 ${prevTally.challenge}회 ${arrow} 이달 ${tally.challenge}회</span>`;
      }

      const markParts = [];
      if (markT.bookmark > 0)
        markParts.push(`<span class="mark">책갈피 ${markT.bookmark}회</span>`);
      if (markT.waste > 0) markParts.push(`낭비 ${markT.waste}회`);
      if (markParts.length > 0)
        line += `<br><span class="exp-line">경험의 갈무리 — ${markParts.join(" · ")}</span>`;

      el.stretchSummary.innerHTML = line;
    }
  }

  function stretchTally(list) {
    const t = { usual: 0, step: 0, challenge: 0 };
    for (const e of list) {
      const k = e.stretch || "usual";
      if (t[k] !== undefined) t[k] += 1;
    }
    return t;
  }

  function markTally(list) {
    const t = { none: 0, bookmark: 0, waste: 0 };
    for (const e of list) {
      const k = e.mark || "none";
      if (t[k] !== undefined) t[k] += 1;
    }
    return t;
  }

  function matchesText(e, needle) {
    const fields = [
      "place",
      "forWhom",
      "relation",
      "purpose",
      "category",
      "context",
      "observation",
      "learning",
      "stretch",
      "mark",
      "receiptText",
      "date",
      "time",
    ];
    for (const f of fields) {
      const v = (e[f] || "").toString().toLowerCase();
      if (v.includes(needle)) return true;
    }
    return false;
  }

  function matchesFilter(e) {
    switch (filterMode) {
      case "bookmark":
        return (e.mark || "none") === "bookmark";
      case "waste":
        return (e.mark || "none") === "waste";
      case "challenge":
        return (e.stretch || "usual") === "challenge";
      default:
        return true;
    }
  }

  function byDateDesc(a, b) {
    return (a.date || "") < (b.date || "")
      ? 1
      : (a.date || "") > (b.date || "")
      ? -1
      : 0;
  }

  // 리스트 결정 규칙:
  //  - 검색어 있거나 필터가 all 아니면 → 전체 달 대상
  //  - 그 외엔 현재 달
  function resolveList() {
    const q = searchQuery.trim().toLowerCase();
    const global = q.length > 0 || filterMode !== "all";
    const base = global
      ? store.entries
      : store.entries.filter((e) => (e.date || "").startsWith(currentMonth));
    return base
      .filter((e) => {
        if (!e) return false;
        if (q && !matchesText(e, q)) return false;
        if (!matchesFilter(e)) return false;
        return true;
      })
      .sort(byDateDesc);
  }

  function highlight(text, q) {
    if (!q) return escapeHtml(text || "");
    const safe = escapeHtml(text || "");
    const needleSafe = escapeHtml(q);
    const re = new RegExp(
      "(" + needleSafe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")",
      "gi"
    );
    return safe.replace(re, "<mark>$1</mark>");
  }

  function renderList() {
    const q = searchQuery.trim();
    const list = resolveList();
    const isGlobal = !!q || filterMode !== "all";

    let title;
    if (q) title = "검색 결과";
    else if (filterMode === "bookmark") title = "책갈피 모음 — 다시 하고픈";
    else if (filterMode === "waste") title = "낭비 모음 — 돌아보기";
    else if (filterMode === "challenge") title = "도전의 기록";
    else title = "이번 달 기록";
    if (el.listTitle) el.listTitle.textContent = title;

    el.count.textContent = `${list.length}건`;
    if (el.searchMeta) {
      const parts = [];
      if (q) parts.push(`"${q}" 일치`);
      if (filterMode !== "all") parts.push("전체 달에서 모음");
      el.searchMeta.textContent = parts.join(" · ");
      el.searchMeta.style.display = parts.length ? "block" : "none";
    }
    el.empty.classList.toggle("visible", list.length === 0);
    if (el.empty) {
      el.empty.textContent = q || filterMode !== "all"
        ? "해당하는 기록이 없습니다."
        : "아직 묻혀있습니다. 오늘, 누구의 얼굴에 웃음을 더하러 가시겠습니까?";
    }

    // 필터 칩 active 상태
    document.querySelectorAll(".filter-chip").forEach((btn) => {
      const fv = btn.getAttribute("data-filter");
      btn.classList.toggle("active", fv === filterMode);
    });

    const qHl = q;
    const searching = isGlobal; // 리스트가 전체 달을 가로지를 때만 월 태그 표시

    el.list.innerHTML = list
      .map((e) => {
        const d = new Date(e.date + "T00:00:00");
        const dateTxt = isNaN(d)
          ? escapeHtml(e.date)
          : `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, "0")}`;
        const weekday = isNaN(d)
          ? ""
          : ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
        const obs = e.observation ? e.observation.trim() : "";
        const learn = e.learning ? e.learning.trim() : "";
        const ctx = e.context ? e.context.trim() : "";

        const stretch = e.stretch || "usual";
        const stretchMark =
          stretch === "challenge"
            ? `<span class="stretch-mark challenge">도전</span>`
            : stretch === "step"
            ? `<span class="stretch-mark step">한 걸음</span>`
            : "";

        const mark = e.mark || "none";
        const expMark =
          mark === "bookmark"
            ? `<span class="exp-mark bookmark">책갈피</span>`
            : mark === "waste"
            ? `<span class="exp-mark waste">낭비</span>`
            : "";
        const entryCls = mark === "bookmark" || mark === "waste" ? ` ${mark}` : "";

        const monthTag = searching
          ? `<span class="month-tag">${
              e.date ? e.date.slice(0, 7).replace("-", ".") : ""
            }</span>`
          : "";

        const timeTxt = (e.time || "").trim();
        const dateInner = `${dateTxt}${weekday ? ` (${weekday})` : ""}${
          timeTxt ? ` ${timeTxt}` : ""
        }`;
        const dateHL = `<span class="date">${highlight(dateInner, qHl)}</span>`;

        const purpose = e.purpose ? e.purpose.trim() : "";

        return `
          <li class="entry${entryCls}" data-id="${escapeHtml(
          e.id
        )}" data-month="${escapeHtml((e.date || "").slice(0, 7))}">
            <div>
              <div class="meta">
                ${monthTag}
                ${dateHL}
                <span class="tag">${highlight(e.category || "기타", qHl)}</span>
              </div>
              <div class="place">${highlight(e.place || "", qHl)}${stretchMark}${expMark}</div>
              <div class="served">대상 — <strong>${highlight(
                e.forWhom || "—",
                qHl
              )}</strong>${e.relation ? ` <span class="relation-tag">${escapeHtml(e.relation)}</span>` : ""}</div>
            </div>
            <div class="amount">${formatWon(e.amount)}</div>
            ${
              purpose
                ? `<div class="purpose"><span class="plabel">바라는 열매</span>${highlight(
                    purpose,
                    qHl
                  )}</div>`
                : ""
            }
            ${
              ctx
                ? `<div class="context">맥락 — ${highlight(ctx, qHl)}</div>`
                : ""
            }
            ${(() => {
              const hasItems =
                Array.isArray(e.receiptItems) && e.receiptItems.length > 0;
              const img = (e.receiptImage || "").trim();
              const raw = (e.receiptText || "").trim();
              if (!hasItems && !img && !raw) return "";
              let summary, inner;
              if (hasItems) {
                summary = `<span class="items-count">상품 ${e.receiptItems.length}건</span>`;
                const items = e.receiptItems
                  .map((it) => {
                    if (!it || !it.name) return "";
                    const name = it.name;
                    const qty =
                      it.quantity && it.quantity > 1 ? ` ×${it.quantity}` : "";
                    const price =
                      it.price && it.price > 0
                        ? `  ${Math.round(it.price).toLocaleString("ko-KR")}원`
                        : "";
                    return `<li>${highlight(name + qty, qHl)}<span class="item-price">${price}</span></li>`;
                  })
                  .filter(Boolean)
                  .join("");
                inner = `<ul class="items-list">${items}</ul>`;
              } else if (img) {
                summary = `<span class="items-count">영수증 사진</span>`;
                inner = `<img class="receipt-img" src="${img}" alt="영수증" loading="lazy" />`;
              } else {
                summary = `<span class="items-count">OCR 원문</span>`;
                inner = `<pre class="receipt-raw">${highlight(raw, qHl)}</pre>`;
              }
              return `<details class="items-details">
                  <summary><span class="items-label">영수증 상세</span>${summary}</summary>
                  ${inner}
                </details>`;
            })()}
            ${
              obs || learn
                ? `<div class="reflection-block">
                    ${
                      obs
                        ? `<div class="reflection observation"><span class="rlabel">상대의 반응 · 관찰</span>${highlight(
                            obs,
                            qHl
                          )}</div>`
                        : ""
                    }
                    ${
                      learn
                        ? `<div class="reflection learning"><span class="rlabel">나의 배움 · 깨달음</span>${highlight(
                            learn,
                            qHl
                          )}</div>`
                        : ""
                    }
                  </div>`
                : ""
            }
            <div class="actions">
              ${
                searching
                  ? `<button class="linkish" data-action="jump">이 달로 이동</button>`
                  : ""
              }
              <button class="linkish" data-action="edit">수정</button>
              <button class="linkish danger" data-action="delete">삭제</button>
            </div>
          </li>
        `;
      })
      .join("");
  }

  function renderReflection() {
    el.reflection.value = store.reflections[currentMonth] || "";
  }

  // --- Actions -----------------------------------------------------------
  function addEntry(data) {
    const stretch =
      data.stretch === "challenge" || data.stretch === "step" ? data.stretch : "usual";
    const mark =
      data.mark === "bookmark" || data.mark === "waste" ? data.mark : "none";
    const entry = {
      id: uid(),
      date: data.date || todayIsoLocal(),
      time: (data.time || "").trim(),
      amount: Math.max(0, Math.round(Number(data.amount) || 0)),
      place: (data.place || "").trim(),
      forWhom: (data.forWhom || "").trim(),
      relation: RELATIONS.includes(data.relation) ? data.relation : "",
      purpose: (data.purpose || "").trim(),
      category: resolveCategory(data.category, data.categoryCustom),
      context: (data.context || "").trim(),
      observation: (data.observation || "").trim(),
      learning: (data.learning || "").trim(),
      stretch,
      mark,
      receiptText: (pendingReceiptText || "").trim(),
      receiptItems: Array.isArray(pendingReceiptItems) ? pendingReceiptItems : [],
      receiptImage: pendingReceiptImage || "",
    };
    store.entries.push(entry);
    saveStore("add");
    currentMonth = entry.date.slice(0, 7);
    render();
  }

  function deleteEntry(id) {
    const e = store.entries.find((x) => x.id === id);
    if (!e) return;
    const ok = confirm(
      `이 훈련 기록을 지우시겠습니까?\n\n${e.date} · ${e.place} · ${formatWon(
        e.amount
      )}\n\n자동 백업은 남으니, 실수여도 되돌릴 수 있습니다.`
    );
    if (!ok) return;
    pushSnapshot("before-delete");
    store.entries = store.entries.filter((x) => x.id !== id);
    saveStore("delete");
    render();
  }

  function openEdit(id) {
    const e = store.entries.find((x) => x.id === id);
    if (!e) return;
    editingId = id;
    const f = el.editForm;
    f.date.value = e.date;
    if (f.time) f.time.value = e.time || "";
    f.amount.value = e.amount;
    f.place.value = e.place || "";
    f.forWhom.value = e.forWhom || "";
    const relVal = RELATIONS.includes(e.relation) ? e.relation : "";
    const relRadios = f.querySelectorAll('input[name="relation"]');
    relRadios.forEach((r) => (r.checked = r.value === relVal));
    f.purpose.value = e.purpose || "";
    const cat = presetForEntry(e.category || "기타");
    f.category.value = cat.select;
    if (f.categoryCustom) f.categoryCustom.value = cat.custom;
    syncCategoryCustom(f);
    f.context.value = e.context || "";
    const stretchVal = e.stretch || "usual";
    const stretchRadio = f.querySelector(
      `input[name="stretch"][value="${stretchVal}"]`
    );
    if (stretchRadio) stretchRadio.checked = true;
    const markVal = e.mark || "none";
    const markRadio = f.querySelector(
      `input[name="mark"][value="${markVal}"]`
    );
    if (markRadio) markRadio.checked = true;
    f.observation.value = e.observation || "";
    f.learning.value = e.learning || "";
    if (typeof el.dialog.showModal === "function") {
      el.dialog.showModal();
    } else {
      el.dialog.setAttribute("open", "");
    }
  }

  function saveEdit() {
    const f = el.editForm;
    const idx = store.entries.findIndex((x) => x.id === editingId);
    if (idx < 0) return;
    pushSnapshot("before-edit");
    const existing = store.entries[idx];
    const stretchChoice = f.querySelector('input[name="stretch"]:checked');
    const markChoice = f.querySelector('input[name="mark"]:checked');
    if (f.date.value && f.date.value < APP_START_DATE) {
      alert(`${APP_START_DATE} 이전 날짜로는 기록할 수 없습니다.`);
      return;
    }
    const updates = {
      date: f.date.value,
      time: (f.time && f.time.value ? f.time.value : "").trim(),
      amount: Math.max(0, Math.round(Number(f.amount.value) || 0)),
      place: f.place.value.trim(),
      forWhom: f.forWhom.value.trim(),
      relation: (() => {
        const r = f.querySelector('input[name="relation"]:checked');
        return r && RELATIONS.includes(r.value) ? r.value : "";
      })(),
      purpose: f.purpose.value.trim(),
      category: resolveCategory(
        f.category.value,
        f.categoryCustom && f.categoryCustom.value
      ),
      context: f.context.value.trim(),
      stretch:
        stretchChoice &&
        (stretchChoice.value === "challenge" || stretchChoice.value === "step")
          ? stretchChoice.value
          : "usual",
      mark:
        markChoice &&
        (markChoice.value === "bookmark" || markChoice.value === "waste")
          ? markChoice.value
          : "none",
      observation: f.observation.value.trim(),
      learning: f.learning.value.trim(),
    };
    // 미래에 추가될 알 수 없는 필드까지 보존
    store.entries[idx] = { ...existing, ...updates };
    saveStore("edit");
    editingId = null;
    render();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(store, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = todayIsoLocal();
    a.href = url;
    a.download = `moneygrace-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || typeof data !== "object")
          throw new Error("형식이 맞지 않습니다");
        pushSnapshot("before-import");
        const incoming = migrate(data);
        const merged = {
          schemaVersion: SCHEMA_VERSION,
          budgets: { ...incoming.budgets, ...store.budgets },
          entries: [...store.entries],
          reflections: { ...incoming.reflections, ...store.reflections },
        };
        const ids = new Set(merged.entries.map((e) => e.id));
        for (const e of incoming.entries) {
          if (!e || !e.id || ids.has(e.id)) continue;
          merged.entries.push(e);
        }
        store = merged;
        saveStore("import");
        render();
        alert("가져오기 완료. (이전 상태는 자동 백업에 보관되어 있습니다)");
      } catch (err) {
        alert("가져오기에 실패했습니다: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  function clearMonth() {
    const label = monthLabel(currentMonth);
    const ok = confirm(
      `${label}의 모든 훈련 기록과 복기를 삭제합니다.\n\n자동 백업에는 남아 있어 되돌릴 수 있습니다. 계속하시겠습니까?`
    );
    if (!ok) return;
    pushSnapshot("before-clear-month");
    store.entries = store.entries.filter(
      (e) => !(e.date || "").startsWith(currentMonth)
    );
    delete store.reflections[currentMonth];
    saveStore("clear-month");
    render();
  }

  function openRestore() {
    const snaps = loadSnapshots();
    if (!snaps.length) {
      alert("아직 복원할 자동 백업이 없습니다.");
      return;
    }
    const body = el.restoreList;
    body.innerHTML = snaps
      .map((s, i) => {
        const d = new Date(s.at);
        const ts =
          isNaN(d)
            ? s.at
            : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(
                2,
                "0"
              )}.${String(d.getDate()).padStart(2, "0")} ${String(
                d.getHours()
              ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
                d.getSeconds()
              ).padStart(2, "0")}`;
        const reason = reasonLabel(s.reason);
        const entries =
          (s.data && Array.isArray(s.data.entries) && s.data.entries.length) ||
          0;
        return `<li class="snap">
          <div>
            <div class="snap-when">${escapeHtml(ts)}</div>
            <div class="snap-meta">${escapeHtml(reason)} · 기록 ${entries}건</div>
          </div>
          <button class="linkish" data-snap="${i}">이 시점으로 복원</button>
        </li>`;
      })
      .join("");
    if (typeof el.restoreDialog.showModal === "function") {
      el.restoreDialog.showModal();
    } else {
      el.restoreDialog.setAttribute("open", "");
    }
  }

  function reasonLabel(r) {
    switch (r) {
      case "add":
        return "기록 추가 후";
      case "edit":
        return "기록 수정 후";
      case "delete":
        return "기록 삭제 후";
      case "before-delete":
        return "삭제 직전";
      case "before-edit":
        return "수정 직전";
      case "before-clear-month":
        return "월 삭제 직전";
      case "before-import":
        return "가져오기 직전";
      case "import":
        return "가져오기 후";
      case "clear-month":
        return "월 삭제 후";
      case "budget":
        return "맡겨진 몫 조정";
      default:
        return r || "자동";
    }
  }

  function restoreFromSnapshot(i) {
    const snaps = loadSnapshots();
    const snap = snaps[i];
    if (!snap) return;
    const ok = confirm(
      `선택한 백업 시점으로 되돌립니다.\n\n현재 상태도 '복원 직전'으로 자동 백업되므로, 다시 되돌아올 수 있습니다.`
    );
    if (!ok) return;
    pushSnapshot("before-restore");
    store = migrate(snap.data);
    saveStore("restore");
    render();
    if (el.restoreDialog.open) el.restoreDialog.close();
  }

  function editBudget() {
    const current = budgetFor(currentMonth);
    const raw = prompt(
      `${monthLabel(currentMonth)} 맡겨진 몫 (원)`,
      String(current)
    );
    if (raw === null) return;
    const val = Math.max(0, Math.round(Number(raw.replace(/[,\s]/g, "")) || 0));
    store.budgets[currentMonth] = val;
    saveStore("budget");
    render();
  }

  function editStartDay() {
    const total = daysInMonth(currentMonth);
    const current = startDayFor(currentMonth);
    const raw = prompt(
      `${monthLabel(currentMonth)} 시작일 (1–${total}). 이 달을 며칠부터 계산할지 정합니다.\n페이스 지표가 해당 기간으로 조정됩니다.`,
      String(current)
    );
    if (raw === null) return;
    const n = Math.round(Number(String(raw).replace(/[^0-9]/g, "")) || 0);
    if (!store.starts) store.starts = {};
    if (n <= 1) {
      delete store.starts[currentMonth];
    } else if (n > total) {
      alert(`시작일은 1부터 ${total} 사이여야 합니다.`);
      return;
    } else {
      store.starts[currentMonth] = n;
    }
    saveStore("start-day");
    render();
  }

  function updateSavedIndicator() {
    if (!el.savedIndicator) return;
    const d = new Date();
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
    el.savedIndicator.textContent = `자동 백업됨 · ${t}`;
  }

  // --- Receipt OCR -------------------------------------------------------
  function setReceiptStatus(text) {
    if (!el.receiptStatus) return;
    el.receiptStatus.textContent = text || "";
  }

  /**
   * @param {"indeterminate"|"determinate"|null} phase
   * @param {number=} progress 0..1 for determinate
   * @param {string=} label
   */
  function setReceiptProgress(phase, progress, label) {
    const p = el.receiptProgress;
    const bar = el.receiptProgressBar;
    const labelEl = el.receiptProgressLabel;
    if (!p || !bar || !labelEl) return;
    if (!phase) {
      p.setAttribute("hidden", "");
      p.classList.remove("indeterminate", "determinate");
      bar.style.width = "0";
      labelEl.textContent = "";
      return;
    }
    p.removeAttribute("hidden");
    p.classList.remove("indeterminate", "determinate");
    p.classList.add(phase);
    if (phase === "determinate") {
      const v = Math.min(100, Math.max(0, (progress || 0) * 100));
      bar.style.width = v + "%";
    } else {
      bar.style.width = "";
    }
    labelEl.textContent = label || "";
  }

  function loadTesseract() {
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
      if (typeof window.Tesseract !== "undefined") return resolve(window.Tesseract);
      const s = document.createElement("script");
      s.src = TESSERACT_URL;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error("OCR 엔진 로드 실패 (네트워크 필요)"));
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }

  async function imageToCanvas(file, maxWidth = 2400, minWidth = 1800) {
    const bmp = await (window.createImageBitmap
      ? createImageBitmap(file)
      : new Promise((res, rej) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            res(img);
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            rej(new Error("이미지를 열 수 없습니다"));
          };
          img.src = url;
        }));
    const w0 = bmp.width || bmp.naturalWidth;
    const h0 = bmp.height || bmp.naturalHeight;
    // 작은 이미지는 확대(최대 2x까지), 큰 이미지는 축소
    let scale = 1;
    if (w0 < minWidth) scale = Math.min(2, minWidth / w0);
    else if (w0 > maxWidth) scale = maxWidth / w0;
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    return c;
  }

  // 저장용 축소 이미지 (dataURL). 원본 canvas 가 아직 색상을 유지한 상태에서 호출할 것.
  async function compressForStorage(canvas, maxWidth = 640, quality = 0.5) {
    const w0 = canvas.width;
    const h0 = canvas.height;
    const scale = w0 > maxWidth ? maxWidth / w0 : 1;
    const w = Math.round(w0 * scale);
    const h = Math.round(h0 * scale);
    const c2 = document.createElement("canvas");
    c2.width = w;
    c2.height = h;
    const ctx = c2.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, w, h);
    return c2.toDataURL("image/jpeg", quality);
  }

  // 그레이스케일 + 가벼운 대비 부스트 — Tesseract 인식률 향상용.
  // 이진화(Otsu)는 앱 스크린샷처럼 고품질 소스에선 역효과라 사용하지 않음.
  function preprocessGrayscale(canvas) {
    const ctx = canvas.getContext("2d");
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    // 1st pass: grayscale
    for (let i = 0; i < d.length; i += 4) {
      const g = Math.round(
        0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      );
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    // 2nd pass: 가벼운 레벨 스트레치 (히스토그램 2~98% 구간으로)
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
    const total = canvas.width * canvas.height;
    let lo = 0, hi = 255, cum = 0;
    for (let i = 0; i < 256; i++) {
      cum += hist[i];
      if (cum / total >= 0.02) { lo = i; break; }
    }
    cum = 0;
    for (let i = 255; i >= 0; i--) {
      cum += hist[i];
      if (cum / total >= 0.02) { hi = i; break; }
    }
    if (hi - lo >= 32) {
      const scale = 255 / (hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.max(0, Math.min(255, Math.round((d[i] - lo) * scale)));
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  async function recognizeReceipt(file) {
    setReceiptProgress("indeterminate", 0, "사진 준비 중");
    const canvas = await imageToCanvas(file);
    // 전처리 전에 축소 컬러 썸네일을 캡처해 저장한다.
    try {
      pendingReceiptImage = await compressForStorage(canvas);
    } catch (_) {
      pendingReceiptImage = "";
    }
    preprocessGrayscale(canvas);
    setReceiptProgress("indeterminate", 0, "엔진 준비 중");
    const Tesseract = await loadTesseract();
    const { data } = await Tesseract.recognize(canvas, "kor+eng", {
      // 단일 컬럼(영수증) · 띄어쓰기 보존 · DPI 힌트
      tessedit_pageseg_mode: "4",
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
      logger: (m) => {
        if (m && m.status === "recognizing text") {
          const pct = Math.round((m.progress || 0) * 100);
          setReceiptProgress("determinate", m.progress || 0, `인식 중 ${pct}%`);
        } else if (m && m.status) {
          const map = {
            "loading tesseract core": "엔진 불러오는 중",
            "initializing tesseract": "엔진 준비 중",
            "loading language traineddata": "한국어 모델 내려받는 중",
            "initializing api": "모델 준비 중",
          };
          if (map[m.status]) setReceiptProgress("indeterminate", 0, map[m.status]);
        }
      },
    });
    return (data && data.text) || "";
  }

  function parseReceipt(text) {
    const out = { amount: null, date: null, time: null, place: null };
    if (!text) return out;

    // 날짜 — YYYY[.-/년 ]MM[.-/월 ]DD / YY[.-/]MM[.-/]DD
    const dm =
      text.match(/(20\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/) ||
      text.match(/\b(\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})\b/);
    if (dm) {
      let y, m, d;
      if (dm[1].length === 4) {
        y = +dm[1]; m = +dm[2]; d = +dm[3];
      } else {
        y = 2000 + +dm[1]; m = +dm[2]; d = +dm[3];
      }
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        out.date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }

    // 시간 — 오후/오전 + HH:MM[:SS], PM/AM + HH:MM, 또는 일반 HH:MM[:SS]
    const normalize = (h, mm) => {
      const hh = Math.max(0, Math.min(23, h));
      const min = Math.max(0, Math.min(59, +mm));
      return `${String(hh).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    };
    let tm;
    tm = text.match(/(오후|PM|p\.m\.)\s*(\d{1,2})\s*[:시]\s*(\d{2})/i);
    if (tm) {
      let h = +tm[2];
      if (h < 12) h += 12;
      out.time = normalize(h, tm[3]);
    } else {
      tm = text.match(/(오전|AM|a\.m\.)\s*(\d{1,2})\s*[:시]\s*(\d{2})/i);
      if (tm) {
        let h = +tm[2];
        if (h === 12) h = 0;
        out.time = normalize(h, tm[3]);
      } else {
        tm = text.match(/\b([01]?\d|2[0-3])\s*[:시]\s*([0-5]\d)(?:\s*[:분]\s*([0-5]\d))?\b/);
        if (tm) out.time = normalize(+tm[1], tm[2]);
      }
    }

    // 금액 — 점수 기반. 키워드·원 접미사·천단위 쉼표를 가산해 후보군을 평가.
    // 날짜·시간·카드번호·차량번호가 금액으로 잡히는 것을 막는다.
    const keywordRe =
      /(합\s*계|총\s*액|총\s*합\s*계|받을금액|결제\s*금액|승인\s*금액|청구\s*금액|운행\s*요금|미터기\s*요금|TOTAL|AMOUNT\s*DUE)/i;
    const lines = text.split(/\r?\n/);
    // 숫자 후보 — 쉼표 포함 또는 원/￦ 접미사 중 하나는 있어야 인정
    const candRe =
      /(?:^|[^\d.,])((?:\d{1,3}(?:,\d{3})+)|(?:\d{3,8}))(?:\s*(원|￦))?/g;

    // 날짜·시간 미리 제거
    const cleanLine = (s) =>
      s
        .replace(/\b\d{2,4}\s*[.\-\/년]\s*\d{1,2}\s*[.\-\/월]\s*\d{1,2}\b/g, " ")
        .replace(/\b\d{1,2}\s*[:시]\s*\d{2}(?:\s*[:분]\s*\d{2})?\b/g, " ");

    /** @type {{val:number, score:number}[]} */
    const candidates = [];
    for (const rawLine of lines) {
      const line = cleanLine(rawLine);
      const hasKeyword = keywordRe.test(line);
      let m;
      candRe.lastIndex = 0;
      while ((m = candRe.exec(line)) !== null) {
        const raw = m[1];
        const hasComma = raw.includes(",");
        const hasWon = !!m[2];
        // 쉼표도 없고 원도 없으면 제외 (차량번호·카드번호·연도 등 노이즈)
        if (!hasComma && !hasWon) continue;
        const n = Number(raw.replace(/,/g, ""));
        if (n < 100 || n >= 100_000_000) continue;
        let score = 0;
        if (hasKeyword) score += 10;
        if (hasComma) score += 3;
        if (hasWon) score += 4;
        // '결제 금액' 이 '결제 수단' 같은 라벨보다 앞선 경우 가산
        if (/결제\s*금액|합\s*계|총\s*액/i.test(line)) score += 2;
        candidates.push({ val: n, score });
      }
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score || b.val - a.val);
      out.amount = candidates[0].val;
    }

    // 상호 — 상단 몇 줄 중 한글 2자 이상 포함, 노이즈 키워드 배제
    const noiseRe =
      /(합계|총액|영수|카드|승인|일시|주소|매장|사업자|대표자|전화|TEL|TOTAL|VAT|과세|면세|부가세|결제|승인번호|거래번호)/i;
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const s = (lines[i] || "").trim();
      if (!s) continue;
      if (!/[가-힣]{2,}/.test(s)) continue;
      if (noiseRe.test(s)) continue;
      out.place = s.replace(/\s{2,}/g, " ").slice(0, 40);
      break;
    }
    return out;
  }

  function prefillFromReceipt(parsed) {
    const f = el.form;
    if (!f) return;
    const todayVal = todayIsoLocal();
    if (parsed.date && parsed.date >= APP_START_DATE) {
      if (!f.date.value || f.date.value === todayVal) f.date.value = parsed.date;
    }
    if (parsed.time && f.time && !f.time.value) f.time.value = parsed.time;
    if (parsed.amount && !f.amount.value) f.amount.value = String(parsed.amount);
    if (parsed.place && !f.place.value) f.place.value = parsed.place;
  }

  async function handleReceiptFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setReceiptStatus("이미지 파일만 지원합니다.");
      setReceiptProgress(null);
      return;
    }
    try {
      pendingReceiptText = "";
      pendingReceiptItems = [];
      setReceiptStatus("");
      setReceiptProgress("indeterminate", 0, "사진 분석 시작");

      const text = await recognizeReceipt(file);
      pendingReceiptText = text;
      const parsed = parseReceipt(text);
      prefillFromReceipt(parsed);
      const done = [];
      if (parsed.amount) done.push(`금액 ${formatWon(parsed.amount)}`);
      if (parsed.date) done.push(`날짜 ${parsed.date}`);
      if (parsed.time) done.push(`시간 ${parsed.time}`);
      if (parsed.place) done.push(`상호 "${parsed.place}"`);
      setReceiptProgress(null);
      setReceiptStatus(
        done.length
          ? `자동 채움 완료 — ${done.join(" · ")}. 확인 후 '기록하기'.`
          : "읽기는 끝났지만 값이 확실히 잡히지 않았습니다. 직접 확인해 주세요."
      );
    } catch (err) {
      console.error(err);
      setReceiptProgress(null);
      setReceiptStatus("영수증을 읽지 못했습니다: " + (err.message || err));
    }
  }

  // --- Principles (localStorage only) ------------------------------------
  function loadPrinciples() {
    try {
      const raw = localStorage.getItem(PRINCIPLES_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return {
        label: parsed.label || "",
        date: parsed.date || "",
        items: Array.isArray(parsed.items)
          ? parsed.items.map((s) => String(s || "")).filter(Boolean)
          : [],
      };
    } catch (_) {
      return null;
    }
  }

  function savePrinciples(obj) {
    try {
      if (!obj) localStorage.removeItem(PRINCIPLES_KEY);
      else localStorage.setItem(PRINCIPLES_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  function renderPrinciplesLine(s) {
    return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function renderPrinciples() {
    const data = loadPrinciples();
    if (el.principlesLabel)
      el.principlesLabel.textContent =
        (data && data.label && data.label.trim()) || "개인 원칙";
    if (el.principlesDate)
      el.principlesDate.textContent = (data && data.date) || "";
    if (!el.principlesList) return;
    if (!data || !data.items || !data.items.length) {
      el.principlesList.innerHTML =
        '<li class="principles-empty">편집을 눌러 개인 원칙을 적어두세요. 이 내용은 이 브라우저에만 저장되며 공개되지 않습니다.</li>';
      return;
    }
    el.principlesList.innerHTML = data.items
      .map((s) => `<li>${renderPrinciplesLine(s)}</li>`)
      .join("");
  }

  function openPrinciplesEditor() {
    if (!el.principlesDialog || !el.principlesForm) return;
    const data = loadPrinciples() || { label: "", date: "", items: [] };
    const f = el.principlesForm;
    f.label.value = data.label || "";
    f.date.value = data.date || "";
    f.items.value = (data.items || []).join("\n");
    if (typeof el.principlesDialog.showModal === "function") {
      el.principlesDialog.showModal();
    } else {
      el.principlesDialog.setAttribute("open", "");
    }
  }

  function savePrinciplesFromForm() {
    const f = el.principlesForm;
    if (!f) return;
    const label = (f.label.value || "").trim();
    const date = (f.date.value || "").trim();
    const items = (f.items.value || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!label && !date && !items.length) {
      savePrinciples(null); // 빈 저장은 삭제
    } else {
      savePrinciples({ label, date, items });
    }
    renderPrinciples();
  }

  // --- Report ------------------------------------------------------------
  function buildReportModel(monthKeyStr) {
    const key = monthKeyStr;
    const budget = budgetFor(key);
    const startDay = startDayFor(key);
    const entries = entriesFor(key).slice().sort((a, b) => {
      const ka = (a.date || "") + (a.time || "");
      const kb = (b.date || "") + (b.time || "");
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const spent = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const remaining = budget - spent;

    const totalDays = daysInMonth(key);
    const [y, m] = key.split("-").map(Number);
    const endDate = `${y}-${String(m).padStart(2, "0")}-${String(totalDays).padStart(2, "0")}`;
    const startDate = `${y}-${String(m).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;

    const stretch = stretchTally(entries);
    const marks = markTally(entries);
    const prevEntries = entriesFor(shiftMonth(key, -1));
    const prevStretch = stretchTally(prevEntries);

    // 대상 집계
    /** @type {Map<string, {count:number, sum:number}>} */
    const byPerson = new Map();
    for (const e of entries) {
      const name = (e.forWhom || "").trim() || "(미기재)";
      const cur = byPerson.get(name) || { count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += Number(e.amount) || 0;
      byPerson.set(name, cur);
    }
    const people = [...byPerson.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.sum - a.sum || b.count - a.count);

    // 카테고리 집계
    /** @type {Map<string, {count:number, sum:number}>} */
    const byCategory = new Map();
    for (const e of entries) {
      const c = e.category || "기타";
      const cur = byCategory.get(c) || { count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += Number(e.amount) || 0;
      byCategory.set(c, cur);
    }
    const categories = [...byCategory.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.sum - a.sum);

    // 관계별 집계
    /** @type {Map<string, {count:number, sum:number}>} */
    const byRelation = new Map();
    for (const e of entries) {
      const r = e.relation || "미지정";
      const cur = byRelation.get(r) || { count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += Number(e.amount) || 0;
      byRelation.set(r, cur);
    }
    const order = ["나", "가족", "직원", "지인", "모르는사람", "미지정"];
    const relations = order
      .map((name) => ({
        name,
        count: (byRelation.get(name) || { count: 0 }).count,
        sum: (byRelation.get(name) || { sum: 0 }).sum,
      }))
      .filter((r) => r.count > 0);

    const bookmarks = entries.filter((e) => (e.mark || "none") === "bookmark");
    const wastes = entries.filter((e) => (e.mark || "none") === "waste");

    return {
      key,
      label: monthLabel(key),
      startDay,
      totalDays,
      startDate,
      endDate,
      budget,
      spent,
      remaining,
      ratio: budget > 0 ? spent / budget : 0,
      entries,
      count: entries.length,
      stretch,
      marks,
      prevStretch,
      people,
      categories,
      relations,
      bookmarks,
      wastes,
      reflection: store.reflections[key] || "",
    };
  }

  function renderSummarySection(m) {
    const forfeit = m.remaining > 0 ? m.remaining : 0;
    const overflow = m.remaining < 0 ? -m.remaining : 0;
    const pct = Math.round(m.ratio * 100);
    const maxCat = Math.max(1, ...m.categories.map((c) => c.sum));
    const stretchArrow =
      m.stretch.challenge > m.prevStretch.challenge
        ? "↑"
        : m.stretch.challenge < m.prevStretch.challenge
        ? "↓"
        : "→";
    return `
<section class="report-section">
  <div class="report-head">
    <p class="report-eyebrow">요약 보고서</p>
    <h1 class="report-title">${escapeHtml(m.label)} 훈련일기 요약</h1>
    <p class="report-sub">${escapeHtml(m.startDate)} – ${escapeHtml(m.endDate)} · ${m.count}건의 기록</p>
  </div>

  <div class="report-group">
    <div class="report-figures">
      <div><span class="label">맡겨진 몫</span><span class="value">${formatWon(m.budget)}</span></div>
      <div><span class="label">흘려보낸 몫</span><span class="value">${formatWon(m.spent)} · ${pct}%</span></div>
      <div><span class="label">${forfeit > 0 ? "소멸된 몫" : overflow > 0 ? "넘어선 몫" : "남은 몫"}</span><span class="value ${forfeit > 0 ? "forfeit" : ""}">${formatWon(forfeit || overflow || 0)}</span></div>
    </div>
  </div>

  <div class="report-group">
    <p class="report-group-title">이달의 걸음</p>
    <p style="margin:0;font-size:14.5px;">
      도전 ${m.stretch.challenge}회 · 한 걸음 ${m.stretch.step}회 · 평소 ${m.stretch.usual}회<br/>
      책갈피 ${m.marks.bookmark}건 · 낭비 ${m.marks.waste}건<br/>
      <span style="color:var(--ink-soft);font-size:13px;">지난달 도전 ${m.prevStretch.challenge}회 ${stretchArrow} 이달 ${m.stretch.challenge}회</span>
    </p>
  </div>

  ${
    m.people.length
      ? `<div class="report-group">
    <p class="report-group-title">함께한 사람들 · 상위 ${Math.min(5, m.people.length)}</p>
    <ul class="report-list">
      ${m.people
        .slice(0, 5)
        .map(
          (p, i) =>
            `<li><span class="rl-left">${i + 1}. ${escapeHtml(p.name)}</span><span class="rl-right">${p.count}회 · ${formatWon(p.sum)}</span></li>`
        )
        .join("")}
    </ul>
  </div>`
      : ""
  }

  ${
    m.relations.length
      ? `<div class="report-group">
    <p class="report-group-title">관계별 분포</p>
    ${(() => {
      const maxRel = Math.max(1, ...m.relations.map((r) => r.sum));
      return m.relations
        .map(
          (r) => `
        <div class="report-bar">
          <span class="b-name">${escapeHtml(r.name)}</span>
          <span class="b-bar"><span style="width:${Math.round(
            (r.sum / maxRel) * 100
          )}%"></span></span>
          <span class="b-amt">${formatWon(r.sum)}</span>
          <span class="b-cnt">${r.count}건</span>
        </div>`
        )
        .join("");
    })()}
  </div>`
      : ""
  }

  ${
    m.categories.length
      ? `<div class="report-group">
    <p class="report-group-title">쓰임의 결 분포</p>
    ${m.categories
      .map(
        (c) => `
      <div class="report-bar">
        <span class="b-name">${escapeHtml(c.name)}</span>
        <span class="b-bar"><span style="width:${Math.round((c.sum / maxCat) * 100)}%"></span></span>
        <span class="b-amt">${formatWon(c.sum)}</span>
        <span class="b-cnt">${c.count}건</span>
      </div>`
      )
      .join("")}
  </div>`
      : ""
  }

  ${
    m.bookmarks.length
      ? `<div class="report-group">
    <p class="report-group-title">다시 하고픈 · 책갈피</p>
    <ul class="report-pills">
      ${m.bookmarks
        .map(
          (e) =>
            `<li><span>${escapeHtml(e.place || "")} · ${escapeHtml(e.forWhom || "")}${
              e.learning ? ` <span class="pill-note">— ${escapeHtml(e.learning.split("\n")[0])}</span>` : ""
            }</span></li>`
        )
        .join("")}
    </ul>
  </div>`
      : ""
  }

  ${
    m.wastes.length
      ? `<div class="report-group">
    <p class="report-group-title">돌아보기 · 낭비</p>
    <ul class="report-pills waste">
      ${m.wastes
        .map(
          (e) =>
            `<li><span>${escapeHtml(e.place || "")} · ${escapeHtml(e.forWhom || "")}${
              e.learning ? ` <span class="pill-note">— ${escapeHtml(e.learning.split("\n")[0])}</span>` : ""
            }</span></li>`
        )
        .join("")}
    </ul>
  </div>`
      : ""
  }

  ${
    m.reflection
      ? `<div class="report-group">
    <p class="report-group-title">이달의 한 문장</p>
    <div class="report-quote">${escapeHtml(m.reflection)}</div>
  </div>`
      : ""
  }
</section>`;
  }

  function renderFullSection(m) {
    const forfeit = m.remaining > 0 ? m.remaining : 0;
    const overflow = m.remaining < 0 ? -m.remaining : 0;
    const pct = Math.round(m.ratio * 100);
    return `
<section class="report-section">
  <div class="report-head">
    <p class="report-eyebrow">전체 기록 보고서</p>
    <h1 class="report-title">${escapeHtml(m.label)} 훈련일기 · 전체 기록</h1>
    <p class="report-sub">${escapeHtml(m.startDate)} – ${escapeHtml(m.endDate)} · ${m.count}건 · 총 ${formatWon(m.spent)}</p>
  </div>

  <div class="report-group">
    <div class="report-figures">
      <div><span class="label">맡겨진 몫</span><span class="value">${formatWon(m.budget)}</span></div>
      <div><span class="label">흘려보낸 몫</span><span class="value">${formatWon(m.spent)} · ${pct}%</span></div>
      <div><span class="label">${forfeit > 0 ? "소멸된 몫" : overflow > 0 ? "넘어선 몫" : "남은 몫"}</span><span class="value ${forfeit > 0 ? "forfeit" : ""}">${formatWon(forfeit || overflow || 0)}</span></div>
    </div>
  </div>

  ${
    m.reflection
      ? `<div class="report-group">
    <p class="report-group-title">이달의 복기</p>
    <div class="report-quote">${escapeHtml(m.reflection)}</div>
  </div>`
      : ""
  }

  <div class="report-group">
    <p class="report-group-title">전체 기록 (시간순)</p>
    <div class="report-entries">
      ${m.entries
        .map((e, i) => renderReportEntry(e, i + 1))
        .join("")}
    </div>
  </div>

  <div class="report-foot">생성 ${new Date().toLocaleString("ko-KR")} · moneygrace</div>
</section>`;
  }

  function renderReportEntry(e, idx) {
    const d = e.date ? new Date(e.date + "T00:00:00") : null;
    const weekday =
      d && !isNaN(d) ? ["일", "월", "화", "수", "목", "금", "토"][d.getDay()] : "";
    const dateTxt =
      d && !isNaN(d)
        ? `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, "0")}`
        : e.date || "";
    const timeTxt = (e.time || "").trim();
    const stretch = e.stretch || "usual";
    const stretchLabel =
      stretch === "challenge" ? "도전" : stretch === "step" ? "한 걸음" : "";
    const mark = e.mark || "none";
    const markLabel =
      mark === "bookmark" ? "책갈피" : mark === "waste" ? "낭비" : "";
    const tagBits = [
      escapeHtml(e.category || "기타"),
      stretchLabel,
      markLabel,
    ].filter(Boolean);

    const items = Array.isArray(e.receiptItems) ? e.receiptItems : [];

    return `
  <div class="report-entry">
    <div class="re-idx">${idx}</div>
    <div>
      <div class="re-line-1">
        <span class="re-date">${escapeHtml(dateTxt)}${weekday ? ` (${weekday})` : ""}${timeTxt ? ` ${escapeHtml(timeTxt)}` : ""}</span>
        <span class="re-amt">${formatWon(e.amount)}</span>
        ${tagBits.map((t) => `<span class="re-tag">· ${t}</span>`).join("")}
      </div>
      <div class="re-place">${escapeHtml(e.place || "")}</div>
      <div class="re-meta">대상 — <strong>${escapeHtml(e.forWhom || "—")}</strong>${e.relation ? ` · ${escapeHtml(e.relation)}` : ""}</div>
      ${
        e.purpose
          ? `<div class="re-row purpose"><span class="lbl">바라는 열매</span>${escapeHtml(e.purpose)}</div>`
          : ""
      }
      ${
        e.context
          ? `<div class="re-row"><span class="lbl">맥락</span>${escapeHtml(e.context)}</div>`
          : ""
      }
      ${
        e.observation
          ? `<div class="re-row"><span class="lbl">상대의 반응·관찰</span>${escapeHtml(e.observation)}</div>`
          : ""
      }
      ${
        e.learning
          ? `<div class="re-row"><span class="lbl">나의 배움·깨달음</span>${escapeHtml(e.learning)}</div>`
          : ""
      }
      ${
        items.length
          ? `<div class="re-items"><span class="lbl">영수증 상세</span>
              <ul>
                ${items
                  .map(
                    (it) =>
                      `<li><span>${escapeHtml(it.name || "")}${
                        it.quantity && it.quantity > 1 ? ` ×${it.quantity}` : ""
                      }</span><span>${
                        it.price && it.price > 0
                          ? Math.round(it.price).toLocaleString("ko-KR") + "원"
                          : ""
                      }</span></li>`
                  )
                  .join("")}
              </ul>
            </div>`
          : ""
      }
    </div>
  </div>`;
  }

  function renderReportMarkdown(m) {
    const lines = [];
    const forfeit = m.remaining > 0 ? m.remaining : 0;
    const overflow = m.remaining < 0 ? -m.remaining : 0;
    const pct = Math.round(m.ratio * 100);

    // === 요약 ===
    lines.push(`# ${m.label} 훈련일기 요약`);
    lines.push(`${m.startDate} – ${m.endDate} · ${m.count}건의 기록`);
    lines.push("");
    lines.push(`- 맡겨진 몫: ${formatWon(m.budget)}`);
    lines.push(`- 흘려보낸 몫: ${formatWon(m.spent)} (${pct}%)`);
    lines.push(
      `- ${forfeit > 0 ? "소멸된 몫" : overflow > 0 ? "넘어선 몫" : "남은 몫"}: ${formatWon(forfeit || overflow || 0)}`
    );
    lines.push("");
    lines.push(`## 이달의 걸음`);
    lines.push(
      `도전 ${m.stretch.challenge}회 · 한 걸음 ${m.stretch.step}회 · 평소 ${m.stretch.usual}회`
    );
    lines.push(`책갈피 ${m.marks.bookmark}건 · 낭비 ${m.marks.waste}건`);
    lines.push(
      `지난달 도전 ${m.prevStretch.challenge}회 → 이달 ${m.stretch.challenge}회`
    );
    lines.push("");
    if (m.people.length) {
      lines.push(`## 함께한 사람들`);
      m.people.slice(0, 5).forEach((p, i) => {
        lines.push(`${i + 1}. ${p.name} — ${p.count}회 · ${formatWon(p.sum)}`);
      });
      lines.push("");
    }
    if (m.relations.length) {
      lines.push(`## 관계별 분포`);
      m.relations.forEach((r) => {
        lines.push(`- ${r.name}: ${formatWon(r.sum)} · ${r.count}건`);
      });
      lines.push("");
    }
    if (m.categories.length) {
      lines.push(`## 쓰임의 결 분포`);
      m.categories.forEach((c) => {
        lines.push(`- ${c.name}: ${formatWon(c.sum)} · ${c.count}건`);
      });
      lines.push("");
    }
    if (m.bookmarks.length) {
      lines.push(`## 다시 하고픈 · 책갈피`);
      m.bookmarks.forEach((e) => {
        const note = e.learning ? ` — ${e.learning.split("\n")[0]}` : "";
        lines.push(`- ${e.place || ""} · ${e.forWhom || ""}${note}`);
      });
      lines.push("");
    }
    if (m.wastes.length) {
      lines.push(`## 돌아보기 · 낭비`);
      m.wastes.forEach((e) => {
        const note = e.learning ? ` — ${e.learning.split("\n")[0]}` : "";
        lines.push(`- ${e.place || ""} · ${e.forWhom || ""}${note}`);
      });
      lines.push("");
    }
    if (m.reflection) {
      lines.push(`## 이달의 한 문장`);
      lines.push("> " + m.reflection.replace(/\n/g, "\n> "));
      lines.push("");
    }

    // === 전체 기록 ===
    lines.push("");
    lines.push(`---`);
    lines.push("");
    lines.push(`# ${m.label} 훈련일기 · 전체 기록`);
    lines.push(`${m.startDate} – ${m.endDate} · ${m.count}건 · 총 ${formatWon(m.spent)}`);
    lines.push("");
    m.entries.forEach((e, i) => {
      const idx = i + 1;
      const d = e.date ? new Date(e.date + "T00:00:00") : null;
      const weekday =
        d && !isNaN(d)
          ? ["일", "월", "화", "수", "목", "금", "토"][d.getDay()]
          : "";
      const stretch = e.stretch || "usual";
      const stretchLabel =
        stretch === "challenge" ? "도전" : stretch === "step" ? "한 걸음" : "";
      const mark = e.mark || "none";
      const markLabel =
        mark === "bookmark" ? "책갈피" : mark === "waste" ? "낭비" : "";
      const tagBits = [e.category || "기타", stretchLabel, markLabel].filter(Boolean);
      lines.push(
        `### ${idx}. ${e.date || ""}${weekday ? ` (${weekday})` : ""}${
          e.time ? ` ${e.time}` : ""
        }  ·  ${formatWon(e.amount)}  ·  ${tagBits.join(" · ")}`
      );
      lines.push(`**${e.place || ""}**`);
      lines.push(`대상 — ${e.forWhom || "—"}`);
      if (e.purpose) lines.push(`바라는 열매 — ${e.purpose}`);
      if (e.context) lines.push(`맥락 — ${e.context}`);
      if (e.observation) lines.push(`상대의 반응 — ${e.observation}`);
      if (e.learning) lines.push(`나의 배움 — ${e.learning}`);
      const items = Array.isArray(e.receiptItems) ? e.receiptItems : [];
      if (items.length) {
        lines.push("");
        lines.push(`영수증 상세:`);
        items.forEach((it) => {
          const q = it.quantity && it.quantity > 1 ? ` ×${it.quantity}` : "";
          const p =
            it.price && it.price > 0
              ? `  ${Math.round(it.price).toLocaleString("ko-KR")}원`
              : "";
          lines.push(`  - ${it.name || ""}${q}${p}`);
        });
      }
      lines.push("");
    });
    lines.push(`---`);
    lines.push(`_생성 ${new Date().toLocaleString("ko-KR")} · moneygrace_`);
    return lines.join("\n");
  }

  function openReport() {
    const model = buildReportModel(currentMonth);
    if (!el.reportBody) return;
    el.reportBody.innerHTML =
      renderSummarySection(model) + renderFullSection(model);
    if (el.reportTitle) el.reportTitle.textContent = `${model.label} 보고서`;
    el.reportDialog._model = model;
    if (typeof el.reportDialog.showModal === "function") {
      el.reportDialog.showModal();
    } else {
      el.reportDialog.setAttribute("open", "");
    }
  }

  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function renderReportCSV(m) {
    const headers = [
      "날짜",
      "시간",
      "금액",
      "장소",
      "대상",
      "관계",
      "쓰임의 결",
      "목적",
      "맥락",
      "도전",
      "경험 갈무리",
      "상대의 반응",
      "나의 배움",
      "상품 요약",
    ];
    const rows = [headers.map(csvEscape).join(",")];
    for (const e of m.entries) {
      const items =
        Array.isArray(e.receiptItems) && e.receiptItems.length
          ? e.receiptItems
              .map(
                (it) =>
                  `${it.name || ""}${
                    it.quantity && it.quantity > 1 ? ` x${it.quantity}` : ""
                  }${
                    it.price && it.price > 0
                      ? ` (${Math.round(it.price).toLocaleString("ko-KR")}원)`
                      : ""
                  }`
              )
              .join(" / ")
          : "";
      const cols = [
        e.date || "",
        e.time || "",
        Number(e.amount) || 0,
        e.place || "",
        e.forWhom || "",
        e.relation || "",
        e.category || "",
        e.purpose || "",
        e.context || "",
        e.stretch === "challenge"
          ? "도전"
          : e.stretch === "step"
          ? "한 걸음"
          : "평소",
        e.mark === "bookmark" ? "책갈피" : e.mark === "waste" ? "낭비" : "",
        e.observation || "",
        e.learning || "",
        items,
      ];
      rows.push(cols.map(csvEscape).join(","));
    }
    return "﻿" + rows.join("\r\n"); // UTF-8 BOM for Excel
  }

  function downloadReportCSV() {
    const model = el.reportDialog && el.reportDialog._model;
    if (!model) return;
    const csv = renderReportCSV(model);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `moneygrace-${model.key}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadReportMarkdown() {
    const model = el.reportDialog && el.reportDialog._model;
    if (!model) return;
    const md = renderReportMarkdown(model);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `moneygrace-${model.key}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function copyReportToClipboard() {
    const model = el.reportDialog && el.reportDialog._model;
    if (!model) return;
    const md = renderReportMarkdown(model);
    try {
      await navigator.clipboard.writeText(md);
      alert("보고서를 클립보드에 복사했습니다.");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = md;
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      ta.remove();
      alert("보고서를 클립보드에 복사했습니다.");
    }
  }

  // --- Whisper -----------------------------------------------------------
  function rotateWhisper() {
    const idx = Math.floor(Math.random() * WHISPERS.length);
    el.whisper.textContent = WHISPERS[idx];
  }

  // --- Event bindings ----------------------------------------------------
  function bind() {
    el.prevMonth.addEventListener("click", () => {
      currentMonth = shiftMonth(currentMonth, -1);
      render();
    });
    el.nextMonth.addEventListener("click", () => {
      currentMonth = shiftMonth(currentMonth, 1);
      render();
    });
    el.monthLabel.addEventListener("click", () => {
      currentMonth = monthKey(new Date());
      render();
    });

    el.editBudget.addEventListener("click", editBudget);
    if (el.editStart) el.editStart.addEventListener("click", editStartDay);

    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(el.form);
      const data = Object.fromEntries(fd.entries());
      if (!data.place || !data.forWhom) return;
      if (!Number(data.amount)) return;
      if (data.date && data.date < APP_START_DATE) {
        alert(`${APP_START_DATE} 이전 날짜로는 기록할 수 없습니다.`);
        return;
      }
      addEntry(data);
      el.form.reset();
      el.form.date.value = todayIsoLocal();
      syncCategoryCustom(el.form);
      pendingReceiptText = "";
      pendingReceiptItems = [];
      pendingReceiptImage = "";
      setReceiptStatus("");
      setReceiptProgress(null);
      if (el.receiptCamera) el.receiptCamera.value = "";
      if (el.receiptGallery) el.receiptGallery.value = "";
      el.form.place.focus();
    });

    // 쓰임의 결에서 기타 선택 시 직접 입력란 토글
    const addFormCat = el.form.querySelector('select[name="category"]');
    if (addFormCat) {
      addFormCat.addEventListener("change", () => syncCategoryCustom(el.form));
    }
    const editFormCat = el.editForm.querySelector('select[name="category"]');
    if (editFormCat) {
      editFormCat.addEventListener("change", () => syncCategoryCustom(el.editForm));
    }

    // 영수증 OCR — 촬영 / 앨범 둘 다
    const bindReceipt = (input, source) => {
      if (!input) return;
      input.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) {
          setReceiptStatus(`${source}: 선택된 파일이 없습니다.`);
          return;
        }
        setReceiptStatus(
          `${source} 수신: ${file.name || "(이름 없음)"} · ${Math.round(
            (file.size || 0) / 1024
          )}KB · ${file.type || "형식 미상"}`
        );
        handleReceiptFile(file);
      });
    };
    bindReceipt(el.receiptCamera, "촬영");
    bindReceipt(el.receiptGallery, "앨범");

    // 영수증 이미지 탭 → 라이트박스
    el.list.addEventListener("click", (e) => {
      const img = e.target.closest("img.receipt-img");
      if (img && img.src) {
        showImageLightbox(img.src);
        e.preventDefault();
        return;
      }
    });

    el.list.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const li = btn.closest("li.entry");
      if (!li) return;
      const id = li.getAttribute("data-id");
      const month = li.getAttribute("data-month");
      if (btn.dataset.action === "delete") deleteEntry(id);
      else if (btn.dataset.action === "edit") openEdit(id);
      else if (btn.dataset.action === "jump" && month) {
        currentMonth = month;
        searchQuery = "";
        if (el.searchInput) el.searchInput.value = "";
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });

    // 검색
    let searchTimer = null;
    el.searchInput.addEventListener("input", (e) => {
      const v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = v;
        render();
      }, 120);
    });
    el.searchClear.addEventListener("click", () => {
      el.searchInput.value = "";
      searchQuery = "";
      render();
      el.searchInput.focus();
    });

    // 필터 칩
    document.querySelectorAll(".filter-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.getAttribute("data-filter");
        if (
          v === "all" ||
          v === "bookmark" ||
          v === "waste" ||
          v === "challenge"
        ) {
          filterMode = v;
          render();
        }
      });
    });

    // 복원
    el.restoreBtn.addEventListener("click", openRestore);
    el.restoreList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-snap]");
      if (!btn) return;
      const i = Number(btn.getAttribute("data-snap"));
      restoreFromSnapshot(i);
    });
    el.restoreClose.addEventListener("click", () => {
      if (el.restoreDialog.open) el.restoreDialog.close();
    });

    // 개인 원칙
    if (el.principlesEdit)
      el.principlesEdit.addEventListener("click", openPrinciplesEditor);
    if (el.principlesForm)
      el.principlesForm.addEventListener("submit", (e) => {
        const submitter = e.submitter;
        if (!submitter || submitter.value !== "save") return;
        savePrinciplesFromForm();
      });

    // 이달의 보고서
    if (el.reportBtn) el.reportBtn.addEventListener("click", openReport);
    if (el.reportClose)
      el.reportClose.addEventListener("click", () => {
        if (el.reportDialog.open) el.reportDialog.close();
      });
    if (el.reportPrint)
      el.reportPrint.addEventListener("click", () => window.print());
    if (el.reportDownload)
      el.reportDownload.addEventListener("click", downloadReportMarkdown);
    if (el.reportCsv)
      el.reportCsv.addEventListener("click", downloadReportCSV);

    // 모드 전환
    if (el.modeWrite)
      el.modeWrite.addEventListener("click", () => setMode("write"));
    if (el.modeRead)
      el.modeRead.addEventListener("click", () => setMode("read"));
    if (el.reportCopy)
      el.reportCopy.addEventListener("click", copyReportToClipboard);

    el.editForm.addEventListener("submit", (e) => {
      const submitter = e.submitter;
      if (submitter && submitter.value === "save") {
        saveEdit();
      } else {
        editingId = null;
      }
    });

    // Autosave reflection
    let reflectionTimer = null;
    el.reflection.addEventListener("input", () => {
      store.reflections[currentMonth] = el.reflection.value;
      clearTimeout(reflectionTimer);
      reflectionTimer = setTimeout(() => {
        saveStore();
        el.reflectionSaved.classList.add("show");
        setTimeout(() => el.reflectionSaved.classList.remove("show"), 1200);
      }, 400);
    });

    el.exportBtn.addEventListener("click", exportJson);
    el.importInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importJson(file);
      el.importInput.value = "";
    });
    el.clearMonth.addEventListener("click", clearMonth);
    if (el.clearSnapshots)
      el.clearSnapshots.addEventListener("click", () => {
        const ok = confirm(
          "자동 백업 스냅샷을 모두 정리합니다. 현재 기록은 그대로이고, 과거 시점 복원만 불가능해집니다.\n계속하시겠습니까?"
        );
        if (ok) clearAllSnapshots();
      });
  }

  // --- Suggestions (autocomplete) ----------------------------------------
  function populateDatalist(id, field) {
    const dl = document.getElementById(id);
    if (!dl) return;
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const e of store.entries) {
      const v = (e && e[field] ? String(e[field]) : "").trim();
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    if (field === "category") {
      // category 직접 입력은 프리셋 외 값만
      for (const [v] of [...counts.entries()]) {
        if (PRESET_CATEGORIES.includes(v)) counts.delete(v);
      }
    }
    const sorted = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)
    );
    dl.innerHTML = sorted
      .map(([v]) => `<option value="${escapeHtml(v)}"></option>`)
      .join("");
  }

  function refreshSuggestions() {
    populateDatalist("place-suggestions", "place");
    populateDatalist("forwhom-suggestions", "forWhom");
    populateDatalist("purpose-suggestions", "purpose");
    populateDatalist("category-custom-suggestions", "category");
  }

  // 정규화: 공백·구두점 제거 + 소문자
  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[\s\.\-_·,!\?\(\)\[\]\/\\"'’`~]/g, "");
  }

  // 입력값과 정규화 일치하지만 표기가 다른 과거 값이 있는지 검사 → 힌트
  function similarityHint(input, value, field) {
    if (!input) return null;
    const n = normalize(value);
    if (!n) return null;
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const e of store.entries) {
      const v = (e && e[field] ? String(e[field]) : "").trim();
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    // 완전 일치하는 값이 이미 있으면 힌트 불필요
    if (counts.has(value.trim())) return null;
    const matches = [];
    for (const [v, c] of counts) {
      if (normalize(v) === n) matches.push({ v, c });
    }
    if (!matches.length) return null;
    matches.sort((a, b) => b.c - a.c);
    return matches[0].v; // 가장 자주 쓴 표기
  }

  function bindSimilarityHints() {
    const fields = [
      ["place", el.form, el.editForm],
      ["forWhom", el.form, el.editForm],
      ["purpose", el.form, el.editForm],
    ];
    for (const [field, ...forms] of fields) {
      for (const form of forms) {
        if (!form) continue;
        const input = form.querySelector(`input[name="${field}"]`);
        if (!input) continue;
        // 기존 hint 노드 재활용
        let hint = input.nextElementSibling;
        if (!hint || !hint.classList || !hint.classList.contains("similar-hint")) {
          hint = document.createElement("p");
          hint.className = "similar-hint";
          input.parentNode.insertBefore(hint, input.nextSibling);
        }
        const update = () => {
          const v = input.value.trim();
          const sim = similarityHint(v, v, field);
          if (sim && sim !== v) {
            hint.innerHTML = `과거에 같은 표현으로 "<button type="button" class="similar-pick">${escapeHtml(sim)}</button>" 가 있습니다.`;
            hint.style.display = "block";
            const pick = hint.querySelector(".similar-pick");
            if (pick)
              pick.addEventListener("click", () => {
                input.value = sim;
                hint.style.display = "none";
                input.focus();
              });
          } else {
            hint.style.display = "none";
            hint.innerHTML = "";
          }
        };
        input.addEventListener("input", update);
        input.addEventListener("blur", update);
      }
    }
  }

  function showImageLightbox(src) {
    const box = document.createElement("div");
    box.className = "lightbox";
    box.innerHTML = `<img src="${src}" alt="영수증" />`;
    box.addEventListener("click", () => box.remove());
    document.body.appendChild(box);
  }

  function checkMonthRoll() {
    const nowKey = monthKey(new Date());
    if (nowKey === lastRealMonth) {
      // 같은 달이어도 pace가 날마다 달라지니 재렌더
      renderSummary();
      return;
    }
    const prev = lastRealMonth;
    lastRealMonth = nowKey;
    // 사용자가 이전 실시간 달을 보고 있었고 이제 새 달로 넘어갔다면 자동 이동
    if (currentMonth === prev) currentMonth = nowKey;
    render();
  }

  function setMode(mode) {
    const m = mode === "read" ? "read" : "write";
    document.body.setAttribute("data-mode", m);
    try { localStorage.setItem("moneygrace:mode", m); } catch (_) {}
    if (el.modeWrite) el.modeWrite.setAttribute("aria-selected", String(m === "write"));
    if (el.modeRead) el.modeRead.setAttribute("aria-selected", String(m === "read"));
  }

  // --- Boot --------------------------------------------------------------
  function init() {
    hydrateEls();
    store = loadStore();
    // 구 버전에서 저장된 이미지 포함 스냅샷을 1회 정리
    prunePastSnapshots();
    const savedMode = (() => {
      try { return localStorage.getItem("moneygrace:mode") || "write"; } catch (_) { return "write"; }
    })();
    setMode(savedMode);
    if (el.form && el.form.date) el.form.date.value = todayIsoLocal();
    lastRealMonth = monthKey(new Date());
    rotateWhisper();
    setInterval(rotateWhisper, 18_000);
    bind();
    render();
    renderPrinciples();
    refreshSuggestions();
    bindSimilarityHints();
    if (loadSnapshots().length === 0) pushSnapshot("initial");

    // 월 경계 자동 재렌더
    setInterval(checkMonthRoll, 60_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkMonthRoll();
    });

    registerServiceWorker();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      navigator.serviceWorker
        .register("./sw.js")
        .then((reg) => {
          reg.addEventListener("updatefound", () => {
            const next = reg.installing;
            if (!next) return;
            next.addEventListener("statechange", () => {
              if (
                next.state === "installed" &&
                navigator.serviceWorker.controller
              ) {
                showUpdateBanner(reg);
              }
            });
          });
        })
        .catch(() => {});

      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    } catch (_) {}
  }

  function showUpdateBanner(reg) {
    if (document.getElementById("update-banner")) return;
    const banner = document.createElement("div");
    banner.id = "update-banner";
    banner.className = "update-banner";
    banner.innerHTML =
      '<span>새 버전이 준비되었습니다</span><button type="button">새로고침</button>';
    const btn = banner.querySelector("button");
    btn.addEventListener("click", () => {
      try {
        if (reg && reg.waiting) reg.waiting.postMessage("SKIP_WAITING");
        else window.location.reload();
      } catch (_) {
        window.location.reload();
      }
    });
    document.body.appendChild(banner);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
