(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const fmt = (value, digits = 2) => Number(value || 0).toLocaleString("da-DK", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const nowIso = () => new Date().toISOString();

  const state = {
    source: "CONNECTING",
    paused: false,
    fuseA: 16,
    buyPrice: 0,
    sellPrice: 0,
    spotPrice: 0,
    priceBreakdown: null,
    priceConfigSource: "",
    buyCostToday: 0,
    sellRevenueToday: 0,
    netCostToday: 0,
    pvPowerW: null,
    housePowerW: null,
    batterySoc: null,
    batteryPowerW: null,
    importTodayKwh: 0,
    exportTodayKwh: 0,
    powerW: 0,
    phases: [
      { name: "L1", powerW: 0, currentA: 0, voltageV: 230 },
      { name: "L2", powerW: 0, currentA: 0, voltageV: 230 },
      { name: "L3", powerW: 0, currentA: 0, voltageV: 230 }
    ],
    history: [],
    alerts: [],
    lastUpdate: null,
    tick: 0
  };

  const live = { failures: 0, connected: false, hasReceived: false };

  function initialize() {
    bindTabs();
    bindActions();
    updateClock();
    renderAll();
    setInterval(updateClock, 1000);
    setInterval(demoTick, 1000);
    connectLive();
  }

  function bindTabs() {
    document.querySelectorAll(".nav-tab").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".nav-tab").forEach((item) => item.classList.toggle("active", item === button));
        document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
        $("tab-" + button.dataset.tab).classList.add("active");
        if (button.dataset.tab === "history") renderHistory();
        if (button.dataset.tab === "overview") drawChart();
      });
    });
  }

  function bindActions() {
    $("fuseSelect").addEventListener("change", (event) => {
      state.fuseA = Number(event.target.value);
      renderAll();
      toast(`Fasegrænsen er sat til ${state.fuseA} A.`);
    });
    $("demoToggle").addEventListener("click", () => {
      if (state.source !== "DEMO") {
        state.history = [];
        seedHistory();
        state.source = "DEMO";
        state.paused = false;
        setDemoSourceUi();
        toast("Demodata kører igen. Importerede data er fortsat bevaret i den eksporterede fil.");
        return;
      }
      state.paused = !state.paused;
      $("demoToggle").textContent = state.paused ? "START DEMO IGEN" : "SÆT DEMO PÅ PAUSE";
      toast(state.paused ? "Demoen er sat på pause." : "Demoen kører igen.");
    });
    $("printBtn").addEventListener("click", () => {
      preparePrintReport();
      window.print();
    });
    $("exportCsvBtn").addEventListener("click", exportCsv);
    $("exportJsonBtn").addEventListener("click", exportJson);
    $("importBtn").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", importJson);
    $("clearAlertsBtn").addEventListener("click", () => {
      state.alerts = [];
      renderGuard();
      toast("Hændelsesloggen er ryddet.");
    });
    window.addEventListener("resize", drawChart);
  }

  function seedHistory() {
    const base = Date.now() - 59 * 1000;
    for (let i = 0; i < 60; i += 1) {
      const wave = 1300 + Math.sin(i / 5) * 650 + Math.sin(i / 2.4) * 190;
      const solarPulse = i > 36 && i < 46 ? -2100 * Math.sin(((i - 36) / 10) * Math.PI) : 0;
      const powerW = Math.round(wave + solarPulse);
      const portions = [0.51, 0.29, 0.20];
      state.history.push({
        timestamp: new Date(base + i * 1000).toISOString(),
        powerW,
        phases: portions.map((part, index) => ({
          currentA: (powerW * part) / (230 + index),
          powerW: powerW * part,
          voltageV: 230 + Math.sin(i / (4 + index)) * 1.1
        })),
        price: state.buyPrice
      });
    }
    const last = state.history[state.history.length - 1];
    state.powerW = last.powerW;
    state.phases = last.phases.map((p, index) => ({ name: `L${index + 1}`, ...p }));
  }

  function demoTick() {
    if (state.paused || state.source !== "DEMO") {
      renderDataAge();
      return;
    }
    state.tick += 1;
    const t = state.tick;
    let base = 1180 + Math.sin(t / 7) * 440 + Math.sin(t / 2.7) * 115;

    // Periodiske, synlige scenarier: eksport og en høj L1-belastning.
    if (t % 72 >= 26 && t % 72 <= 38) base -= 2800 * Math.sin(((t % 72 - 26) / 12) * Math.PI);
    const overload = t % 96 >= 66 && t % 96 <= 74;

    const phasePower = [
      overload ? 3560 + Math.sin(t) * 120 : base * .52 + Math.sin(t / 3) * 80,
      base * .30 + Math.cos(t / 4) * 60,
      base * .18 + Math.sin(t / 5) * 45
    ];
    if (base < 0) {
      phasePower[0] = base * .47;
      phasePower[1] = base * .34;
      phasePower[2] = base * .19;
    }

    state.phases = phasePower.map((powerW, index) => {
      const voltageV = 230 + Math.sin((t + index * 4) / 8) * 1.4;
      return { name: `L${index + 1}`, powerW: Math.round(powerW), currentA: powerW / voltageV, voltageV };
    });
    state.powerW = Math.round(state.phases.reduce((sum, p) => sum + p.powerW, 0));
    const kwhThisSecond = Math.abs(state.powerW) / 3600000;
    if (state.powerW >= 0) state.importTodayKwh += kwhThisSecond;
    else state.exportTodayKwh += kwhThisSecond;
    state.lastUpdate = Date.now();
    state.history.push({ timestamp: nowIso(), powerW: state.powerW, phases: state.phases.map((p) => ({ ...p })), price: state.buyPrice });
    if (state.history.length > 900) state.history.shift();
    detectAlerts();
    renderAll();
  }

  async function connectLive() {
    await pollLive();
    setInterval(pollLive, 2000);
  }

  async function pollLive() {
    try {
      const response = await fetch("api/live", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (!live.hasReceived) {
        state.history = [];
        live.hasReceived = true;
      }
      applyMeasurement(data);
      state.source = "LIVE · HOME ASSISTANT P1";
      state.paused = true;
      state.lastUpdate = new Date(data.timestamp || Date.now()).getTime();
      state.importTodayKwh = Number(data.importTodayKwh ?? state.importTodayKwh);
      state.exportTodayKwh = Number(data.exportTodayKwh ?? state.exportTodayKwh);
      if (data.buyPrice !== null && data.buyPrice !== undefined && Number.isFinite(Number(data.buyPrice))) state.buyPrice = Number(data.buyPrice);
      if (data.sellPrice !== null && data.sellPrice !== undefined && Number.isFinite(Number(data.sellPrice))) state.sellPrice = Number(data.sellPrice);
      if (data.spotPrice !== null && data.spotPrice !== undefined && Number.isFinite(Number(data.spotPrice))) state.spotPrice = Number(data.spotPrice);
      state.priceBreakdown = data.priceBreakdown || null;
      state.priceConfigSource = data.priceConfigSource || "";
      state.buyCostToday = Number(data.buyCostToday ?? state.buyCostToday);
      state.sellRevenueToday = Number(data.sellRevenueToday ?? state.sellRevenueToday);
      state.netCostToday = Number(data.netCostToday ?? (state.buyCostToday - state.sellRevenueToday));
      state.pvPowerW = data.pvPowerW == null ? null : Number(data.pvPowerW);
      state.housePowerW = data.housePowerW == null ? null : Number(data.housePowerW);
      state.batterySoc = data.batterySoc == null ? null : Number(data.batterySoc);
      state.batteryPowerW = data.batteryPowerW == null ? null : Number(data.batteryPowerW);
      state.history.push({ timestamp: data.timestamp || nowIso(), powerW: state.powerW, phases: state.phases.map((p) => ({ ...p })), price: state.buyPrice });
      if (state.history.length > 900) state.history.shift();
      live.failures = 0;
      live.connected = true;
      setLiveSourceUi(data.quality || "OK");
      detectAlerts();
      renderAll();
    } catch (error) {
      live.failures += 1;
      live.connected = false;
      if (live.failures === 1) toast(`Live P1 afventer: ${error.message}`);
      setOfflineSourceUi(error.message);
      renderDataAge();
    }
  }

  function detectAlerts() {
    const worst = [...state.phases].sort((a, b) => Math.abs(b.currentA) - Math.abs(a.currentA))[0];
    const pct = Math.abs(worst.currentA) / state.fuseA * 100;
    if (pct >= 100) addAlert("danger", `${worst.name} over grænsen`, `${fmt(Math.abs(worst.currentA), 1)} A svarer til ${fmt(pct, 0)} % af ${state.fuseA} A.`);
    else if (pct >= 90) addAlert("warning", `${worst.name} tæt på grænsen`, `${fmt(Math.abs(worst.currentA), 1)} A svarer til ${fmt(pct, 0)} % af ${state.fuseA} A.`);
  }

  function addAlert(level, title, text) {
    const latest = state.alerts[0];
    if (latest && latest.title === title && Date.now() - new Date(latest.timestamp).getTime() < 15000) return;
    state.alerts.unshift({ level, title, text, timestamp: nowIso() });
    state.alerts = state.alerts.slice(0, 30);
  }

  function renderAll() {
    renderOverview();
    renderPhases();
    renderEconomy();
    renderGuard();
    renderDataAge();
  }

  function renderOverview() {
    const isExport = state.powerW < 0;
    $("powerValue").textContent = fmt(Math.abs(state.powerW) / 1000, 2);
    $("flowLabel").textContent = isExport ? "EKSPORT" : "IMPORT";
    $("flowIcon").textContent = isExport ? "↑" : "↓";
    $("powerOrbit").classList.toggle("export", isExport);
    const costPerHour = isExport ? state.powerW / 1000 * state.sellPrice : state.powerW / 1000 * state.buyPrice;
    $("costHour").textContent = fmt(costPerHour, 2);
    $("priceNow").textContent = fmt(state.buyPrice, 2);
    $("importToday").textContent = fmt(state.importTodayKwh, 2);
    $("exportToday").textContent = fmt(state.exportTodayKwh, 2);
    $("netCostToday").textContent = fmt(netCost(), 2);
    $("fuseTop").textContent = state.fuseA;
    $("priceState").textContent = state.buyPrice < 1 ? "BILLIG" : state.buyPrice > 3 ? "DYR" : "NORMAL";
    $("priceState").className = `price-state ${state.buyPrice < 1 ? "low" : state.buyPrice > 3 ? "high" : ""}`;
    $("phaseListOverview").innerHTML = state.phases.map(phaseRowHtml).join("");
    renderRecommendation();
    drawChart();
  }

  function phaseRowHtml(phase) {
    const pct = Math.abs(phase.currentA) / state.fuseA * 100;
    const level = pct >= 100 ? "danger" : pct >= 85 ? "warning" : "";
    return `<div class="phase-row">
      <span class="phase-name">${phase.name}</span>
      <span class="phase-bar"><span class="${level}" style="width:${clamp(pct, 0, 100)}%"></span></span>
      <span class="phase-amp">${fmt(Math.abs(phase.currentA), 1)} A</span>
      <span class="phase-watt">${fmt(phase.powerW, 0)} W</span>
    </div>`;
  }

  function renderRecommendation() {
    const card = $("recommendCard");
    const worst = [...state.phases].sort((a, b) => Math.abs(b.currentA) - Math.abs(a.currentA))[0];
    const pct = Math.abs(worst.currentA) / state.fuseA * 100;
    card.className = "recommend-card glass-card";
    if (pct >= 100) {
      card.classList.add("danger");
      $("recommendTitle").textContent = `${worst.name} har overskredet ${state.fuseA} A`;
      $("recommendText").textContent = "Frakobl eller udsæt en større belastning på denne fase. Kontrollér fasefordelingen, hvis hændelsen gentager sig.";
      card.querySelector(".recommend-icon").textContent = "!";
    } else if (pct >= 85) {
      card.classList.add("warning");
      $("recommendTitle").textContent = `${worst.name} nærmer sig sikringsgrænsen`;
      $("recommendText").textContent = `Belastningen er ${fmt(pct, 0)} %. Undgå at starte endnu et større apparat på samme fase.`;
      card.querySelector(".recommend-icon").textContent = "!";
    } else if (state.powerW < -200) {
      $("recommendTitle").textContent = "Der eksporteres energi";
      $("recommendText").textContent = "Et senere NECC-modul kan foreslå VVB, batteri eller andre fleksible belastninger, før strømmen sælges billigt.";
      card.querySelector(".recommend-icon").textContent = "↗";
    } else {
      $("recommendTitle").textContent = "Driften er normal";
      $("recommendText").textContent = "Alle tre faser ligger inden for den indstillede belastningsgrænse.";
      card.querySelector(".recommend-icon").textContent = "✓";
    }
  }

  function renderPhases() {
    $("fuseSelect").value = String(state.fuseA);
    $("phaseDetailGrid").innerHTML = state.phases.map((phase, index) => {
      const pct = Math.abs(phase.currentA) / state.fuseA * 100;
      const color = pct >= 100 ? "var(--red)" : pct >= 85 ? "var(--orange)" : ["var(--cyan)", "var(--teal)", "var(--purple)"][index];
      return `<article class="phase-detail glass-card" style="--phase-color:${color}">
        <div class="phase-detail-head"><h3>${phase.name}</h3><span class="phase-percent">${fmt(pct, 0)} % af ${state.fuseA} A</span></div>
        <div class="phase-current">${fmt(Math.abs(phase.currentA), 1)} <small>A</small></div>
        <div class="phase-bar"><span class="${pct >= 100 ? "danger" : pct >= 85 ? "warning" : ""}" style="width:${clamp(pct, 0, 100)}%"></span></div>
        <div class="phase-detail-values">
          <div><span>AKTIV EFFEKT</span><b>${fmt(phase.powerW, 0)} W</b></div>
          <div><span>SPÆNDING</span><b>${fmt(phase.voltageV, 1)} V</b></div>
        </div>
      </article>`;
    }).join("");
    const currents = state.phases.map((p) => Math.abs(p.currentA));
    const diff = Math.max(...currents) - Math.min(...currents);
    const imbalancePct = Math.max(...currents) > 0 ? diff / Math.max(...currents) * 100 : 0;
    $("imbalanceTitle").textContent = `${fmt(diff, 1)} A forskel`;
    $("balanceFill").style.width = `${clamp(imbalancePct, 0, 100)}%`;
    $("imbalanceText").textContent = imbalancePct > 60 ? "Stor forskel mellem faserne. Faste belastninger bør undersøges med en elektriker." : "Faseforskellen overvåges løbende. Kortvarige udsving er normale.";
  }

  function netCost() {
    if (Number.isFinite(state.netCostToday)) return state.netCostToday;
    return state.importTodayKwh * state.buyPrice - state.exportTodayKwh * state.sellPrice;
  }

  function renderEconomy() {
    const buy = Number.isFinite(state.buyCostToday) ? state.buyCostToday : state.importTodayKwh * state.buyPrice;
    const sell = Number.isFinite(state.sellRevenueToday) ? state.sellRevenueToday : state.exportTodayKwh * state.sellPrice;
    $("economyNet").textContent = fmt(buy - sell, 2);
    $("ledgerImport").textContent = `${fmt(state.importTodayKwh, 2)} kWh`;
    $("ledgerBuy").textContent = `${fmt(buy, 2)} kr.`;
    $("ledgerExport").textContent = `${fmt(state.exportTodayKwh, 2)} kWh`;
    $("ledgerSell").textContent = `${fmt(sell, 2)} kr.`;
    $("ledgerNet").textContent = `${fmt(buy - sell, 2)} kr.`;
    const p = state.priceBreakdown || {};
    $("pbSpot").textContent = `${fmt(p.spotExVat ?? state.spotPrice, 3)} kr.`;
    $("pbVat").textContent = `${fmt(p.vatTotal ?? p.spotVat, 3)} kr.`;
    $("pbSupplier").textContent = `${fmt(p.supplierMarkup, 3)} kr.`;
    $("pbTax").textContent = `${fmt(p.electricityTax, 3)} kr.`;
    $("pbN1").textContent = `${fmt(p.n1Tariff, 3)} kr.`;
    $("pbN1Period").textContent = p.n1Period ? `· ${String(p.n1Period).toUpperCase()}` : "";
    $("pbSystem").textContent = `${fmt(p.energinetSystem, 3)} kr.`;
    $("pbGrid").textContent = `${fmt(p.energinetGrid, 3)} kr.`;
    $("pbTotal").textContent = `${fmt(p.buyTotal ?? state.buyPrice, 3)} kr./kWh`;
    $("pbSell").textContent = `${fmt(p.sellPrice ?? state.sellPrice, 3)} kr./kWh`;
    $("priceSourceNote").textContent = state.priceConfigSource ? `NECC Price Engine · ${state.priceConfigSource}` : "NECC Price Engine · automatisk";
    $("pvPowerNow").textContent = state.pvPowerW == null ? "– W" : `${fmt(state.pvPowerW, 0)} W`;
    $("housePowerNow").textContent = state.housePowerW == null ? "– W" : `${fmt(state.housePowerW, 0)} W`;
    $("batterySocNow").textContent = state.batterySoc == null ? "– %" : `${fmt(state.batterySoc, 1)} %`;
    $("batteryPowerNow").textContent = state.batteryPowerW == null ? "– W" : `${fmt(state.batteryPowerW, 0)} W`;
  }

  function renderHistory() {
    const rows = [...state.history].reverse().slice(0, 250);
    $("historyCount").textContent = `${state.history.length} målinger`;
    $("historyBody").innerHTML = rows.map((row) => {
      const phases = normalizedPhases(row);
      const exportMode = Number(row.powerW) < 0;
      return `<tr>
        <td>${new Date(row.timestamp).toLocaleTimeString("da-DK")}</td>
        <td class="status-${exportMode ? "export" : "import"}">${exportMode ? "EKSPORT" : "IMPORT"}</td>
        <td>${fmt(row.powerW, 0)}</td>
        <td>${fmt(Math.abs(phases[0].currentA), 1)}</td>
        <td>${fmt(Math.abs(phases[1].currentA), 1)}</td>
        <td>${fmt(Math.abs(phases[2].currentA), 1)}</td>
        <td>${fmt(row.price ?? state.buyPrice, 2)}</td>
      </tr>`;
    }).join("");
  }

  function renderGuard() {
    const worst = [...state.phases].sort((a, b) => Math.abs(b.currentA) - Math.abs(a.currentA))[0];
    const pct = Math.abs(worst.currentA) / state.fuseA * 100;
    const ring = $("guardRing");
    ring.className = "guard-ring";
    if (pct >= 100) {
      ring.classList.add("danger");
      $("guardStatusIcon").textContent = "!";
      $("guardStatusTitle").textContent = "Kritisk fasebelastning";
      $("guardStatusText").textContent = `${worst.name} ligger over den valgte ${state.fuseA} A grænse.`;
    } else if (pct >= 85) {
      ring.classList.add("warning");
      $("guardStatusIcon").textContent = "!";
      $("guardStatusTitle").textContent = "Hold øje med belastningen";
      $("guardStatusText").textContent = `${worst.name} ligger på ${fmt(pct, 0)} % af grænsen.`;
    } else {
      $("guardStatusIcon").textContent = "✓";
      $("guardStatusTitle").textContent = "Alt normalt";
      $("guardStatusText").textContent = "Ingen aktive faseadvarsler.";
    }
    $("alertBadge").textContent = String(state.alerts.length);
    $("alertBadge").dataset.count = String(state.alerts.length);
    $("alertsList").innerHTML = state.alerts.length ? state.alerts.map((alert) => `<div class="alert-item ${alert.level}">
      <span class="alert-level"></span><div><b>${escapeHtml(alert.title)}</b><p>${escapeHtml(alert.text)}</p></div>
      <time>${new Date(alert.timestamp).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
    </div>`).join("") : '<div class="empty-state">Ingen hændelser registreret endnu.</div>';
  }

  function renderDataAge() {
    if (!state.lastUpdate) {
      $("dataAge").textContent = "afventer";
      return;
    }
    const age = Math.max(0, Math.floor((Date.now() - state.lastUpdate) / 1000));
    $("dataAge").textContent = `${age} sek.`;
  }

  function updateClock() {
    const now = new Date();
    $("clock").textContent = now.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("dateLabel").textContent = now.toLocaleDateString("da-DK", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  }

  function drawChart() {
    const canvas = $("powerChart");
    if (!canvas || !canvas.getContext) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;
    const values = state.history.slice(-60).map((item) => Number(item.powerW) || 0);
    const max = Math.max(1000, ...values.map(Math.abs)) * 1.1;
    const zeroY = height / 2;
    $("chartRange").textContent = `± ${fmt(max / 1000, 1)} kW`;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(92,150,145,.18)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(width, zeroY); ctx.stroke();
    if (values.length < 2) return;
    const points = values.map((value, index) => ({ x: index / (values.length - 1) * width, y: zeroY - value / max * (height * .42) }));
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "#35e9f2"); gradient.addColorStop(1, "#37f1bd");
    ctx.strokeStyle = gradient; ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.beginPath(); points.forEach((p, index) => index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    const fill = ctx.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, "rgba(53,233,242,.18)"); fill.addColorStop(1, "rgba(55,241,189,0)");
    ctx.lineTo(width, zeroY); ctx.lineTo(0, zeroY); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }

  function exportCsv() {
    const header = ["tidspunkt", "status", "net_w", "l1_w", "l1_a", "l1_v", "l2_w", "l2_a", "l2_v", "l3_w", "l3_a", "l3_v", "koebspris_kr_kwh"];
    const lines = state.history.map((row) => {
      const phases = normalizedPhases(row);
      return [row.timestamp, row.powerW < 0 ? "EKSPORT" : "IMPORT", row.powerW,
        phases[0].powerW, phases[0].currentA, phases[0].voltageV,
        phases[1].powerW, phases[1].currentA, phases[1].voltageV,
        phases[2].powerW, phases[2].currentA, phases[2].voltageV, row.price ?? state.buyPrice
      ].map(csvValue).join(";");
    });
    const blob = new Blob(["\ufeff" + [header.join(";"), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    saveBlob(blob, fileName("NECC_P1_VAGT", "csv"), [{ description: "CSV-fil", accept: { "text/csv": [".csv"] } }]);
  }

  function exportJson() {
    const payload = {
      format: "necc-p1-vagt-0.1",
      exportedAt: nowIso(),
      source: state.source,
      settings: { fuseA: state.fuseA, buyPrice: state.buyPrice, sellPrice: state.sellPrice, priceConfigSource: state.priceConfigSource },
      totals: { importTodayKwh: state.importTodayKwh, exportTodayKwh: state.exportTodayKwh, buyCostToday: state.buyCostToday, sellRevenueToday: state.sellRevenueToday, netCostToday: state.netCostToday },
      liveEnergy: { pvPowerW: state.pvPowerW, housePowerW: state.housePowerW, batterySoc: state.batterySoc, batteryPowerW: state.batteryPowerW },
      priceBreakdown: state.priceBreakdown,
      current: { powerW: state.powerW, phases: state.phases, timestamp: new Date(state.lastUpdate).toISOString() },
      alerts: state.alerts,
      history: state.history
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    saveBlob(blob, fileName("NECC_P1_VAGT_BACKUP", "json"), [{ description: "JSON-fil", accept: { "application/json": [".json"] } }]);
  }

  async function saveBlob(blob, suggestedName, types) {
    try {
      if (window.showSaveFilePicker && window.isSecureContext) {
        const handle = await window.showSaveFilePicker({ suggestedName, types });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast("Filen er gemt. Du kan vælge pc, USB eller netværksdrev i Gem som-vinduet.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = suggestedName; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Filen er sendt til computerens mappe for overførsler.");
    } catch (error) {
      if (error && error.name !== "AbortError") toast("Filen kunne ikke gemmes: " + error.message);
    }
  }

  async function importJson(event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format && Array.isArray(data.history)) {
        state.source = data.source === "DEMO" ? "IMPORTERET BACKUP" : (data.source || "IMPORTERET BACKUP");
        state.fuseA = Number(data.settings?.fuseA || state.fuseA);
        state.buyPrice = Number(data.settings?.buyPrice ?? state.buyPrice);
        state.sellPrice = Number(data.settings?.sellPrice ?? state.sellPrice);
        state.priceConfigSource = data.settings?.priceConfigSource || state.priceConfigSource;
        state.importTodayKwh = Number(data.totals?.importTodayKwh ?? state.importTodayKwh);
        state.exportTodayKwh = Number(data.totals?.exportTodayKwh ?? state.exportTodayKwh);
        state.buyCostToday = Number(data.totals?.buyCostToday ?? state.buyCostToday);
        state.sellRevenueToday = Number(data.totals?.sellRevenueToday ?? state.sellRevenueToday);
        state.netCostToday = Number(data.totals?.netCostToday ?? state.netCostToday);
        state.priceBreakdown = data.priceBreakdown || state.priceBreakdown;
        state.pvPowerW = data.liveEnergy?.pvPowerW ?? state.pvPowerW;
        state.housePowerW = data.liveEnergy?.housePowerW ?? state.housePowerW;
        state.batterySoc = data.liveEnergy?.batterySoc ?? state.batterySoc;
        state.batteryPowerW = data.liveEnergy?.batteryPowerW ?? state.batteryPowerW;
        state.history = data.history.map(normalizeHistoryRow).filter(Boolean);
        state.alerts = Array.isArray(data.alerts) ? data.alerts : [];
        const current = data.current || state.history[state.history.length - 1];
        applyMeasurement(current);
      } else {
        // Accepterer også et enkelt HomeWizard-lignende measurement-objekt.
        applyMeasurement(data);
        state.history.push({ timestamp: nowIso(), powerW: state.powerW, phases: state.phases.map((p) => ({ ...p })), price: state.buyPrice });
        state.source = "IMPORTERET P1 JSON";
      }
      state.paused = true;
      state.lastUpdate = Date.now();
      setSourceUi();
      renderAll();
      renderHistory();
      toast(`Data fra ${file.name} er indlæst.`);
    } catch (error) {
      toast("JSON-filen kunne ikke læses: " + error.message);
    }
  }

  function applyMeasurement(input) {
    if (!input) throw new Error("Filen indeholder ingen måling.");
    const source = input.current || input;
    const phases = Array.isArray(source.phases) ? source.phases : [1, 2, 3].map((n) => ({
      name: `L${n}`,
      powerW: Number(source[`power_l${n}_w`] ?? 0),
      currentA: Number(source[`current_l${n}_a`] ?? 0),
      voltageV: Number(source[`voltage_l${n}_v`] ?? 230)
    }));
    state.powerW = Number(source.powerW ?? source.power_w ?? phases.reduce((sum, p) => sum + Number(p.powerW || 0), 0));
    state.phases = phases.slice(0, 3).map((p, i) => ({
      name: p.name || `L${i + 1}`,
      powerW: Number(p.powerW ?? p.power_w ?? 0),
      currentA: Number(p.currentA ?? p.current_a ?? 0),
      voltageV: Number(p.voltageV ?? p.voltage_v ?? 230)
    }));
    while (state.phases.length < 3) state.phases.push({ name: `L${state.phases.length + 1}`, powerW: 0, currentA: 0, voltageV: 230 });
  }

  function normalizeHistoryRow(row) {
    if (!row) return null;
    try {
      const phases = normalizedPhases(row);
      return { timestamp: row.timestamp || nowIso(), powerW: Number(row.powerW ?? row.power_w ?? 0), phases, price: Number(row.price ?? state.buyPrice) };
    } catch { return null; }
  }

  function normalizedPhases(row) {
    if (Array.isArray(row.phases)) return [0,1,2].map((index) => ({
      powerW: Number(row.phases[index]?.powerW ?? row.phases[index]?.power_w ?? 0),
      currentA: Number(row.phases[index]?.currentA ?? row.phases[index]?.current_a ?? 0),
      voltageV: Number(row.phases[index]?.voltageV ?? row.phases[index]?.voltage_v ?? 230)
    }));
    return [1,2,3].map((n) => ({ powerW: Number(row[`power_l${n}_w`] ?? 0), currentA: Number(row[`current_l${n}_a`] ?? 0), voltageV: Number(row[`voltage_l${n}_v`] ?? 230) }));
  }

  function setSourceUi() {
    $("connectionPill").className = "connection-pill imported";
    $("connectionLabel").textContent = state.source;
    $("footerSource").textContent = `Datakilde: ${state.source}`;
    $("demoToggle").textContent = "START DEMO IGEN";
  }

  function setDemoSourceUi() {
    $("connectionPill").className = "connection-pill demo";
    $("connectionLabel").textContent = "DEMO · SIMULEREDE DATA";
    $("footerSource").textContent = "Datakilde: DEMO";
    $("demoToggle").textContent = "SÆT DEMO PÅ PAUSE";
  }

  function setLiveSourceUi(quality) {
    $("connectionPill").className = "connection-pill imported";
    $("connectionLabel").textContent = quality === "PARTIAL" ? "LIVE · P1 (DELVIS)" : "LIVE · P1 FORBUNDET";
    $("footerSource").textContent = "Datakilde: Home Assistant · P1";
    $("demoToggle").textContent = "SKIFT TIL DEMO";
  }

  function setOfflineSourceUi(message) {
    $("connectionPill").className = "connection-pill demo";
    $("connectionLabel").textContent = "LIVE · AFVENTER P1";
    $("footerSource").textContent = `P1 afbrudt: ${String(message || "ukendt fejl").slice(0, 80)}`;
    $("demoToggle").textContent = "START DEMO";
  }

  function preparePrintReport() {
    const flow = state.powerW < 0 ? "EKSPORT" : "IMPORT";
    $("printTimestamp").textContent = new Date().toLocaleString("da-DK");
    $("printFlow").textContent = flow;
    $("printPower").textContent = `${fmt(Math.abs(state.powerW) / 1000, 2)} kW`;
    $("printCost").textContent = `${fmt(netCost(), 2)} kr.`;
    $("printPhaseBody").innerHTML = state.phases.map((p) => `<tr><td>${p.name}</td><td>${fmt(p.powerW, 0)} W</td><td>${fmt(Math.abs(p.currentA), 1)} A</td><td>${fmt(p.voltageV, 1)} V</td><td>${fmt(Math.abs(p.currentA) / state.fuseA * 100, 0)} %</td></tr>`).join("");
    $("printLedger").innerHTML = `<tr><td>Købt energi</td><td>${fmt(state.importTodayKwh, 2)} kWh</td></tr>
      <tr><td>Omkostning</td><td>${fmt(state.buyCostToday, 2)} kr.</td></tr>
      <tr><td>Solgt energi</td><td>${fmt(state.exportTodayKwh, 2)} kWh</td></tr>
      <tr><td>Indtægt</td><td>${fmt(state.sellRevenueToday, 2)} kr.</td></tr>
      <tr><td><b>Netto</b></td><td><b>${fmt(netCost(), 2)} kr.</b></td></tr>`;
    $("printRecommendation").textContent = `${$("recommendTitle").textContent}: ${$("recommendText").textContent}`;
  }

  function fileName(prefix, extension) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    return `${prefix}_${stamp}.${extension}`;
  }

  function csvValue(value) {
    const string = String(value ?? "").replace(/"/g, '""');
    return /[;"\r\n]/.test(string) ? `"${string}"` : string;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
  }

  let toastTimer;
  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 3600);
  }

  initialize();
})();
