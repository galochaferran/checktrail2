/* Category 2 — Mirror Vote
   Schema: category_two
   Players get the same questions in different shuffled orders.
   Votes are anonymous. Results = bar charts + personal trait body.
*/

(() => {
  "use strict";

  const SUPABASE_URL = window.SUPABASE_CONFIG?.url || "";
  const SUPABASE_KEY = window.SUPABASE_CONFIG?.publishableKey || "";
  const supabase = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY, {
    db: { schema: "category_two" },
  });
  const db = () => supabase.schema("category_two");

  const $ = (s, r = document) => r.querySelector(s);

  const screens = {
    home: $("#screen-home"),
    lobby: $("#screen-lobby"),
    play: $("#screen-play"),
    wait: $("#screen-wait"),
    results: $("#screen-results"),
  };

  const els = {
    homeForm: $("#home-form"),
    playerName: $("#player-name"),
    roomCode: $("#room-code"),
    btnCreate: $("#btn-create"),
    btnJoin: $("#btn-join"),
    homeError: $("#home-error"),
    lobbyCode: $("#lobby-code"),
    btnCopy: $("#btn-copy"),
    playerList: $("#player-list"),
    lobbyStatus: $("#lobby-status"),
    btnStart: $("#btn-start"),
    lobbyHint: $("#lobby-hint"),
    progressChip: $("#progress-chip"),
    questionText: $("#question-text"),
    nomineeGrid: $("#nominee-grid"),
    waitCopy: $("#wait-copy"),
    waitStat: $("#wait-stat"),
    charts: $("#charts"),
    traitList: $("#trait-list"),
    bodyFigure: $("#body-figure"),
    toast: $("#toast"),
  };

  let me = { id: null, name: "", isHost: false };
  let roomCode = null;

  function sessionKey(code) {
    return `c2-session-${String(code || "").toUpperCase()}`;
  }
  function saveSession() {
    if (!roomCode || !me?.id) return;
    try {
      localStorage.setItem(
        sessionKey(roomCode),
        JSON.stringify({ id: me.id, name: me.name, isHost: me.isHost, roomCode })
      );
    } catch (_) {}
  }
  function loadSession(code) {
    try {
      const raw = localStorage.getItem(sessionKey(code));
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }
  function clearSession(code) {
    try {
      localStorage.removeItem(sessionKey(code));
    } catch (_) {}
  }
  let channel = null;
  let players = [];
  let questions = [];
  let myOrder = [];
  let myIndex = 0;
  let myVotes = {}; // questionId -> nomineeId
  let phase = "home";
  let toastTimer = null;
  let votingLock = false;
  let waitPollTimer = null;

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function makeRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) out += chars[(Math.random() * chars.length) | 0];
    return out;
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function show(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2400);
  }

  function setError(msg) {
    els.homeError.hidden = !msg;
    els.homeError.textContent = msg || "";
  }

  function inviteUrl(code) {
    const url = new URL(location.href);
    url.searchParams.set("room", code);
    url.searchParams.delete("host");
    return url.toString();
  }

  async function loadQuestionBank() {
    const { data, error } = await db()
      .from("question_bank")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    questions = data || [];
    if (!questions.length) throw new Error("No Category 2 questions found in Supabase.");
  }

  async function refreshPlayers(opts = {}) {
    const { data, error } = await db()
      .from("players")
      .select("*")
      .eq("room_id", roomCode)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    players = data || [];
    const self = players.find((p) => p.id === me.id);
    if (self?.question_order?.length) myOrder = self.question_order;
    renderLobby();
    if (!opts.silent && (phase === "playing" || phase === "wait")) {
      await maybeAdvanceFromVotes();
    }
  }

  async function refreshRoom() {
    const { data, error } = await db()
      .from("rooms")
      .select("*")
      .eq("code", roomCode)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return;
    if (data.phase === "playing" && phase === "lobby") {
      phase = "playing";
      await beginPlaying();
    } else if (data.phase === "results") {
      phase = "results";
      await showResults();
    }
  }

  async function subscribe() {
    if (channel) supabase.removeChannel(channel);
    channel = supabase
      .channel(`c2:${roomCode}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "category_two", table: "players", filter: `room_id=eq.${roomCode}` },
        () => refreshPlayers().catch(console.error)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "category_two", table: "rooms", filter: `code=eq.${roomCode}` },
        () => refreshRoom().catch(console.error)
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "category_two", table: "votes", filter: `room_id=eq.${roomCode}` },
        () => maybeAdvanceFromVotes().catch(console.error)
      )
      .subscribe();
  }

  function renderLobby() {
    els.lobbyCode.textContent = roomCode;
    els.playerList.innerHTML = "";
    players.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${escapeHtml(p.name)}</span><span>${p.id === me.id ? "you" : p.is_host ? "host" : "joined"}</span>`;
      els.playerList.appendChild(li);
    });
    const ready = players.length >= 2;
    els.lobbyStatus.textContent = `${players.length} player${players.length === 1 ? "" : "s"}`;
    els.lobbyHint.textContent = ready
      ? me.isHost
        ? "Start when ready — each player gets a unique question order."
        : "Waiting for the host to start."
      : "Need at least 2 players.";
    els.btnStart.hidden = !me.isHost;
    els.btnStart.disabled = !ready;
  }

  async function createRoom(name) {
    await loadQuestionBank();
    const code = makeRoomCode();
    me = { id: uid(), name, isHost: true };
    roomCode = code;
    const order = shuffle(questions.map((q) => q.id));

    const { error: roomErr } = await db().from("rooms").insert({
      code,
      host_id: me.id,
      phase: "lobby",
      question_count: questions.length,
    });
    if (roomErr) throw new Error(roomErr.message);

    const { error: playerErr } = await db().from("players").insert({
      id: me.id,
      room_id: code,
      name,
      is_host: true,
      question_order: order,
    });
    if (playerErr) throw new Error(playerErr.message);

    myOrder = order;
    history.replaceState(null, "", inviteUrl(code));
    await subscribe();
    await refreshPlayers();
    phase = "lobby";
    show("lobby");
    saveSession();
    toast(`Room ${code} ready`);
  }

  async function joinRoom(name, code) {
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (code.length < 4) throw new Error("Enter a valid room code.");
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Enter a name.");
    await loadQuestionBank();

    const { data: room, error: roomErr } = await db()
      .from("rooms")
      .select("*")
      .eq("code", code)
      .maybeSingle();
    if (roomErr) throw new Error(roomErr.message);
    if (!room) throw new Error("Room not found.");
    if (room.phase !== "lobby") throw new Error("This room already started.");

    const { data: existing, error: existingErr } = await db()
      .from("players")
      .select("id, name")
      .eq("room_id", code);
    if (existingErr) throw new Error(existingErr.message);
    if (
      (existing || []).some((p) => p.name.toLowerCase() === cleanName.toLowerCase())
    ) {
      throw new Error("That name is already taken in this room. Pick another.");
    }

    me = { id: uid(), name: cleanName, isHost: false };
    roomCode = code;
    const order = shuffle(questions.map((q) => q.id));

    const { error: playerErr } = await db().from("players").insert({
      id: me.id,
      room_id: code,
      name: cleanName,
      is_host: false,
      question_order: order,
    });
    if (playerErr) throw new Error(playerErr.message);

    myOrder = order;
    history.replaceState(null, "", inviteUrl(code));
    await subscribe();
    await refreshPlayers();
    phase = "lobby";
    show("lobby");
    saveSession();
  }

  async function resumeRoom(code) {
    const session = loadSession(code);
    if (!session?.id) return false;
    await loadQuestionBank();

    const { data: room, error: roomErr } = await db()
      .from("rooms")
      .select("*")
      .eq("code", code)
      .maybeSingle();
    if (roomErr || !room) {
      clearSession(code);
      return false;
    }

    const { data: player } = await db()
      .from("players")
      .select("*")
      .eq("room_id", code)
      .eq("id", session.id)
      .maybeSingle();
    if (!player) {
      clearSession(code);
      return false;
    }

    me = { id: player.id, name: player.name, isHost: !!player.is_host || !!session.isHost };
    roomCode = code;
    myOrder = player.question_order || [];
    history.replaceState(null, "", inviteUrl(code));
    await subscribe();
    await refreshPlayers({ silent: true });
    saveSession();

    if (room.phase === "lobby") {
      phase = "lobby";
      show("lobby");
    } else if (room.phase === "playing") {
      phase = "playing";
      await beginPlaying();
    } else if (room.phase === "results") {
      phase = "results";
      await showResults();
    } else {
      phase = "lobby";
      show("lobby");
    }
    toast(`Welcome back, ${me.name}`);
    return true;
  }

  async function startGame() {
    if (!me.isHost) return;
    const { error } = await db()
      .from("rooms")
      .update({ phase: "playing", updated_at: new Date().toISOString() })
      .eq("code", roomCode);
    if (error) throw new Error(error.message);
    phase = "playing";
    await beginPlaying();
  }

  async function beginPlaying() {
    stopWaitPoll();
    // Load any votes I already cast (refresh safety)
    const { data: votes } = await db()
      .from("votes")
      .select("question_id, nominee_id")
      .eq("room_id", roomCode)
      .eq("voter_id", me.id);
    myVotes = {};
    (votes || []).forEach((v) => {
      myVotes[v.question_id] = v.nominee_id;
    });

    // Always walk the full bank order; repair gaps if UI skipped ahead
    if (!myOrder?.length) {
      const self = players.find((p) => p.id === me.id);
      myOrder = self?.question_order?.length
        ? self.question_order
        : shuffle(questions.map((q) => q.id));
    }

    myIndex = myOrder.findIndex((qid) => !myVotes[qid]);
    if (myIndex < 0) {
      // Verify every bank question has a vote — not just order length
      const missing = questions.map((q) => q.id).filter((id) => !myVotes[id]);
      if (missing.length) {
        myOrder = [...myOrder.filter((id) => !myVotes[id] && missing.includes(id)), ...missing.filter((id) => !myOrder.includes(id))];
        // Dedupe: only unanswered
        myOrder = [...new Set(questions.map((q) => q.id).filter((id) => !myVotes[id]))];
        myIndex = 0;
        phase = "playing";
        renderQuestion();
        show("play");
        toast(`Answer ${missing.length} remaining question${missing.length === 1 ? "" : "s"}`);
        return;
      }
      phase = "wait";
      show("wait");
      startWaitPoll();
      await maybeAdvanceFromVotes();
      return;
    }
    phase = "playing";
    votingLock = false;
    renderQuestion();
    show("play");
  }

  function questionById(id) {
    return questions.find((q) => q.id === id);
  }

  function renderQuestion() {
    const qid = myOrder[myIndex];
    const q = questionById(qid);
    if (!q) {
      // Skip unknown ids
      myIndex += 1;
      if (myIndex >= myOrder.length) {
        beginPlaying().catch(console.error);
      } else {
        renderQuestion();
      }
      return;
    }
    const answeredCount = Object.keys(myVotes).length;
    els.progressChip.textContent = `${Math.min(answeredCount + 1, questions.length)} / ${questions.length}`;
    els.questionText.textContent = q.prompt;
    els.nomineeGrid.innerHTML = "";
    votingLock = false;
    players.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nominee";
      btn.textContent = p.name;
      btn.onclick = () => castVote(qid, p.id, btn);
      els.nomineeGrid.appendChild(btn);
    });
  }

  async function castVote(questionId, nomineeId, btn) {
    if (votingLock) return;
    if (myVotes[questionId]) return;
    votingLock = true;

    [...els.nomineeGrid.querySelectorAll(".nominee")].forEach((b) => {
      b.disabled = true;
      b.classList.remove("selected");
    });
    btn.classList.add("selected");

    const { error } = await db().from("votes").upsert(
      {
        room_id: roomCode,
        question_id: questionId,
        voter_id: me.id,
        nominee_id: nomineeId,
      },
      { onConflict: "room_id,question_id,voter_id" }
    );
    if (error) {
      toast(error.message || "Vote failed — try again");
      votingLock = false;
      [...els.nomineeGrid.querySelectorAll(".nominee")].forEach((b) => {
        b.disabled = false;
        b.classList.remove("selected");
      });
      return;
    }

    myVotes[questionId] = nomineeId;
    saveSession();

    // Next unanswered in order (never skip by double-increment)
    const nextIdx = myOrder.findIndex((qid) => !myVotes[qid]);
    if (nextIdx < 0) {
      const missing = questions.map((q) => q.id).filter((id) => !myVotes[id]);
      if (missing.length) {
        myOrder = missing;
        myIndex = 0;
        votingLock = false;
        renderQuestion();
        show("play");
        return;
      }
      phase = "wait";
      show("wait");
      startWaitPoll();
      await maybeAdvanceFromVotes();
    } else {
      myIndex = nextIdx;
      setTimeout(() => {
        votingLock = false;
        renderQuestion();
      }, 180);
    }
  }

  function stopWaitPoll() {
    if (waitPollTimer) {
      clearInterval(waitPollTimer);
      waitPollTimer = null;
    }
  }

  function startWaitPoll() {
    stopWaitPoll();
    waitPollTimer = setInterval(() => {
      maybeAdvanceFromVotes().catch(console.error);
    }, 2000);
  }

  async function maybeAdvanceFromVotes() {
    if (!roomCode || !questions.length) return;
    await refreshPlayers({ silent: true }).catch(() => {});

    if (!players.length) return;

    const { data: allVotes, error } = await db()
      .from("votes")
      .select("question_id, voter_id")
      .eq("room_id", roomCode);
    if (error) {
      console.error(error);
      return;
    }

    const votes = allVotes || [];
    const needed = players.length * questions.length;
    const count = votes.length;
    els.waitStat.textContent = `${count} / ${needed} votes in`;

    // Per-player completeness against full question bank
    const qids = questions.map((q) => q.id);
    const unfinished = players.filter((p) => {
      const theirs = new Set(votes.filter((v) => v.voter_id === p.id).map((v) => v.question_id));
      return qids.some((id) => !theirs.has(id));
    });

    if (unfinished.length) {
      els.waitCopy.textContent = `Waiting on ${unfinished.map((p) => p.name).join(", ")}…`;
      // If I'm unfinished (e.g. skipped via double-tap), send me back to play
      if (unfinished.some((p) => p.id === me.id) && phase === "wait") {
        stopWaitPoll();
        await beginPlaying();
      }
      return;
    }

    els.waitCopy.textContent = "Everyone finished — opening results…";
    stopWaitPoll();

    if (me.isHost) {
      await db()
        .from("rooms")
        .update({ phase: "results", updated_at: new Date().toISOString() })
        .eq("code", roomCode);
    }
    phase = "results";
    await showResults();
  }

  async function showResults() {
    show("results");
    const { data: votes, error } = await db()
      .from("votes")
      .select("question_id, nominee_id")
      .eq("room_id", roomCode);
    if (error) {
      toast(error.message);
      return;
    }

    els.charts.innerHTML = "";
    const orderedQuestions = [...questions].sort((a, b) => a.sort_order - b.sort_order);

    orderedQuestions.forEach((q) => {
      const tallies = {};
      players.forEach((p) => {
        tallies[p.id] = 0;
      });
      (votes || [])
        .filter((v) => v.question_id === q.id)
        .forEach((v) => {
          if (tallies[v.nominee_id] != null) tallies[v.nominee_id] += 1;
        });

      const card = document.createElement("article");
      card.className = "chart-card";
      card.innerHTML = `<h3>${escapeHtml(q.prompt)}</h3><div class="chart-canvas-wrap"></div>`;
      const wrap = card.querySelector(".chart-canvas-wrap");
      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      els.charts.appendChild(card);
      drawBarChart(
        canvas,
        players.map((p) => ({ name: p.name, value: tallies[p.id] || 0 }))
      );
    });

    renderBodyPortrait(votes || []);
  }

  function drawBarChart(canvas, series) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.min(640, canvas.parentElement.clientWidth || 640);
    const cssH = 260;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const padL = 36;
    const padR = 12;
    const padT = 16;
    const padB = 42;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;

    const maxVal = Math.max(8, ...series.map((s) => s.value), 1);
    // Nice top = next even number at least maxVal
    const yMax = Math.max(8, Math.ceil(maxVal / 2) * 2);
    const step = yMax <= 8 ? 2 : Math.ceil(yMax / 4);

    // background
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cssW, cssH);

    // grid + y labels
    ctx.strokeStyle = "#3a3a3a";
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1;
    ctx.fillStyle = "#9a9a9a";
    ctx.font = "12px Outfit, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let y = 0; y <= yMax; y += step) {
      const py = padT + plotH - (y / yMax) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(cssW - padR, py);
      ctx.stroke();
      ctx.fillText(String(y), padL - 8, py);
    }
    ctx.setLineDash([]);

    const n = Math.max(series.length, 1);
    const gap = 18;
    const barW = Math.min(70, (plotW - gap * (n + 1)) / n);

    series.forEach((s, i) => {
      const x = padL + gap + i * (barW + gap) + ((plotW - gap * (n + 1) - barW * n) / 2);
      const h = (s.value / yMax) * plotH;
      const y = padT + plotH - h;
      const r = 10;

      ctx.fillStyle = "#355f9c";
      roundTopRect(ctx, x, y, barW, h, r);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "13px Outfit, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(s.name.slice(0, 12), x + barW / 2, padT + plotH + 10);
    });
  }

  function roundTopRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  function renderBodyPortrait(votes) {
    const totalVoters = players.length || 1;
    // For each trait, % of players who nominated ME on questions with that trait
    const traitMap = {};
    questions.forEach((q) => {
      if (!traitMap[q.trait_key]) {
        traitMap[q.trait_key] = {
          key: q.trait_key,
          label: q.trait_label,
          bodyPart: q.body_part,
          hits: 0,
          possible: 0,
        };
      }
      traitMap[q.trait_key].possible += totalVoters;
      votes
        .filter((v) => v.question_id === q.id && v.nominee_id === me.id)
        .forEach(() => {
          traitMap[q.trait_key].hits += 1;
        });
    });

    const traits = Object.values(traitMap)
      .map((t) => ({
        ...t,
        pct: t.possible ? Math.round((t.hits / t.possible) * 100) : 0,
      }))
      .sort((a, b) => b.pct - a.pct);

    els.traitList.innerHTML = "";
    traits.forEach((t) => {
      const li = document.createElement("li");
      li.className = t.pct === 0 ? "trait-chip dim" : "trait-chip";
      li.innerHTML = `
        <span class="trait-pct">${t.pct}%</span>
        <span class="trait-copy">think you're <em>${escapeHtml(t.label)}</em></span>
        <span class="trait-bar" aria-hidden="true"><span style="width:${t.pct}%"></span></span>
      `;
      els.traitList.appendChild(li);
    });

    // Light body parts by average trait % for that part
    const partScores = {};
    traits.forEach((t) => {
      if (!partScores[t.bodyPart]) partScores[t.bodyPart] = [];
      partScores[t.bodyPart].push(t.pct);
    });

    els.bodyFigure.querySelectorAll(".part").forEach((el) => {
      const part = el.getAttribute("data-part");
      const scores = partScores[part] || [0];
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      el.style.fill = tintForPercent(avg);
    });
  }

  function tintForPercent(pct) {
    // 0% = dark slate, 100% = bright blue
    const t = Math.max(0, Math.min(100, pct)) / 100;
    const r = Math.round(26 + (53 - 26) * t);
    const g = Math.round(31 + (95 - 31) * t);
    const b = Math.round(42 + (173 - 42) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // events
  let inviteMode = false;

  function enableInviteHome(code) {
    inviteMode = true;
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    els.roomCode.value = normalized;

    const home = document.getElementById("screen-home");
    const actions = document.querySelector("#screen-home .actions");
    if (!home || !actions) return;

    home.classList.add("invite-receiver-mode");
    els.btnCreate.hidden = true;
    els.btnCreate.style.display = "none";
    const joinRow = actions.querySelector(".join-row");
    if (joinRow) {
      joinRow.hidden = true;
      joinRow.style.display = "none";
    }

    let inviteBlock = document.getElementById("invite-join-block");
    if (!inviteBlock) {
      inviteBlock = document.createElement("div");
      inviteBlock.id = "invite-join-block";
      inviteBlock.className = "invite-join-block";
      inviteBlock.innerHTML = `
        <p class="invite-room-label">Joining room <strong id="invite-room-label">${normalized}</strong></p>
        <button type="button" class="btn btn-primary btn-lg" id="btn-invite-join">Join group</button>
        <button type="button" class="invite-own-group" id="btn-start-own-group">start your own group</button>
      `;
      actions.appendChild(inviteBlock);
      $("#btn-invite-join").onclick = () => els.btnJoin.click();
      $("#btn-start-own-group").onclick = () => {
        location.href = "/";
      };
    } else {
      const label = $("#invite-room-label");
      if (label) label.textContent = normalized;
      inviteBlock.hidden = false;
    }
  }

  els.homeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("");
    const name = els.playerName.value.trim();
    if (!name) return;

    if (inviteMode) {
      els.btnJoin.click();
      return;
    }

    els.btnCreate.disabled = true;
    try {
      await createRoom(name);
    } catch (err) {
      setError(err.message || "Could not create room.");
    } finally {
      els.btnCreate.disabled = false;
    }
  });

  els.btnJoin.addEventListener("click", async () => {
    setError("");
    const name = els.playerName.value.trim();
    const code = els.roomCode.value.trim();
    if (!name) {
      setError("Add your name first.");
      return;
    }
    els.btnJoin.disabled = true;
    const inviteBtn = $("#btn-invite-join");
    if (inviteBtn) inviteBtn.disabled = true;
    try {
      await joinRoom(name, code);
    } catch (err) {
      setError(err.message || "Could not join.");
    } finally {
      els.btnJoin.disabled = false;
      if (inviteBtn) inviteBtn.disabled = false;
    }
  });

  els.btnCopy.addEventListener("click", async () => {
    const url = inviteUrl(roomCode);
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied");
    } catch (_) {
      toast(url);
    }
  });

  els.btnStart.addEventListener("click", async () => {
    try {
      await startGame();
    } catch (err) {
      toast(err.message || "Could not start");
    }
  });

  const params = new URLSearchParams(location.search);
  const preset = params.get("room");
  (async () => {
    if (preset) {
      const resumed = await resumeRoom(preset.toUpperCase());
      if (!resumed) enableInviteHome(preset);
    } else if (params.get("host") !== "1") {
      location.replace("/");
    }
  })();
})();