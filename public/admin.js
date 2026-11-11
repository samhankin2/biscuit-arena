(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const API_BASE = String(window.ARENA_API_BASE || "").replace(/\/+$/, "");
  const PW_KEY = "biscuit-arena-admin-pw";

  let password = "";
  let data = { biscuits: [], submissions: [] };

  function readPw() {
    try { return sessionStorage.getItem(PW_KEY) || ""; } catch (_) { return ""; }
  }
  function savePw(pw) {
    try { pw ? sessionStorage.setItem(PW_KEY, pw) : sessionStorage.removeItem(PW_KEY); } catch (_) {}
  }

  async function api(path, method) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: method || "GET",
      headers: { Accept: "application/json", "x-admin-password": password },
    });
    let body;
    try { body = await res.json(); } catch (_) { throw new Error("Unexpected server response"); }
    if (res.status === 401) {
      const err = new Error(body.error || "Wrong password");
      err.unauthorised = true;
      throw err;
    }
    if (!res.ok || !body.ok) throw new Error(body.error || "Something went wrong");
    return body;
  }

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function biscuitName(id) {
    const b = data.biscuits.find((x) => x.id === id);
    return b ? `${b.emoji || ""} ${b.name}`.trim() : id;
  }

  function avg(list) {
    return list.length ? list.reduce((a, r) => a + r.score, 0) / list.length : 0;
  }

  function showError(msg) {
    const el = $("#admin-error");
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  // ---------------------------------------------------------------- render
  function render() {
    const subs = data.submissions;
    const allRatings = subs.flatMap((s) => s.ratings);

    $("#admin-stats").innerHTML = [
      [subs.length, "Submissions"],
      [allRatings.length, "Ratings"],
      [allRatings.length ? avg(allRatings).toFixed(2) : "–", "Overall avg"],
    ]
      .map(([n, l]) => `<div><strong>${esc(n)}</strong><span>${esc(l)}</span></div>`)
      .join("");

    const rows = data.biscuits
      .map((b) => {
        const rs = allRatings.filter((r) => r.biscuit_id === b.id);
        return { b, n: rs.length, avg: avg(rs) };
      })
      .sort((a, z) => z.avg - a.avg);
    $("#admin-averages").innerHTML =
      "<thead><tr><th>#</th><th>Biscuit</th><th class='num'>Avg</th><th class='num'>Votes</th></tr></thead><tbody>" +
      rows
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td>${esc(biscuitName(r.b.id))}</td><td class="num">${r.n ? r.avg.toFixed(2) : "–"}</td><td class="num">${r.n}</td></tr>`,
        )
        .join("") +
      "</tbody>";

    renderList();
  }

  function renderList() {
    const q = $("#admin-filter").value.trim().toLowerCase();
    const open = new Set(
      Array.from(document.querySelectorAll(".admin-sub[open]")).map((d) => d.dataset.id),
    );
    const subs = data.submissions.filter((s) => {
      if (!q) return true;
      const hay = [s.name, s.comment, s.email, s.code, ...s.ratings.map((r) => r.comment)].join(" ").toLowerCase();
      return hay.includes(q);
    });

    if (!subs.length) {
      $("#admin-list").innerHTML = `<p class="admin-empty">${q ? "No matches." : "No submissions yet."}</p>`;
      return;
    }

    // Same name on different devices: worth a look (could be two people, could be a repeat voter).
    const nameCounts = new Map();
    for (const x of data.submissions) {
      const key = String(x.name || "").trim().toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }

    $("#admin-list").innerHTML = subs
      .map((s) => {
        const dupes = nameCounts.get(String(s.name || "").trim().toLowerCase()) || 0;
        const ratings = s.ratings
          .slice()
          .sort((a, z) => data.biscuits.findIndex((b) => b.id === a.biscuit_id) - data.biscuits.findIndex((b) => b.id === z.biscuit_id))
          .map(
            (r) => `<tr>
              <td>${esc(biscuitName(r.biscuit_id))}</td>
              <td class="num">${"★".repeat(r.score)}<span style="opacity:.25">${"★".repeat(5 - r.score)}</span> ${r.score}</td>
              <td>${esc(r.comment)}</td>
              <td class="num"><button class="admin-delete" type="button" data-action="del-rating" data-id="${s.id}" data-biscuit="${esc(r.biscuit_id)}">Delete</button></td>
            </tr>`,
          )
          .join("");
        return `<details class="admin-sub" data-id="${s.id}"${open.has(String(s.id)) ? " open" : ""}>
          <summary>
            <span class="admin-sub-name">${esc(s.name)}</span>
            <span class="admin-sub-meta">#${s.id} · ${esc(formatDate(s.created_at))}${s.updated_at ? ` · edited ${esc(formatDate(s.updated_at))}` : ""} · ${s.ratings.length} rated</span>
            ${dupes > 1 ? `<span class="admin-flag" title="Another submission uses this name">Same name ×${dupes}</span>` : ""}
            <span class="admin-sub-avg">${s.ratings.length ? avg(s.ratings).toFixed(2) : "–"} ★</span>
          </summary>
          <div class="admin-sub-body">
            ${s.comment ? `<p class="admin-sub-comment">“${esc(s.comment)}”</p>` : ""}
            ${s.email ? `<p class="admin-sub-meta">${esc(s.email)}</p>` : ""}
            <p class="admin-sub-meta">Device: ${s.device_id ? esc(s.device_id.slice(0, 8)) : "unknown (before device tracking)"}</p>
            ${ratings ? `<div class="admin-table-wrap"><table class="admin-table"><tbody>${ratings}</tbody></table></div>` : `<p class="admin-sub-meta">No ratings left.</p>`}
            <button class="admin-delete admin-delete-all" type="button" data-action="del-sub" data-id="${s.id}">Delete whole submission</button>
          </div>
        </details>`;
      })
      .join("");
  }

  function formatDate(sqlUtc) {
    // SQLite datetime('now') is UTC without a zone marker.
    const d = new Date(String(sqlUtc).replace(" ", "T") + "Z");
    return isNaN(d) ? sqlUtc : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  // ---------------------------------------------------------------- actions
  async function load() {
    showError("");
    try {
      data = await api("/api/admin/submissions");
      render();
    } catch (err) {
      if (err.unauthorised) return logout(err.message);
      showError(err.message);
    }
  }

  function logout(msg) {
    password = "";
    savePw("");
    $("#admin-screen").hidden = true;
    $("#login-screen").hidden = false;
    const e = $("#login-error");
    e.textContent = msg || "";
    e.hidden = !msg;
    $("#admin-password").focus();
  }

  $("#login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    password = $("#admin-password").value;
    try {
      data = await api("/api/admin/submissions");
    } catch (err) {
      const e = $("#login-error");
      e.textContent = err.unauthorised ? "Wrong password" : err.message;
      e.hidden = false;
      return;
    }
    savePw(password);
    $("#login-screen").hidden = true;
    $("#admin-screen").hidden = false;
    $("#admin-password").value = "";
    render();
  });

  $("#admin-list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const sub = data.submissions.find((s) => String(s.id) === id);
    let path;
    if (btn.dataset.action === "del-sub") {
      if (!confirm(`Delete ${sub ? sub.name : "this"}'s whole submission (#${id})?`)) return;
      path = `/api/admin/submissions/${id}`;
    } else {
      const b = btn.dataset.biscuit;
      if (!confirm(`Delete ${sub ? sub.name : "this"}'s rating for ${biscuitName(b)}?`)) return;
      path = `/api/admin/submissions/${id}/ratings/${encodeURIComponent(b)}`;
    }
    btn.disabled = true;
    try {
      await api(path, "DELETE");
      await load();
    } catch (err) {
      btn.disabled = false;
      if (err.unauthorised) return logout(err.message);
      showError(err.message);
    }
  });

  $("#admin-filter").addEventListener("input", renderList);
  $("#admin-refresh").addEventListener("click", load);
  $("#admin-logout").addEventListener("click", () => logout(""));

  $("#admin-export").addEventListener("click", () => {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["id", "name", "created_at", "comment", ...data.biscuits.map((b) => b.name)];
    const lines = [header.map(cell).join(",")];
    for (const s of data.submissions) {
      const scores = data.biscuits.map((b) => (s.ratings.find((r) => r.biscuit_id === b.id) || {}).score ?? "");
      lines.push([s.id, s.name, s.created_at, s.comment, ...scores].map(cell).join(","));
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "biscuit-arena-ratings.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // Auto-login within the same tab session.
  const saved = readPw();
  if (saved) {
    password = saved;
    api("/api/admin/submissions")
      .then((d) => {
        data = d;
        $("#login-screen").hidden = true;
        $("#admin-screen").hidden = false;
        render();
      })
      .catch(() => logout(""));
  }
})();
