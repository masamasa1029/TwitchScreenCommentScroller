// ==UserScript==
// @name        Twitch Screen Comment Scroller Custom 2
// @namespace   masamasa1029
// @description Twitch のコメントをニコニコ風にスクロールさせます。
// @match       https://www.twitch.tv/*
// @version     0.8.0
// 原作: knoa (kona) さんの "Twitch Screen Comment Scroller"
//   https://greasyfork.org/ja/scripts/376225
// 本スクリプトは、その改修版 "Twitch Screen Comment Scroller(fix)"
// (page.loupe) を土台に改変したものです。
//   https://greasyfork.org/scripts/458513-twitch-screen-comment-scroller-fix
// @updateURL   https://raw.githubusercontent.com/masamasa1029/TwitchScreenCommentScroller/main/TwitchScreenCommentScroller.user.js
// @downloadURL https://raw.githubusercontent.com/masamasa1029/TwitchScreenCommentScroller/main/TwitchScreenCommentScroller.user.js
// @grant       GM_registerMenuCommand
// @grant       GM_getValue
// @grant       GM_setValue
// @run-at      document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_NAME = "ScreenCommentScroller";
  const SETTINGS_KEY = `${SCRIPT_NAME}.settings.v2`;
  const STYLE_ID = `${SCRIPT_NAME}Style`;
  const COMMENT_SELECTOR =
    '[data-a-target="chat-line-message-body"], .video-chat__message';
  const PLAYER_SELECTOR =
    ".video-player__container, .chat-scrollable-area__message-container, .video-chat__message-list-wrapper, video";

  const DEFAULT_SETTINGS = Object.freeze({
    color: "#ffffff",
    outlineColor: "#000000",
    outlineWidth: 0.1,
    opacity: 0.25,
    fontSize: 48,
    fontFamily: "Meiryo",
    maxLines: 10,
    duration: 5,
    verticalMargin: 12,
    showStamps: true,
    emojiSize: 1.5,
    emojiLimit: 10,
    animateStamps: true,
    canvasMaxWidth: 2560,
    autoPrimeCollapsedChat: true,
    show: true,
    placement: "center",
    maxActiveComments: 0,
    maxCommentsPerLane: 0,
    minLaneInterval: 0,
    minCommentLength: 0,
    ignoreCommands: false,
    ignoreLinks: false,
    ignoreEmojiOnly: false,
    blockedWords: "",
  });

  // measureText 結果のキャッシュ上限。よく出る短い断片 (草、www 等) の再計測を避ける。
  const TEXT_MEASURE_CACHE_LIMIT = 500;
  // スプライトプールの上限枚数と、プール用に切り上げる幅の単位 (px)。
  const SPRITE_POOL_LIMIT = 48;
  const SPRITE_BUCKET_WIDTH = 64;

  let config = loadSettings();
  let blockedWordFilters = parseBlockedWords(config.blockedWords);
  let screen = null;
  let board = null;
  let video = null;
  let canvas = null;
  let context = null;
  let fontSize = 0;
  let laneHeight = 0;
  let textAscent = 0;
  let textDescent = 0;
  let viewport = { width: 0, height: 0, pixelRatio: 1 };
  let lines = [];
  let laneLastAddedAt = [];
  let laneCursor = 0;
  // 描画中コメントの総数。毎回 lines を数え直さずカウンタで管理する。
  let activeCommentTotal = 0;
  // レーン選択順を入れる使い回しバッファ。コメント追加のたびの配列生成を避ける。
  let laneOrderBuffer = [];
  // 前フレームで描いた行 (消去対象) と今フレームで描く行。2つの Set を交換して使い回す。
  let dirtyRows = new Set();
  let frameActiveRows = new Set();
  let needsFullClear = false;
  let commentObserver = null;
  let resizeObserver = null;
  let pageObserver = null;
  let animationFrame = null;
  let lastFrameAt = null;
  let removeVideoListeners = null;
  let controlsFrame = null;
  let menuFrame = null;
  let discoveryQueued = false;
  let mountedUrl = "";
  // 折りたたみチャットの自動初期化 (プライム) の実行中フラグと、
  // プレイヤー/ボードの差し替えを見張るウォッチドッグのタイマー。
  let primeInProgress = false;
  let watchdogTimer = null;
  // プライム可否の状態管理 (URL単位)。対象は「そのページに到着した時点で
  // 折りたたまれていて、まだ一度も開かれていない」場合だけに限る。
  // 展開状態を一度でも見た、またはユーザーが自分で閉じた場合は対象外。
  let primeUrl = "";
  let primeSettled = false;
  let primeWindowUntil = 0;
  let lastChatCollapsed = null;
  let seenComments = new WeakSet();
  // measureText の結果キャッシュ (キー: 文字列)。フォント変更時に破棄する。
  const textMeasureCache = new Map();
  // 使い終わったスプライト表面のプール (キー: "幅バケツx高さ")。
  const spritePool = new Map();
  let spritePoolCount = 0;
  // アニメーションスタンプのデコード済みフレーム (キー: 画像URL)。
  // 同じスタンプが何度も流れるため、URL単位で共有して再デコードを避ける。
  // 上限は「フレームを保持しているエントリ」だけを数える (静止画だった
  // エントリはフレームを持たずメモリをほぼ使わないため数えない)。
  const ANIMATED_STAMP_CACHE_LIMIT = 48;
  const ANIMATED_STAMP_MAX_FRAMES = 120;
  const animatedStampCache = new Map();

  const site = {
    getScreen: () => document.querySelector(".video-player__container"),
    getBoard: () =>
      document.querySelector(".chat-scrollable-area__message-container") ||
      document.querySelector(".video-chat__message-list-wrapper ul"),
    getVideo: (player) => player?.querySelector("video") || null,
    // チャットの展開/折りたたみボタン。UI言語で aria-label が変わるため、
    // 日本語と英語の両方を候補にする。
    getExpandChatButton: () =>
      document.querySelector(
        'button[aria-label="チャットを展開"], button[aria-label="Expand chat"]',
      ),
    getCollapseChatButton: () =>
      document.querySelector(
        'button[aria-label="チャットを折りたたむ"], button[aria-label="Collapse chat"]',
      ),
  };

  const core = {
    start() {
      core.addStyle();
      core.registerMenu();
      core.observePage();
      core.queueDiscovery();
      core.startWatchdog();
    },

    // ページ監視 (MutationObserver) が取りこぼしたプレイヤー/チャット欄の
    // 差し替えを、数秒間隔の軽い確認で拾う保険。
    startWatchdog() {
      if (watchdogTimer) return;
      watchdogTimer = setInterval(() => {
        if (!screen) return;
        const currentBoard = site.getBoard();
        if (
          !screen.isConnected ||
          !board?.isConnected ||
          !video?.isConnected ||
          (currentBoard && currentBoard !== board)
        ) {
          core.queueDiscovery();
          return;
        }
        // 開閉状態を記録してから、対象の場合だけプライムする。
        core.noteChatState();
        core.maybePrimeCollapsedChat();
      }, 3000);
    },

    // チャット欄が折りたたまれているかどうか。
    // 展開ボタンが存在するか、ボードが描画領域を持たない (非表示) ことで判定する。
    isChatCollapsed() {
      if (site.getExpandChatButton()) return true;
      if (!board) return false;
      return board.getClientRects().length === 0;
    },

    // チャットの開閉状態を記録し、プライムの対象かどうかを確定させる。
    // 展開状態を一度でも見たら、そのページでは以後プライムしない
    // (＝Twitch 側の初期化は済んでいるし、後からユーザーが自分で閉じた
    // チャットを勝手に開き直すこともなくなる)。
    noteChatState() {
      if (primeUrl !== location.href) {
        primeUrl = location.href;
        primeSettled = false;
        primeWindowUntil = performance.now() + 30000;
        lastChatCollapsed = null;
      }
      if (!board || primeInProgress) return;
      // 判定不能な状態 (ボードがまだレイアウトされていない等) は記録しない。
      let collapsed = null;
      if (site.getExpandChatButton()) collapsed = true;
      else if (board.getClientRects().length > 0) collapsed = false;
      if (collapsed === null) return;
      if (!collapsed) {
        primeSettled = true;
      } else if (lastChatCollapsed === false) {
        // 展開されていたものが閉じられた＝ユーザーが自分で閉じた操作。
        primeSettled = true;
      }
      lastChatCollapsed = collapsed;
    },

    // 折りたたんだまま別配信へ移ると、Twitch 側のチャットは初期バックログを
    // DOM に入れただけで新規メッセージの追加を始めないことがある
    // (一度展開すると以後は折りたたんでも追加され続ける)。
    // その手動の「一度開いて閉じる」を、対象ページで1回だけ自動で行う。
    // 対象は noteChatState で確定した「到着時に折りたたまれていて未展開」
    // のページだけ。到着から時間が経った後の折りたたみには干渉しない。
    maybePrimeCollapsedChat() {
      if (!config.autoPrimeCollapsedChat) return;
      if (primeInProgress || primeSettled) return;
      if (primeUrl !== location.href) return;
      if (performance.now() > primeWindowUntil) return;
      if (!board || !core.isChatCollapsed()) return;
      const expandButton = site.getExpandChatButton();
      if (!expandButton) return;

      primeSettled = true;
      primeInProgress = true;
      const startedAt = performance.now();
      expandButton.click();

      const finishPrime = () => {
        const collapseButton = site.getCollapseChatButton();
        if (collapseButton && core.isChatCollapsed() === false)
          collapseButton.click();
        primeInProgress = false;
        // 展開/折りたたみでボードが差し替わっている場合に監視を付け直す。
        core.queueDiscovery();
      };
      const waitUntilVisible = () => {
        const currentBoard = site.getBoard();
        const visible =
          currentBoard && currentBoard.getClientRects().length > 0;
        const elapsed = performance.now() - startedAt;
        // チャットが見える状態になって少し経つか、タイムアウトで閉じに戻す。
        if ((visible && elapsed >= 1000) || elapsed >= 4000) {
          finishPrime();
          return;
        }
        setTimeout(waitUntilVisible, 200);
      };
      setTimeout(waitUntilVisible, 200);
    },

    registerMenu() {
      if (typeof GM_registerMenuCommand === "function") {
        GM_registerMenuCommand("コメントスクロール設定", core.openSettings);
      }
    },

    observePage() {
      if (pageObserver || !document.body) return;
      pageObserver = new MutationObserver(core.handlePageMutations);
      // head内の更新はプレイヤー再生成と無関係なため、bodyだけを監視する。
      pageObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
      window.addEventListener("popstate", core.queueDiscovery);
      window.addEventListener("hashchange", core.queueDiscovery);
      window.addEventListener("pagehide", core.teardown);
    },

    handlePageMutations(mutations) {
      const playerWasReplaced =
        !screen?.isConnected || !board?.isConnected || !video?.isConnected;
      const urlChanged = mountedUrl !== location.href;
      if (
        playerWasReplaced ||
        urlChanged ||
        mutations.some(core.isRelevantPageMutation)
      ) {
        core.queueDiscovery();
      }
    },

    isRelevantPageMutation(mutation) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(PLAYER_SELECTOR)) return true;
        // チャット本文やプレイヤーUIの更新は専用の監視で処理済み。
        // ここで子孫検索をしないことで、高速チャット時の走査を避ける。
        if (board?.contains(node) || screen?.contains(node)) continue;
        if (node.querySelector(PLAYER_SELECTOR)) return true;
      }
      return false;
    },

    queueDiscovery() {
      if (discoveryQueued) return;
      discoveryQueued = true;
      requestAnimationFrame(() => {
        discoveryQueued = false;
        core.mountIfNeeded();
      });
    },

    mountIfNeeded() {
      const nextScreen = site.getScreen();
      const nextBoard = site.getBoard();
      const nextVideo = site.getVideo(nextScreen);
      const urlChanged = mountedUrl !== location.href;

      if (!nextScreen || !nextBoard || !nextVideo) return;
      if (
        nextScreen === screen &&
        nextBoard === board &&
        nextVideo === video &&
        !urlChanged &&
        canvas
      )
        return;

      core.teardownPlayer();
      screen = nextScreen;
      board = nextBoard;
      video = nextVideo;
      mountedUrl = location.href;
      core.initialize();
    },

    initialize() {
      seenComments = new WeakSet();

      canvas = document.createElement("canvas");
      canvas.id = SCRIPT_NAME;
      canvas.setAttribute("aria-hidden", "true");
      screen.appendChild(canvas);
      context = canvas.getContext("2d");

      core.resizeCanvas();
      core.resetLines();
      resizeObserver = new ResizeObserver(() => {
        const oldViewport = { ...viewport };
        if (core.resizeCanvas()) {
          // サイズ変更ではコメントを消さず、位置を新しい画面へ写し替える。
          core.remapCommentsAfterResize(oldViewport);
        }
      });
      resizeObserver.observe(screen);

      core.listenComments();
      core.bindVideoPlayback();
      core.installControls();
      core.startAnimation();
      core.noteChatState();
      core.maybePrimeCollapsedChat();
    },

    teardown() {
      pageObserver?.disconnect();
      pageObserver = null;
      core.teardownPlayer();
    },

    teardownPlayer() {
      core.stopAnimation();
      commentObserver?.disconnect();
      commentObserver = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      removeVideoListeners?.();
      removeVideoListeners = null;
      if (controlsFrame) cancelAnimationFrame(controlsFrame);
      if (menuFrame) cancelAnimationFrame(menuFrame);
      controlsFrame = null;
      menuFrame = null;

      core.releaseAllSprites();
      canvas?.remove();
      canvas = null;
      context = null;
      fontSize = 0;
      laneHeight = 0;
      textAscent = 0;
      textDescent = 0;
      viewport = { width: 0, height: 0, pixelRatio: 1 };
      lines = [];
      activeCommentTotal = 0;
      dirtyRows.clear();
      frameActiveRows.clear();
      needsFullClear = false;
      document
        .querySelector(`#${SCRIPT_NAME}ChatButton`)
        ?.closest(`[data-from="${SCRIPT_NAME}"]`)
        ?.remove();
    },

    resizeCanvas() {
      if (!screen || !canvas || !context) return false;
      const width = Math.round(screen.clientWidth);
      const height = Math.round(screen.clientHeight);
      if (!width || !height) return false;
      // 内部解像度の上限: 4K + 高DPRでもバッファが際限なく大きくならないよう、
      // 実効 pixelRatio を「Canvas最大幅 / 表示幅」で頭打ちにする。
      // スプライトもこの実効 pixelRatio で作るため、自動的に同じ解像度へ揃う。
      let pixelRatio = window.devicePixelRatio || 1;
      if (config.canvasMaxWidth > 0) {
        pixelRatio = Math.min(pixelRatio, config.canvasMaxWidth / width);
      }
      if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) pixelRatio = 1;
      if (
        width === viewport.width &&
        height === viewport.height &&
        pixelRatio === viewport.pixelRatio
      )
        return false;

      viewport = { width, height, pixelRatio };
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      applyDrawingSettings();
      return true;
    },

    resetLines() {
      // 破棄するコメントのスプライトはプールへ返し、カウンタもリセットする。
      core.releaseAllSprites();
      activeCommentTotal = 0;
      const availableRows = availableLaneCount();
      const targetLines =
        config.maxLines === 0
          ? availableRows
          : Math.min(config.maxLines, availableRows);

      lines = Array.from({ length: targetLines }, () => []);
      laneLastAddedAt = Array(lines.length).fill(-Infinity);
      laneCursor = 0;
      dirtyRows.clear();
      frameActiveRows.clear();
      needsFullClear = true;
    },

    // 動画部分のサイズ変更時に、流れているコメントを消さずに引き継ぐ。
    // 各コメントは「進んだ距離の割合 (進行割合)」を保ったまま、
    // 新しい画面幅での位置・速度・レーン判定の残り時間を計算し直す。
    // レーン数が減った場合だけ、はみ出したレーンのコメントを破棄する。
    remapCommentsAfterResize(oldViewport) {
      if (!lines.length || !(oldViewport.width > 0)) {
        core.resetLines();
        return;
      }
      const newWidth = viewport.width;
      const availableRows = availableLaneCount();
      const targetLines =
        config.maxLines === 0
          ? availableRows
          : Math.min(config.maxLines, availableRows);

      if (targetLines < lines.length) {
        for (let index = targetLines; index < lines.length; index += 1) {
          for (const record of lines[index]) {
            activeCommentTotal -= 1;
            core.releaseSprite(record.sprite);
            record.sprite = null;
          }
        }
        lines.length = targetLines;
        laneLastAddedAt.length = targetLines;
      }
      while (lines.length < targetLines) {
        lines.push([]);
        laneLastAddedAt.push(-Infinity);
      }
      if (laneCursor >= lines.length) laneCursor = 0;

      const durationMs = config.duration * 1000;
      for (let index = 0; index < lines.length; index += 1) {
        const rowTop = laneAreaTop() + laneHeight * index;
        for (const record of lines[index]) {
          const oldTrackWidth = oldViewport.width + record.width;
          const progress = Math.min(
            1,
            Math.max(0, (oldViewport.width - record.left) / oldTrackWidth),
          );
          const newTrackWidth = newWidth + record.width;
          record.pixelsPerMs = newTrackWidth / durationMs;
          record.left = newWidth - progress * newTrackWidth;
          record.reveal =
            (record.left + record.width - newWidth) / record.pixelsPerMs;
          record.touch = record.left / record.pixelsPerMs;
          record.rowTop = rowTop;
          record.top =
            rowTop +
            (laneHeight - textAscent - textDescent) / 2 +
            textAscent;
        }
      }
      // Canvas はサイズ変更で消えているため、次フレームは全面消去から始める。
      dirtyRows.clear();
      frameActiveRows.clear();
      needsFullClear = true;
    },

    releaseAllSprites() {
      for (const row of lines) {
        for (const record of row) core.releaseSprite(record.sprite);
      }
    },

    releaseSprite(sprite) {
      if (!sprite) return;
      if (spritePoolCount >= SPRITE_POOL_LIMIT) return;
      const stack = spritePool.get(sprite.poolKey);
      if (stack) stack.push(sprite.surface);
      else spritePool.set(sprite.poolKey, [sprite.surface]);
      spritePoolCount += 1;
    },

    acquireSpriteSurface(logicalWidth, logicalHeight, scale) {
      // 幅はバケツ単位に切り上げてプールのヒット率を上げる。
      // 実際の描画は drawImage のソース矩形で論理サイズ分だけ切り出す。
      const bucketWidth =
        Math.ceil(logicalWidth / SPRITE_BUCKET_WIDTH) * SPRITE_BUCKET_WIDTH;
      const poolKey = `${bucketWidth}x${logicalHeight}x${scale}`;
      const stack = spritePool.get(poolKey);
      let surface;
      if (stack?.length) {
        surface = stack.pop();
        spritePoolCount -= 1;
      } else if (typeof OffscreenCanvas === "function") {
        surface = new OffscreenCanvas(
          Math.ceil(bucketWidth * scale),
          Math.ceil(logicalHeight * scale),
        );
      } else {
        surface = document.createElement("canvas");
        surface.width = Math.ceil(bucketWidth * scale);
        surface.height = Math.ceil(logicalHeight * scale);
      }
      return { surface, poolKey };
    },

    addStyle() {
      let style = document.getElementById(STYLE_ID);
      if (style) return;
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        canvas#${SCRIPT_NAME} {
          pointer-events: none;
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          opacity: 1;
          z-index: 99999;
        }
        dialog#${SCRIPT_NAME}Settings {
          color: #efeff1;
          background: #18181b;
          border: 1px solid #464649;
          border-radius: 8px;
          padding: 20px;
          max-width: min(92vw, 420px);
        }
        dialog#${SCRIPT_NAME}Settings::backdrop { background: rgba(0, 0, 0, .65); }
        #${SCRIPT_NAME}Settings form { display: grid; gap: 12px; }
        #${SCRIPT_NAME}Settings label { display: grid; gap: 4px; font: 14px sans-serif; }
        #${SCRIPT_NAME}Settings input, #${SCRIPT_NAME}Settings select { box-sizing: border-box; width: 100%; }
        #${SCRIPT_NAME}Settings .${SCRIPT_NAME}-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      `;
      (document.head || document.documentElement).appendChild(style);
    },

    listenComments() {
      commentObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            core.findComments(node).forEach(core.attachComment);
          }
        }
      });
      // Twitch の仮想スクロールで追加される入れ子要素も検知する。
      commentObserver.observe(board, { childList: true, subtree: true });
    },

    findComments(node) {
      const candidates = new Set();
      const parentComment = node.parentElement?.closest(COMMENT_SELECTOR);
      if (parentComment) candidates.add(parentComment);
      if (!(node instanceof Element)) return [...candidates];

      const addOutermostComment = (candidate) => {
        candidates.add(
          candidate.parentElement?.closest(COMMENT_SELECTOR) || candidate,
        );
      };
      if (node.matches(COMMENT_SELECTOR)) addOutermostComment(node);
      node.querySelectorAll(COMMENT_SELECTOR).forEach(addOutermostComment);
      return [...candidates];
    },

    attachComment(comment) {
      if (!config.show || seenComments.has(comment)) return;

      const parts = core.getCommentParts(comment);
      if (!parts.length) return;
      if (!core.passesCommentFilters(parts)) return;
      // 本文が後から挿入されることがあるため、空のコメントは未処理のままにする。
      seenComments.add(comment);
      if (
        config.maxActiveComments > 0 &&
        core.activeCommentCount() >= config.maxActiveComments
      )
        return;

      const width = parts.reduce((total, part) => total + part.width, 0);
      if (!width || !Number.isFinite(width)) return;

      const durationMs = config.duration * 1000;
      const pixelsPerMs = (viewport.width + width) / durationMs;
      const record = {
        parts,
        width,
        life: durationMs,
        left: viewport.width,
        pixelsPerMs,
        reveal: width / pixelsPerMs,
        touch: viewport.width / pixelsPerMs,
        top: 0,
        sprite: null,
        imageLoadBound: false,
        spriteRebuildQueued: false,
        hasAnimatedStamp: parts.some(
          (part) => part.type === "image" && part.animated,
        ),
      };

      const now = performance.now();
      for (const index of core.getLaneOrder()) {
        const row = lines[index];
        const previous = row.at(-1);
        if (
          config.maxCommentsPerLane > 0 &&
          row.length >= config.maxCommentsPerLane
        )
          continue;
        if (now - laneLastAddedAt[index] < config.minLaneInterval * 1000)
          continue;
        const rowIsAvailable =
          !previous ||
          (previous.reveal <= 0 && previous.pixelsPerMs > record.pixelsPerMs) ||
          (previous.life < record.touch &&
            previous.pixelsPerMs < record.pixelsPerMs);
        if (!rowIsAvailable) continue;

        record.rowTop = laneAreaTop() + laneHeight * index;
        record.top =
          record.rowTop +
          (laneHeight - textAscent - textDescent) / 2 +
          textAscent;
        core.rasterizeComment(record);
        row.push(record);
        activeCommentTotal += 1;
        laneLastAddedAt[index] = now;
        if (config.placement === "spread")
          laneCursor = (index + 1) % lines.length;
        core.startAnimation();
        return;
      }
      // 全レーンが埋まったコメントは意図的に捨て、キューを無制限に増やさない。
    },

    getLaneOrder() {
      // 使い回しバッファへ書き込み、呼び出し側は直ちに走査する前提で返す。
      laneOrderBuffer.length = lines.length;
      if (config.placement === "top") {
        for (let index = 0; index < lines.length; index += 1)
          laneOrderBuffer[index] = index;
        return laneOrderBuffer;
      }
      if (config.placement === "bottom") {
        for (let index = 0; index < lines.length; index += 1)
          laneOrderBuffer[index] = lines.length - index - 1;
        return laneOrderBuffer;
      }
      if (config.placement === "spread") {
        for (let offset = 0; offset < lines.length; offset += 1)
          laneOrderBuffer[offset] = (laneCursor + offset) % lines.length;
        return laneOrderBuffer;
      }

      let write = 0;
      const leftCenter = Math.floor((lines.length - 1) / 2);
      const rightCenter = Math.ceil((lines.length - 1) / 2);
      for (let offset = 0; write < lines.length; offset += 1) {
        const left = leftCenter - offset;
        const right = rightCenter + offset;
        if (left >= 0) laneOrderBuffer[write++] = left;
        if (right < lines.length && right !== left)
          laneOrderBuffer[write++] = right;
      }
      return laneOrderBuffer;
    },

    activeCommentCount() {
      // カウンタ参照のみ (O(1))。増減は投入時と寿命切れ除去時に行う。
      return activeCommentTotal;
    },

    passesCommentFilters(parts) {
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      if (text.length < config.minCommentLength) return false;
      if (
        config.ignoreEmojiOnly &&
        !text &&
        parts.some((part) => part.type === "image")
      )
        return false;
      if (config.ignoreCommands && text.startsWith("!")) return false;
      if (config.ignoreLinks && /(?:https?:\/\/|www\.)/i.test(text))
        return false;

      return !blockedWordFilters.some((word) => text.includes(word));
    },

    getCommentParts(comment) {
      // Twitchではテキスト断片とスタンプ画像が同じ本文要素の兄弟として置かれる。
      // 最初のテキスト断片だけでなく、本文全体をDOM順に読み取る。
      const message = comment.matches(
        '[data-a-target="chat-line-message-body"]',
      )
        ? comment
        : comment.querySelector('[data-a-target="chat-line-message-body"]') ||
          comment.querySelector('[data-a-target="chat-message-text"]') ||
          comment;
      const parts = [];
      let images = 0;
      let runningOffset = 0;
      const walker = document.createTreeWalker(
        message,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      );
      let node = walker.nextNode();

      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.replace(/\s+/g, " ");

          // アーカイブ特有のスタンプ前後の孤立したコロンを除外する
          if (text && text !== ":") {
            const width = measureTextCached(text);
            const previous = parts.at(-1);
            if (previous?.type === "text") {
              previous.text += text;
              previous.width += width;
            } else {
              parts.push({ type: "text", text, width, offset: runningOffset });
            }
            runningOffset += width;
          }
        } else if (
          node instanceof HTMLImageElement &&
          config.showStamps &&
          images < config.emojiLimit
        ) {
          images += 1;
          const size = fontSize * config.emojiSize;
          // 表示の高さは size に固定し、幅は元画像のアスペクト比から
          // 決める (正方形に引き伸ばすと横長・縦長の画像が潰れるため)。
          // チャット側の img は表示済みで自然サイズが分かることが多い。
          const aspect =
            node.naturalWidth && node.naturalHeight
              ? node.naturalWidth / node.naturalHeight
              : 1;
          // チャットDOMの img 要素そのものは保持しない。
          // 仮想スクロールで要素が再利用・除去されても化けないよう、
          // URL を控えて自前の Image へ読み直す。解像度は srcset に任せる。
          const source = node.currentSrc || node.src || "";
          const image = new Image();
          if (node.srcset) {
            image.srcset = node.srcset;
            image.sizes = `${Math.ceil(size)}px`;
          }
          image.src = source;
          const animated =
            config.animateStamps && isAnimatedStampSource(source, node);
          // Twitch は同じスタンプの繰り返しに #e=0, #e=1... と
          // インスタンス番号のフラグメントを付ける。フラグメント違いを
          // 別URLとしてキャッシュすると、1コメントでキャッシュが
          // 埋まって追い出しが起きるため、キーには使わない。
          const stampUrl = source.split("#")[0];
          const displayWidth = stampDisplayWidth(size, aspect);
          parts.push({
            type: "image",
            image,
            url: stampUrl,
            alt: node.alt || "",
            width: displayWidth,
            size,
            aspect,
            offset: runningOffset,
            animated,
          });
          // アニメーション候補は、裏でフレームのデコードを開始しておく。
          if (animated) loadAnimatedStampFrames(stampUrl);
          runningOffset += displayWidth;
        }
        node = walker.nextNode();
      }
      return parts;
    },

    // 読み込み済みの画像があれば、その自然サイズからアスペクト比を
    // 確定して表示幅へ反映する。取り込み時点で比率が分からなかった
    // 画像 (読み込み中だったもの) のための後追い処理。
    syncImageAspects(record) {
      let changed = false;
      for (const part of record.parts) {
        if (part.type !== "image") continue;
        if (
          !part.image.complete ||
          !part.image.naturalWidth ||
          !part.image.naturalHeight
        )
          continue;
        const aspect = part.image.naturalWidth / part.image.naturalHeight;
        if (Math.abs(aspect - part.aspect) > 0.01) {
          part.aspect = aspect;
          part.width = stampDisplayWidth(part.size, aspect);
          changed = true;
        }
      }
      if (changed) core.relayoutRecord(record);
    },

    // 部品幅の変化に合わせて、部品オフセットとコメント全体の幅・
    // 速度・残り時間を計算し直す (現在位置はそのまま維持する)。
    relayoutRecord(record) {
      let offset = 0;
      for (const part of record.parts) {
        part.offset = offset;
        offset += part.width;
      }
      if (offset === record.width) return;
      record.width = offset;
      const durationMs = config.duration * 1000;
      record.pixelsPerMs = (viewport.width + record.width) / durationMs;
      record.reveal =
        (record.left + record.width - viewport.width) / record.pixelsPerMs;
      record.touch = record.left / record.pixelsPerMs;
      record.life = (record.left + record.width) / record.pixelsPerMs;
    },

    rasterizeComment(record) {
      core.syncImageAspects(record);
      const previousSprite = record.sprite;
      record.sprite = core.createCommentSprite(record);
      if (previousSprite) core.releaseSprite(previousSprite);
      if (record.imageLoadBound) return;
      record.imageLoadBound = true;
      // 画像の読み込み完了を監視する。静止画はスプライトの焼き直し、
      // アニメーションスタンプは表示幅 (アスペクト比) の確定が目的。
      // 複数画像が相次いで読み込まれても、再ラスタライズは rAF で
      // フレームあたり1回にまとめる。
      const scheduleRebuild = () => {
        if (record.life <= 0 || record.spriteRebuildQueued) return;
        record.spriteRebuildQueued = true;
        requestAnimationFrame(() => {
          record.spriteRebuildQueued = false;
          if (record.life > 0) core.rasterizeComment(record);
        });
      };
      record.parts
        .filter((part) => part.type === "image" && !part.image.complete)
        .forEach((part) => {
          part.image.addEventListener("load", scheduleRebuild, { once: true });
          part.image.addEventListener("error", scheduleRebuild, { once: true });
        });
    },

    createCommentSprite(record) {
      const padding = Math.ceil(
        (config.outlineWidth > 0 ? context.lineWidth / 2 : 0) + 2,
      );
      const width = Math.ceil(record.width + padding * 2);
      const height = Math.ceil(laneHeight);
      const scale = viewport.pixelRatio;
      const { surface, poolKey } = core.acquireSpriteSurface(
        width,
        height,
        scale,
      );
      const spriteContext = surface.getContext("2d");
      spriteContext.setTransform(1, 0, 0, 1, 0, 0);
      spriteContext.clearRect(0, 0, surface.width, surface.height);
      spriteContext.setTransform(scale, 0, 0, scale, 0, 0);
      spriteContext.font = context.font;
      spriteContext.fillStyle = config.color;
      spriteContext.strokeStyle = config.outlineColor;
      spriteContext.lineWidth = context.lineWidth;
      spriteContext.globalAlpha = 1;

      let left = padding;
      const baseline = record.top - record.rowTop;
      for (const part of record.parts) {
        if (part.type === "text") {
          if (config.outlineWidth > 0)
            spriteContext.strokeText(part.text, left, baseline);
          spriteContext.fillText(part.text, left, baseline);
        } else if (
          part.animated ||
          (part.image.complete && part.image.naturalWidth)
        ) {
          // アニメーションスタンプはスプライトへ焼き込むと静止画になるため、
          // ここでは空白だけ確保し、drawComment で毎フレーム直接描く。
          if (!part.animated) {
            spriteContext.drawImage(
              part.image,
              left,
              (height - part.size) / 2,
              part.width,
              part.size,
            );
          }
        }
        left += part.width;
      }
      return { surface, width, height, padding, poolKey, scale };
    },

    bindVideoPlayback() {
      const onPlay = () => core.startAnimation();
      video.addEventListener("play", onPlay);
      removeVideoListeners = () => {
        video?.removeEventListener("play", onPlay);
      };
    },

    startAnimation() {
      if (animationFrame || !video || !core.shouldAnimate()) return;
      lastFrameAt = null;
      const frame = (now) => {
        if (!canvas || !context || !core.shouldAnimate()) {
          animationFrame = null;
          lastFrameAt = null;
          return;
        }
        if (lastFrameAt === null) lastFrameAt = now;
        const elapsed = now - lastFrameAt;
        lastFrameAt = now;
        // requestAnimationFrame は画面のリフレッシュレートに同期する。
        try {
          core.drawFrame(elapsed);
        } catch (error) {
          // 1フレームの描画失敗でループ自体を止めない。例外を放置すると
          // 次フレームが予約されず、二度と流れなくなる (Kick版の教訓)。
          console.warn(
            `${SCRIPT_NAME}: 描画中にエラーが発生しました`,
            error,
          );
        }
        if (core.shouldAnimate()) animationFrame = requestAnimationFrame(frame);
        else {
          animationFrame = null;
          lastFrameAt = null;
        }
      };
      animationFrame = requestAnimationFrame(frame);
    },

    stopAnimation() {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      lastFrameAt = null;
    },

    hasActiveComments() {
      return activeCommentTotal > 0;
    },

    shouldAnimate() {
      return core.hasActiveComments();
    },

    clearCanvas() {
      if (!context) return;
      const previousAlpha = context.globalAlpha;
      context.globalAlpha = 1;
      context.clearRect(0, 0, viewport.width, viewport.height);
      context.globalAlpha = previousAlpha;
      dirtyRows.clear();
      frameActiveRows.clear();
      needsFullClear = false;
    },

    clearCommentRows() {
      if (!context) return;
      context.globalAlpha = 1;
      if (needsFullClear) {
        context.clearRect(0, 0, viewport.width, viewport.height);
        needsFullClear = false;
        dirtyRows.clear();
        return;
      }
      // 前フレームの行と今フレームの行を消す。合併用の Set は作らず、
      // 重複行は片側だけで消して二重消去を避ける。
      for (const index of dirtyRows) {
        context.clearRect(
          0,
          laneAreaTop() + index * laneHeight,
          viewport.width,
          laneHeight,
        );
      }
      for (const index of frameActiveRows) {
        if (dirtyRows.has(index)) continue;
        context.clearRect(
          0,
          laneAreaTop() + index * laneHeight,
          viewport.width,
          laneHeight,
        );
      }
    },

    drawFrame(elapsed) {
      context.globalAlpha = 1;
      frameActiveRows.clear();

      for (let index = 0; index < lines.length; index += 1) {
        const row = lines[index];
        // filter で新配列を作らず、同じ配列内で生存コメントを前に詰める。
        let writeIndex = 0;
        for (let readIndex = 0; readIndex < row.length; readIndex += 1) {
          const record = row[readIndex];
          record.life -= elapsed;
          record.reveal -= elapsed;
          record.touch -= elapsed;
          record.left -= record.pixelsPerMs * elapsed;
          if (record.life > 0) {
            row[writeIndex] = record;
            writeIndex += 1;
          } else {
            activeCommentTotal -= 1;
            core.releaseSprite(record.sprite);
            record.sprite = null;
          }
        }
        row.length = writeIndex;
        if (writeIndex > 0) frameActiveRows.add(index);
      }

      core.clearCommentRows();
      context.globalAlpha = config.opacity;
      if (config.show) {
        for (const index of frameActiveRows) {
          for (const record of lines[index]) {
            core.drawComment(record);
          }
        }
      }
      // 今フレームの行集合を次フレームの消去対象として使い回す。
      const previousDirtyRows = dirtyRows;
      dirtyRows = frameActiveRows;
      frameActiveRows = previousDirtyRows;
    },

    drawComment(record) {
      const sprite = record.sprite;
      if (sprite) {
        // プールの表面は論理サイズより大きいことがあるため、
        // ソース矩形で論理サイズ分だけを切り出して描く。
        context.drawImage(
          sprite.surface,
          0,
          0,
          sprite.width * sprite.scale,
          sprite.height * sprite.scale,
          record.left - sprite.padding,
          record.rowTop,
          sprite.width,
          sprite.height,
        );
      }
      if (!record.hasAnimatedStamp) return;
      // アニメーションスタンプは、デコード済みフレームから現在時刻に合う
      // ものを選んで描く。Image 要素を drawImage するだけでは Chrome では
      // アニメーションが進まず1フレーム目で止まることがあるための対策。
      // 対象はアニメーション入りコメントだけなので件数は限られる。
      for (const part of record.parts) {
        if (part.type !== "image" || !part.animated) continue;
        const left = record.left + part.offset;
        const top = record.rowTop + (laneHeight - part.size) / 2;
        const entry = animatedStampCache.get(part.url);
        if (entry) {
          // 描画に使っている間は最新扱いにして、追い出し対象から外す。
          animatedStampCache.delete(part.url);
          animatedStampCache.set(part.url, entry);
        }
        if (entry?.ready && entry.frames.length) {
          let elapsedInLoop = performance.now() % entry.totalDuration;
          let frame = entry.frames[entry.frames.length - 1];
          for (const candidate of entry.frames) {
            if (elapsedInLoop < candidate.duration) {
              frame = candidate;
              break;
            }
            elapsedInLoop -= candidate.duration;
          }
          context.drawImage(frame.image, left, top, part.width, part.size);
        } else if (part.image.complete && part.image.naturalWidth) {
          // デコード前・失敗時は従来どおり Image をそのまま描く (静止画化)。
          context.drawImage(part.image, left, top, part.width, part.size);
        }
      }
    },

    installControls() {
      const deadline = performance.now() + 5000;
      const install = () => {
        const controls = core.getVisibleElement(
          screen?.querySelectorAll(
            ".player-controls__right-control-group",
          ) || [],
        );
        const nativeSettingsButton = core.getVisibleElement(
          controls?.querySelectorAll(
            'button[data-a-target="player-settings-button"]',
          ) || [],
        );
        if (!controls) return false;

        let button = document.getElementById(`${SCRIPT_NAME}ChatButton`);
        if (!button) {
          const wrapper = document.createElement("div");
          wrapper.dataset.from = SCRIPT_NAME;
          const nativeWrapper = nativeSettingsButton?.closest(
            ".player-controls__right-control-group > div",
          );
          if (nativeWrapper) wrapper.className = nativeWrapper.className;

          button = document.createElement("button");
          button.id = `${SCRIPT_NAME}ChatButton`;
          button.type = "button";
          button.title = "コメントスクロールを表示・非表示";
          button.setAttribute("aria-label", button.title);
          button.textContent = "💬";
          if (nativeSettingsButton)
            button.className = nativeSettingsButton.className;
          button.addEventListener("click", core.toggleComments);
          wrapper.appendChild(button);
          controls.insertBefore(wrapper, nativeWrapper || null);
        }
        core.updateChatButton();
        nativeSettingsButton?.removeEventListener(
          "click",
          core.showPlayerSettings,
        );
        nativeSettingsButton?.addEventListener(
          "click",
          core.showPlayerSettings,
        );
        return true;
      };

      const watch = () => {
        if (install() || performance.now() >= deadline) {
          controlsFrame = null;
          return;
        }
        controlsFrame = requestAnimationFrame(watch);
      };
      watch();
    },

    getVisibleElement(elements) {
      const candidates = Array.from(elements);
      return (
        candidates.find((element) => {
          const styles = window.getComputedStyle(element);
          return (
            styles.display !== "none" &&
            styles.visibility !== "hidden" &&
            styles.opacity !== "0" &&
            element.getClientRects().length > 0
          );
        }) || candidates[0] || null
      );
    },

    updateChatButton() {
      const button = document.getElementById(`${SCRIPT_NAME}ChatButton`);
      if (!button) return;
      button.style.opacity = config.show ? "1" : "0.5";
      button.setAttribute("aria-pressed", String(config.show));
    },

    toggleComments() {
      setConfig({ ...config, show: !config.show });
      saveSettings();
      core.resetLines();
      core.clearCanvas();
      core.updateChatButton();
    },

    showPlayerSettings() {
      if (menuFrame) cancelAnimationFrame(menuFrame);
      const deadline = performance.now() + 1000;
      const inject = () => {
        const menu = core.getVisibleElement(
          document.querySelectorAll(
            'div[data-a-target="player-settings-menu"]',
          ),
        );
        if (menu) {
          core.injectPlayerSettings(menu);
          menuFrame = null;
          return;
        }
        if (performance.now() < deadline)
          menuFrame = requestAnimationFrame(inject);
        else menuFrame = null;
      };
      menuFrame = requestAnimationFrame(inject);
    },

    injectPlayerSettings(menu) {
      if (menu.querySelector(`[data-from="${SCRIPT_NAME}"]`)) return;
      const template = menu.querySelector('[role="menuitem"]:last-of-type');
      if (!template) return;
      const separatorTemplate = menu.querySelector('[role="separator"]');
      if (separatorTemplate) {
        const separator = separatorTemplate.cloneNode(true);
        separator.dataset.from = SCRIPT_NAME;
        menu.appendChild(separator);
      }

      const addItem = (label, callback) => {
        const item = template.cloneNode(true);
        item.dataset.from = SCRIPT_NAME;
        item.querySelector("div")?.replaceChildren(label);
        item.addEventListener("click", callback);
        menu.appendChild(item);
      };
      addItem("コメントスクロール設定", core.openSettings);
    },

    resetSettings() {
      setConfig({ ...DEFAULT_SETTINGS });
      saveSettings();
      core.resizeCanvas();
      applyDrawingSettings();
      core.resetLines();
      core.clearCanvas();
      core.updateChatButton();
    },

    openSettings() {
      const openDialog = document.getElementById(`${SCRIPT_NAME}Settings`);
      if (openDialog) {
        openDialog.showModal?.();
        return;
      }
      const dialog = document.createElement("dialog");
      dialog.id = `${SCRIPT_NAME}Settings`;
      const form = document.createElement("form");
      form.noValidate = true;
      form.appendChild(makeHeading("コメントスクロール設定"));

      const fields = [
        ["color", "コメント色", "color"],
        ["outlineColor", "コメント縁取り色", "color"],
        [
          "outlineWidth",
          "コメント縁取りの太さ（比率）",
          "number",
          { min: 0, max: 1, step: 0.01 },
        ],
        [
          "opacity",
          "コメントの不透明度",
          "number",
          { min: 0, max: 1, step: 0.01 },
        ],
        [
          "fontSize",
          "文字サイズ（px）",
          "number",
          { min: 12, max: 200, step: 1 },
        ],
        [
          "fontFamily",
          "フォント名（例: Meiryo）",
          "text",
          { maxLength: 100, placeholder: "Meiryo" },
        ],
        [
          "maxLines",
          "コメント最大行数（0＝画面の縦幅に収まるまで無制限）",
          "number",
          { min: 0, max: 200, step: 1 },
        ],
        [
          "verticalMargin",
          "上下マージン（px、動画の上下端から開ける余白）",
          "number",
          { min: 0, max: 200, step: 1 },
        ],
        [
          "duration",
          "スクロール秒数",
          "number",
          { min: 0.5, max: 30, step: 0.1 },
        ],
        ["showStamps", "スタンプを表示する", "checkbox"],
        [
          "emojiSize",
          "絵文字の大きさ",
          "number",
          { min: 0.5, max: 4, step: 0.1 },
        ],
        [
          "emojiLimit",
          "絵文字の最大表示数",
          "number",
          { min: 0, max: 50, step: 1 },
        ],
        [
          "animateStamps",
          "アニメーションスタンプを動かす（対象コメントのみ毎フレーム描画）",
          "checkbox",
        ],
        [
          "canvasMaxWidth",
          "Canvas内部解像度の最大幅（px、0＝制限なし）",
          "number",
          { min: 0, max: 7680, step: 1 },
        ],
        [
          "autoPrimeCollapsedChat",
          "折りたたみで開いた配信は、チャットを一度自動で開閉して初期化する",
          "checkbox",
        ],
        [
          "placement",
          "コメント位置",
          "select",
          {
            options: [
              ["center", "中央優先"],
              ["spread", "均等に分散"],
              ["top", "上から"],
              ["bottom", "下から"],
            ],
          },
        ],
        [
          "maxActiveComments",
          "同時表示数（0＝制限なし）",
          "number",
          { min: 0, max: 300, step: 1 },
        ],
        [
          "maxCommentsPerLane",
          "レーンごとの最大数（0＝制限なし）",
          "number",
          { min: 0, max: 30, step: 1 },
        ],
        [
          "minLaneInterval",
          "同じレーンの最小投入間隔（秒、0＝制限なし）",
          "number",
          { min: 0, max: 10, step: 0.1 },
        ],
        [
          "minCommentLength",
          "最小文字数（0＝制限なし）",
          "number",
          { min: 0, max: 500, step: 1 },
        ],
        ["ignoreCommands", "「!」から始まるコメントを除外する", "checkbox"],
        ["ignoreLinks", "URLを含むコメントを除外する", "checkbox"],
        ["ignoreEmojiOnly", "絵文字だけのコメントを除外する", "checkbox"],
        ["blockedWords", "除外ワード（カンマまたは改行で区切る）", "text"],
        ["show", "コメントを表示する", "checkbox"],
      ];
      fields.forEach(([name, label, type, attributes]) =>
        form.appendChild(makeField(name, label, type, attributes)),
      );

      const buttons = document.createElement("div");
      buttons.className = `${SCRIPT_NAME}-buttons`;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "キャンセル";
      cancel.addEventListener("click", () => dialog.close());
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "保存";

      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "デフォルトに戻す";

      reset.addEventListener("click", () => {
        core.resetSettings();
        dialog.remove();
        core.openSettings();
      });

      buttons.append(reset, cancel, save);
      form.appendChild(buttons);

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        [
          "showStamps",
          "show",
          "ignoreCommands",
          "ignoreLinks",
          "ignoreEmojiOnly",
          "animateStamps",
          "autoPrimeCollapsedChat",
        ].forEach((name) => {
          values[name] = form.elements[name].checked;
        });
        setConfig(normalizeSettings(values));
        saveSettings();
        core.resizeCanvas();
        // Canvas のサイズが同じでも、色・フォント・縁取りを直ちに反映する。
        applyDrawingSettings();
        core.resetLines();
        core.clearCanvas();
        lastFrameAt = null;
        core.updateChatButton();
        dialog.close();
      });
      dialog.addEventListener("close", () => dialog.remove());
      dialog.appendChild(form);
      document.body.appendChild(dialog);
      dialog.showModal();
    },
  };

  function makeHeading(text) {
    const heading = document.createElement("h2");
    heading.textContent = text;
    heading.style.margin = "0 0 4px";
    return heading;
  }

  function makeField(name, labelText, type, attributes = {}) {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = labelText;
    const { options = [], ...inputAttributes } = attributes;
    const input = document.createElement(
      type === "select" ? "select" : "input",
    );
    input.name = name;
    if (type !== "select") input.type = type;
    Object.assign(input, inputAttributes);
    if (type === "select") {
      options.forEach(([value, optionLabel]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = optionLabel;
        input.appendChild(option);
      });
    }
    if (type === "checkbox") input.checked = config[name];
    else input.value = config[name];
    label.append(text, input);
    return label;
  }

  // レーンを配置する領域の上端 (動画の上端から開けるマージン)。
  function laneAreaTop() {
    return config.verticalMargin;
  }

  // スタンプ画像の表示幅。表示の高さ (size) を基準に、元画像の
  // アスペクト比 (横÷縦) から決める。極端に横長・縦長の画像で
  // レイアウトが崩れないよう、比率は 0.25〜4 の範囲に丸める。
  function stampDisplayWidth(size, aspect) {
    const clampedAspect = Math.min(4, Math.max(0.25, aspect || 1));
    return size * clampedAspect;
  }

  // 上下マージンを除いた内側の高さに収まるレーン数。
  function availableLaneCount() {
    const rowHeight = Math.max(1, laneHeight);
    const innerHeight = Math.max(
      0,
      viewport.height - config.verticalMargin * 2,
    );
    return Math.max(1, Math.floor(innerHeight / rowHeight));
  }

  function applyDrawingSettings() {
    if (!context) return;
    fontSize = config.fontSize;
    context.setTransform(viewport.pixelRatio, 0, 0, viewport.pixelRatio, 0, 0);
    context.font = `bold ${fontSize}px ${canvasFontFamily(config.fontFamily)}`;
    // フォントが変わると文字幅も変わるため、計測キャッシュはここで捨てる。
    textMeasureCache.clear();
    context.fillStyle = config.color;
    context.strokeStyle = config.outlineColor;
    const outlineSize = fontSize * config.outlineWidth;
    // lineWidth=0 はCanvas APIで無効なため、縁取りなしは描画時に分岐する。
    context.lineWidth = Math.max(0.01, outlineSize);
    const metrics = context.measureText("Mg");
    textAscent = metrics.actualBoundingBoxAscent || fontSize * 0.8;
    textDescent = metrics.actualBoundingBoxDescent || fontSize * 0.2;
    const contentHeight = Math.max(
      textAscent + textDescent,
      config.showStamps ? fontSize * config.emojiSize : 0,
    );
    laneHeight = Math.ceil(contentHeight + outlineSize * 2 + 4);
  }

  // measureText の結果をキャッシュ付きで返す。
  // 「草」「www」のような高頻度断片の再計測を避けるためのもので、
  // 上限を超えたら古いものから捨てる (簡易LRU)。
  function measureTextCached(text) {
    const cached = textMeasureCache.get(text);
    if (cached !== undefined) {
      textMeasureCache.delete(text);
      textMeasureCache.set(text, cached);
      return cached;
    }
    const width = context.measureText(text).width;
    textMeasureCache.set(text, width);
    if (textMeasureCache.size > TEXT_MEASURE_CACHE_LIMIT) {
      textMeasureCache.delete(textMeasureCache.keys().next().value);
    }
    return width;
  }

  // スタンプがアニメーション画像かどうかをURLから判定する。
  // Twitch のアニメーションエモートはパスに /animated/ を含むものもあるが、
  // 現在のチャットが使う emotesv2 形式は /default/ で、これは
  // 「アニメーション版があればそれ、無ければ静止画」を返すURLのため、
  // URLだけでは判別できない。/default/ も候補に含め、最終判断は
  // ImageDecoder のフレーム数 (1フレームなら静止画) に委ねる。
  // 外部系 (7TV/BTTV等) は .gif / .apng / .webp のことが多い。
  // .webp は静止画もあるが、同様にフレーム数で確定するため問題ない。
  function isAnimatedStampSource(source, node) {
    const urls = [source, node?.currentSrc, node?.src].filter(Boolean);
    return urls.some(
      (url) =>
        /\/animated\//i.test(url) ||
        /\/emoticons\/v2\/[^/]+\/default\//i.test(url) ||
        /\.(?:gif|apng|webp)(?:[?#]|$)/i.test(url),
    );
  }

  // フレームを保持しているエントリだけを数え、上限を超えた分を
  // 古い順に破棄する。破棄時はフレームを close してから参照も空に
  // する (描画側はURLで引き直すため、破棄された時点で静止画に
  // フォールバックする)。Kick版 v0.16.4 と同じ数え方。
  function trimAnimatedStampCache() {
    let frameHoldingCount = 0;
    for (const entry of animatedStampCache.values()) {
      if (entry.frames.length) frameHoldingCount += 1;
    }
    if (frameHoldingCount <= ANIMATED_STAMP_CACHE_LIMIT) return;
    for (const [cachedUrl, entry] of animatedStampCache) {
      if (frameHoldingCount <= ANIMATED_STAMP_CACHE_LIMIT) break;
      if (!entry.frames.length) continue;
      entry.frames.forEach((frame) => frame.image.close?.());
      entry.frames = [];
      entry.ready = false;
      animatedStampCache.delete(cachedUrl);
      frameHoldingCount -= 1;
    }
  }

  // アニメーションスタンプを ImageDecoder でフレーム列にデコードする。
  // 結果はURL単位でキャッシュし、同じスタンプの再デコードを避ける。
  // ImageDecoder が無い環境やデコード失敗時は entry.failed が立ち、
  // 描画側は Image の直接描画 (静止画) にフォールバックする。
  function loadAnimatedStampFrames(url) {
    if (!url || typeof ImageDecoder === "undefined") return;
    const existing = animatedStampCache.get(url);
    if (existing) {
      // 使われた順を最新に寄せる (LRU)。表示中のスタンプが
      // 新着スタンプに押し出されて静止画化するのを防ぐ。
      animatedStampCache.delete(url);
      animatedStampCache.set(url, existing);
      return;
    }
    const entry = { ready: false, failed: false, frames: [], totalDuration: 0 };
    animatedStampCache.set(url, entry);
    (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        const type =
          response.headers.get("content-type")?.split(";")[0].trim() ||
          (url.includes(".gif")
            ? "image/gif"
            : url.includes(".webp")
              ? "image/webp"
              : "image/png");
        const decoder = new ImageDecoder({ data, type });
        await decoder.tracks.ready;
        const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 1;
        if (frameCount <= 1) {
          entry.failed = true;
          decoder.close();
          return;
        }
        const count = Math.min(frameCount, ANIMATED_STAMP_MAX_FRAMES);
        let totalDuration = 0;
        for (let index = 0; index < count; index += 1) {
          const { image } = await decoder.decode({ frameIndex: index });
          // デコード中にキャッシュから退避されていたら、残りを打ち切る。
          if (animatedStampCache.get(url) !== entry) {
            image.close?.();
            decoder.close();
            return;
          }
          // VideoFrame.duration はマイクロ秒。短すぎる値はブラウザの
          // GIF最低遅延に寄せて 20ms を下限にする。
          const durationMs = Math.max(20, (image.duration ?? 100000) / 1000);
          entry.frames.push({ image, duration: durationMs });
          totalDuration += durationMs;
        }
        decoder.close();
        entry.totalDuration = totalDuration;
        entry.ready = true;
        // フレームを保持し始めたので、上限を超えていれば古い分を破棄する。
        trimAnimatedStampCache();
      } catch (error) {
        entry.failed = true;
      }
    })();
  }

  function loadSettings() {
    let stored = {};
    try {
      stored = GM_getValue(SETTINGS_KEY, {});
    } catch (error) {
      console.warn(`${SCRIPT_NAME}: 設定を読み込めませんでした`, error);
    }
    return normalizeSettings(stored);
  }

  function setConfig(nextConfig) {
    config = nextConfig;
    blockedWordFilters = parseBlockedWords(config.blockedWords);
  }

  function parseBlockedWords(value) {
    return value
      .split(/[\n,]/)
      .map((word) => word.trim())
      .filter(Boolean);
  }

  function saveSettings() {
    try {
      GM_setValue(SETTINGS_KEY, config);
    } catch (error) {
      console.warn(`${SCRIPT_NAME}: 設定を保存できませんでした`, error);
    }
  }

  function normalizeSettings(value) {
    const raw = value && typeof value === "object" ? value : {};
    return {
      color: validColor(raw.color, DEFAULT_SETTINGS.color),
      outlineColor: validColor(raw.outlineColor, DEFAULT_SETTINGS.outlineColor),
      outlineWidth: numberSetting(
        raw.outlineWidth,
        DEFAULT_SETTINGS.outlineWidth,
        0,
        1,
      ),
      opacity: numberSetting(raw.opacity, DEFAULT_SETTINGS.opacity, 0, 1),
      fontSize: numberSetting(
        raw.fontSize,
        DEFAULT_SETTINGS.fontSize,
        12,
        200,
        true,
      ),
      fontFamily: fontFamilySetting(
        raw.fontFamily,
        DEFAULT_SETTINGS.fontFamily,
      ),
      maxLines: numberSetting(
        raw.maxLines,
        DEFAULT_SETTINGS.maxLines,
        0,
        200,
        true,
      ),
      verticalMargin: numberSetting(
        raw.verticalMargin,
        DEFAULT_SETTINGS.verticalMargin,
        0,
        200,
        true,
      ),
      duration: numberSetting(raw.duration, DEFAULT_SETTINGS.duration, 0.5, 30),
      // 旧設定の emoji は、スタンプ表示設定として引き継ぐ。
      showStamps: booleanSetting(
        raw.showStamps ?? raw.emoji,
        DEFAULT_SETTINGS.showStamps,
      ),
      emojiSize: numberSetting(
        raw.emojiSize,
        DEFAULT_SETTINGS.emojiSize,
        0.5,
        4,
      ),
      emojiLimit: numberSetting(
        raw.emojiLimit,
        DEFAULT_SETTINGS.emojiLimit,
        0,
        50,
        true,
      ),
      animateStamps: booleanSetting(
        raw.animateStamps,
        DEFAULT_SETTINGS.animateStamps,
      ),
      canvasMaxWidth: numberSetting(
        raw.canvasMaxWidth,
        DEFAULT_SETTINGS.canvasMaxWidth,
        0,
        7680,
        true,
      ),
      autoPrimeCollapsedChat: booleanSetting(
        raw.autoPrimeCollapsedChat,
        DEFAULT_SETTINGS.autoPrimeCollapsedChat,
      ),
      show: booleanSetting(raw.show, DEFAULT_SETTINGS.show),
      placement: optionSetting(raw.placement, DEFAULT_SETTINGS.placement, [
        "center",
        "spread",
        "top",
        "bottom",
      ]),
      maxActiveComments: numberSetting(
        raw.maxActiveComments,
        DEFAULT_SETTINGS.maxActiveComments,
        0,
        300,
        true,
      ),
      maxCommentsPerLane: numberSetting(
        raw.maxCommentsPerLane,
        DEFAULT_SETTINGS.maxCommentsPerLane,
        0,
        30,
        true,
      ),
      minLaneInterval: numberSetting(
        raw.minLaneInterval,
        DEFAULT_SETTINGS.minLaneInterval,
        0,
        10,
      ),
      minCommentLength: numberSetting(
        raw.minCommentLength,
        DEFAULT_SETTINGS.minCommentLength,
        0,
        500,
        true,
      ),
      ignoreCommands: booleanSetting(
        raw.ignoreCommands,
        DEFAULT_SETTINGS.ignoreCommands,
      ),
      ignoreLinks: booleanSetting(
        raw.ignoreLinks,
        DEFAULT_SETTINGS.ignoreLinks,
      ),
      ignoreEmojiOnly: booleanSetting(
        raw.ignoreEmojiOnly,
        DEFAULT_SETTINGS.ignoreEmojiOnly,
      ),
      blockedWords: stringSetting(
        raw.blockedWords,
        DEFAULT_SETTINGS.blockedWords,
        500,
      ),
    };
  }

  function numberSetting(value, fallback, min, max, integer = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const clamped = Math.min(max, Math.max(min, number));
    return integer ? Math.round(clamped) : clamped;
  }

  function booleanSetting(value, fallback) {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1" || value === 1) return true;
    if (value === "false" || value === "0" || value === 0) return false;
    return fallback;
  }

  function optionSetting(value, fallback, options) {
    return options.includes(value) ? value : fallback;
  }

  function stringSetting(value, fallback, maxLength) {
    return typeof value === "string" ? value.slice(0, maxLength) : fallback;
  }

  function fontFamilySetting(value, fallback) {
    if (typeof value !== "string") return fallback;
    const family = value
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, 100);
    return family || fallback;
  }

  function canvasFontFamily(value) {
    return `"${value.replace(/["\\]/g, "\\$&")}", sans-serif`;
  }

  function validColor(value, fallback) {
    if (typeof value !== "string") return fallback;
    const probe = document.createElement("span").style;
    probe.color = value;
    return probe.color ? value : fallback;
  }

  core.start();
})();
