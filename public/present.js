/* Biscuit Arena — results deck.
 * Pulls every (anonymised) submission from the public /api/show endpoint and turns it into a slide show.
 * Keys: ← → / space move, F fullscreen, R refresh data. #3 in the URL jumps to slide 3.
 * Names are never shown: tasters appear only as numbers. */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const params = new URLSearchParams(location.search);
  // ?api= lets you rehearse locally against the live server (localhost only).
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  const API_BASE = String((isLocal && params.get("api")) || window.ARENA_API_BASE || "").replace(/\/+$/, "");
  const NS = "http://www.w3.org/2000/svg";

  // Pack membership mirrors data/config.json (the API doesn't expose it).
  const CREAM_PACK = new Set(["orange-slice", "shortbread-cream", "kingston", "monte-carlo", "delta-cream"]);
  const SCORE = ["", "#b8432a", "#e0957a", "#cfc6bc", "#8db3d6", "#2f6aa8"];
  const FACE = ["", "😖", "🙁", "😐", "🙂", "😍"];
  const FAMILY = "#c2662d";
  const CREAM = "#3d6fb4";

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "–");
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const sd = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- tooltip
  const tip = $("#tip");
  function showTip(html, evt) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 16;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() {
    tip.hidden = true;
  }
  function bindTip(node, html) {
    node.addEventListener("mousemove", (e) => showTip(typeof html === "function" ? html() : html, e));
    node.addEventListener("mouseleave", hideTip);
  }
  function biscuitTip(b) {
    const max = Math.max(1, ...b.counts.slice(1));
    const bars = [5, 4, 3, 2, 1]
      .map(
        (s) =>
          `<span>${s}★</span><i style="width:${(b.counts[s] / max) * 100}%;background:${SCORE[s]}"></i><span>${b.counts[s]}</span>`,
      )
      .join("");
    return `<strong>${esc(b.name)}</strong><br>Average ${fmt(b.mean)} · spread ${fmt(b.sd)} · ${b.n} vote${b.n === 1 ? "" : "s"}<div class="bars">${bars}</div>`;
  }

  // ---------------------------------------------------------------- data model
  function parseTime(s) {
    if (!s) return null;
    const d = new Date(String(s).replace(" ", "T") + "Z");
    return isNaN(d) ? null : d;
  }

  function buildModel(raw) {
    const biscuits = raw.biscuits.map((b) => ({ ...b, pack: CREAM_PACK.has(b.id) ? "cream" : "family" }));
    const byId = new Map(biscuits.map((b) => [b.id, b]));
    const subs = raw.submissions
      .filter((s) => s.ratings && s.ratings.length)
      .map((s) => ({
        id: s.id,
        t: parseTime(s.created_at),
        comment: (s.comment || "").trim(),
        scores: Object.fromEntries(s.ratings.filter((r) => byId.has(r.biscuit_id)).map((r) => [r.biscuit_id, r.score])),
        ratings: s.ratings.filter((r) => byId.has(r.biscuit_id)),
      }))
      .sort((a, b) => (a.t || 0) - (b.t || 0) || a.id - b.id);
    subs.forEach((s, i) => (s.no = i + 1));

    for (const b of biscuits) {
      const v = subs.map((s) => s.scores[b.id]).filter((x) => x != null);
      b.votes = v;
      b.n = v.length;
      b.mean = mean(v);
      b.sd = sd(v);
      b.counts = [0, 0, 0, 0, 0, 0];
      for (const x of v) b.counts[x]++;
    }
    const ranked = biscuits
      .filter((b) => b.n)
      .sort((a, b) => b.mean - a.mean || b.n - a.n || a.sd - b.sd || a.name.localeCompare(b.name));

    const comments = [];
    for (const s of subs)
      for (const r of s.ratings)
        if (r.comment && r.comment.trim()) comments.push({ b: byId.get(r.biscuit_id), score: r.score, text: r.comment.trim(), sub: s.no });

    const ratingsCount = subs.reduce((a, s) => a + s.ratings.length, 0);
    return { biscuits, byId, subs, ranked, comments, ratingsCount };
  }

  function pearson(M, a, b) {
    const xs = [];
    const ys = [];
    for (const s of M.subs) {
      if (s.scores[a.id] != null && s.scores[b.id] != null) {
        xs.push(s.scores[a.id]);
        ys.push(s.scores[b.id]);
      }
    }
    if (xs.length < 3) return null;
    const mx = mean(xs);
    const my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    if (!sxx || !syy) return null;
    return { r: sxy / Math.sqrt(sxx * syy), n: xs.length };
  }

  // ---------------------------------------------------------------- slide scaffolding
  function shell(kicker, title, takeaway, extraClass) {
    const s = document.createElement("section");
    s.className = `slide ${extraClass || ""}`;
    s.innerHTML = `<header class="slide-head"><p class="kicker">${kicker}</p><h2>${title}</h2><p class="takeaway">${takeaway || ""}</p></header><div class="slide-body"></div>`;
    return s;
  }
  const body = (s) => $(".slide-body", s);
  function replay(node) {
    node.classList.remove("on");
    void node.offsetWidth;
    node.classList.add("on");
  }
  function emptyNote(s, text) {
    body(s).innerHTML = `<div class="empty">${esc(text || "Not enough votes yet — check back once more people have rated.")}</div>`;
  }
  const img = (b, cls) => `<img src="${esc(b.image)}" alt="" class="${cls || ""}" draggable="false">`;

  // ================================================================ 1. title
  function titleSlide(M) {
    const s = document.createElement("section");
    s.className = "slide slide-title";
    const days = [...new Set(M.subs.filter((x) => x.t).map((x) => x.t.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })))];
    const when = days.length ? (days.length > 1 ? `${days[0]} – ${days[days.length - 1]}` : days[0]) : "";
    const stats = [
      [M.biscuits.length, "Biscuits"],
      [M.subs.length, "Tasters"],
      [M.ratingsCount, "Ratings"],
      [M.comments.length + M.subs.filter((x) => x.comment).length, "Comments"],
    ];
    const spots = [
      [70, 70, -8], [1380, 60, 7], [40, 380, 6], [1430, 360, -6], [120, 690, -5], [1350, 680, 9],
      [360, 30, 4], [1090, 40, -4], [300, 760, 8], [1110, 770, -7], [560, 790, 5], [830, 20, -5],
    ];
    s.innerHTML = `
      <div class="floaters">${M.biscuits
        .slice(0, spots.length)
        .map((b, i) => `<img src="${esc(b.image)}" alt="" style="left:${spots[i][0]}px;top:${spots[i][1]}px;--r:${spots[i][2]}deg;--d:${i * 0.08}s;animation-delay:${-i * 0.6}s">`)
        .join("")}</div>
      <div class="title-inner">
        <p class="kicker">The results are in${when ? ` · ${esc(when)}` : ""}</p>
        <h1>Arnott's<br><em>Biscuit Arena</em></h1>
        <p class="title-sub">${M.biscuits.length} biscuits. ${M.subs.length} brave tasters. One office, deeply divided.</p>
        <div class="title-stats">${stats.map(([n, l]) => `<div><strong data-n="${n}">0</strong><span>${l}</span></div>`).join("")}</div>
      </div>`;
    return {
      el: s,
      enter() {
        const nums = [...s.querySelectorAll("[data-n]")];
        const start = performance.now();
        const tick = (now) => {
          const p = clamp((now - start) / 1400, 0, 1);
          const e = 1 - Math.pow(1 - p, 3);
          for (const n of nums) n.textContent = Math.round(Number(n.dataset.n) * e);
          if (p < 1 && s.classList.contains("active")) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
    };
  }

  // ================================================================ 2. ridgeline
  function ridgeSlide(M) {
    const rows = M.ranked;
    const withSpread = rows.filter((b) => b.n >= 3);
    const cons = withSpread.slice().sort((a, b) => a.sd - b.sd)[0];
    const div = withSpread.slice().sort((a, b) => b.sd - a.sd)[0];
    const take =
      cons && div && cons !== div
        ? `Tall spikes = the office agrees. Wide humps = arguments. <strong>${esc(cons.name)}</strong> is the most agreed-on; <strong>${esc(div.name)}</strong> splits the room.`
        : "Tall spikes = the office agrees. Wide humps = arguments.";
    const s = shell("How the votes spread", "Love it or hate it?", take);
    if (!rows.length) {
      emptyNote(s);
      return { el: s };
    }

    const W = 1440, H = 600;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Ridgeline of score distributions per biscuit" });
    body(s).appendChild(svg);
    const x0 = 330, x1 = 1290;
    const X = (v) => x0 + ((v - 0.5) / 5) * (x1 - x0);
    const top = 34, bottom = H - 56;
    const step = (bottom - top) / rows.length;
    const amp = step * 2.1;

    const defs = svgEl("defs", {}, svg);
    const grad = svgEl("linearGradient", { id: "ridgeGrad", gradientUnits: "userSpaceOnUse", x1: X(1), x2: X(5), y1: 0, y2: 0 }, defs);
    for (let k = 1; k <= 5; k++) svgEl("stop", { offset: (k - 1) / 4, "stop-color": SCORE[k] }, grad);

    for (let k = 1; k <= 5; k++) {
      svgEl("line", { class: "gridline", x1: X(k), x2: X(k), y1: top - 20, y2: bottom }, svg);
      const t = svgEl("text", { x: X(k), y: bottom + 34, "text-anchor": "middle", "font-size": 20, "font-weight": 700, class: "muted" }, svg);
      t.textContent = `${FACE[k]} ${k}★`;
    }

    const bw = 0.42;
    const xs = [];
    for (let v = 0.5; v <= 5.5001; v += 0.04) xs.push(v);
    const dens = rows.map((b) =>
      xs.map((x) => {
        let d = 0;
        for (let k = 1; k <= 5; k++) if (b.counts[k]) d += b.counts[k] * Math.exp(-0.5 * ((x - k) / bw) ** 2);
        return d / (b.n * bw * Math.sqrt(2 * Math.PI));
      }),
    );
    const dmax = Math.max(...dens.flat());

    rows.forEach((b, i) => {
      const base = top + step * (i + 1);
      const delay = `${i * 0.07}s`;
      const g = svgEl("g", { class: "ridge", style: `--d:${delay}` }, svg);
      const pts = xs.map((x, j) => `${X(x).toFixed(1)},${(base - (dens[i][j] / dmax) * amp).toFixed(1)}`);
      svgEl("path", { d: `M${X(0.5)},${base} L${pts.join(" L")} L${X(5.5)},${base} Z`, fill: "url(#ridgeGrad)", "fill-opacity": 0.92, stroke: "#fffaf3", "stroke-width": 2.5 }, g);
      svgEl("path", { d: `M${pts.join(" L")}`, fill: "none", stroke: "#38231b", "stroke-width": 1.4, "stroke-opacity": 0.75 }, g);

      svgEl("image", { href: b.image, x: 0, y: base - step * 0.95, width: 92, height: step * 0.9, preserveAspectRatio: "xMidYMid meet" }, svg);
      const nm = svgEl("text", { x: 104, y: base - step * 0.35, "font-size": 19, "font-weight": 700 }, svg);
      nm.textContent = b.name;
      const mv = svgEl("text", { x: x1 + 70, y: base - step * 0.35, "font-size": 19, "font-weight": 800, "text-anchor": "end" }, svg);
      mv.textContent = fmt(b.mean);
      const hit = svgEl("rect", { class: "row-hit", x: 0, y: base - step, width: W, height: step }, svg);
      bindTip(hit, () => biscuitTip(b));
    });
    const hdr = svgEl("text", { x: x1 + 70, y: top - 14, "font-size": 14, "font-weight": 800, "text-anchor": "end", class: "muted", "letter-spacing": "0.1em" }, svg);
    hdr.textContent = "AVG";

    return { el: s, enter: () => replay(s) };
  }

  // ================================================================ 3. divisive scatter
  function scatterSlide(M) {
    const pts = M.ranked.filter((b) => b.n >= 2);
    const div = pts.slice().sort((a, b) => b.sd - a.sd)[0];
    const fav = pts.slice().sort((a, b) => b.mean - b.sd - (a.mean - a.sd))[0];
    const take =
      div && fav
        ? `<strong>${esc(div.name)}</strong> starts the most arguments. <strong>${esc(fav.name)}</strong> is the safest biscuit to bring to a meeting.`
        : "";
    const s = shell("Crowd-pleasers vs. troublemakers", "Who divides the office?", take);
    if (pts.length < 2) {
      emptyNote(s);
      return { el: s };
    }
    const W = 1440, H = 600;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Average score against disagreement" });
    body(s).appendChild(svg);
    const L = 110, R = W - 60, T = 20, B = H - 76;
    const means = pts.map((b) => b.mean);
    const sds = pts.map((b) => b.sd);
    const xlo = Math.max(1, Math.floor((Math.min(...means) - 0.2) * 4) / 4);
    const xhi = Math.min(5, Math.ceil((Math.max(...means) + 0.2) * 4) / 4);
    const ylo = Math.max(0, Math.floor((Math.min(...sds) - 0.15) * 10) / 10);
    const yhi = Math.ceil((Math.max(...sds) + 0.15) * 10) / 10;
    const X = (v) => L + ((v - xlo) / (xhi - xlo)) * (R - L);
    const Y = (v) => B - ((v - ylo) / (yhi - ylo)) * (B - T);
    const xm = mean(means);
    const sortedSd = sds.slice().sort((a, b) => a - b);
    const ym = sortedSd[Math.floor(sortedSd.length / 2)];

    const quads = [
      [X(xm), T, R, Y(ym), "Loved… by some", SCORE[5], "end", R - 18, T + 30],
      [X(xm), Y(ym), R, B, "Crowd-pleasers", SCORE[5], "end", R - 18, B - 18],
      [L, Y(ym), X(xm), B, "Everyone agrees: meh", SCORE[1], "start", L + 18, B - 18],
      [L, T, X(xm), Y(ym), "Divisive duds", SCORE[1], "start", L + 18, T + 30],
    ];
    for (const [qx0, qy0, qx1, qy1, label, col, anchor, lx, ly] of quads) {
      svgEl("rect", { x: qx0, y: qy0, width: qx1 - qx0, height: qy1 - qy0, fill: col, "fill-opacity": 0.05 }, svg);
      const t = svgEl("text", { x: lx, y: ly, "text-anchor": anchor, class: "quad-label muted" }, svg);
      t.textContent = label;
    }
    for (let v = Math.ceil(xlo * 4) / 4; v <= xhi + 1e-9; v += 0.25) {
      svgEl("line", { class: "gridline", x1: X(v), x2: X(v), y1: T, y2: B }, svg);
      const t = svgEl("text", { x: X(v), y: B + 28, "text-anchor": "middle", "font-size": 16, class: "muted" }, svg);
      t.textContent = v.toFixed(2);
    }
    for (let v = Math.ceil(ylo * 10) / 10; v <= yhi + 1e-9; v += 0.1) {
      svgEl("line", { class: "gridline", x1: L, x2: R, y1: Y(v), y2: Y(v) }, svg);
      const t = svgEl("text", { x: L - 12, y: Y(v) + 5, "text-anchor": "end", "font-size": 16, class: "muted" }, svg);
      t.textContent = v.toFixed(1);
    }
    svgEl("line", { x1: X(xm), x2: X(xm), y1: T, y2: B, stroke: "#c9b8a6", "stroke-width": 1.5 }, svg);
    svgEl("line", { x1: L, x2: R, y1: Y(ym), y2: Y(ym), stroke: "#c9b8a6", "stroke-width": 1.5 }, svg);
    const xl = svgEl("text", { x: (L + R) / 2, y: H - 10, "text-anchor": "middle", "font-size": 18, "font-weight": 700 }, svg);
    xl.textContent = "Average score  →  better";
    const yl = svgEl("text", { x: 0, y: 0, transform: `translate(26 ${(T + B) / 2}) rotate(-90)`, "text-anchor": "middle", "font-size": 18, "font-weight": 700 }, svg);
    yl.textContent = "Disagreement (spread of scores)  →";

    // label placement: try below, above, right, left — avoid other labels and rings
    const ringW = 46, ring = 22;
    const placed = [];
    const rings = pts.map((b) => ({ x: X(b.mean), y: Y(b.sd) }));
    const overlaps = (a, c) => a.x0 < c.x1 && a.x1 > c.x0 && a.y0 < c.y1 && a.y1 > c.y0;
    const labelPos = pts.map((b, i) => {
      const { x, y } = rings[i];
      const w = b.name.length * 9.6 + 8;
      const h = 22;
      const opts = [
        [0, ring + 20, "middle"],
        [0, -ring - 10, "middle"],
        [ringW + 8, 6, "start"],
        [-ringW - 8, 6, "end"],
        [ringW - 6, ring + 20, "start"],
        [-ringW + 6, ring + 20, "end"],
        [ringW - 6, -ring - 10, "start"],
        [-ringW + 6, -ring - 10, "end"],
      ];
      let best = opts[0];
      for (const o of opts) {
        const lx = x + o[0];
        const x0b = o[2] === "middle" ? lx - w / 2 : o[2] === "start" ? lx : lx - w;
        const box = { x0: x0b, x1: x0b + w, y0: y + o[1] - h + 4, y1: y + o[1] + 4 };
        const hitsLabel = placed.some((p) => overlaps(p, box));
        const hitsRing = rings.some((r) => overlaps({ x0: r.x - ringW, x1: r.x + ringW, y0: r.y - ring, y1: r.y + ring }, box));
        if (!hitsLabel && !hitsRing) {
          best = o;
          placed.push(box);
          break;
        }
        if (o === opts[opts.length - 1]) placed.push(box);
      }
      return best;
    });

    const nodes = pts.map((b, i) => {
      const g = svgEl("g", { class: "pt" }, svg);
      svgEl("rect", { class: "pt-ring", x: -ringW, y: -ring, width: ringW * 2, height: ring * 2, rx: ring }, g);
      svgEl("image", { href: b.image, x: -ringW + 6, y: -ring + 3, width: ringW * 2 - 12, height: ring * 2 - 6 }, g);
      const [dx, dy, anchor] = labelPos[i];
      const t = svgEl("text", { class: "pt-label", x: dx, y: dy, "text-anchor": anchor }, g);
      t.textContent = b.name;
      bindTip(g, () => biscuitTip(b));
      return { g, x: rings[i].x, y: rings[i].y };
    });

    return {
      el: s,
      enter() {
        const cx = (L + R) / 2, cy = (T + B) / 2;
        for (const n of nodes) {
          n.g.style.transition = "none";
          n.g.style.opacity = "0";
          n.g.style.transform = `translate(${cx}px, ${cy}px) scale(0.2)`;
        }
        void svg.getBoundingClientRect();
        nodes.forEach((n, i) => {
          n.g.style.transition = "";
          n.g.style.transitionDelay = `${0.2 + i * 0.09}s`;
          n.g.style.opacity = "1";
          n.g.style.transform = `translate(${n.x}px, ${n.y}px)`;
        });
      },
    };
  }

  // ================================================================ 4. taste network
  function networkSlide(M) {
    const nodes = M.ranked.filter((b) => b.n >= 3);
    const pairs = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const p = pearson(M, nodes[i], nodes[j]);
        if (p) pairs.push({ a: nodes[i], b: nodes[j], ai: i, bi: j, r: p.r, n: p.n });
      }
    const pos = pairs.filter((p) => p.r > 0).sort((a, b) => b.r - a.r);
    const neg = pairs.filter((p) => p.r < 0).sort((a, b) => a.r - b.r);
    const take = pos[0]
      ? `Love <strong>${esc(pos[0].a.name)}</strong>? Odds are you also love <strong>${esc(pos[0].b.name)}</strong>.`
      : "";
    const s = shell("Taste-alikes", "Biscuit soulmates & sworn enemies", take);
    if (nodes.length < 3 || !pairs.length) {
      emptyNote(s);
      return { el: s };
    }
    body(s).innerHTML = `<div class="net-wrap"><div class="net-graph"></div><aside class="net-panel"></aside></div>`;
    const W = 900, H = 600;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Network of biscuits rated alike" });
    $(".net-graph", s).appendChild(svg);

    // target distances: alike biscuits sit close, opposites far apart
    const n = nodes.length;
    const D = Array.from({ length: n }, () => Array(n).fill(1));
    for (const p of pairs) D[p.ai][p.bi] = D[p.bi][p.ai] = 1 - p.r;
    const strongCut = Math.min(0.4, pos[Math.min(5, pos.length - 1)]?.r ?? 0.4);
    const edges = pairs.filter((p) => p.r >= strongCut || p.r <= -Math.max(0.4, strongCut));
    const edgeG = svgEl("g", {}, svg);
    const nodeG = svgEl("g", {}, svg);
    const edgeEls = edges.map((p) => {
      const pos = p.r > 0;
      const line = svgEl(
        "line",
        {
          class: "net-edge",
          stroke: pos ? SCORE[5] : SCORE[1],
          "stroke-width": (1.5 + Math.abs(p.r) * 9).toFixed(1),
          "stroke-opacity": (0.25 + Math.abs(p.r) * 0.6).toFixed(2),
          "stroke-linecap": "round",
        },
        edgeG,
      );
      return { p, line };
    });
    const nodeEls = nodes.map((b, i) => {
      const g = svgEl("g", { class: "net-node" }, nodeG);
      svgEl("rect", { class: "pt-ring", x: -52, y: -24, width: 104, height: 48, rx: 24 }, g);
      svgEl("image", { href: b.image, x: -46, y: -21, width: 92, height: 42 }, g);
      const t = svgEl("text", { class: "pt-label", y: 46, "text-anchor": "middle" }, g);
      t.textContent = b.name;
      const mine = pairs.filter((p) => p.ai === i || p.bi === i);
      const other = (p) => (p.ai === i ? p.b : p.a);
      const best = mine.slice().sort((x, y) => y.r - x.r)[0];
      const worst = mine.slice().sort((x, y) => x.r - y.r)[0];
      bindTip(
        g,
        `<strong>${esc(b.name)}</strong><br>Best mate: ${best ? `${esc(other(best).name)} (${best.r >= 0 ? "+" : ""}${fmt(best.r)})` : "–"}<br>Nemesis: ${worst && worst.r < 0 ? `${esc(other(worst).name)} (${fmt(worst.r)})` : "nobody, really"}`,
      );
      g.addEventListener("mouseenter", () => {
        svg.classList.add("net-dim");
        g.classList.add("hot");
        for (const e of edgeEls)
          if (e.p.ai === i || e.p.bi === i) {
            e.line.classList.add("hot");
            nodeEls[e.p.ai === i ? e.p.bi : e.p.ai].g.classList.add("hot");
          }
      });
      g.addEventListener("mouseleave", () => {
        svg.classList.remove("net-dim");
        svg.querySelectorAll(".hot").forEach((x) => x.classList.remove("hot"));
      });
      return { g };
    });

    // stress-minimising layout (tiny MDS), animated as it settles
    let P;
    let raf = 0;
    function render() {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of P) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const padX = 70, padT = 36, padB = 60;
      let sx = (W - padX * 2) / (maxX - minX || 1);
      let sy = (H - padT - padB) / (maxY - minY || 1);
      // allow some stretch to fill the frame, but not so much the layout lies
      sx = Math.min(sx, sy * 1.7);
      sy = Math.min(sy, sx * 1.7);
      const ox = (W - (maxX - minX) * sx) / 2;
      const oy = padT + (H - padT - padB - (maxY - minY) * sy) / 2;
      const S = P.map(([x, y]) => [ox + (x - minX) * sx, oy + (y - minY) * sy]);
      // nudge apart nodes whose pills/labels would collide
      for (let pass = 0; pass < 40; pass++) {
        for (let i = 0; i < S.length; i++)
          for (let j = i + 1; j < S.length; j++) {
            const dx = S[j][0] - S[i][0];
            const dy = S[j][1] - S[i][1];
            const gx = 150 - Math.abs(dx);
            const gy = 84 - Math.abs(dy);
            if (gx > 0 && gy > 0) {
              if (gx / 150 < gy / 84) {
                const m = (gx / 2) * (dx < 0 ? -1 : 1);
                S[i][0] -= m; S[j][0] += m;
              } else {
                const m = (gy / 2) * (dy < 0 ? -1 : 1);
                S[i][1] -= m; S[j][1] += m;
              }
            }
          }
        for (const q of S) {
          q[0] = clamp(q[0], 70, W - 70);
          q[1] = clamp(q[1], 30, H - 50);
        }
      }
      nodeEls.forEach((ne, i) => ne.g.setAttribute("transform", `translate(${S[i][0].toFixed(1)} ${S[i][1].toFixed(1)})`));
      for (const e of edgeEls) {
        e.line.setAttribute("x1", S[e.p.ai][0]);
        e.line.setAttribute("y1", S[e.p.ai][1]);
        e.line.setAttribute("x2", S[e.p.bi][0]);
        e.line.setAttribute("y2", S[e.p.bi][1]);
      }
    }
    function run() {
      cancelAnimationFrame(raf);
      const rand = seeded(42);
      P = nodes.map((_, i) => {
        const a = (i / n) * Math.PI * 2;
        return [Math.cos(a) + (rand() - 0.5) * 0.1, Math.sin(a) + (rand() - 0.5) * 0.1];
      });
      let iter = 0;
      const total = 420;
      const frame = () => {
        for (let k = 0; k < 4 && iter < total; k++, iter++) {
          const lr = 0.08 * (1 - iter / total) + 0.005;
          for (let i = 0; i < n; i++)
            for (let j = i + 1; j < n; j++) {
              const dx = P[i][0] - P[j][0];
              const dy = P[i][1] - P[j][1];
              const d = Math.hypot(dx, dy) || 1e-6;
              const target = 0.35 + D[i][j];
              const g = ((d - target) / d) * lr;
              P[i][0] -= g * dx; P[i][1] -= g * dy;
              P[j][0] += g * dx; P[j][1] += g * dy;
            }
        }
        render();
        if (iter < total && s.classList.contains("active")) raf = requestAnimationFrame(frame);
      };
      render();
      raf = requestAnimationFrame(frame);
    }

    const panel = $(".net-panel", s);
    const pairRow = (p, i, cls) =>
      `<div class="pair" style="--d:${0.3 + i * 0.12}s"><div class="pair-imgs">${img(p.a)}${img(p.b)}</div><div class="pair-names">${esc(p.a.name)} &amp; ${esc(p.b.name)}</div><div class="pair-r ${cls}">${p.r > 0 ? "+" : "−"}${fmt(Math.abs(p.r))}</div></div>`;
    panel.innerHTML = `
      <h3>💞 Soulmates</h3><p>Rated alike, taster after taster</p>
      ${pos.slice(0, 3).map((p, i) => pairRow(p, i, "pos")).join("") || "<p>None yet.</p>"}
      <h3 style="margin-top:16px">⚔️ Sworn enemies</h3><p>Love one, hate the other</p>
      ${neg.slice(0, 3).map((p, i) => pairRow(p, i + 3, "neg")).join("") || "<p>No rivalries yet.</p>"}
      <div class="net-legend"><span><i style="background:${SCORE[5]}"></i>rated alike</span><span><i style="background:${SCORE[1]}"></i>rated opposite</span></div>
      <p class="net-note">Score = correlation across tasters who rated both: +1 always rated alike, −1 always opposite. With ${M.subs.length} tasters, treat it as gossip, not science.</p>`;

    return {
      el: s,
      enter() {
        replay(s);
        run();
      },
      leave() {
        cancelAnimationFrame(raf);
      },
    };
  }

  // ================================================================ 5. family vs cream
  function packSlide(M) {
    const famB = M.biscuits.filter((b) => b.pack === "family");
    const crB = M.biscuits.filter((b) => b.pack === "cream");
    const allFam = famB.flatMap((b) => b.votes);
    const allCr = crB.flatMap((b) => b.votes);
    const famAvg = mean(allFam);
    const crAvg = mean(allCr);
    const tasters = M.subs
      .map((s) => {
        const f = famB.map((b) => s.scores[b.id]).filter((v) => v != null);
        const c = crB.map((b) => s.scores[b.id]).filter((v) => v != null);
        return f.length && c.length ? { no: s.no, f: mean(f), c: mean(c) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.c - b.f - (a.c - a.f));
    const tie = 0.15;
    const creamPeople = tasters.filter((t) => t.c - t.f > tie).length;
    const famPeople = tasters.filter((t) => t.f - t.c > tie).length;
    const fence = tasters.length - creamPeople - famPeople;
    const creamWins = crAvg > famAvg;
    const winner = creamWins ? "Cream Favourites" : "Family Favourites";
    const take =
      Number.isFinite(famAvg) && Number.isFinite(crAvg)
        ? `<strong>${winner}</strong> take it, ${fmt(Math.max(famAvg, crAvg))} to ${fmt(Math.min(famAvg, crAvg))} — but ${creamWins ? famPeople : creamPeople} rebel${(creamWins ? famPeople : creamPeople) === 1 ? "" : "s"} disagree.`
        : "";
    const s = shell("The pack war", "Family Favourites vs. Cream Favourites", take);
    if (!tasters.length) {
      emptyNote(s);
      return { el: s };
    }
    const card = (name, list, avg, col, win, d) => `
      <div class="pack-card" style="--c:${col};--d:${d}s">
        ${win ? `<span class="pack-ribbon">🏆 Winner</span>` : ""}
        <div><h3>${name}</h3><span class="sub">${list.length} biscuits</span>
          <div class="pack-thumbs">${list.map((b) => img(b)).join("")}</div></div>
        <div class="pack-avg">${fmt(avg)}<small>avg score</small></div>
      </div>`;
    body(s).innerHTML = `
      <div class="pack-wrap">
        <div class="pack-cards">
          ${card("Family Favourites", famB, famAvg, FAMILY, !creamWins, 0.1)}
          ${card("Cream Favourites", crB, crAvg, CREAM, creamWins, 0.25)}
          <div class="tally">
            <div style="--d:1.4s"><strong style="color:${CREAM}">${creamPeople}</strong><span>Cream people</span></div>
            <div style="--d:1.55s"><strong style="color:${FAMILY}">${famPeople}</strong><span>Family people</span></div>
            <div style="--d:1.7s"><strong>${fence}</strong><span>Fence-sitters</span></div>
          </div>
        </div>
        <div class="pack-chart">
          <div class="legend"><span><i style="background:${FAMILY}"></i>Family avg</span><span><i style="background:${CREAM}"></i>Cream avg</span><span>· one row per taster</span></div>
        </div>
      </div>`;
    const W = 760, H = 548;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", style: "height:calc(100% - 34px)", role: "img", "aria-label": "Each taster's Family and Cream averages" });
    $(".pack-chart", s).appendChild(svg);
    const L = 70, R = W - 20, T = 34, B = H - 6;
    const X = (v) => L + ((v - 1) / 4) * (R - L);
    for (let k = 1; k <= 5; k++) {
      svgEl("line", { class: "gridline", x1: X(k), x2: X(k), y1: T - 6, y2: B }, svg);
      const t = svgEl("text", { x: X(k), y: T - 14, "text-anchor": "middle", "font-size": 16, class: "muted" }, svg);
      t.textContent = `${k}★`;
    }
    const step = (B - T) / tasters.length;
    const r = clamp(step * 0.32, 4, 9);
    const items = tasters.map((t, i) => {
      const y = T + step * (i + 0.5);
      const mid = X((t.f + t.c) / 2);
      if (step >= 13) {
        const lab = svgEl("text", { x: L - 14, y: y + 5, "text-anchor": "end", "font-size": clamp(step * 0.6, 11, 15), class: "faint" }, svg);
        lab.textContent = `#${t.no}`;
      }
      const line = svgEl("line", { class: "dumb-line", x1: mid, x2: mid, y1: y, y2: y, stroke: "#c9b8a6", "stroke-width": Math.max(2, r * 0.6), "stroke-linecap": "round", style: `--d:${0.5 + i * 0.04}s` }, svg);
      const df = svgEl("circle", { class: "dumb-dot", cx: mid, cy: y, r, fill: FAMILY, stroke: "#fffaf3", "stroke-width": 2, style: `--d:${0.5 + i * 0.04}s` }, svg);
      const dc = svgEl("circle", { class: "dumb-dot", cx: mid, cy: y, r, fill: CREAM, stroke: "#fffaf3", "stroke-width": 2, style: `--d:${0.5 + i * 0.04}s` }, svg);
      const hit = svgEl("rect", { x: 0, y: y - step / 2, width: W, height: step, fill: "transparent" }, svg);
      bindTip(hit, `<strong>Taster #${t.no}</strong><br>Family ${fmt(t.f)} · Cream ${fmt(t.c)}<br>${Math.abs(t.c - t.f) <= tie ? "Sitting on the fence" : t.c > t.f ? "Team Cream" : "Team Family"}`);
      return { t, mid, line, df, dc };
    });
    return {
      el: s,
      enter() {
        for (const it of items) {
          for (const e of [it.df, it.dc]) e.setAttribute("cx", it.mid);
          it.line.setAttribute("x1", it.mid);
          it.line.setAttribute("x2", it.mid);
        }
        replay(s);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            for (const it of items) {
              it.df.setAttribute("cx", X(it.t.f));
              it.dc.setAttribute("cx", X(it.t.c));
              it.line.setAttribute("x1", X(it.t.f));
              it.line.setAttribute("x2", X(it.t.c));
            }
          }),
        );
      },
    };
  }

  // ================================================================ 6. comment plinko
  function plinkoSlide(M) {
    const cs = M.comments;
    const byScore = [1, 2, 3, 4, 5].map((k) => cs.filter((c) => c.score === k));
    const busiest = byScore.reduce((a, b, i) => (b.length > byScore[a].length ? i : a), 0) + 1;
    const take = cs.length
      ? `${cs.length} comments, sorted by the score that came with them. The ${busiest}★ bin is where people had the most to say.`
      : "";
    const s = shell("Critics' corner", "Every comment, dropped where it landed", take);
    if (!cs.length) {
      emptyNote(s, "No comments yet.");
      return { el: s };
    }
    body(s).innerHTML = `<div class="plinko">${[1, 2, 3, 4, 5]
      .map(
        (k) =>
          `<div class="plinko-col" style="--c:${SCORE[k]}"><div class="plinko-head"><span class="face">${FACE[k]}</span>${k}★<span class="count">${byScore[k - 1].length}</span></div><div class="plinko-bin" data-k="${k}"></div></div>`,
      )
      .join("")}</div>`;
    const wrap = $(".plinko", s);
    const maxCol = Math.max(...byScore.map((a) => a.length));
    wrap.classList.toggle("compact", maxCol > 9);
    const rand = seeded(7);
    const order = cs
      .map((c) => ({ c, k: rand() }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.c);
    let timers = [];
    return {
      el: s,
      enter() {
        timers.forEach(clearTimeout);
        timers = [];
        const bins = [...s.querySelectorAll(".plinko-bin")];
        bins.forEach((b) => (b.innerHTML = ""));
        const gap = clamp(5000 / order.length, 60, 220);
        order.forEach((c, i) => {
          timers.push(
            setTimeout(() => {
              const bin = bins[c.score - 1];
              const card = document.createElement("div");
              card.className = "plinko-card";
              card.style.setProperty("--c", SCORE[c.score]);
              card.style.setProperty("--r", `${(rand() - 0.5) * 3}deg`);
              card.innerHTML = `${img(c.b)}<p>${esc(c.text)}</p>`;
              bindTip(card, `<strong>${esc(c.b.name)} · ${c.score}★</strong><br>“${esc(c.text)}”`);
              bin.insertBefore(card, bin.querySelector(".plinko-more"));
              // The bin stacks bottom-up, so overflow shows as the top item sitting above the bin's
              // top edge. (scrollHeight is no use here: the drop-in transform inflates it.)
              const overflowing = () => {
                const top = bin.lastElementChild;
                return top && top.offsetTop < 0;
              };
              if (overflowing()) {
                card.remove();
                let more = bin.querySelector(".plinko-more");
                if (!more) {
                  more = document.createElement("span");
                  more.className = "plinko-more";
                  bin.appendChild(more);
                }
                more.dataset.n = String(Number(more.dataset.n || 0) + 1);
                more.textContent = `+${more.dataset.n} more`;
                // the badge itself may push the top card out
                if (overflowing()) {
                  const cards = bin.querySelectorAll(".plinko-card");
                  if (cards.length) cards[cards.length - 1].remove();
                  more.dataset.n = String(Number(more.dataset.n) + 1);
                  more.textContent = `+${more.dataset.n} more`;
                }
              }
            }, 300 + i * gap),
          );
        });
      },
      leave() {
        timers.forEach(clearTimeout);
      },
    };
  }

  // ================================================================ 7. quote spotlight
  function quoteSlide(M) {
    const names = M.biscuits.map((b) => b.name.toLowerCase());
    const scored = M.comments
      .filter((c) => c.text.replace(/[^a-z0-9]/gi, "").length >= 3)
      .map((c) => {
        const lower = c.text.toLowerCase();
        const mentions = names.some((n) => n !== c.b.name.toLowerCase() && lower.includes(n.split(" ")[0]));
        const words = c.text.split(/\s+/).length;
        return { ...c, interest: Math.abs(c.score - 3) * 1.6 + Math.min(words, 18) / 4 + (mentions ? 2.5 : 0) + (/[!?]|\d\/\d/.test(c.text) ? 1 : 0) };
      })
      .sort((a, b) => b.interest - a.interest)
      .slice(0, 16);
    const roasts = scored.filter((c) => c.score <= 2);
    const toasts = scored.filter((c) => c.score >= 4);
    const shrugs = scored.filter((c) => c.score === 3);
    const list = [];
    while (roasts.length || toasts.length || shrugs.length) {
      if (roasts.length) list.push(roasts.shift());
      if (toasts.length) list.push(toasts.shift());
      if (shrugs.length && list.length % 3 === 2) list.push(shrugs.shift());
      if (!roasts.length && !toasts.length && shrugs.length) list.push(shrugs.shift());
    }
    for (const sub of M.subs) if (sub.comment) list.push({ general: true, text: sub.comment, sub: sub.no });

    const s = shell("In their own words", "The roast &amp; toast", "Straight from the comment boxes. Anonymous, unedited, occasionally unhinged.");
    if (!list.length) {
      emptyNote(s, "No comments yet.");
      return { el: s };
    }
    body(s).innerHTML = `<div class="quote-wrap"><div class="quote-pic"></div><div class="quote-main"></div></div>`;
    const pic = $(".quote-pic", s);
    const main = $(".quote-main", s);
    let idx = 0;
    let typing = 0;
    let full = "";

    function show(i) {
      clearInterval(typing);
      idx = i;
      const q = list[i];
      let chip, col;
      if (q.general) [chip, col] = ["💬 Final thoughts", "#78665b"];
      else if (q.score <= 2) [chip, col] = ["🔥 The roast", SCORE[1]];
      else if (q.score >= 4) [chip, col] = ["🥂 The toast", SCORE[5]];
      else [chip, col] = ["🤷 The shrug", "#8a7d72"];
      pic.innerHTML = q.general
        ? `<div style="font-size:220px;line-height:1">💬</div>`
        : `${img(q.b)}<div class="bname">${esc(q.b.name)}</div><div class="stars">${"★".repeat(q.score)}<span class="off">${"★".repeat(5 - q.score)}</span></div>`;
      main.innerHTML = `<span class="chip" style="--c:${col}">${chip}</span><p class="quote-text"><span class="qt"></span><span class="caret"></span></p><p class="quote-meta">— Taster #${q.sub}${q.general ? "" : `, on ${esc(q.b.name)}`} · ${i + 1} of ${list.length}</p>`;
      full = `“${q.text}”`;
      const qt = $(".qt", main);
      const big = full.length > 110;
      $(".quote-text", main).style.fontSize = big ? "42px" : full.length > 60 ? "50px" : "60px";
      let n = 0;
      typing = setInterval(() => {
        n += 1;
        qt.textContent = full.slice(0, n);
        if (n >= full.length) clearInterval(typing);
      }, clamp(1400 / full.length, 14, 45));
    }
    const isTyping = () => $(".qt", main) && $(".qt", main).textContent.length < full.length;
    function finishTyping() {
      clearInterval(typing);
      $(".qt", main).textContent = full;
    }

    return {
      el: s,
      enter(fromEnd) {
        show(fromEnd ? list.length - 1 : 0);
      },
      leave() {
        clearInterval(typing);
      },
      next() {
        if (isTyping()) {
          finishTyping();
          return true;
        }
        if (idx < list.length - 1) {
          show(idx + 1);
          return true;
        }
        return false;
      },
      prev() {
        if (idx > 0) {
          show(idx - 1);
          return true;
        }
        return false;
      },
    };
  }

  // ================================================================ 8. leaderboard race
  function raceSlide(M) {
    const s = shell("Replay", "How the race unfolded", "");
    const N = M.subs.length;
    if (!N || !M.ranked.length) {
      emptyNote(s);
      return { el: s };
    }
    const bs = M.biscuits;
    // frames[k] = averages after the first k tasters
    const frames = [];
    const sum = Object.fromEntries(bs.map((b) => [b.id, 0]));
    const cnt = Object.fromEntries(bs.map((b) => [b.id, 0]));
    frames.push(bs.map((b) => ({ b, avg: 0, n: 0 })));
    for (const sub of M.subs) {
      for (const id in sub.scores) {
        sum[id] += sub.scores[id];
        cnt[id] += 1;
      }
      frames.push(bs.map((b) => ({ b, avg: cnt[b.id] ? sum[b.id] / cnt[b.id] : 0, n: cnt[b.id] })));
    }
    const order = (f) => f.slice().sort((a, b) => b.avg - a.avg || b.n - a.n || a.b.name.localeCompare(b.b.name));
    const leaders = frames.map((f, k) => (k ? order(f)[0].b : null));
    let changes = 0;
    for (let k = 2; k <= N; k++) if (leaders[k] !== leaders[k - 1]) changes++;
    const champ = leaders[N];
    const held = leaders.filter((l) => l === champ).length;
    const finalTake = `The lead changed hands <strong>${changes}</strong> time${changes === 1 ? "" : "s"}. <strong>${esc(champ.name)}</strong> led after ${held} of ${N} tasters.`;

    body(s).innerHTML = `
      <div class="race-wrap">
        <div class="race-side">
          <div class="race-count"><small>Taster</small><span class="rc">0</span><span style="font-size:32px;color:var(--muted)"> / ${N}</span></div>
          <div class="race-time">&nbsp;</div>
          <div class="race-leader"><small>Leading</small><img alt="" hidden><strong class="rl">—</strong></div>
          <button class="race-btn" type="button">↻ Replay</button>
        </div>
        <div class="race-board">
          <div class="race-grid">${[1, 2, 3, 4, 5].map((k) => `<span style="left:${(k / 5) * 100}%">${k}★</span>`).join("")}</div>
        </div>
      </div>`;
    const board = $(".race-board", s);
    const rowH = 586 / bs.length;
    const rows = new Map(
      bs.map((b) => {
        const row = document.createElement("div");
        row.className = "race-row";
        row.style.height = `${rowH}px`;
        row.innerHTML = `<span class="rk"></span>${img(b)}<span class="nm">${esc(b.name)}</span><div class="race-track"><div class="race-fill"></div><span class="race-val"></span></div>`;
        board.appendChild(row);
        return [b.id, row];
      }),
    );
    const leaderBox = $(".race-leader", s);
    let timer = 0;
    function apply(k) {
      const ordered = order(frames[k]);
      ordered.forEach((e, i) => {
        const row = rows.get(e.b.id);
        row.style.transform = `translateY(${i * rowH}px)`;
        $(".rk", row).textContent = e.n ? i + 1 : "";
        const w = `${(e.avg / 5) * 100}%`;
        $(".race-fill", row).style.width = w;
        const val = $(".race-val", row);
        val.style.setProperty("--w", w);
        val.textContent = e.n ? fmt(e.avg) : "";
        row.classList.toggle("lead", k > 0 && i === 0);
      });
      $(".rc", s).textContent = k;
      const sub = M.subs[k - 1];
      $(".race-time", s).textContent = sub && sub.t ? sub.t.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : " ";
      const L = leaders[k];
      const li = $("img", leaderBox);
      if (L) {
        if (li.getAttribute("src") !== L.image) {
          li.src = L.image;
          leaderBox.classList.remove("bump");
          void leaderBox.offsetWidth;
          leaderBox.classList.add("bump");
        }
        li.hidden = false;
        $(".rl", s).textContent = L.name;
      } else {
        li.hidden = true;
        $(".rl", s).textContent = "—";
      }
    }
    function play() {
      clearTimeout(timer);
      $(".takeaway", s).innerHTML = "&nbsp;";
      apply(0);
      const dur = clamp(16000 / N, 220, 1300);
      let k = 0;
      const tick = () => {
        k += 1;
        apply(k);
        if (k < N) timer = setTimeout(tick, dur);
        else timer = setTimeout(() => ($(".takeaway", s).innerHTML = finalTake), 700);
      };
      timer = setTimeout(tick, 700);
    }
    $(".race-btn", s).addEventListener("click", play);
    return {
      el: s,
      enter: play,
      leave() {
        clearTimeout(timer);
      },
    };
  }

  // ================================================================ 9. podium
  function podiumSlide(M) {
    const s = shell("And the winner is…", "The podium", "");
    const R = M.ranked;
    if (R.length < 3) {
      emptyNote(s);
      return { el: s };
    }
    const last = R[R.length - 1];
    const spoons = R.filter((b) => Math.abs(b.mean - last.mean) < 1e-9);
    body(s).innerHTML = `
      <div class="podium">
        <div class="spoon">${img(spoons[0])}<div><small>🥄 Wooden spoon</small><strong>${spoons.map((b) => esc(b.name)).join(" &amp; ")}</strong><span>${fmt(last.mean)} average${spoons.length > 1 ? " — a tie for last!" : ""}</span></div></div>
        ${[0, 1, 2]
          .map(
            (i) =>
              `<div class="pod p${i + 1}">${img(R[i])}<div class="pname">${esc(R[i].name)}</div><div class="pscore">${fmt(R[i].mean)} avg · ${R[i].n} votes</div><div class="block">${i + 1}</div></div>`,
          )
          .join("")}
        <canvas class="confetti" width="1440" height="600"></canvas>
      </div>`;
    const steps = [$(".spoon", s), $(".pod.p3", s), $(".pod.p2", s), $(".pod.p1", s)];
    const takes = [
      "Let's start at the bottom…",
      `…the wooden spoon goes to <strong>${spoons.map((b) => esc(b.name)).join(" &amp; ")}</strong>.`,
      `Bronze: <strong>${esc(R[2].name)}</strong>.`,
      `Silver: <strong>${esc(R[1].name)}</strong>.`,
      `Your office's favourite biscuit: <strong>${esc(R[0].name)}</strong>! 🎉`,
    ];
    let shown = 0;
    let raf = 0;
    function setStep(n) {
      shown = n;
      steps.forEach((el, i) => el.classList.toggle("show", i < n));
      $(".takeaway", s).innerHTML = takes[n];
      if (n === 4) confetti();
    }
    function confetti() {
      const cv = $(".confetti", s);
      const ctx = cv.getContext("2d");
      const cols = ["#a94f28", "#f4c74f", "#2f6aa8", "#c2662d", "#8db3d6", "#e0957a"];
      const rand = seeded(Date.now());
      const parts = Array.from({ length: 220 }, () => ({
        x: cv.width / 2 + (rand() - 0.5) * 200,
        y: cv.height * 0.45,
        vx: (rand() - 0.5) * 18,
        vy: -rand() * 18 - 6,
        w: 6 + rand() * 8,
        h: 4 + rand() * 6,
        a: rand() * Math.PI,
        va: (rand() - 0.5) * 0.3,
        c: cols[Math.floor(rand() * cols.length)],
      }));
      const start = performance.now();
      cancelAnimationFrame(raf);
      const frame = (now) => {
        ctx.clearRect(0, 0, cv.width, cv.height);
        for (const p of parts) {
          p.vy += 0.42;
          p.vx *= 0.99;
          p.x += p.vx;
          p.y += p.vy;
          p.a += p.va;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.a);
          ctx.fillStyle = p.c;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.restore();
        }
        if (now - start < 5000 && s.classList.contains("active")) raf = requestAnimationFrame(frame);
        else ctx.clearRect(0, 0, cv.width, cv.height);
      };
      raf = requestAnimationFrame(frame);
    }
    return {
      el: s,
      enter(fromEnd) {
        setStep(fromEnd ? 4 : 0);
      },
      leave() {
        cancelAnimationFrame(raf);
      },
      next() {
        if (shown < 4) {
          setStep(shown + 1);
          return true;
        }
        return false;
      },
      prev() {
        if (shown > 0) {
          setStep(shown - 1);
          return true;
        }
        return false;
      },
    };
  }

  // ---------------------------------------------------------------- deck
  const FACTORIES = [titleSlide, ridgeSlide, scatterSlide, networkSlide, packSlide, plinkoSlide, quoteSlide, raceSlide, podiumSlide];
  const stage = $("#stage");
  const dotsEl = $("#deck-dots");
  let slides = [];
  let current = -1;

  function fit() {
    const sc = Math.min(innerWidth / 1600, innerHeight / 900);
    stage.style.setProperty("--scale", sc);
  }
  addEventListener("resize", fit);
  fit();

  function build(M) {
    stage.innerHTML = "";
    slides = FACTORIES.map((f) => {
      try {
        return f(M);
      } catch (err) {
        console.error(err);
        const s = shell("Oops", "This slide hit a snag", esc(err.message));
        return { el: s };
      }
    });
    for (const sl of slides) stage.appendChild(sl.el);
    dotsEl.innerHTML = slides.map((_, i) => `<button type="button" aria-label="Slide ${i + 1}"></button>`).join("");
    [...dotsEl.children].forEach((b, i) => b.addEventListener("click", () => go(i)));
  }

  function go(i, fromEnd) {
    i = clamp(i, 0, slides.length - 1);
    hideTip();
    if (current >= 0 && slides[current]) {
      slides[current].el.classList.remove("active");
      slides[current].leave?.();
    }
    current = i;
    const sl = slides[i];
    sl.el.classList.add("active");
    sl.enter?.(fromEnd);
    [...dotsEl.children].forEach((b, j) => b.classList.toggle("on", j === i));
    history.replaceState(null, "", `#${i + 1}`);
  }
  function next() {
    const sl = slides[current];
    if (sl?.next?.()) return;
    if (current < slides.length - 1) go(current + 1);
  }
  function prev() {
    const sl = slides[current];
    if (sl?.prev?.()) return;
    if (current > 0) go(current - 1, true);
  }

  addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) {
      e.preventDefault();
      next();
    } else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) {
      e.preventDefault();
      prev();
    } else if (e.key === "Home") go(0);
    else if (e.key === "End") go(slides.length - 1);
    else if (e.key === "f" || e.key === "F") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    } else if (e.key === "r" || e.key === "R") load(true);
  });
  $("#nav-next").addEventListener("click", next);
  $("#nav-prev").addEventListener("click", prev);

  // nav fades out when the mouse is still, so the screen share stays clean
  const nav = $("#deck-nav");
  let idleT = 0;
  const wake = () => {
    nav.classList.remove("idle");
    clearTimeout(idleT);
    idleT = setTimeout(() => nav.classList.add("idle"), 2500);
  };
  addEventListener("mousemove", wake);
  wake();

  // ---------------------------------------------------------------- data loading
  // /api/show is public and anonymised: scores and comments, no names or emails.
  async function fetchData() {
    const res = await fetch(`${API_BASE}/api/show`, { headers: { Accept: "application/json" } });
    let body;
    try {
      body = await res.json();
    } catch (_) {
      throw new Error("Unexpected server response");
    }
    if (!res.ok || !body.ok) throw new Error(body.error || "Could not load results");
    return body;
  }

  async function load(keepSlide) {
    try {
      const raw = await fetchData();
      $("#status").hidden = true;
      const keep = keepSlide ? current : Number((location.hash || "").slice(1)) - 1;
      build(buildModel(raw));
      current = -1;
      go(Number.isFinite(keep) && keep >= 0 ? keep : 0);
    } catch (err) {
      console.error(err);
      if (!slides.length) showStatus(`Couldn't reach the server: ${err.message}`);
    }
  }

  function showStatus(msg) {
    $("#status").hidden = false;
    $("#status-msg").textContent = msg;
    $("#status-retry").hidden = false;
  }
  $("#status-retry").addEventListener("click", () => {
    $("#status-msg").textContent = "Loading the results…";
    $("#status-retry").hidden = true;
    load(false);
  });

  load(false);
})();
