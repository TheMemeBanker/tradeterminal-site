/* Trade Terminal — live data layer + command line + paper book.
   Feeds (all CORS-open, keyless):
     CoinGecko   crypto + xStocks: price, 1h/24h/7d, volume, mcap, 7d sparkline, intraday/30d charts
     DexScreener desk tokens by mint (Solana): price, 5m/1h/6h/24h, volume, liquidity
     Frankfurter ECB reference fix: FX majors, 30-day history
   The book is paper: fills are simulated at the live mark, persisted in localStorage. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CG = "https://api.coingecko.com/api/v3";
  const DS = "https://api.dexscreener.com/tokens/v1/solana/";
  const FXAPI = "https://api.frankfurter.dev/v1";

  /* ── instrument universe ───────────────────────────── */
  const CRYPTO = [
    ["bitcoin", "BTC", "Bitcoin", "btc"], ["ethereum", "ETH", "Ethereum", "eth"], ["solana", "SOL", "Solana", "sol"],
    ["ripple", "XRP", "XRP"], ["binancecoin", "BNB", "BNB"], ["dogecoin", "DOGE", "Dogecoin"],
    ["hyperliquid", "HYPE", "Hyperliquid"], ["chainlink", "LINK", "Chainlink"], ["avalanche-2", "AVAX", "Avalanche"],
    ["sui", "SUI", "Sui"], ["cardano", "ADA", "Cardano"], ["litecoin", "LTC", "Litecoin"],
  ];
  const XSTOCK = [
    ["tesla-xstock", "TSLAx", "Tesla"], ["nvidia-xstock", "NVDAx", "NVIDIA"], ["apple-xstock", "AAPLx", "Apple"],
    ["sp500-xstock", "SPYx", "S&P 500"], ["nasdaq-xstock", "QQQx", "Nasdaq 100"], ["alphabet-xstock", "GOOGLx", "Alphabet"],
    ["amazon-xstock", "AMZNx", "Amazon"], ["microsoft-xstock", "MSFTx", "Microsoft"], ["meta-xstock", "METAx", "Meta"],
    ["coinbase-xstock", "COINx", "Coinbase"], ["robinhood-xstock", "HOODx", "Robinhood"], ["microstrategy-xstock", "MSTRx", "Strategy"],
    ["gold-xstock", "GLDx", "Gold"], ["circle-xstock", "CRCLx", "Circle"], ["amd-xstock", "AMDx", "AMD"],
  ];
  const DESK = [
    ["MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump", "OTC", "OTC Desks", "https://otcdesks.cash/"],
    ["4XnsZoB8BNbNoKR1d6bG1rxGDM5WUYrarSZfv8t4pump", "BOND", "Bond Desks", "https://bonddesks.cash/"],
    ["J54xPeJjzG3Ni52W9zLRrmFtmR93oXiRfKhgoFUSpump", "FOREX", "FX Desks", "https://fxdesks.cash/"],
    ["Fa4AMVRFa5hCU9UtvHu8NkxEtxuuLFY6Z442DJVCpump", "TRD", "Trade Terminal", "https://pump.fun/coin/Fa4AMVRFa5hCU9UtvHu8NkxEtxuuLFY6Z442DJVCpump"],
  ];
  const FXP = [["EUR", true, "Euro"], ["GBP", true, "British Pound"], ["JPY", false, "Japanese Yen"], ["CHF", false, "Swiss Franc"], ["AUD", true, "Australian Dollar"], ["CAD", false, "Canadian Dollar"]];

  const state = {
    inst: new Map(),       // sym -> instrument
    order: [],             // display order of syms
    filter: "all", q: "", sort: "move", page: 0, PAGE: 10,
    sel: null, tf: 1, side: "buy",
    watch: new Set(), chartCache: new Map(), lastTick: 0, feedsUp: 0, feedsTotal: 3,
  };
  try { state.watch = new Set(JSON.parse(localStorage.getItem("tt-watch") || "[]")); } catch (e) {}

  /* ── formatting (magnitude-aware) ──────────────────── */
  const fmtPx = (v) => {
    if (v == null || !isFinite(v)) return "—";
    if (v >= 10000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (v >= 1000) return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 100) return v.toFixed(2);
    if (v >= 1) return v.toFixed(3);
    if (v >= 0.01) return v.toFixed(4);
    return v.toPrecision(4).replace(/\.?0+$/, "");
  };
  const fmtUSD = (v) => (v == null || !isFinite(v)) ? "—" : "$" + fmtPx(v);
  const fmtMoney = (v) => (v == null || !isFinite(v)) ? "—" : "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (v) => `${v >= 0 ? "+" : "−"}${fmtMoney(v)}`;
  const fmtBig = (v) => {
    if (v == null || !isFinite(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + v.toFixed(0);
  };
  const fmtDelta = (d) => (d == null || !isFinite(d)) ? "—" : `${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(2)}%`;
  const deltaCls = (d) => (d == null || !isFinite(d)) ? "fl" : d >= 0 ? "up" : "dn";
  const fmtQty = (q) => q.toLocaleString(undefined, { maximumFractionDigits: 6 });
  const pad = (n) => String(n).padStart(2, "0");
  const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };

  /* ── sparkline svg ─────────────────────────────────── */
  function spark(points, w, h, big) {
    if (!points || points.length < 2) return "";
    const min = Math.min(...points), max = Math.max(...points), span = (max - min) || 1;
    const up = points[points.length - 1] >= points[0];
    const col = up ? "var(--phos)" : "var(--alert)";
    const xs = points.map((p, i) => [i / (points.length - 1) * w, h - 3 - (p - min) / span * (h - 6)]);
    const line = xs.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
    const gid = "g" + (spark._n = (spark._n || 0) + 1);
    return `<svg class="tt-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <path d="${line}L${w} ${h}L0 ${h}Z" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="${col}" stroke-width="${big ? 1.8 : 1.4}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  const badge = (it, sm) => `<span class="tt-badge${sm ? " sm" : ""}" data-hue="${it.hue}" aria-hidden="true">${it.glyph}</span>`;

  /* ── instrument registry ───────────────────────────── */
  function reg(it) {
    const prev = state.inst.get(it.sym);
    if (prev) Object.assign(prev, it); else { state.inst.set(it.sym, it); state.order.push(it.sym); }
  }
  function seedUniverse() {
    for (const [id, sym, name, hue] of CRYPTO) reg({ sym, name, id, group: "crypto", hue: hue || "crypto", glyph: sym.slice(0, 2), price: null });
    for (const [id, sym, name] of XSTOCK) reg({ sym, name, id, group: "xstock", hue: "xstock", glyph: sym.slice(0, 2), price: null });
    for (const [mint, sym, name, url] of DESK) reg({ sym, name, mint, url, group: "desk", hue: "desk", glyph: sym.slice(0, 2), price: null });
    for (const [ccy, inv, name] of FXP) {
      const sym = inv ? `${ccy}/USD` : `USD/${ccy}`;
      reg({ sym, name: inv ? `${name} / US Dollar` : `US Dollar / ${name}`, ccy, inv, group: "fx", hue: "fx", glyph: ccy.slice(0, 2), price: null, cg: false });
    }
  }
  const find = (q) => {
    if (!q) return null;
    const u = q.toUpperCase().replace(/^\$/, "");
    if (state.inst.has(u)) return state.inst.get(u);
    for (const it of state.inst.values()) if (it.sym.toUpperCase() === u) return it;
    for (const it of state.inst.values()) if (it.sym.toUpperCase() === u + "X" || it.sym.toUpperCase().replace("/", "") === u) return it;
    for (const it of state.inst.values()) if (it.sym.toUpperCase().startsWith(u) || it.name.toUpperCase().startsWith(u)) return it;
    return null;
  };

  /* ── feeds ─────────────────────────────────────────── */
  async function loadCG() {
    const ids = [...CRYPTO, ...XSTOCK].map((x) => x[0]).join(",");
    const r = await fetch(`${CG}/coins/markets?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=1h,24h,7d&per_page=100`);
    if (!r.ok) throw new Error("cg " + r.status);
    const rows = await r.json();
    for (const row of rows) {
      const it = [...state.inst.values()].find((x) => x.id === row.id);
      if (!it) continue;
      const sp = (row.sparkline_in_7d && row.sparkline_in_7d.price) || [];
      Object.assign(it, {
        price: row.current_price, d1h: row.price_change_percentage_1h_in_currency, d24: row.price_change_percentage_24h_in_currency,
        d7: row.price_change_percentage_7d_in_currency, vol: row.total_volume, mcap: row.market_cap, hi24: row.high_24h, lo24: row.low_24h,
        pts: sp.length > 40 ? sp.filter((_, i) => i % 4 === 0) : sp, image: row.image,
      });
    }
    state.cgAt = Date.now();
  }
  async function loadDS() {
    const r = await fetch(DS + DESK.map((d) => d[0]).join(","));
    if (!r.ok) throw new Error("ds " + r.status);
    const pairs = await r.json();
    const best = new Map();
    for (const p of pairs) {
      const mint = p.baseToken && p.baseToken.address;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      if (!best.has(mint) || liq > best.get(mint)._liq) { p._liq = liq; best.set(mint, p); }
    }
    for (const [mint] of DESK) {
      const it = [...state.inst.values()].find((x) => x.mint === mint);
      const p = best.get(mint);
      if (!p) { Object.assign(it, { price: null, nomarket: true }); continue; }
      const pc = p.priceChange || {}, v = p.volume || {};
      Object.assign(it, {
        price: parseFloat(p.priceUsd), d5m: pc.m5, d1h: pc.h1, d6h: pc.h6, d24: pc.h24, d7: null, vol: v.h24, liq: p._liq,
        mcap: p.marketCap || p.fdv, dex: p.dexId, pairUrl: p.url, nomarket: false, pts: null,
      });
    }
    state.dsAt = Date.now();
  }
  async function loadFX() {
    const end = new Date(), start = new Date(end.getTime() - 32 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    const r = await fetch(`${FXAPI}/${iso(start)}..${iso(end)}?base=USD&symbols=${FXP.map((f) => f[0]).join(",")}`);
    if (!r.ok) throw new Error("fx " + r.status);
    const h = await r.json();
    const dates = Object.keys(h.rates).sort();
    for (const [ccy, inv] of FXP) {
      const it = [...state.inst.values()].find((x) => x.ccy === ccy);
      let pts = dates.map((d) => h.rates[d][ccy]).filter((v) => v != null);
      if (inv) pts = pts.map((v) => 1 / v);
      const last = pts[pts.length - 1], prev = pts[pts.length - 2], wk = pts[Math.max(0, pts.length - 6)];
      Object.assign(it, { price: last, d24: prev ? (last / prev - 1) * 100 : null, d7: wk ? (last / wk - 1) * 100 : null, d1h: null, vol: null, pts, hist: pts, histDates: dates, fixDate: h.end_date || dates[dates.length - 1] });
    }
    state.fxAt = Date.now();
  }

  /* ── rail / cards / chips / table ──────────────────── */
  const tick = (it) => `<span class="tt-tick">${badge(it, true)}<b>${it.sym}</b><span class="v">${it.group === "fx" ? fmtPx(it.price) : fmtUSD(it.price)}</span><span class="${deltaCls(it.d24)}">${fmtDelta(it.d24)}</span></span>`;
  function renderRail() {
    const items = state.order.map((s) => state.inst.get(s)).filter((it) => it.price != null).filter((it) => it.group !== "desk" || it.vol > 1000).slice(0, 22);
    if (!items.length) return;
    const html = items.map(tick).join('<span class="tt-tick" aria-hidden="true">·</span>');
    $("railTrack").innerHTML = html + '<span class="tt-tick" aria-hidden="true">·</span>' + html;
  }
  function renderCards() {
    const live = [...state.inst.values()].filter((it) => it.price != null && it.pts && it.pts.length > 2 && it.group !== "fx");
    const bench = state.inst.get("BTC");
    const mover = [...live].filter((it) => it.d24 != null).sort((a, b) => Math.abs(b.d24) - Math.abs(a.d24))[0];
    const active = [...live].filter((it) => it.vol).sort((a, b) => b.vol - a.vol).filter((it) => it.sym !== "BTC")[0];
    const defs = [["Benchmark", bench], ["Biggest mover (24h)", mover], ["Most traded (24h)", active]];
    $("cards").innerHTML = defs.map(([label, it]) => it && it.pts ? `
      <div class="tt-card-wrap"><div class="tt-card-label">${label}</div>
        <div class="tt-card" data-sym="${it.sym}" role="button" tabindex="0">
          <div style="height:80px;width:100%">${spark(it.pts, 300, 80, true)}</div>
          <div class="tt-card-foot">
            <span class="tt-card-name">${badge(it)}<span class="nm">${it.sym}</span></span>
            <span class="tt-card-delta ${deltaCls(it.d24)}" style="color:${it.d24 >= 0 ? "var(--phos)" : "var(--alert)"}">${fmtDelta(it.d24)}</span>
          </div></div></div>` : "").join("");
    $("cards").querySelectorAll(".tt-card").forEach((c) => c.addEventListener("click", () => select(c.dataset.sym)));
  }
  const CHIPS = [["all", "All"], ["crypto", "Crypto"], ["xstock", "xStocks"], ["desk", "Desk tokens"], ["fx", "FX"], ["watch", "Watching"]];
  function renderChips() {
    const count = (k) => k === "all" ? state.inst.size : k === "watch" ? state.watch.size : [...state.inst.values()].filter((it) => it.group === k).length;
    $("chips").innerHTML = CHIPS.map(([k, l]) => `<button type="button" class="tt-chip${state.filter === k ? " on" : ""}" data-f="${k}">${l}<span class="n">${count(k)}</span></button>`).join("");
    $("chips").querySelectorAll(".tt-chip").forEach((b) => b.addEventListener("click", () => { state.filter = b.dataset.f; state.page = 0; renderChips(); renderTable(); }));
  }
  function visible() {
    let v = state.order.map((s) => state.inst.get(s));
    if (state.filter === "watch") v = v.filter((it) => state.watch.has(it.sym));
    else if (state.filter !== "all") v = v.filter((it) => it.group === state.filter);
    if (state.q) v = v.filter((it) => `${it.sym} ${it.name}`.toLowerCase().includes(state.q));
    const s = state.sort, m = (it) => Math.abs(it.d24 == null ? -1 : it.d24);
    v = [...v].sort((a, b) => s === "name" ? a.sym.localeCompare(b.sym) : s === "price" ? (b.price || 0) - (a.price || 0) : s === "vol" ? (b.vol || 0) - (a.vol || 0) : m(b) - m(a));
    return v;
  }
  function renderTable() {
    const v = visible();
    const maxPage = Math.max(0, Math.ceil(v.length / state.PAGE) - 1);
    state.page = Math.min(state.page, maxPage);
    const slice = v.slice(state.page * state.PAGE, (state.page + 1) * state.PAGE);
    $("tbody").innerHTML = slice.map((it) => `
      <div class="tt-row${state.sel === it.sym ? " sel" : ""}" data-sym="${it.sym}" role="button" tabindex="0">
        <span class="tt-name">${badge(it)}<span style="min-width:0"><span class="nm">${it.sym}${state.watch.has(it.sym) ? '<span class="w" title="Watching">◆</span>' : ""}</span> <span class="tk">${it.nomarket ? "no market yet" : it.name}</span></span></span>
        <span class="tt-r tt-px">${it.group === "fx" ? fmtPx(it.price) : fmtUSD(it.price)}</span>
        <span class="tt-r tt-delta tt-hidemob ${deltaCls(it.d1h)}">${fmtDelta(it.d1h)}</span>
        <span class="tt-r tt-delta ${deltaCls(it.d24)}">${fmtDelta(it.d24)}</span>
        <span class="tt-r tt-delta tt-hidemob ${deltaCls(it.d7)}">${fmtDelta(it.d7)}</span>
        <span class="tt-r tt-vol tt-hidemob">${it.vol != null ? fmtBig(it.vol) : "—"}</span>
        <span class="tt-r tt-hidemob">${it.pts ? spark(it.pts, 120, 30) : ""}</span>
      </div>`).join("") || `<div class="tt-row" style="cursor:default"><span class="text-[11.5px] text-muted">No instruments match.</span></div>`;
    const from = v.length ? state.page * state.PAGE + 1 : 0;
    $("pageLabel").textContent = `${from}–${Math.min(v.length, (state.page + 1) * state.PAGE)} of ${v.length}`;
    $("pgPrev").disabled = state.page === 0; $("pgNext").disabled = state.page >= maxPage;
    $("tbody").querySelectorAll(".tt-row[data-sym]").forEach((r) => {
      r.addEventListener("click", () => select(r.dataset.sym));
      r.addEventListener("keydown", (e) => { if (e.key === "Enter") select(r.dataset.sym); });
    });
  }

  /* ── quote panel + chart ───────────────────────────── */
  function select(sym, quiet) {
    const it = state.inst.get(sym); if (!it) return;
    state.sel = sym;
    $("tkSym").value = sym;
    renderTable(); renderQuote(); loadChart(); updateEst();
    if (!quiet) log(`${it.sym} · ${it.name}`, "hi");
  }
  function renderQuote() {
    const it = state.inst.get(state.sel); if (!it) return;
    $("qHead").innerHTML = `${badge(it)}<span class="nm">${it.sym}</span><span class="tk">${it.name}</span>`;
    $("qLast").textContent = it.group === "fx" ? fmtPx(it.price) : fmtUSD(it.price);
    const d = $("qDelta"); d.className = `tt-delta ${deltaCls(it.d24)}`; d.textContent = it.price == null ? (it.nomarket ? "no market yet" : "") : `${fmtDelta(it.d24)} 24h`;
    const st = (k, v) => `<div class="tt-qstat"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    let stats = "";
    if (it.group === "fx") stats = st("1w", fmtDelta(it.d7)) + st("30d high", fmtPx(Math.max(...it.hist))) + st("30d low", fmtPx(Math.min(...it.hist))) + st("Fix date", it.fixDate || "—");
    else if (it.group === "desk") stats = st("5m", fmtDelta(it.d5m)) + st("1h", fmtDelta(it.d1h)) + st("6h", fmtDelta(it.d6h)) + st("Liquidity", fmtBig(it.liq)) + st("Volume 24h", fmtBig(it.vol)) + st("Market cap", fmtBig(it.mcap)) + st("Venue", it.dex || "—") + st("Desk", `<a href="${it.url}" target="_blank" rel="noopener" style="color:var(--tt)">${it.name} ↗</a>`);
    else stats = st("1h", fmtDelta(it.d1h)) + st("7d", fmtDelta(it.d7)) + st("24h high", fmtUSD(it.hi24)) + st("24h low", fmtUSD(it.lo24)) + st("Volume 24h", fmtBig(it.vol)) + st("Market cap", fmtBig(it.mcap)) + st("Group", it.group === "xstock" ? "xStock (tokenized)" : "Crypto") + st("Source", "CoinGecko");
    $("qStats").innerHTML = stats;
  }
  async function loadChart() {
    const it = state.inst.get(state.sel); if (!it) return;
    let series = null;
    if (it.group === "fx") {
      const n = state.tf === 1 ? 7 : state.tf === 7 ? 10 : 30;
      series = it.hist.slice(-n).map((p, i, a) => [Date.now() - (a.length - 1 - i) * 864e5, p]);
    } else if (it.group === "desk") {
      series = null;
    } else {
      const key = `${it.id}:${state.tf}`;
      const c = state.chartCache.get(key);
      if (c && Date.now() - c.at < 180e3) series = c.series;
      else {
        try {
          const r = await fetch(`${CG}/coins/${it.id}/market_chart?vs_currency=usd&days=${state.tf}`);
          if (r.ok) { const j = await r.json(); series = j.prices; state.chartCache.set(key, { at: Date.now(), series }); }
        } catch (e) {}
        if (!series && it.pts) series = it.pts.map((p, i, a) => [Date.now() - (a.length - 1 - i) * 7 * 864e5 / a.length, p]);
      }
    }
    if (state.sel !== it.sym) return;
    drawChart(series, it);
  }
  const chart = { series: null, hover: null };
  function drawChart(series, it) {
    chart.series = series; chart.it = it;
    const cv = $("chart"), wrap = cv.parentElement, dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth, H = 200;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const empty = $("chartEmpty");
    if (!series || series.length < 2) {
      empty.hidden = false; empty.textContent = it && it.group === "desk" ? (it.nomarket ? "No pair on-chain yet for this desk token." : "Intraday history isn't published for this pair — the 5m / 1h / 6h / 24h moves below are live.") : "Chart unavailable.";
      return;
    }
    empty.hidden = true;
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    const ys = series.map((p) => p[1]), min = Math.min(...ys), max = Math.max(...ys), span = (max - min) || 1;
    const padL = 6, padR = 58, padT = 14, padB = 18;
    const X = (i) => padL + i / (series.length - 1) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);
    const up = ys[ys.length - 1] >= ys[0];
    const line = up ? col("--phos") : col("--alert");
    // grid
    ctx.strokeStyle = col("--line"); ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    for (let g = 0; g <= 3; g++) { const y = padT + g * (H - padT - padB) / 3; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); }
    ctx.setLineDash([]);
    // area
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    grad.addColorStop(0, line + "44"); grad.addColorStop(1, line + "00");
    ctx.beginPath(); ctx.moveTo(X(0), Y(ys[0]));
    for (let i = 1; i < ys.length; i++) ctx.lineTo(X(i), Y(ys[i]));
    ctx.lineTo(X(ys.length - 1), H - padB); ctx.lineTo(X(0), H - padB); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); ctx.moveTo(X(0), Y(ys[0]));
    for (let i = 1; i < ys.length; i++) ctx.lineTo(X(i), Y(ys[i]));
    ctx.strokeStyle = line; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.stroke();
    // axis labels
    ctx.font = "10px " + (col("--font-mono") || "ui-monospace, monospace"); ctx.fillStyle = col("--muted"); ctx.textAlign = "left";
    const f = it.group === "fx" ? fmtPx : fmtUSD;
    const ly = Y(ys[ys.length - 1]);
    if (Math.abs(ly - padT) > 14) ctx.fillText(f(max), W - padR + 6, padT + 4);
    if (Math.abs(ly - (H - padB)) > 14) ctx.fillText(f(min), W - padR + 6, H - padB);
    // last-price crosshair (the logo's dashed cyan line, live)
    ctx.setLineDash([3, 3]); ctx.strokeStyle = col("--tt"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col("--tt"); const tag = f(ys[ys.length - 1]); const tw = ctx.measureText(tag).width + 10;
    ctx.beginPath(); ctx.roundRect(W - padR + 2, ly - 8, Math.max(tw, 36), 16, 4); ctx.fill();
    ctx.fillStyle = col("--tt-ink"); ctx.fillText(tag, W - padR + 7, ly + 3.5);
    // hover
    if (chart.hover != null) {
      const i = chart.hover, x = X(i), y = Y(ys[i]);
      ctx.setLineDash([3, 3]); ctx.strokeStyle = col("--tt"); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col("--tt"); ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
      const d = new Date(series[i][0]);
      const when = state.tf === 1 && it.group !== "fx" ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
      const lab = `${f(ys[i])} · ${when}`; const lw = ctx.measureText(lab).width + 12;
      const lx = Math.min(Math.max(x - lw / 2, padL), W - padR - lw);
      ctx.fillStyle = col("--ink"); ctx.beginPath(); ctx.roundRect(lx, 0, lw, 16, 4); ctx.fill();
      ctx.fillStyle = col("--paper"); ctx.fillText(lab, lx + 6, 11.5);
    }
  }
  $("chart").addEventListener("mousemove", (e) => {
    if (!chart.series) return;
    const r = e.currentTarget.getBoundingClientRect(); const W = r.width, padL = 6, padR = 58;
    const t = Math.min(1, Math.max(0, (e.clientX - r.left - padL) / (W - padL - padR)));
    chart.hover = Math.round(t * (chart.series.length - 1)); drawChart(chart.series, chart.it);
  });
  $("chart").addEventListener("mouseleave", () => { chart.hover = null; if (chart.series) drawChart(chart.series, chart.it); });
  $("tf").querySelectorAll(".tt-tfb").forEach((b) => b.addEventListener("click", () => {
    state.tf = +b.dataset.tf; $("tf").querySelectorAll(".tt-tfb").forEach((x) => x.classList.toggle("on", x === b)); loadChart();
  }));
  window.addEventListener("resize", () => { if (chart.series) drawChart(chart.series, chart.it); });

  /* ── paper book ────────────────────────────────────── */
  const START_CASH = 100000;
  let book = { cash: START_CASH, pos: {}, fills: [], orders: [], realized: 0 };
  try { const b = JSON.parse(localStorage.getItem("tt-book")); if (b && typeof b.cash === "number") book = Object.assign(book, b); } catch (e) {}
  const saveBook = () => { try { localStorage.setItem("tt-book", JSON.stringify(book)); } catch (e) {} };
  const mark = (sym) => { const it = state.inst.get(sym); return it && it.price != null ? it.price : null; };
  function fill(side, sym, qty, px, kind) {
    const p = book.pos[sym] || { qty: 0, avg: 0 };
    if (side === "buy") {
      const cost = qty * px; if (cost > book.cash + 1e-9) return { err: `Insufficient paper cash — need ${fmtMoney(cost)}, have ${fmtMoney(book.cash)}.` };
      p.avg = (p.avg * p.qty + cost) / (p.qty + qty); p.qty += qty; book.cash -= cost;
    } else {
      if (qty > p.qty + 1e-9) return { err: `You hold ${fmtQty(p.qty)} ${sym} — can't sell ${fmtQty(qty)}.` };
      book.realized += (px - p.avg) * qty; book.cash += qty * px; p.qty -= qty; if (p.qty < 1e-9) { p.qty = 0; p.avg = 0; }
    }
    if (p.qty > 0) book.pos[sym] = p; else delete book.pos[sym];
    book.fills.unshift({ t: Date.now(), side, sym, qty, px, kind }); book.fills = book.fills.slice(0, 40);
    saveBook(); return { ok: true };
  }
  function placeOrder(side, sym, qty, type, limit) {
    const it = state.inst.get(sym); if (!it) return { err: `Unknown instrument "${sym}". Try SOL, TSLAx, OTC or EUR/USD.` };
    if (!(qty > 0)) return { err: "Quantity must be positive." };
    const px = mark(sym); if (px == null) return { err: `${sym} has no live mark right now.` };
    if (type === "limit") {
      if (!(limit > 0)) return { err: "Limit price must be positive." };
      const crosses = side === "buy" ? px <= limit : px >= limit;
      if (crosses) { const r = fill(side, sym, qty, px, "limit"); return r.err ? r : { ok: true, msg: `${side === "buy" ? "Bought" : "Sold"} ${fmtQty(qty)} ${sym} at ${fmtUSD(px)} (limit ${fmtUSD(limit)} crossed on arrival).` }; }
      book.orders.push({ id: Date.now(), side, sym, qty, limit }); saveBook();
      return { ok: true, msg: `Working: ${side} ${fmtQty(qty)} ${sym} @ ${fmtUSD(limit)} (mark ${fmtUSD(px)}).` };
    }
    const r = fill(side, sym, qty, px, "market");
    return r.err ? r : { ok: true, msg: `${side === "buy" ? "Bought" : "Sold"} ${fmtQty(qty)} ${sym} at ${fmtUSD(px)} · paper.` };
  }
  function sweepOrders() {
    if (!book.orders.length) return;
    const keep = [];
    for (const o of book.orders) {
      const px = mark(o.sym);
      if (px != null && (o.side === "buy" ? px <= o.limit : px >= o.limit)) {
        const r = fill(o.side, o.sym, o.qty, px, "limit");
        if (r.ok) log(`Limit filled: ${o.side} ${fmtQty(o.qty)} ${o.sym} at ${fmtUSD(px)}.`, "ok"); else keep.push(o);
      } else keep.push(o);
    }
    book.orders = keep; saveBook();
  }
  function equity() {
    let e = book.cash;
    for (const [sym, p] of Object.entries(book.pos)) { const px = mark(sym); e += (px != null ? px : p.avg) * p.qty; }
    return e;
  }
  function renderBook() {
    const syms = Object.keys(book.pos);
    const posEl = $("positions");
    let unreal = 0;
    posEl.innerHTML = (syms.length ? `<div class="tt-pos hd"><span>Instrument</span><span class="n">Qty</span><span class="n avg">Avg</span><span class="n">P&amp;L</span></div>` : "") +
      syms.map((sym) => {
        const p = book.pos[sym], it = state.inst.get(sym), px = mark(sym);
        const pnl = px != null ? (px - p.avg) * p.qty : 0; unreal += pnl;
        const pct = px != null ? (px / p.avg - 1) * 100 : null;
        return `<div class="tt-pos"><span class="l">${it ? badge(it, true) : ""}<span class="nm">${sym}</span></span><span class="n m">${fmtQty(p.qty)}</span><span class="n m avg">${fmtUSD(p.avg)}</span><span class="n tt-delta ${deltaCls(pnl)}">${signed(pnl)}${pct != null ? ` <span style="opacity:.7">(${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)</span>` : ""}</span></div>`;
      }).join("") || `<p class="tt-empty">Flat. Type <span style="color:var(--tt)">buy 1 SOL</span> in the command line or use the ticket.</p>`;
    if (syms.length) posEl.innerHTML += `<div class="tt-pos" style="border-top:1px solid var(--line);margin-top:4px"><span class="l"><span class="nm" style="font-weight:400;color:var(--muted)">Unrealized / realized</span></span><span class="n"></span><span class="n avg"></span><span class="n tt-delta ${deltaCls(unreal)}">${signed(unreal)} <span style="color:var(--muted)">/ ${signed(book.realized)}</span></span></div>`;
    const fillsEl = $("fills");
    const work = book.orders.map((o) => `<div class="tt-fill"><span class="l"><span class="side work">Working</span><span>${o.side} ${fmtQty(o.qty)} ${o.sym} @ ${fmtUSD(o.limit)}</span></span><span class="r">mark ${fmtUSD(mark(o.sym))}<button class="x" type="button" data-cancel="${o.id}" aria-label="Cancel order" title="Cancel">×</button></span></div>`).join("");
    const fills = book.fills.slice(0, 12).map((f) => { const d = new Date(f.t); return `<div class="tt-fill"><span class="l"><span class="side ${f.side}">${f.side}</span><span>${fmtQty(f.qty)} ${f.sym} @ ${fmtUSD(f.px)}</span></span><span class="r">${f.kind}<span>${pad(d.getHours())}:${pad(d.getMinutes())}</span></span></div>`; }).join("");
    fillsEl.innerHTML = work + fills || `<p class="tt-empty">No fills yet.</p>`;
    fillsEl.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => { book.orders = book.orders.filter((o) => String(o.id) !== b.dataset.cancel); saveBook(); renderBook(); log("Order cancelled.", "ok"); }));
    $("bkCash").textContent = fmtMoney(book.cash);
    const eq = equity(), d = eq - START_CASH;
    $("bkEquity").innerHTML = `${fmtMoney(eq)} <span class="tt-delta ${deltaCls(d)}" style="font-size:10.5px">${d >= 0 ? "+" : "−"}${(Math.abs(d) / START_CASH * 100).toFixed(2)}%</span>`;
  }

  /* ── ticket ────────────────────────────────────────── */
  function updateEst() {
    const sym = $("tkSym").value.trim().toUpperCase(), it = find(sym), qty = parseFloat($("tkQty").value.replace(/[,\s]/g, ""));
    const type = $("tkType").value, lim = parseFloat($("tkLimit").value.replace(/[,\s]/g, ""));
    const px = type === "limit" && lim > 0 ? lim : it ? mark(it.sym) : null;
    $("tkEst").textContent = it && px != null && qty > 0 ? `${fmtMoney(qty * px)} · ${fmtQty(qty)} ${it.sym} @ ${fmtUSD(px)}` : "—";
    $("tkSubmit").textContent = `${state.side === "buy" ? "Buy" : "Sell"} ${type === "limit" ? "at limit" : "at market"}`;
    $("tkSubmit").className = `tt-submit ${state.side}`;
    $("tkSubmit").disabled = !(it && px != null && qty > 0);
  }
  $("side").querySelectorAll(".tt-sideb").forEach((b) => b.addEventListener("click", () => {
    state.side = b.dataset.side; $("side").querySelectorAll(".tt-sideb").forEach((x) => x.classList.toggle("on", x === b)); updateEst();
  }));
  $("tkType").addEventListener("change", () => { $("tkLimitWrap").hidden = $("tkType").value !== "limit"; $("tkTypeWrap").classList.toggle("wide", $("tkType").value !== "limit"); if ($("tkType").value === "limit" && !$("tkLimit").value) { const it = find($("tkSym").value); if (it && mark(it.sym) != null) $("tkLimit").value = fmtPx(mark(it.sym)).replace(/,/g, ""); } updateEst(); });
  ["tkSym", "tkQty", "tkLimit"].forEach((id) => $(id).addEventListener("input", updateEst));
  $("tkSubmit").addEventListener("click", () => {
    const it = find($("tkSym").value); if (!it) return;
    const qty = parseFloat($("tkQty").value.replace(/[,\s]/g, "")), type = $("tkType").value, lim = parseFloat($("tkLimit").value.replace(/[,\s]/g, ""));
    const r = placeOrder(state.side, it.sym, qty, type, lim);
    log(r.err || r.msg, r.err ? "err" : "ok"); renderBook(); updateEst();
  });
  $("bkReset").addEventListener("click", () => {
    if (!confirm("Reset the paper book? Positions, fills and working orders are cleared.")) return;
    book = { cash: START_CASH, pos: {}, fills: [], orders: [], realized: 0 }; saveBook(); renderBook(); updateEst(); log("Book reset to $100,000 paper cash.", "ok");
  });

  /* ── command line ──────────────────────────────────── */
  const HELP = "Commands: SYMBOL · watch SYMBOL · unwatch SYMBOL · buy|sell QTY SYMBOL [@ PRICE] · chart 1d|7d|30d · book · reset book · theme · clear · help";
  function log(msg, cls) {
    const d = new Date(), el = $("console");
    el.insertAdjacentHTML("afterbegin", `<div class="ln"><span class="ts">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span><span class="${cls || ""}">${msg}</span></div>`);
    while (el.children.length > 5) el.removeChild(el.lastChild);
  }
  function run(raw) {
    const s = raw.trim(); if (!s) return;
    const t = s.split(/\s+/); const c = t[0].toLowerCase();
    if (c === "help" || c === "?") return log(HELP, "hi");
    if (c === "clear") { $("console").innerHTML = ""; return; }
    if (c === "theme") return toggleTheme();
    if (c === "book") { document.getElementById("book").scrollIntoView({ behavior: "smooth" }); return log(`Paper cash ${fmtMoney(book.cash)} · equity ${fmtMoney(equity())} · ${Object.keys(book.pos).length} position(s).`, "hi"); }
    if (c === "reset" && (t[1] || "").toLowerCase() === "book") { $("bkReset").click(); return; }
    if (c === "chart") { const tf = { "1d": 1, "7d": 7, "30d": 30 }[(t[1] || "").toLowerCase()]; if (!tf) return log("chart 1d | 7d | 30d", "err"); $("tf").querySelector(`[data-tf="${tf}"]`).click(); return; }
    if (c === "watch" || c === "unwatch") {
      const it = find(t[1]); if (!it) return log(`Unknown instrument "${t[1] || ""}".`, "err");
      if (c === "watch") state.watch.add(it.sym); else state.watch.delete(it.sym);
      try { localStorage.setItem("tt-watch", JSON.stringify([...state.watch])); } catch (e) {}
      renderChips(); renderTable(); return log(`${c === "watch" ? "Watching" : "Unwatched"} ${it.sym}.`, "ok");
    }
    if (c === "buy" || c === "sell") {
      const m = s.match(/^(buy|sell)\s+([\d.,]+)\s+(\S+)(?:\s*@\s*([\d.,]+))?$/i);
      if (!m) return log("buy|sell QTY SYMBOL [@ PRICE] — e.g. buy 2 SOL @ 110", "err");
      const it = find(m[3]); if (!it) return log(`Unknown instrument "${m[3]}".`, "err");
      const r = placeOrder(c, it.sym, parseFloat(m[2].replace(/,/g, "")), m[4] ? "limit" : "market", m[4] ? parseFloat(m[4].replace(/,/g, "")) : null);
      renderBook(); if (r.ok) select(it.sym, true); return log(r.err || r.msg, r.err ? "err" : "ok");
    }
    const it = find(s); if (it) { select(it.sym); document.getElementById("terminal").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    log(`No instrument or command "${s}". Type help.`, "err");
  }
  $("cmdForm").addEventListener("submit", (e) => { e.preventDefault(); run($("cmdBox").value); $("cmdBox").value = ""; state.q = ""; state.page = 0; renderTable(); });
  $("cmdBox").addEventListener("input", (e) => { const v = e.target.value.trim().toLowerCase(); state.q = /^(buy|sell|watch|unwatch|chart|reset|help|theme|clear|book)\b/.test(v) ? "" : v; state.page = 0; renderTable(); });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("cmdBox").focus(); } });
  $("ctaTrade").addEventListener("click", () => setTimeout(() => $("cmdBox").focus(), 300));

  /* ── misc wiring ───────────────────────────────────── */
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", cur);
    try { localStorage.setItem("tt-theme", cur); } catch (e) {}
    if (chart.series) drawChart(chart.series, chart.it);
  }
  $("themeBtn").addEventListener("click", toggleTheme);
  $("sortSel").addEventListener("change", (e) => { state.sort = e.target.value; state.page = 0; renderTable(); });
  $("pgPrev").addEventListener("click", () => { state.page--; renderTable(); });
  $("pgNext").addEventListener("click", () => { state.page++; renderTable(); });
  document.querySelectorAll("[data-filter]").forEach((a) => a.addEventListener("click", () => { state.filter = a.dataset.filter; state.page = 0; renderChips(); renderTable(); }));
  function clocks() {
    const d = new Date();
    const et = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(d);
    $("clockET").textContent = `${et} ET`; $("clockUTC").textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  }
  setInterval(clocks, 1000); clocks();
  function status() {
    const feeds = [["CoinGecko", state.cgAt], ["DexScreener", state.dsAt], ["ECB fix", state.fxAt]];
    const up = feeds.filter((f) => f[1]).length;
    const led = $("led"); led.className = "tt-led " + (up === 3 ? "live" : up ? "stale" : "down");
    $("statusText").textContent = up ? feeds.map(([n, t]) => t ? `${n} ${ago(t)}` : `${n} down`).join(" · ") : "Feeds unavailable — retrying.";
    const it = state.inst.get("EUR/USD");
    $("updated").textContent = up ? `Live marks · ${up}/3 feeds · ECB fix ${it && it.fixDate ? it.fixDate : "—"}` : "Markets unavailable — retry shortly.";
  }
  setInterval(status, 5000);

  /* ── boot + refresh loops ──────────────────────────── */
  function rerender() { renderRail(); renderCards(); renderChips(); renderTable(); if (state.sel) { renderQuote(); } renderBook(); updateEst(); status(); }
  async function refresh(which) {
    const jobs = [];
    if (which.cg) jobs.push(loadCG().catch((e) => { state.cgErr = e; }));
    if (which.ds) jobs.push(loadDS().catch((e) => { state.dsErr = e; }));
    if (which.fx) jobs.push(loadFX().catch((e) => { state.fxErr = e; }));
    await Promise.all(jobs);
    sweepOrders(); rerender();
  }
  async function boot() {
    seedUniverse(); renderChips(); renderTable(); renderBook(); status();
    await refresh({ cg: true, ds: true, fx: true });
    if (!state.sel) select("SOL", true);
    log("Terminal up. Type help for commands, or a symbol to pull it up.", "hi");
    setInterval(() => refresh({ cg: true }), 60e3);
    setInterval(() => refresh({ ds: true }), 45e3);
    setInterval(() => refresh({ fx: true }), 600e3);
    setInterval(() => { if (state.sel && state.tf === 1) loadChart(); }, 300e3);
  }
  boot();
})();
