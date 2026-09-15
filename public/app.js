/* Anon Wheel — multiplayer party game (HTML/CSS/JS)
   Architecture:
   - DATABASE: rooms + players (scoped by room code / ?room=ABC123)
   - REALTIME postgres_changes: everyone sees the same players in a room
   - BROADCAST: spin / questions / phase game events (not one giant shared player list)
*/

(() => {
  "use strict";

  const QUESTION_SECONDS = 3 * 60;
  const FINALS_PREP_SECONDS = 2 * 60;
  const FINALS_SECONDS = 45;
  const MAX_SKIPS = 3;

  const SUPABASE_URL = window.SUPABASE_CONFIG?.url || "";
  const SUPABASE_KEY = window.SUPABASE_CONFIG?.publishableKey || "";

  if (!window.supabase || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Supabase config missing. Check supabase-config.js and the Supabase CDN script.");
  }

  const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY, {
    db: { schema: "category_one" },
  });
  const db = () => supabaseClient.schema("category_one");
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const screens = {
    home: $("#screen-home"),
    lobby: $("#screen-lobby"),
    questions: $("#screen-questions"),
    game: $("#screen-game"),
    finals: $("#screen-finals"),
    end: $("#screen-end"),
  };

  const els = {
    homeForm: $("#home-form"),
    playerName: $("#player-name"),
    roomCode: $("#room-code"),
    btnCreate: $("#btn-create"),
    btnJoin: $("#btn-join"),
    homeError: $("#home-error"),
    lobbyCode: $("#lobby-code"),
    btnCopyLink: $("#btn-copy-link"),
    playerList: $("#player-list"),
    lobbyStatus: $("#lobby-status"),
    btnStartQuestions: $("#btn-start-questions"),
    lobbyHint: $("#lobby-hint"),
    questionTimer: $("#question-timer"),
    questionForm: $("#question-form"),
    questionInput: $("#question-input"),
    questionFeedback: $("#question-feedback"),
    questionCount: $("#question-count"),
    finalsQuestionCount: $("#finals-question-count"),
    myQuestions: $("#my-questions"),
    scoreStrip: $("#score-strip"),
    wheelCanvas: $("#wheel-canvas"),
    wheelCaption: $("#wheel-caption"),
    actionPanel: $("#action-panel"),
    finalistAName: $("#finalist-a-name"),
    finalistBName: $("#finalist-b-name"),
    finalistAScore: $("#finalist-a-score"),
    finalistBScore: $("#finalist-b-score"),
    buzzerA: $("#buzzer-a"),
    buzzerB: $("#buzzer-b"),
    finalsTimer: $("#finals-timer"),
    finalsQuestion: $("#finals-question"),
    finalsPhaseLabel: $("#finals-phase-label"),
    finalsControls: $("#finals-controls"),
    endTitle: $("#end-title"),
    endSub: $("#end-sub"),
    revealPanel: $("#reveal-panel"),
    revealList: $("#reveal-list"),
    standings: $("#standings"),
    btnPlayAgain: $("#btn-play-again"),
    kickedOverlay: $("#kicked-overlay"),
    toast: $("#toast"),
  };

  const WHEEL_COLORS = [
    "#c8f542", "#3ec6ff", "#ffb020", "#ff5a4a",
    "#7c5cff", "#3dff9a", "#ff7ad9", "#ffe566",
  ];

  /** @type {GameState} */
  let state = null;
  let me = { id: null, name: "", isHost: false };
  let sync = null;
  let questionTick = null;
  let finalsTick = null;
  let wheelAngle = 0;
  let wheelSpinning = false;
  let lastSpinToken = -1;
  let myLocalQuestions = [];
  let toastTimer = null;

  function sessionKey(code) {
    return `c1-session-${String(code || "").toUpperCase()}`;
  }

  function saveSession() {
    if (!me?.id || !state?.roomCode) return;
    try {
      localStorage.setItem(
        sessionKey(state.roomCode),
        JSON.stringify({
          id: me.id,
          name: me.name,
          isHost: me.isHost,
          roomCode: state.roomCode,
        })
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

  // ---------- utils ----------
  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function roomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) out += chars[(Math.random() * chars.length) | 0];
    return out;
  }

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2600);
  }

  function setHomeError(msg) {
    if (!msg) {
      els.homeError.hidden = true;
      els.homeError.textContent = "";
      return;
    }
    els.homeError.hidden = false;
    els.homeError.textContent = msg;
  }

  function handleNameTaken(message) {
    const msg =
      message || "That name is already taken in this room. Pick another.";
    const code = sync?.code || state?.roomCode || els.roomCode?.value?.trim();
    try {
      sync?.destroy?.();
    } catch (_) {}
    sync = null;
    state = null;
    if (code) clearSession(code);
    setHomeError(msg);
    showScreen("home");
    if (code && typeof enableInviteHome === "function") enableInviteHome(code);
    toast(msg);
    if (els.btnJoin) els.btnJoin.disabled = false;
  }

  function formatTime(totalSec) {
    const s = Math.max(0, Math.ceil(totalSec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function activePlayers(st = state) {
    return (st?.players || []).filter((p) => !p.kicked);
  }

  function unusedQuestions(st = state) {
    return (st?.questions || []).filter((q) => !q.used);
  }

  function getPlayer(id, st = state) {
    return (st?.players || []).find((p) => p.id === id);
  }

  function inviteUrl(code) {
    const url = new URL(location.href);
    url.searchParams.set("room", code);
    url.searchParams.delete("host");
    url.searchParams.delete("local");
    return url.toString();
  }

  function mapDbPlayer(row) {
    return {
      id: row.id,
      name: row.name,
      answered: row.answered ?? 0,
      skips: row.skips ?? 0,
      kicked: !!row.kicked,
      isHost: !!row.is_host,
    };
  }

  function gameOnly(st) {
    const {
      phase,
      roomCode,
      hostId,
      questions,
      finalsQuestions,
      questionEndsAt,
      currentPlayerId,
      currentQuestionId,
      spinToken,
      spinTargetIndex,
      finals,
      winnerId,
      revealForId,
      _finalistAId,
      _finalistBId,
    } = st;
    return {
      phase,
      roomCode,
      hostId,
      questions,
      finalsQuestions: finalsQuestions || [],
      questionEndsAt,
      currentPlayerId,
      currentQuestionId,
      spinToken,
      spinTargetIndex,
      finals,
      winnerId,
      revealForId,
      _finalistAId,
      _finalistBId,
    };
  }

  function mergeGameIntoState(game, players) {
    return {
      ...createState(game.roomCode || "------", players[0] || {
        id: "tmp",
        name: "…",
        answered: 0,
        skips: 0,
        kicked: false,
        isHost: false,
      }),
      ...game,
      players,
    };
  }

  // ---------- state factory ----------
  function createState(code, hostPlayer) {
    return {
      phase: "lobby",
      roomCode: code,
      hostId: hostPlayer.id,
      players: [hostPlayer],
      questions: [],
      finalsQuestions: [],
      questionEndsAt: null,
      currentPlayerId: null,
      currentQuestionId: null,
      spinToken: 0,
      spinTargetIndex: 0,
      finals: null,
      winnerId: null,
      revealForId: null,
    };
  }

  // ---------- sync: Supabase (rooms/players DB + Broadcast events) ----------
  class SupabaseSync {
    constructor(code, isHost) {
      this.code = code;
      this.isHost = isHost;
      this.channel = null;
      this.onState = null;
      this.onAction = null;
      this.onPlayers = null;
      this._writing = false;
      this._pendingGame = null;
    }

    async ensureRoom(hostPlayer, { fresh = true } = {}) {
      if (!fresh) {
        const existing = await this.fetchRoom();
        if (existing) return existing;
      }
      const { error } = await db().from("rooms").upsert({
        code: this.code,
        host_id: hostPlayer.id,
        phase: "lobby",
        game: gameOnly(createState(this.code, hostPlayer)),
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message || "Could not create room.");
      return null;
    }

    /** Step 7 — add a player into this room only */
    async addPlayer(player) {
      const { error } = await db().from("players").upsert(
        {
          id: player.id,
          room_id: this.code,
          name: player.name,
          answered: player.answered ?? 0,
          skips: player.skips ?? 0,
          kicked: player.kicked ?? false,
          is_host: player.isHost ?? false,
        },
        { onConflict: "id" }
      );
      if (error) throw new Error(error.message || "Could not add player.");
      console.log("Player added!", player.name, "→ room", this.code);
    }

    async fetchPlayers() {
      const { data, error } = await db()
        .from("players")
        .select("*")
        .eq("room_id", this.code)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message || "Could not load players.");
      return (data || []).map(mapDbPlayer);
    }

    async fetchRoom() {
      const { data, error } = await db()
        .from("rooms")
        .select("*")
        .eq("code", this.code)
        .maybeSingle();
      if (error) throw new Error(error.message || "Could not load room.");
      return data;
    }

    async start({ hostPlayer = null, joinPlayer = null, resume = false } = {}) {
      if (!supabaseClient) {
        throw new Error("Supabase client failed to load. Check your connection and config.");
      }

      if (this.isHost && hostPlayer) {
        if (resume) {
          const room = await this.ensureRoom(hostPlayer, { fresh: false });
          const players = await this.fetchPlayers();
          if (!players.some((p) => p.id === hostPlayer.id)) {
            await this.addPlayer(hostPlayer);
          }
          if (room) {
            const game = room.game && typeof room.game === "object" ? room.game : {};
            const latestPlayers = await this.fetchPlayers();
            this.onState?.(
              mergeGameIntoState(
                {
                  ...game,
                  roomCode: this.code,
                  hostId: room.host_id || hostPlayer.id,
                  phase: room.phase || game.phase || "lobby",
                },
                latestPlayers
              )
            );
          }
        } else {
          await this.ensureRoom(hostPlayer, { fresh: true });
          await this.addPlayer(hostPlayer);
        }
      } else {
        const room = await this.fetchRoom();
        if (!room) {
          throw new Error("Room not found. Check the code / link (?room=ABC123).");
        }
        const players = await this.fetchPlayers();
        const game = room.game && typeof room.game === "object" ? room.game : {};
        this.onState?.(
          mergeGameIntoState(
            {
              ...game,
              roomCode: this.code,
              hostId: room.host_id,
              phase: room.phase || game.phase || "lobby",
            },
            players
          )
        );

        if (joinPlayer) {
          const taken = players.some(
            (p) =>
              p.id !== joinPlayer.id &&
              String(p.name || "").toLowerCase() ===
                String(joinPlayer.name || "").trim().toLowerCase()
          );
          if (taken) {
            throw new Error(
              "That name is already taken in this room. Pick another."
            );
          }
          if (!players.some((p) => p.id === joinPlayer.id)) {
            await this.addPlayer(joinPlayer);
          }
        }
      }

      // Step 8 — listen for player inserts/updates in THIS room only
      this.channel = supabaseClient.channel(`room:${this.code}`, {
        config: { broadcast: { self: false } },
      });

      this.channel
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "category_one",
            table: "players",
            filter: `room_id=eq.${this.code}`,
          },
          async (payload) => {
            console.log("Players change:", payload.eventType, payload.new || payload.old);
            try {
              const players = await this.fetchPlayers();
              this.onPlayers?.(players);
            } catch (err) {
              console.error(err);
            }
          }
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "category_one",
            table: "rooms",
            filter: `code=eq.${this.code}`,
          },
          (payload) => {
            const row = payload.new;
            if (!row) return;
            const game = row.game && typeof row.game === "object" ? row.game : {};
            this.onState?.(
              mergeGameIntoState(
                {
                  ...game,
                  roomCode: this.code,
                  hostId: row.host_id,
                  phase: row.phase || game.phase,
                },
                state?.players || []
              )
            );
          }
        )
        .on("broadcast", { event: "game" }, ({ payload }) => {
          // Fast path: spin / phase / questions land for every browser
          if (!payload) return;
          this.onState?.(
            mergeGameIntoState(payload, state?.players || [])
          );
        })
        .on("broadcast", { event: "action" }, ({ payload }) => {
          if (this.isHost && payload) this.onAction?.(payload);
        })
        .on("broadcast", { event: "joinRejected" }, ({ payload }) => {
          if (payload?.playerId === me.id) {
            handleNameTaken(payload.message);
          }
        });

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Supabase realtime timed out.")), 12000);
        this.channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(t);
            resolve();
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(t);
            reject(new Error("Supabase realtime channel failed."));
          }
        });
      });

      // Host: seed local state after channel is up
      if (this.isHost && hostPlayer) {
        const players = await this.fetchPlayers();
        this.onState?.(createState(this.code, hostPlayer));
        this.onPlayers?.(players);
      } else if (joinPlayer) {
        const players = await this.fetchPlayers();
        this.onPlayers?.(players);
      }
    }

    /** Persist + broadcast game events (NOT a global player dump) */
    async broadcastState(st) {
      this._pendingGame = gameOnly(st);
      if (this._writing) return;
      this._writing = true;

      try {
        while (this._pendingGame) {
          const snapshot = this._pendingGame;
          this._pendingGame = null;

          // Broadcast: everyone starts the same spin / phase instantly
          this.channel?.send({
            type: "broadcast",
            event: "game",
            payload: snapshot,
          });

          const { error } = await db().from("rooms").upsert({
            code: this.code,
            host_id: snapshot.hostId || st.hostId,
            phase: snapshot.phase,
            game: snapshot,
            updated_at: new Date().toISOString(),
          });
          if (error) {
            console.error("Room save failed:", error);
            toast(error.message || "Failed to save room");
          }

          // Keep player scores in the players table (room-scoped)
          await this.syncPlayerStats(st.players || []);
        }
      } finally {
        this._writing = false;
      }
    }

    async syncPlayerStats(players) {
      await Promise.all(
        players.map((p) =>
          db()
            .from("players")
            .update({
              answered: p.answered,
              skips: p.skips,
              kicked: p.kicked,
              name: p.name,
              is_host: p.isHost,
            })
            .eq("id", p.id)
            .eq("room_id", this.code)
        )
      );
    }

    sendAction(action) {
      if (this.isHost) {
        this.onAction?.(action);
        return;
      }
      this.channel?.send({
        type: "broadcast",
        event: "action",
        payload: action,
      });
    }

    notifyJoinRejected(payload) {
      this.channel?.send({
        type: "broadcast",
        event: "joinRejected",
        payload,
      });
    }

    destroy() {
      if (this.channel) {
        supabaseClient.removeChannel(this.channel);
        this.channel = null;
      }
    }
  }

  // ---------- sync: local (BroadcastChannel) ----------
  class LocalSync {
    constructor(code, isHost) {
      this.code = code;
      this.isHost = isHost;
      this.channel = new BroadcastChannel(`anonwheel-${code}`);
      this.storageKey = `anonwheel-state-${code}`;
      this.onState = null;
      this.onAction = null;
      this.channel.onmessage = (ev) => this._handle(ev.data);
      window.addEventListener("storage", this._onStorage);
    }

    _onStorage = (e) => {
      if (e.key !== this.storageKey || !e.newValue) return;
      try {
        const st = JSON.parse(e.newValue);
        this.onState?.(st);
      } catch (_) {}
    };

    _handle(msg) {
      if (!msg || msg.sourceId === me.id) return;
      if (msg.type === "state") this.onState?.(msg.state);
      if (msg.type === "action" && this.isHost) this.onAction?.(msg.action);
      if (msg.type === "hello" && this.isHost && state) {
        this.broadcastState(state);
      }
      if (msg.type === "joinRejected" && msg.payload?.playerId === me.id) {
        handleNameTaken(msg.payload.message);
      }
    }

    async start() {
      if (!this.isHost) {
        const raw = localStorage.getItem(this.storageKey);
        if (raw) {
          try {
            this.onState?.(JSON.parse(raw));
          } catch (_) {}
        }
        this.channel.postMessage({ type: "hello", sourceId: me.id });
      }
    }

    broadcastState(st) {
      localStorage.setItem(this.storageKey, JSON.stringify(st));
      this.channel.postMessage({ type: "state", sourceId: me.id, state: st });
    }

    sendAction(action) {
      if (this.isHost) {
        this.onAction?.(action);
        return;
      }
      this.channel.postMessage({ type: "action", sourceId: me.id, action });
    }

    notifyJoinRejected(payload) {
      this.channel.postMessage({ type: "joinRejected", sourceId: me.id, payload });
    }

    destroy() {
      this.channel.close();
      window.removeEventListener("storage", this._onStorage);
    }
  }

  // ---------- host action handling ----------
  async function upsertQuestionRow(entry, pot) {
    if (!supabaseClient || !state?.roomCode || !entry) return;
    const { error } = await db().from("questions").upsert({
      id: entry.id,
      room_id: state.roomCode,
      question_text: entry.text,
      author_id: entry.authorId || null,
      author_name: entry.authorName || null,
      pot: pot === "finals" ? "finals" : "wheel",
      status: "unanswered",
      skip_count: 0,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error("Failed to upsert question:", error);
  }

  async function logQuestionOutcome({ question, player, pot, outcome }) {
    if (!supabaseClient || !state?.roomCode || !question || !player) return;

    const isSkip = outcome === "skipped";
    const potValue = pot === "finals" ? "finals" : "wheel";

    const { error: logError } = await db().from("answered_questions").insert({
      room_id: state.roomCode,
      question_id: question.id,
      question_text: question.text,
      player_id: player.id,
      player_name: player.name,
      author_id: question.authorId || null,
      author_name: question.authorName || null,
      pot: potValue,
      outcome: isSkip ? "skipped" : "answered",
      returned_to_pool: isSkip,
    });
    if (logError) console.error("Failed to log question outcome:", logError);

    // Keep the live pot status in sync: skips stay unanswered; answers resolve
    if (isSkip) {
      const { data: existing } = await db()
        .from("questions")
        .select("skip_count")
        .eq("id", question.id)
        .maybeSingle();
      const nextSkips = (existing?.skip_count || 0) + 1;
      const { error } = await db()
        .from("questions")
        .update({
          status: "unanswered",
          skip_count: nextSkips,
          updated_at: new Date().toISOString(),
        })
        .eq("id", question.id);
      if (error) console.error("Failed to mark question still unanswered after skip:", error);
    } else {
      const { error } = await db()
        .from("questions")
        .update({
          status: "answered",
          answered_by_id: player.id,
          answered_by_name: player.name,
          updated_at: new Date().toISOString(),
        })
        .eq("id", question.id);
      if (error) console.error("Failed to mark question answered:", error);
    }
  }

  function publish() {
    if (!state) return Promise.resolve();
    saveSession();
    render();
    if (me.isHost && sync) return Promise.resolve(sync.broadcastState(state));
    return Promise.resolve();
  }

  function handleAction(action) {
    if (!me.isHost || !state || !action) return;

    switch (action.type) {
      case "join": {
        if (state.phase !== "lobby") return;
        if (state.players.some((p) => p.id === action.player.id)) return;
        if (
          state.players.some(
            (p) => p.name.toLowerCase() === String(action.player.name || "").trim().toLowerCase()
          )
        ) {
          sync?.notifyJoinRejected?.({
            playerId: action.player.id,
            reason: "name_taken",
            message: "That name is already taken in this room. Pick another.",
          });
          return;
        }
        state.players.push({
          id: action.player.id,
          name: String(action.player.name || "").trim(),
          answered: 0,
          skips: 0,
          kicked: false,
          isHost: false,
        });
        publish();
        break;
      }
      case "startQuestions": {
        if (state.phase !== "lobby") return;
        if (activePlayers().length < 2) return;
        state.phase = "questions";
        state.questionEndsAt = Date.now() + QUESTION_SECONDS * 1000;
        publish();
        break;
      }
      case "addQuestion": {
        if (state.phase !== "questions" && state.phase !== "finalsPrep") return;
        const text = String(action.text || "").trim();
        if (!text) return;
        const author = getPlayer(action.playerId);
        if (!author || author.kicked) return;
        const pot = action.pot === "finals" || state.phase === "finalsPrep" ? "finals" : "wheel";
        const entry = {
          id: uid(),
          text,
          authorId: author.id,
          authorName: author.name,
          used: false,
        };
        if (pot === "finals") {
          if (!state.finalsQuestions) state.finalsQuestions = [];
          state.finalsQuestions.push(entry);
        } else {
          state.questions.push(entry);
        }
        upsertQuestionRow(entry, pot);
        publish();
        break;
      }
      case "questionsDone": {
        if (state.phase !== "questions") return;
        beginWheelRound();
        break;
      }
      case "skip": {
        if (state.phase !== "answering") return;
        if (action.playerId !== state.currentPlayerId) return;
        const player = getPlayer(action.playerId);
        const q = state.questions.find((x) => x.id === state.currentQuestionId);
        if (!player || !q) return;
        player.skips += 1;
        // Skipped questions stay in the unanswered pool for someone else
        if (!Array.isArray(q.skippedBy)) q.skippedBy = [];
        if (!q.skippedBy.includes(player.id)) q.skippedBy.push(player.id);
        if (player.skips >= MAX_SKIPS) player.kicked = true;
        logQuestionOutcome({ question: q, player, pot: "wheel", outcome: "skipped" });
        state.currentPlayerId = null;
        state.currentQuestionId = null;
        if (shouldGoToFinals()) startFinals();
        else beginWheelRound();
        break;
      }
      case "chooseAnswer": {
        if (state.phase !== "answering") return;
        if (action.playerId !== state.currentPlayerId) return;
        state.phase = "confirm";
        publish();
        break;
      }
      case "confirmAnswered": {
        if (state.phase !== "confirm") return;
        if (action.playerId !== state.currentPlayerId) return;
        const player = getPlayer(action.playerId);
        const q = state.questions.find((x) => x.id === state.currentQuestionId);
        if (!player || !q) return;
        player.answered += 1;
        q.used = true;
        logQuestionOutcome({ question: q, player, pot: "wheel", outcome: "answered" });
        state.currentPlayerId = null;
        state.currentQuestionId = null;
        if (shouldGoToFinals()) startFinals();
        else beginWheelRound();
        break;
      }
      case "buzz": {
        if (!state.finals || state.finals.phase !== "open") return;
        if (state.finals.buzzedBy) return;
        if (action.playerId !== state.finals.aId && action.playerId !== state.finals.bId) return;
        state.finals.buzzedBy = action.playerId;
        state.finals.phase = "locked";
        publish();
        break;
      }
      case "judgeBuzz": {
        if (!state.finals || state.finals.phase !== "locked") return;
        const correct = !!action.correct;
        const id = state.finals.buzzedBy;
        if (correct) {
          if (id === state.finals.aId) state.finals.aScore += 1;
          if (id === state.finals.bId) state.finals.bScore += 1;
          const player = getPlayer(id);
          const q = state.finals.questions?.[state.finals.index];
          if (player && q) {
            logQuestionOutcome({ question: q, player, pot: "finals", outcome: "answered" });
          }
        }
        advanceFinalsQuestion();
        break;
      }
      case "startFinalsClock": {
        if (!state.finals || state.finals.phase !== "ready") return;
        openFinalsQuestion();
        break;
      }
      case "beginFinalsNow": {
        if (state.phase !== "finalsPrep") return;
        beginFinalsMatch();
        break;
      }
      default:
        break;
    }
  }

  function shouldGoToFinals() {
    const alive = activePlayers();
    const left = unusedQuestions();
    if (alive.length < 2) return true;
    if (left.length === 0) return true;
    return false;
  }

  function beginWheelRound() {
    const alive = activePlayers();
    const left = unusedQuestions();

    if (alive.length < 2 || left.length === 0) {
      startFinals();
      return;
    }

    // Prefer a player + question they have not already skipped
    const shuffledPlayers = [...alive].sort(() => Math.random() - 0.5);
    let player = null;
    let q = null;
    for (const p of shuffledPlayers) {
      const available = left.filter((quest) => !(quest.skippedBy || []).includes(p.id));
      if (available.length) {
        player = p;
        q = available[(Math.random() * available.length) | 0];
        break;
      }
    }
    // Edge case: every alive player already skipped every leftover question
    if (!player || !q) {
      player = shuffledPlayers[0];
      q = left[(Math.random() * left.length) | 0];
    }

    const targetIndex = Math.max(0, alive.findIndex((p) => p.id === player.id));

    state.phase = "spinning";
    state.spinTargetIndex = targetIndex;
    state.spinToken += 1;
    state.currentPlayerId = player.id;
    state.currentQuestionId = q.id;
    publish();

    // Host flips to answering after spin duration (clients animate via spinToken)
    setTimeout(() => {
      if (!state || state.phase !== "spinning") return;
      if (state.currentPlayerId !== player.id) return;
      state.phase = "answering";
      publish();
    }, 4200);
  }

  function startFinals() {
    const ranked = [...activePlayers()].sort((a, b) => b.answered - a.answered || a.name.localeCompare(b.name));

    if (ranked.length === 0) {
      state.phase = "end";
      state.winnerId = null;
      state.revealForId = null;
      publish();
      return;
    }

    if (ranked.length === 1) {
      state.phase = "end";
      state.winnerId = ranked[0].id;
      state.revealForId = ranked[0].id;
      publish();
      return;
    }

    // Top 2 by answers; break ties randomly among tied for #2 if needed
    const topScore = ranked[0].answered;
    const firstTier = ranked.filter((p) => p.answered === topScore);
    let a;
    let b;
    if (firstTier.length >= 2) {
      const shuffled = [...firstTier].sort(() => Math.random() - 0.5);
      a = shuffled[0];
      b = shuffled[1];
    } else {
      a = ranked[0];
      const secondScore = ranked[1].answered;
      const secondTier = ranked.filter((p) => p.answered === secondScore && p.id !== a.id);
      b = secondTier[(Math.random() * secondTier.length) | 0];
    }

    // Remember finalists + reveal privilege, then ensure a NEW question bank
    state.revealForId = ranked[0].id;
    state._finalistAId = a.id;
    state._finalistBId = b.id;

    const bank = state.finalsQuestions || [];
    if (bank.length === 0) {
      // Need brand-new rapid-fire questions — short prep round
      state.phase = "finalsPrep";
      state.questionEndsAt = Date.now() + FINALS_PREP_SECONDS * 1000;
      state.currentPlayerId = null;
      state.currentQuestionId = null;
      state.finals = null;
      publish();
      return;
    }

    beginFinalsMatch();
  }

  function beginFinalsMatch() {
    const aId = state._finalistAId;
    const bId = state._finalistBId;
    const a = getPlayer(aId);
    const b = getPlayer(bId);
    if (!a || !b) {
      state.phase = "end";
      publish();
      return;
    }

    const bank = [...(state.finalsQuestions || [])];
    if (bank.length === 0) {
      toast("Add at least one rapid-fire question first");
      state.phase = "finalsPrep";
      state.questionEndsAt = Date.now() + FINALS_PREP_SECONDS * 1000;
      publish();
      return;
    }

    const finalsQs = bank.sort(() => Math.random() - 0.5).slice(0, 12);

    state.phase = "finals";
    state.currentPlayerId = null;
    state.currentQuestionId = null;
    state.finals = {
      aId: a.id,
      bId: b.id,
      aScore: 0,
      bScore: 0,
      index: 0,
      questions: finalsQs,
      buzzedBy: null,
      phase: "ready",
      endsAt: null,
    };
    publish();
  }

  function openFinalsQuestion() {
    if (!state.finals) return;
    if (state.finals.index >= state.finals.questions.length) {
      finishFinals();
      return;
    }
    state.finals.buzzedBy = null;
    state.finals.phase = "open";
    state.finals.endsAt = Date.now() + FINALS_SECONDS * 1000;
    publish();
  }

  function advanceFinalsQuestion() {
    if (!state.finals) return;
    state.finals.index += 1;
    state.finals.buzzedBy = null;
    if (
      state.finals.index >= state.finals.questions.length ||
      (state.finals.endsAt && Date.now() >= state.finals.endsAt)
    ) {
      finishFinals();
      return;
    }
    state.finals.phase = "open";
    publish();
  }

  function finishFinals() {
    const f = state.finals;
    let winnerId = state.revealForId;
    if (f) {
      if (f.aScore > f.bScore) winnerId = f.aId;
      else if (f.bScore > f.aScore) winnerId = f.bId;
      else winnerId = state.revealForId; // tie → most answered keeps crown
    }
    state.winnerId = winnerId;
    state.phase = "end";
    publish();
  }

  // ---------- client send helpers ----------
  function send(action) {
    sync?.sendAction(action);
  }

  // ---------- wheel drawing ----------
  function drawWheel(players, angleRad, highlightIndex = -1) {
    const canvas = els.wheelCanvas;
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 8;
    const n = Math.max(players.length, 1);
    const arc = (Math.PI * 2) / n;

    ctx.clearRect(0, 0, size, size);

    // outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
    ctx.fillStyle = "#0a1520";
    ctx.fill();

    for (let i = 0; i < n; i++) {
      const start = angleRad + i * arc;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, start + arc);
      ctx.closePath();
      ctx.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
      if (highlightIndex === i) ctx.fillStyle = "#ffffff";
      ctx.fill();

      // label
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + arc / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = "#071018";
      ctx.font = `bold ${Math.max(14, 28 - n)}px Outfit, sans-serif`;
      const label = (players[i]?.name || "?").slice(0, 10);
      ctx.fillText(label, radius - 16, 6);
      ctx.restore();
    }

    // hub
    ctx.beginPath();
    ctx.arc(cx, cy, 34, 0, Math.PI * 2);
    ctx.fillStyle = "#071018";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.fillStyle = "#ffb020";
    ctx.fill();
  }

  function animateWheelToIndex(players, targetIndex, token) {
    if (wheelSpinning && lastSpinToken === token) return;
    wheelSpinning = true;
    lastSpinToken = token;

    const n = players.length;
    const arc = (Math.PI * 2) / n;
    // Pointer is at top (-PI/2). Segment i center should land under pointer.
    const targetCenter = targetIndex * arc + arc / 2;
    const desired = -Math.PI / 2 - targetCenter;
    const turns = 4 + Math.random() * 2;
    const from = wheelAngle;
    const to = from + turns * Math.PI * 2 + ((desired - from) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);

    const duration = 4000;
    const start = performance.now();

    function frame(now) {
      if (lastSpinToken !== token) return;
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      wheelAngle = from + (to - from) * eased;
      drawWheel(players, wheelAngle, t > 0.92 ? targetIndex : -1);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        wheelAngle = desired;
        drawWheel(players, wheelAngle, targetIndex);
        wheelSpinning = false;
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- render ----------
  function render() {
    if (!state) return;

    clearInterval(questionTick);
    questionTick = null;
    clearInterval(finalsTick);
    finalsTick = null;

    const self = getPlayer(me.id);
    els.kickedOverlay.hidden = !(self && self.kicked && state.phase !== "end" && state.phase !== "lobby");

    switch (state.phase) {
      case "lobby":
        showScreen("lobby");
        renderLobby();
        break;
      case "questions":
      case "finalsPrep":
        showScreen("questions");
        renderQuestions();
        break;
      case "spinning":
      case "answering":
      case "confirm":
        showScreen("game");
        renderGame();
        break;
      case "finals":
        showScreen("finals");
        renderFinals();
        break;
      case "end":
        showScreen("end");
        renderEnd();
        break;
      default:
        break;
    }
  }

  function renderLobby() {
    els.lobbyCode.textContent = state.roomCode;
    els.playerList.innerHTML = "";
    state.players.forEach((p) => {
      const li = document.createElement("li");
      li.className = "player-pill";
      if (p.isHost) li.classList.add("host");
      if (p.id === me.id) li.classList.add("you");
      li.innerHTML = `<span class="name">${escapeHtml(p.name)}</span><span class="meta">answered ${p.answered} · skips ${p.skips}/${MAX_SKIPS}${p.id === me.id ? " · you" : ""}</span>`;
      els.playerList.appendChild(li);
    });

    const ready = activePlayers().length >= 2;
    els.lobbyStatus.textContent = ready
      ? `${activePlayers().length} players ready`
      : "Waiting for players…";
    els.lobbyHint.textContent = ready
      ? me.isHost
        ? "You’re the host — start when everyone is in."
        : "Waiting for the host to start the question round."
      : "Need at least 2 players to start.";

    els.btnStartQuestions.hidden = !me.isHost;
    els.btnStartQuestions.disabled = !ready;
  }

  function renderQuestions() {
    const remaining = ((state.questionEndsAt || Date.now()) - Date.now()) / 1000;
    els.questionTimer.textContent = formatTime(remaining);
    els.questionTimer.classList.toggle("urgent", remaining <= 30);
    els.questionCount.textContent = String(state.questions?.length || 0);
    if (els.finalsQuestionCount) {
      els.finalsQuestionCount.textContent = String(state.finalsQuestions?.length || 0);
    }

    const title = document.querySelector("#screen-questions .section-title");
    const sub = document.querySelector("#screen-questions .section-sub");
    const potFieldset = document.querySelector(".pot-choice");
    if (state.phase === "finalsPrep") {
      if (title) title.textContent = "Rapid-fire questions";
      if (sub) {
        sub.textContent =
          "Wheel is done. Add NEW questions for the top-2 buzzer round — these won’t reuse the wheel pot.";
      }
      if (potFieldset) {
        potFieldset.hidden = true;
        const finalsRadio = document.querySelector('input[name="question-pot"][value="finals"]');
        if (finalsRadio) finalsRadio.checked = true;
      }
    } else {
      if (title) title.textContent = "Drop your questions";
      if (sub) sub.textContent = "Totally anonymous — nobody sees who wrote what (yet).";
      if (potFieldset) potFieldset.hidden = false;
    }

    // Host shortcut during finals prep
    let hostBtn = document.getElementById("btn-begin-finals");
    if (state.phase === "finalsPrep" && me.isHost) {
      if (!hostBtn) {
        hostBtn = document.createElement("button");
        hostBtn.type = "button";
        hostBtn.id = "btn-begin-finals";
        hostBtn.className = "btn btn-primary";
        hostBtn.style.marginTop = "0.75rem";
        els.questionForm.parentElement?.appendChild(hostBtn);
      }
      const n = state.finalsQuestions?.length || 0;
      hostBtn.hidden = false;
      hostBtn.disabled = n < 1;
      hostBtn.textContent = n < 1 ? "Need at least 1 rapid-fire question" : `Start rapid fire (${n} ready)`;
      hostBtn.onclick = () => send({ type: "beginFinalsNow" });
    } else if (hostBtn) {
      hostBtn.hidden = true;
    }

    els.myQuestions.innerHTML = "";
    myLocalQuestions.forEach((item) => {
      const li = document.createElement("li");
      const label = typeof item === "string" ? item : `${item.pot === "finals" ? "[Finale] " : "[Wheel] "}${item.text}`;
      li.textContent = label;
      els.myQuestions.appendChild(li);
    });

    questionTick = setInterval(() => {
      if (!state || (state.phase !== "questions" && state.phase !== "finalsPrep")) return;
      const left = ((state.questionEndsAt || Date.now()) - Date.now()) / 1000;
      els.questionTimer.textContent = formatTime(left);
      els.questionTimer.classList.toggle("urgent", left <= 30);
      if (left <= 0 && me.isHost) {
        clearInterval(questionTick);
        if (state.phase === "questions") {
          handleAction({ type: "questionsDone" });
        } else if (state.phase === "finalsPrep") {
          if ((state.finalsQuestions || []).length > 0) {
            handleAction({ type: "beginFinalsNow" });
          } else {
            // Give more time if still empty
            state.questionEndsAt = Date.now() + FINALS_PREP_SECONDS * 1000;
            publish();
            toast("Still need rapid-fire questions — timer extended");
          }
        }
      }
    }, 250);
  }

  function renderGame() {
    const alive = activePlayers();
    els.scoreStrip.innerHTML = "";
    alive.forEach((p) => {
      const chip = document.createElement("span");
      chip.className = "score-chip";
      chip.innerHTML = `${escapeHtml(p.name)} · answered <strong>${p.answered}</strong> · skips <strong>${p.skips}/${MAX_SKIPS}</strong>`;
      els.scoreStrip.appendChild(chip);
    });

    drawWheel(alive, wheelAngle, state.phase === "answering" || state.phase === "confirm" ? state.spinTargetIndex : -1);

    if (state.phase === "spinning" && state.spinToken !== lastSpinToken) {
      els.wheelCaption.textContent = "The wheel decides…";
      animateWheelToIndex(alive, state.spinTargetIndex, state.spinToken);
    }

    const picked = getPlayer(state.currentPlayerId);
    const question = state.questions.find((q) => q.id === state.currentQuestionId);
    const isMe = state.currentPlayerId === me.id;
    const panel = els.actionPanel;
    panel.innerHTML = "";

    if (state.phase === "spinning") {
      panel.innerHTML = `<p class="waiting-note">Hold tight — a name is about to land.</p>`;
      return;
    }

    if (!picked || !question) {
      panel.innerHTML = `<p class="waiting-note">Preparing next spin…</p>`;
      return;
    }

    els.wheelCaption.textContent = `${picked.name} is up`;

    const nameEl = document.createElement("p");
    nameEl.className = "picked-name";
    nameEl.textContent = picked.name;
    panel.appendChild(nameEl);

    const qEl = document.createElement("p");
    qEl.className = "question-display";
    qEl.textContent = question.text;
    panel.appendChild(qEl);

    if (state.phase === "answering") {
      if (isMe) {
        const warn = document.createElement("p");
        warn.className = "skip-warn";
        warn.textContent = `Your score — answered: ${picked.answered} · skips: ${picked.skips}/${MAX_SKIPS} (${MAX_SKIPS - picked.skips} left before you’re out)`;
        panel.appendChild(warn);

        const row = document.createElement("div");
        row.className = "choice-row";
        row.innerHTML = `
          <button type="button" class="btn btn-danger" id="btn-skip">Skip</button>
          <button type="button" class="btn btn-primary" id="btn-answer">I’ll answer</button>
        `;
        panel.appendChild(row);
        $("#btn-skip", panel).onclick = () => send({ type: "skip", playerId: me.id });
        $("#btn-answer", panel).onclick = () => send({ type: "chooseAnswer", playerId: me.id });
      } else {
        const note = document.createElement("p");
        note.className = "waiting-note";
        note.textContent = `Waiting for ${picked.name} to skip or answer…`;
        panel.appendChild(note);
      }
    }

    if (state.phase === "confirm") {
      if (isMe) {
        const note = document.createElement("p");
        note.className = "waiting-note";
        note.textContent = "Shout your answer out loud. When you’re done:";
        panel.appendChild(note);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-ok btn-lg";
        btn.textContent = "Have you answered? — Yes";
        btn.onclick = () => send({ type: "confirmAnswered", playerId: me.id });
        panel.appendChild(btn);
      } else {
        const note = document.createElement("p");
        note.className = "waiting-note";
        note.textContent = `${picked.name} is answering out loud…`;
        panel.appendChild(note);
      }
    }
  }

  function renderFinals() {
    const f = state.finals;
    if (!f) return;
    const a = getPlayer(f.aId);
    const b = getPlayer(f.bId);
    els.finalistAName.textContent = a?.name || "—";
    els.finalistBName.textContent = b?.name || "—";
    els.finalistAScore.textContent = String(f.aScore);
    els.finalistBScore.textContent = String(f.bScore);

    const amA = me.id === f.aId;
    const amB = me.id === f.bId;
    const canBuzz = f.phase === "open" && (amA || amB);

    els.buzzerA.disabled = !(canBuzz && amA);
    els.buzzerB.disabled = !(canBuzz && amB);
    els.buzzerA.classList.toggle("lit", f.buzzedBy === f.aId);
    els.buzzerB.classList.toggle("lit", f.buzzedBy === f.bId);

    const q = f.questions[f.index];
    els.finalsControls.innerHTML = "";

    if (f.phase === "ready") {
      els.finalsPhaseLabel.textContent = "Finale";
      els.finalsQuestion.textContent = `${a?.name} vs ${b?.name} — rapid-fire buzzers. First to buzz answers out loud.`;
      els.finalsTimer.textContent = formatTime(FINALS_SECONDS);
      if (me.isHost) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-primary";
        btn.textContent = "Start rapid-fire";
        btn.onclick = () => send({ type: "startFinalsClock" });
        els.finalsControls.appendChild(btn);
      } else {
        els.finalsControls.innerHTML = `<p class="waiting-note">Waiting for host…</p>`;
      }
      return;
    }

    if (!q) {
      els.finalsQuestion.textContent = "Wrapping up…";
      return;
    }

    els.finalsPhaseLabel.textContent =
      f.phase === "open" ? "Buzz in!" : f.buzzedBy ? `${getPlayer(f.buzzedBy)?.name} buzzed` : "Locked";
    els.finalsQuestion.textContent = q.text;

    const updateTimer = () => {
      if (!state?.finals?.endsAt) return;
      const left = (state.finals.endsAt - Date.now()) / 1000;
      els.finalsTimer.textContent = formatTime(left);
      if (left <= 0 && me.isHost && state.finals.phase !== "ready") {
        clearInterval(finalsTick);
        finishFinals();
      }
    };
    updateTimer();
    finalsTick = setInterval(updateTimer, 250);

    if (f.phase === "locked" && me.isHost) {
      const row = document.createElement("div");
      row.className = "choice-row";
      row.innerHTML = `
        <button type="button" class="btn btn-ok" id="btn-correct">Correct</button>
        <button type="button" class="btn btn-danger" id="btn-wrong">Wrong</button>
      `;
      els.finalsControls.appendChild(row);
      $("#btn-correct", row).onclick = () => send({ type: "judgeBuzz", correct: true });
      $("#btn-wrong", row).onclick = () => send({ type: "judgeBuzz", correct: false });
    } else if (f.phase === "locked") {
      els.finalsControls.innerHTML = `<p class="waiting-note">Host is judging the answer…</p>`;
    } else if (f.phase === "open") {
      if (amA || amB) {
        els.finalsControls.innerHTML = `<p class="waiting-note">Smash your buzzer if you know it!</p>`;
      } else {
        els.finalsControls.innerHTML = `<p class="waiting-note">Spectating the showdown…</p>`;
      }
    }
  }

  function renderEnd() {
    const winner = getPlayer(state.winnerId);
    const revealFor = getPlayer(state.revealForId);
    els.endTitle.textContent = winner ? `${winner.name} takes it` : "That’s a wrap";
    els.endSub.textContent = revealFor
      ? `${revealFor.name} earned the author reveal (most answers in the main round).`
      : "Thanks for playing.";

    const ranked = [...state.players].sort((a, b) => b.answered - a.answered);
    els.standings.innerHTML = "";
    ranked.forEach((p, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>#${i + 1} ${escapeHtml(p.name)}${p.kicked ? " (out)" : ""}</span><span>${p.answered} answered · ${p.skips} skips</span>`;
      els.standings.appendChild(li);
    });

    const canReveal = me.id === state.revealForId || me.id === state.winnerId;
    if (canReveal && ((state.questions?.length || 0) + (state.finalsQuestions?.length || 0)) > 0) {
      els.revealPanel.hidden = false;
      els.revealList.innerHTML = "";
      (state.questions || []).forEach((q) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="q">[Wheel] ${escapeHtml(q.text)}</span><span class="by">— ${escapeHtml(q.authorName)}</span>`;
        els.revealList.appendChild(li);
      });
      (state.finalsQuestions || []).forEach((q) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="q">[Finale] ${escapeHtml(q.text)}</span><span class="by">— ${escapeHtml(q.authorName)}</span>`;
        els.revealList.appendChild(li);
      });
    } else {
      els.revealPanel.hidden = true;
      if (!canReveal) {
        els.endSub.textContent += " Only the top answerer can see who wrote each question.";
      }
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- room bootstrap ----------
  function applyPlayers(players) {
    if (!state) {
      state = mergeGameIntoState({ roomCode: sync?.code, phase: "lobby" }, players);
    } else {
      state = { ...state, players };
    }
    render();
  }

  function applyGameState(st) {
    const players = state?.players || st.players || [];
    state = { ...st, players };
    render();
  }

  function attachSyncHandlers() {
    sync.onState = (st) => applyGameState(st);
    sync.onPlayers = (players) => applyPlayers(players);
    sync.onAction = handleAction;
  }

  async function createRoom(name, preferLocal) {
    const code = roomCode();
    me = { id: uid(), name, isHost: true };
    myLocalQuestions = [];
    lastSpinToken = -1;

    const player = {
      id: me.id,
      name,
      answered: 0,
      skips: 0,
      kicked: false,
      isHost: true,
    };
    state = createState(code, player);

    sync = preferLocal ? new LocalSync(code, true) : new SupabaseSync(code, true);
    attachSyncHandlers();

    try {
      if (preferLocal) {
        await sync.start();
      } else {
        await sync.start({ hostPlayer: player });
        const players = await sync.fetchPlayers();
        applyPlayers(players);
      }
    } catch (err) {
      if (!preferLocal) {
        console.error(err);
        toast("Supabase failed — switching to local tab sync");
        sync.destroy?.();
        sync = new LocalSync(code, true);
        attachSyncHandlers();
        await sync.start();
        const url = new URL(location.href);
        url.searchParams.set("room", code);
        url.searchParams.set("local", "1");
        history.replaceState(null, "", url);
      } else {
        throw err;
      }
    }

    const url = new URL(location.href);
    url.searchParams.set("room", code);
    url.searchParams.delete("host");
    if (preferLocal) url.searchParams.set("local", "1");
    else url.searchParams.delete("local");
    history.replaceState(null, "", url);

    await publish();
    showScreen("lobby");
    saveSession();
    toast(
      preferLocal
        ? "Local room ready — open this link in other tabs"
        : `Room ${code} ready — share ?room=${code}`
    );
  }

  async function joinRoom(name, code, preferLocal, opts = {}) {
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (code.length < 4) throw new Error("Enter a valid room code.");

    const resumeId = opts.resumeId || null;
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Enter a name.");

    // Block duplicate names before joining (except resuming as yourself)
    if (!resumeId) {
      if (!preferLocal) {
        const { data: existing, error } = await db()
          .from("players")
          .select("id, name")
          .eq("room_id", code);
        if (error) throw new Error(error.message);
        if (
          (existing || []).some(
            (p) => p.name.toLowerCase() === cleanName.toLowerCase()
          )
        ) {
          throw new Error(
            "That name is already taken in this room. Pick another."
          );
        }
      }
    }

    me = {
      id: resumeId || uid(),
      name: cleanName,
      isHost: !!opts.resumeAsHost,
    };
    myLocalQuestions = [];
    lastSpinToken = -1;
    state = null;

    sync = preferLocal ? new LocalSync(code, me.isHost) : new SupabaseSync(code, me.isHost);

    try {
      if (preferLocal) {
        let joined = false;
        sync.onState = (st) => {
          state = st;
          render();
          saveSession();
          if (!joined && !opts.resumeId) {
            joined = true;
            const taken = (st.players || []).some(
              (p) =>
                p.id !== me.id &&
                String(p.name || "").toLowerCase() === cleanName.toLowerCase()
            );
            if (taken) {
              handleNameTaken(
                "That name is already taken in this room. Pick another."
              );
              return;
            }
            send({
              type: "join",
              player: { id: me.id, name: me.name },
            });
          }
        };
        sync.onAction = handleAction;
        await sync.start();
        await new Promise((r) => setTimeout(r, 400));
        if (!state && sync) throw new Error("No local room found. Create one first on this device.");
        if (!sync) return; // name was taken and cleaned up
      } else if (me.isHost) {
        attachSyncHandlers();
        const hostPlayer = {
          id: me.id,
          name: me.name,
          answered: 0,
          skips: 0,
          kicked: false,
          isHost: true,
        };
        await sync.start({ hostPlayer, resume: true });
        const players = await sync.fetchPlayers();
        applyPlayers(players);
      } else {
        attachSyncHandlers();
        const joinPlayer = {
          id: me.id,
          name: me.name,
          answered: 0,
          skips: 0,
          kicked: false,
          isHost: false,
        };
        await sync.start({ joinPlayer, resume: !!resumeId });
        if (!state) throw new Error("Room not found. Check ?room=CODE.");
      }

      const url = new URL(location.href);
      url.searchParams.set("room", code);
      url.searchParams.delete("host");
      if (preferLocal) url.searchParams.set("local", "1");
      else url.searchParams.delete("local");
      history.replaceState(null, "", url);
      saveSession();
    } catch (err) {
      try {
        sync?.destroy?.();
      } catch (_) {}
      sync = null;
      state = null;
      throw err;
    }
  }

  async function resumeRoom(code) {
    const session = loadSession(code);
    if (!session?.id) return false;

    const preferLocal = wantLocalMode();
    try {
      await joinRoom(session.name, code, preferLocal, {
        resumeId: session.id,
        resumeAsHost: !!session.isHost,
      });
      toast(`Welcome back, ${session.name}`);
      return true;
    } catch (err) {
      console.error("Resume failed:", err);
      clearSession(code);
      return false;
    }
  }

  let inviteMode = false;

  function resetHomeToFirstLook() {
    inviteMode = false;
    document.getElementById("screen-home")?.classList.remove("invite-receiver-mode");
    els.btnCreate.hidden = false;
    els.btnCreate.style.display = "";
    const joinRow = document.querySelector("#screen-home .join-row");
    if (joinRow) {
      joinRow.hidden = false;
      joinRow.style.display = "";
    }
    const inviteBlock = document.getElementById("invite-join-block");
    if (inviteBlock) inviteBlock.hidden = true;
  }

  // ---------- events ----------
  function wantLocalMode() {
    const params = new URLSearchParams(location.search);
    return params.get("local") === "1" || location.protocol === "file:";
  }

  els.homeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setHomeError("");
    const name = els.playerName.value.trim();
    if (!name) return;

    // Invite-link receivers: Enter submits join, not create
    if (inviteMode) {
      els.btnJoin.click();
      return;
    }

    const preferLocal = wantLocalMode();
    els.btnCreate.disabled = true;
    try {
      await createRoom(name, preferLocal);
    } catch (err) {
      setHomeError(err.message || "Could not create room.");
    } finally {
      els.btnCreate.disabled = false;
    }
  });

  els.btnJoin.addEventListener("click", async () => {
    setHomeError("");
    const name = els.playerName.value.trim();
    const code = els.roomCode.value.trim();
    if (!name) {
      setHomeError("Add your name first.");
      return;
    }
    const preferLocal = wantLocalMode();
    els.btnJoin.disabled = true;
    try {
      await joinRoom(name, code, preferLocal);
    } catch (err) {
      setHomeError(err.message || "Could not join room.");
    } finally {
      els.btnJoin.disabled = false;
    }
  });
  els.btnCopyLink.addEventListener("click", async () => {
    if (!state) return;
    const url = inviteUrl(state.roomCode);
    if (new URLSearchParams(location.search).get("local") === "1") {
      const u = new URL(url);
      u.searchParams.set("local", "1");
      try {
        await navigator.clipboard.writeText(u.toString());
        toast("Invite link copied");
      } catch (_) {
        toast(u.toString());
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied");
    } catch (_) {
      toast(url);
    }
  });

  els.btnStartQuestions.addEventListener("click", () => {
    send({ type: "startQuestions" });
  });

  els.questionForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.questionInput.value.trim();
    if (!text) return;
    const potEl = document.querySelector('input[name="question-pot"]:checked');
    const pot =
      state?.phase === "finalsPrep" ? "finals" : potEl?.value === "finals" ? "finals" : "wheel";
    myLocalQuestions.push({ text, pot });
    send({ type: "addQuestion", playerId: me.id, text, pot });
    els.questionInput.value = "";
    els.questionFeedback.hidden = false;
    els.questionFeedback.textContent =
      pot === "finals" ? "Added to rapid-fire pot." : "Added to wheel pot.";
    setTimeout(() => {
      els.questionFeedback.hidden = true;
    }, 1600);
    if (state?.phase === "questions" || state?.phase === "finalsPrep") renderQuestions();
  });

  els.buzzerA.addEventListener("click", () => {
    if (state?.finals?.aId === me.id) send({ type: "buzz", playerId: me.id });
  });
  els.buzzerB.addEventListener("click", () => {
    if (state?.finals?.bId === me.id) send({ type: "buzz", playerId: me.id });
  });

  window.addEventListener("keydown", (e) => {
    if (!state || state.phase !== "finals" || state.finals?.phase !== "open") return;
    if (e.repeat) return;
    if (e.code === "Space" || e.key === "a" || e.key === "A" || e.key === "l" || e.key === "L") {
      e.preventDefault();
      if (state.finals.aId === me.id || state.finals.bId === me.id) {
        send({ type: "buzz", playerId: me.id });
      }
    }
  });
  els.btnPlayAgain.addEventListener("click", () => {
    if (state?.roomCode) clearSession(state.roomCode);
    sync?.destroy?.();
    sync = null;
    state = null;
    me = { id: null, name: "", isHost: false };
    myLocalQuestions = [];
    history.replaceState(null, "", "/");
    resetHomeToFirstLook();
    showScreen("home");
    els.playerName.value = "";
    els.roomCode.value = "";
    setHomeError("");
  });

  // Prefill / invite-only home when opening an existing room link (?room=)
  // First-look page (no ?room=) stays unchanged.
  const params = new URLSearchParams(location.search);
  const presetRoom = params.get("room");

  function enableInviteHome(code) {
    inviteMode = true;
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    els.roomCode.value = normalized;

    const home = document.getElementById("screen-home");
    const actions = document.querySelector("#screen-home .home-actions");
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

  (async () => {
    if (presetRoom) {
      const resumed = await resumeRoom(presetRoom);
      if (!resumed) enableInviteHome(presetRoom);
    } else if (params.get("host") !== "1") {
      location.replace("/");
      return;
    }
    drawWheel([{ name: "…" }, { name: "…" }, { name: "…" }, { name: "…" }], 0);
  })();
})();