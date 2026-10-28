(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const STORAGE_KEY = "biscuit-arena-participant-name";
  // Empty when the frontend is served by the API itself; set in api-config.js when hosted apart.
  const API_BASE = String(window.ARENA_API_BASE || "").replace(/\/+$/, "");
  const scoreDescriptions = ["", "Not for me", "Not bad", "Pretty good", "Really good", "All-time favourite"];

  const state = {
    config: null,
    name: "",
    biscuits: [],
    ratings: new Map(),
    currentScreen: "welcome",
    submitting: false,
    resultsRequest: 0,
  };

  const elements = {
    name: $("#participant-name"),
    nameError: $("#name-error"),
    ratingsForm: $("#ratings-form"),
    biscuitList: $("#biscuit-list"),
    ratingLoading: $("#rating-loading"),
    ratingLoadError: $("#rating-load-error"),
    ratingLoadErrorMessage: $("#rating-load-error-message"),
    submitButton: $("#submit-ratings"),
    submitLabel: $("#submit-label"),
    submitError: $("#submit-error"),
    resultsLoading: $("#results-loading"),
    resultsError: $("#results-error"),
    leaderboard: $("#leaderboard"),
    leaderCard: $("#leader-card"),
    emptyResults: $("#empty-results"),
    resultsStats: $("#results-stats"),
    refreshResults: $("#refresh-results"),
  };

  async function api(path, options) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options && options.body ? { "Content-Type": "application/json" } : {}),
        ...(options && options.headers ? options.headers : {}),
      },
    });

    let data;
    try {
      data = await response.json();
    } catch (_) {
      throw new Error("The server sent an unexpected response. Please try again.");
    }

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Something went wrong. Please try again.");
    }
    return data;
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[character]);
  }

  function saveName(name) {
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch (_) {
      // The app still works when storage is blocked or full.
    }
  }

  function requireName() {
    const name = elements.name.value.trim();
    if (!name) {
      elements.nameError.textContent = "Add your name before you start judging.";
      elements.nameError.hidden = false;
      elements.name.setAttribute("aria-invalid", "true");
      elements.name.focus();
      return false;
    }
    state.name = name;
    saveName(name);
    clearNameError();
    return true;
  }

  function clearNameError() {
    elements.nameError.hidden = true;
    elements.name.removeAttribute("aria-invalid");
  }

  function showScreen(name, options) {
    const settings = { focus: true, ...(options || {}) };
    $$(".screen").forEach((screen) => {
      screen.hidden = screen.id !== `${name}-screen`;
    });
    state.currentScreen = name;
    window.scrollTo({ top: 0, behavior: "auto" });

    if (settings.focus && name !== "welcome") {
      const heading = $(`#${name}-screen h2`);
      if (heading) requestAnimationFrame(() => heading.focus({ preventScroll: true }));
    }
  }

  function goHome() {
    showScreen("welcome", { focus: false });
  }

  async function loadConfig() {
    const config = await api("/api/config");
    state.config = config;
    state.biscuits = Array.isArray(config.biscuits) ? config.biscuits : [];
    $("#welcome-title").textContent = config.title;
    $("#welcome-subtitle").textContent = config.subtitle;
    document.title = config.title;
    return config;
  }

  // ---------------------------------------------------------------- ratings
  function updateProgress() {
    const total = state.biscuits.length;
    const rated = state.biscuits.reduce((count, biscuit) => count + (state.ratings.has(biscuit.id) ? 1 : 0), 0);
    const remaining = total - rated;
    const complete = total > 0 && rated === total;

    $("#rating-progress-text").textContent = `Rated ${rated} of ${total}`;
    $("#rating-progress-note").textContent = complete ? "Judging card complete!" : rated === 0 ? "Let’s get tasting" : `${remaining} to go`;
    $("#rating-progressbar").setAttribute("aria-valuemax", String(total));
    $("#rating-progressbar").setAttribute("aria-valuenow", String(rated));
    $("#rating-progress-fill").style.width = total ? `${(rated / total) * 100}%` : "0%";
    $("#dock-progress").textContent = `${rated} / ${total} rated`;
    $("#dock-message").textContent = complete ? "Ready to crown a champion" : "Rate every biscuit to submit";
    elements.submitButton.disabled = !complete || state.submitting;
  }

  function updateRatingCard(biscuitId, animate) {
    const card = Array.from(elements.biscuitList.children).find((item) => item.dataset.biscuitId === biscuitId);
    if (!card) return;
    const biscuit = state.biscuits.find((item) => item.id === biscuitId);
    const score = state.ratings.get(biscuitId) || 0;

    card.classList.toggle("is-rated", score > 0);
    card.querySelectorAll(".star-button").forEach((button) => {
      const buttonScore = Number(button.dataset.score);
      const filled = buttonScore <= score;
      button.classList.toggle("is-filled", filled);
      button.textContent = filled ? "★" : "☆";
      button.setAttribute("aria-pressed", String(buttonScore === score));
    });
    card.querySelector(".rating-hint").textContent = score ? `${score}/5 · ${scoreDescriptions[score]}` : "Tap to rate";

    if (animate) {
      card.classList.remove("just-rated");
      void card.offsetWidth;
      card.classList.add("just-rated");
      setTimeout(() => card.classList.remove("just-rated"), 300);
    }

    if (biscuit) card.setAttribute("aria-label", `${biscuit.name}, ${score ? `rated ${score} out of 5` : "not rated"}`);
  }

  function renderBiscuits() {
    elements.biscuitList.innerHTML = state.biscuits.map((biscuit) => {
      const id = escapeHTML(biscuit.id);
      const name = escapeHTML(biscuit.name);
      const emoji = escapeHTML(biscuit.emoji || "🍪");
      const stars = [1, 2, 3, 4, 5].map((score) => `
        <button class="star-button" type="button" data-biscuit-id="${id}" data-score="${score}"
          aria-label="Rate ${name} ${score} out of 5" aria-pressed="false">☆</button>
      `).join("");

      return `
        <article class="biscuit-card" data-biscuit-id="${id}">
          <div class="biscuit-heading">
            <span class="biscuit-emoji" aria-hidden="true">${emoji}</span>
            <div class="biscuit-title">
              <h3>${name}</h3>
              <span class="rating-hint">Tap to rate</span>
            </div>
          </div>
          <div class="star-rating" role="group" aria-label="${name} rating">${stars}</div>
          <label class="sr-only" for="note-${id}">Optional note for ${name}</label>
          <input class="biscuit-note" id="note-${id}" data-note-id="${id}" type="text" maxlength="500" placeholder="Optional note" />
        </article>
      `;
    }).join("");
    updateProgress();
  }

  async function startRating() {
    if (!requireName()) return;

    state.ratings = new Map();
    state.submitting = false;
    elements.submitError.hidden = true;
    elements.submitLabel.textContent = "Submit my scores";
    $("#overall-comment").value = "";
    elements.biscuitList.innerHTML = "";
    elements.ratingsForm.hidden = true;
    elements.ratingLoadError.hidden = true;
    elements.ratingLoading.hidden = false;
    showScreen("rating");

    try {
      // The biscuit list comes from /api/config, loaded once at startup and reused.
      if (!state.biscuits.length) await loadConfig();
      if (!state.biscuits.length) throw new Error("The judging card came back empty. Please try again.");
      renderBiscuits();
      elements.ratingLoading.hidden = true;
      elements.ratingsForm.hidden = false;
    } catch (error) {
      elements.ratingLoading.hidden = true;
      elements.ratingLoadError.hidden = false;
      const message = error && error.message ? error.message : "";
      // fetch() rejects with "Failed to fetch"; show the friendly copy instead.
      elements.ratingLoadErrorMessage.textContent =
        !message || /failed to fetch|networkerror|load failed|fetch failed/i.test(message)
          ? "Check your connection and try again."
          : message;
    }
  }

  function handleStarClick(event) {
    const button = event.target.closest(".star-button");
    if (!button || state.submitting) return;
    const id = button.dataset.biscuitId;
    const score = Number(button.dataset.score);
    if (!state.biscuits.some((biscuit) => biscuit.id === id) || score < 1 || score > 5) return;

    state.ratings.set(id, score);
    updateRatingCard(id, true);
    updateProgress();
    if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) {
      navigator.vibrate(8);
    }
  }

  async function submitRatings(event) {
    event.preventDefault();
    if (state.submitting || !state.biscuits.length) return;

    const rated = state.biscuits.filter((biscuit) => state.ratings.has(biscuit.id)).length;
    if (rated !== state.biscuits.length) {
      updateProgress();
      return;
    }

    state.submitting = true;
    elements.submitError.hidden = true;
    elements.submitLabel.textContent = "Sending scores…";
    updateProgress();

    const ratings = state.biscuits.map((biscuit) => {
      const note = elements.biscuitList.querySelector(`[data-note-id="${CSS.escape(biscuit.id)}"]`);
      return {
        id: biscuit.id,
        score: state.ratings.get(biscuit.id),
        comment: note ? note.value.trim() : "",
      };
    });
    const payload = {
      name: state.name,
      comment: $("#overall-comment").value.trim(),
      ratings,
    };

    try {
      await api("/api/submissions", { method: "POST", body: JSON.stringify(payload) });
      const average = ratings.reduce((sum, rating) => sum + rating.score, 0) / ratings.length;
      $("#success-name").textContent = state.name;
      $("#success-average").textContent = average.toFixed(1);
      showScreen("success");
    } catch (error) {
      elements.submitError.textContent = error.message;
      elements.submitError.hidden = false;
      elements.submitError.setAttribute("tabindex", "-1");
      elements.submitError.focus();
    } finally {
      state.submitting = false;
      elements.submitLabel.textContent = "Submit my scores";
      updateProgress();
    }
  }

  // ---------------------------------------------------------------- results
  function formatVotes(votes) {
    return `${votes} ${votes === 1 ? "vote" : "votes"}`;
  }

  function renderResults(data) {
    const biscuits = data.biscuits.slice().sort((a, b) => {
      return Number(b.avg || 0) - Number(a.avg || 0) || Number(b.votes || 0) - Number(a.votes || 0) || a.name.localeCompare(b.name);
    });
    const hasVotes = biscuits.some((biscuit) => Number(biscuit.votes) > 0);
    const leader = data.leader && Number(data.leader.votes) > 0 ? data.leader : null;

    $("#total-participants").textContent = String(data.total);
    $("#recent-submissions").textContent = String(data.recent.length);
    elements.resultsStats.hidden = false;
    elements.emptyResults.hidden = hasVotes;
    elements.leaderboard.hidden = !hasVotes;
    elements.leaderCard.hidden = !leader;

    if (leader) {
      $("#leader-emoji").textContent = leader.emoji || "🍪";
      $("#leader-name").textContent = leader.name;
      $("#leader-votes").textContent = formatVotes(Number(leader.votes));
      $("#leader-average").textContent = Number(leader.avg).toFixed(1);
    }

    elements.leaderboard.innerHTML = hasVotes ? biscuits.map((biscuit, index) => {
      const average = Number(biscuit.avg || 0);
      const votes = Number(biscuit.votes || 0);
      const width = Math.max(0, Math.min(100, (average / 5) * 100));
      const isLeader = leader && biscuit.id === leader.id;
      return `
        <article class="result-row${isLeader ? " is-leader" : ""}">
          <span class="result-rank">${index + 1}</span>
          <span class="result-emoji" aria-hidden="true">${escapeHTML(biscuit.emoji || "🍪")}</span>
          <strong class="result-name">${escapeHTML(biscuit.name)}</strong>
          <span class="result-score">${average.toFixed(1)}<small> / 5</small></span>
          <div class="result-bar" aria-hidden="true"><span style="width: ${width}%"></span></div>
          <span class="result-votes">${formatVotes(votes)}</span>
        </article>
      `;
    }).join("") : "";

    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());
    $("#results-updated").textContent = `Updated at ${time}`;
  }

  async function loadResults() {
    const request = ++state.resultsRequest;
    showScreen("results");
    elements.resultsLoading.hidden = false;
    elements.resultsError.hidden = true;
    elements.resultsStats.hidden = true;
    elements.leaderCard.hidden = true;
    elements.leaderboard.hidden = true;
    elements.emptyResults.hidden = true;
    elements.refreshResults.classList.add("is-loading");
    elements.refreshResults.disabled = true;
    $("#results-updated").textContent = "";

    try {
      const results = await api("/api/results");
      if (request !== state.resultsRequest) return;
      renderResults(results);
      elements.resultsLoading.hidden = true;
    } catch (error) {
      if (request !== state.resultsRequest) return;
      elements.resultsLoading.hidden = true;
      elements.resultsError.hidden = false;
      $("#results-error-message").textContent = error.message;
    } finally {
      if (request === state.resultsRequest) {
        elements.refreshResults.classList.remove("is-loading");
        elements.refreshResults.disabled = false;
      }
    }
  }

  function bindEvents() {
    $("#brand-home").addEventListener("click", goHome);
    $("#start-judging").addEventListener("click", startRating);

    elements.name.addEventListener("input", clearNameError);
    elements.name.addEventListener("change", () => {
      if (elements.name.value.trim()) saveName(elements.name.value.trim());
    });
    elements.name.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      startRating();
    });

    $("#rating-back").addEventListener("click", goHome);
    $("#retry-form").addEventListener("click", () => {
      // Drop the cached list so the retry re-fetches /api/config.
      state.biscuits = [];
      startRating();
    });
    elements.biscuitList.addEventListener("click", handleStarClick);
    elements.ratingsForm.addEventListener("submit", submitRatings);

    $("#rate-again").addEventListener("click", () => startRating());
    $("#success-results").addEventListener("click", loadResults);
    $("#success-home").addEventListener("click", goHome);

    $("#view-results").addEventListener("click", loadResults);
    $("#results-back").addEventListener("click", goHome);
    elements.refreshResults.addEventListener("click", loadResults);
    $("#retry-results").addEventListener("click", loadResults);
    $("#results-rate").addEventListener("click", () => {
      if (!requireName()) {
        showScreen("welcome", { focus: false });
        elements.name.focus();
        return;
      }
      startRating();
    });
  }

  function init() {
    try {
      const savedName = localStorage.getItem(STORAGE_KEY);
      if (savedName) elements.name.value = savedName;
    } catch (_) {
      // Storage is optional.
    }
    bindEvents();
    // Load the biscuits once. If this fails, the static welcome copy stands in and
    // startRating() retries the request and shows its own error state.
    loadConfig().catch(() => {});
  }

  init();
})();
