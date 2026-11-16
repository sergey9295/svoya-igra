/* Своя игра — логика игры: заставка, представление игроков, раунды, вопросы, финал, итоги. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
    return e;
  }

  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
  const fmt = n => (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('ru-RU');
  const SAVE_KEY = 'svoya-igra-save-v1';
  const THINK_SECONDS = 30;
  const THEME_INTERVAL = 3300; // мс между появлением тем раунда
  const HIDDEN = '?????';
  const LETTERS = 'АБВГДЕ';

  const G = {
    data: null,      // { deck, players, hash }
    players: [],     // { name, img, score }
    round: 0,        // индекс раунда; rounds.length = финал
    played: {},      // 'раунд-тема-вопрос' -> true
    chooser: null,   // индекс игрока, выбирающего вопрос
    revealed: {},    // 'раунд-тема' -> true для открытых скрытых тем
    history: [],     // [{ p, delta }] для отмены
    finished: false,
    fin: null,       // состояние финала
  };
  let Q = null;        // открытый вопрос
  let advance = null;  // что делать по щелчку на «щелкательных» экранах
  let themeTimers = [];

  /* ================= Экраны ================= */
  function show(id) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    $('#toolbar').hidden = id === 'screen-load' || id === 'screen-splash';
  }

  document.addEventListener('click', e => {
    if (!advance || e.target.closest('button, input, label, #toolbar, #help')) return;
    if (e.target.closest('.screen.clickable.active')) { const f = advance; f(); }
  });

  function restartAnimation(el) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }

  /* ================= Загрузка ================= */
  async function boot() {
    const data = await Loader.loadAll();
    if (data) return ready(data);
    if (Loader.isFileProtocol()) {
      $('#load-msg').textContent = '';
      $('#picker-box').hidden = false;
      $('#picker').addEventListener('change', async e => {
        const err = $('#picker-error');
        if (!Loader.usePickedFiles(e.target.files)) {
          err.hidden = false;
          err.textContent = 'В выбранной папке нет deck/questions.txt. Выберите папку игры целиком.';
          return;
        }
        const d = await Loader.loadAll();
        if (d) ready(d);
      });
    } else {
      $('#load-msg').textContent = 'Не удалось прочитать файл deck/questions.txt';
    }
  }

  function ready(data) {
    G.data = data;
    const { deck, players } = data;
    $('#deck-title').textContent = deck.title || '';
    const qCount = deck.rounds.reduce((s, r) => s + r.themes.reduce((a, t) => a + t.questions.length, 0), 0);
    const info = [
      `Игроков: ${players.length}`,
      `Раундов: ${deck.rounds.length}${deck.final ? ' + финал' : ''}`,
      `Вопросов: ${qCount}`,
    ];
    $('#deck-info').textContent = info.join('  ·  ');

    const warns = [...deck.warnings];
    if (!players.length) warns.unshift('Не найдено ни одного игрока: положите фото в папку players или заполните players/players.txt');
    if (!deck.rounds.length && !deck.final) warns.unshift('В колоде нет ни одного вопроса');
    const w = $('#warnings');
    w.hidden = !warns.length;
    $('summary', w).textContent = `Замечания по колоде: ${warns.length}`;
    $('ul', w).replaceChildren(...warns.map(t => h('li', { text: t })));
    if (warns.length && !players.length) w.open = true;

    const save = loadSave();
    $('#btn-continue').hidden = !save;
    $('#btn-new').disabled = !players.length || (!deck.rounds.length && !deck.final);
    show('screen-splash');
  }

  $('#btn-new').addEventListener('click', () => newGame());
  $('#btn-continue').addEventListener('click', () => continueGame());

  /* ================= Сохранение ================= */
  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        hash: G.data.hash,
        names: G.players.map(p => p.name),
        scores: G.players.map(p => p.score),
        round: G.round, played: G.played, revealed: G.revealed, chooser: G.chooser, history: G.history.slice(-50), finished: G.finished,
      }));
    } catch (e) { /* хранилище недоступно — играем без сохранения */ }
  }
  function loadSave() {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (!s || s.hash !== G.data.hash) return null;
      if (s.names.join('\n') !== G.data.players.map(p => p.name).join('\n')) return null;
      return s;
    } catch (e) { return null; }
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { } }

  /* ================= Начало игры ================= */
  function resetState() {
    G.players = G.data.players.map(p => ({ ...p, score: 0 }));
    G.round = 0; G.played = {}; G.revealed = {}; G.chooser = null; G.history = []; G.finished = false; G.fin = null;
  }

  function newGame() {
    clearSave();
    resetState();
    save();
    playIntro();
  }

  function continueGame() {
    const s = loadSave();
    resetState();
    if (s) {
      s.scores.forEach((sc, i) => { if (G.players[i]) G.players[i].score = sc; });
      Object.assign(G, { round: s.round, played: s.played || {}, revealed: s.revealed || {}, chooser: s.chooser, history: s.history || [], finished: !!s.finished });
    }
    if (G.finished) return showWinner();
    if (G.round >= G.data.deck.rounds.length) return startFinal();
    showBoard();
  }

  function playIntro() {
    show('screen-intro');
    restartAnimation($('.intro-logo'));
    Sound.stopAll();
    Sound.play('intro');
    advance = () => introPlayer(0);
  }

  function introPlayer(i) {
    if (i >= G.players.length) return startRound(0);
    const p = G.players[i];
    show('screen-player');
    const box = $('.player-intro');
    $('.pi-label', box).textContent = `Игрок №${i + 1}`;
    const ph = $('.pi-photo', box);
    ph.classList.toggle('noimg', !p.img);
    ph.replaceChildren(p.img ? h('img', { src: p.img, alt: '' }) : p.name[0]);
    $('.pi-name', box).textContent = p.name;
    restartAnimation(box);
    advance = () => introPlayer(i + 1);
  }

  /* ================= Темы раунда ================= */
  function showThemes(title, themes, next) {
    show('screen-themes');
    Sound.stopAll(700);
    themeTimers.forEach(clearTimeout);
    const titleEl = $('.themes-title');
    titleEl.textContent = title;
    restartAnimation(titleEl);
    const list = $('.themes-list');
    const lines = themes.map(t => h('div', { class: 'theme-line' + (t.hidden ? ' hidden-theme' : ''), text: t.hidden ? HIDDEN : t.name }));
    list.replaceChildren(...lines);
    const fs = Math.min(3.4, 26 / Math.max(themes.length, 1)); // чем больше тем, тем мельче
    lines.forEach(l => { l.style.fontSize = `min(${fs}vw, ${fs * 1.6}vh)`; });

    let shown = 0, started = false;
    const reveal = () => { if (shown < lines.length) lines[shown++].classList.add('show'); };
    // Сначала звучит заставка раунда, потом под музыку тем появляются названия
    const startThemes = () => {
      if (started) return;
      started = true;
      Sound.stop('roundstart', 500);
      Sound.play('categories');
      themeTimers = lines.map((_, i) => setTimeout(reveal, 500 + i * THEME_INTERVAL));
    };
    Sound.play('roundstart', { onEnd: startThemes });
    advance = () => {
      if (!started) return startThemes();
      if (shown < lines.length) { themeTimers.forEach(clearTimeout); while (shown < lines.length) reveal(); return; }
      advance = null;
      Sound.stop('categories', 1200);
      next();
    };
  }

  /* ================= Раунды ================= */
  function startRound(r) {
    closeQuestionSilently();
    $$('.round-over').forEach(e => e.remove());
    G.round = r;
    save();
    const rounds = G.data.deck.rounds;
    if (r >= rounds.length) return startFinal();
    showThemes(rounds[r].name, rounds[r].themes, showBoard);
  }

  function roundComplete() {
    const round = G.data.deck.rounds[G.round];
    return round.themes.every((t, ti) => t.questions.every((_, qi) => G.played[`${G.round}-${ti}-${qi}`]));
  }

  function endRound() {
    closeQuestionSilently();
    if ($('.round-over')) return;
    const isLast = G.round + 1 >= G.data.deck.rounds.length;
    const nextName = isLast ? (G.data.deck.final ? G.data.deck.final.name : 'Итоги игры') : G.data.deck.rounds[G.round + 1].name;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      Sound.stop('roundend', 600);
      startRound(G.round + 1);
    };
    const ov = h('div', { class: 'q-splash round-over', onclick: go },
      h('div', { class: 'rays' }),
      h('div', { class: 'big-word', text: `${G.data.deck.rounds[G.round].name} окончен` }),
      h('div', { class: 'sub', text: `Далее: ${nextName}` }),
      h('div', { class: 'hint', text: 'щёлкните, чтобы продолжить' }));
    $('#board-wrap').append(ov);
    Sound.stopAll(300);
    Sound.play('roundend', { onEnd: () => setTimeout(go, 600) });
  }

  function revealTheme(ti) {
    G.revealed[`${G.round}-${ti}`] = true;
    save();
    renderBoard();
    const cell = $(`#board .cell.theme[data-ti="${ti}"]`);
    if (cell) cell.classList.add('flip');
  }

  function showBoard() {
    advance = null;
    show('screen-game');
    $('#qpanel').hidden = true;
    $('#final-panel').hidden = true;
    $('#board').hidden = false;
    $('#round-label').textContent = G.data.deck.rounds[G.round].name;
    renderPlayers();
    renderBoard();
  }

  function renderBoard() {
    const round = G.data.deck.rounds[G.round];
    if (!round) return;
    const board = $('#board');
    const cols = Math.max(...round.themes.map(t => t.questions.length));
    board.style.gridTemplateColumns = `minmax(0, 2.3fr) repeat(${cols}, minmax(0, 1fr))`;
    board.style.gridTemplateRows = `repeat(${round.themes.length}, minmax(0, 1fr))`;
    const cells = [];
    round.themes.forEach((t, ti) => {
      const hidden = t.hidden && !G.revealed[`${G.round}-${ti}`];
      cells.push(h('div', {
        class: 'cell theme' + (hidden ? ' hidden-theme' : ''), 'data-ti': ti,
        text: hidden ? HIDDEN : t.name,
        title: hidden ? 'Щёлкните, чтобы открыть тему' : null,
        onclick: hidden ? () => { if (!Q) revealTheme(ti); } : null,
      }));
      for (let qi = 0; qi < cols; qi++) {
        const q = t.questions[qi];
        if (!q) { cells.push(h('div', { class: 'cell empty' })); continue; }
        const key = `${G.round}-${ti}-${qi}`;
        const played = !!G.played[key];
        cells.push(h('div', {
          class: 'cell price' + (played ? ' played' : ''),
          text: q.value,
          onclick: e => { if (!played && !Q) openQuestion(ti, qi, e.currentTarget); },
        }));
      }
    });
    board.replaceChildren(...cells);
    fitBoard();
  }

  function fitBoard() {
    const board = $('#board');
    const round = G.data.deck.rounds[G.round];
    if (!round || !board.offsetParent) return;
    const rowH = board.clientHeight / round.themes.length;
    const priceCell = $('.cell.price, .cell.empty', board);
    const colW = priceCell ? priceCell.clientWidth : 100;
    const priceFs = Math.min(rowH * 0.55, colW * 0.36);
    $$('.cell.price', board).forEach(c => { c.style.fontSize = priceFs + 'px'; });
    $$('.cell.theme', board).forEach(c => {
      let fs = Math.min(rowH * 0.3, window.innerWidth * 0.024);
      c.style.fontSize = fs + 'px';
      while ((c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1) && fs > 9) {
        fs *= 0.92; c.style.fontSize = fs + 'px';
      }
    });
  }

  /* ================= Игроки ================= */
  function renderPlayers() {
    const box = $('#players');
    box.replaceChildren(...G.players.map((p, i) => {
      const card = h('div', { class: 'pcard', 'data-i': i },
        h('div', { class: 'ph', title: 'Щёлкните, чтобы сделать игрока выбирающим', onclick: () => onPlayerCard(i) },
          p.img ? h('img', { src: p.img, alt: '' }) : h('div', { class: 'initial', text: p.name[0] })),
        h('div', { class: 'nm', text: p.name }),
        h('div', { class: 'sc', title: 'Щёлкните, чтобы изменить счёт', onclick: () => editScore(i) }));
      return card;
    }));
    updatePlayers();
  }

  function updatePlayers() {
    $$('#players .pcard').forEach((card, i) => {
      const p = G.players[i];
      const sc = $('.sc', card);
      sc.textContent = fmt(p.score);
      sc.classList.toggle('neg', p.score < 0);
      card.classList.toggle('chooser', G.chooser === i && !G.fin);
      card.classList.toggle('answering', !!Q && Q.answerer === i);
      const out = (Q && Q.tried && Q.tried.has(i)) || (G.fin && !G.fin.part.includes(i));
      card.classList.toggle('out', !!out);
    });
  }

  function flashPlayer(i, good) {
    const card = $(`#players .pcard[data-i="${i}"]`);
    if (!card) return;
    card.classList.remove('flash-good', 'flash-bad');
    void card.offsetWidth;
    card.classList.add(good ? 'flash-good' : 'flash-bad');
  }

  function addScore(i, delta) {
    if (!delta) return;
    G.players[i].score += delta;
    G.history.push({ p: i, delta });
    flashPlayer(i, delta > 0);
    updatePlayers();
    save();
  }

  function onPlayerCard(i) {
    if (Q && Q.onPlayer) return Q.onPlayer(i);
    if (G.fin) return;
    G.chooser = G.chooser === i ? null : i;
    updatePlayers();
    save();
  }

  function editScore(i) {
    const p = G.players[i];
    const v = prompt(`Счёт игрока «${p.name}»:`, p.score);
    if (v == null) return;
    const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
    if (isNaN(n)) return;
    addScore(i, n - p.score);
  }

  function undo() {
    const last = G.history.pop();
    if (!last) return;
    G.players[last.p].score -= last.delta;
    flashPlayer(last.p, last.delta < 0);
    updatePlayers();
    save();
  }

  /* ================= Вопрос ================= */
  const SPECIAL = {
    cat: {
      word: 'Кот в мешке', emoji: '🐱',
      rule: 'Выбирающий отдаёт вопрос сопернику. Стоимость можно изменить. Верный ответ — очки прибавляются, неверный — вычитаются.',
      who: 'Кому отдаём:',
    },
    auction: {
      word: 'Аукцион', emoji: '🔨',
      rule: 'Игроки торгуются за право ответить. Минимальная ставка — стоимость вопроса, «ва-банк» — все очки игрока. Верно — ставка прибавляется, неверно — вычитается.',
      who: 'Торги выиграл:',
    },
    norisk: {
      word: 'Вопрос без риска', emoji: '🍀',
      rule: 'Вопрос достаётся выбирающему. Верный ответ — удвоенная стоимость, за неверный очки не снимаются.',
      who: 'Отвечает:',
    },
  };

  function buildPanel() {
    const P = $('#qpanel');
    P.replaceChildren(
      h('div', { class: 'q-head' }, h('span', { class: 'q-theme' }), h('span', { class: 'q-price' })),
      h('div', { class: 'q-body' }),
      h('div', { class: 'q-controls' }));
    return P;
  }
  const setHead = (theme, price) => { $('#qpanel .q-theme').textContent = theme; $('#qpanel .q-price').textContent = price; };
  const setControls = (...kids) => $('#qpanel .q-controls').replaceChildren(...kids.flat().filter(Boolean));

  function zoomFrom(P, cell) {
    P.hidden = false;
    if (!cell) return;
    const wr = $('#board-wrap').getBoundingClientRect(), cr = cell.getBoundingClientRect();
    P.classList.remove('zoom');
    Object.assign(P.style, { top: (cr.top - wr.top) + 'px', left: (cr.left - wr.left) + 'px', right: (wr.right - cr.right) + 'px', bottom: (wr.bottom - cr.bottom) + 'px' });
    P.classList.add('zoom');
    void P.offsetWidth;
    Object.assign(P.style, { top: '0', left: '0', right: '0', bottom: '0' });
    setTimeout(() => { P.classList.remove('zoom'); fitQuestion(); }, 470);
  }

  function openQuestion(ti, qi, cell) {
    const theme = G.data.deck.rounds[G.round].themes[ti];
    const q = theme.questions[qi];
    if (theme.hidden && !G.revealed[`${G.round}-${ti}`]) { G.revealed[`${G.round}-${ti}`] = true; save(); renderBoard(); }
    Q = {
      key: `${G.round}-${ti}-${qi}`, q, theme,
      type: q.type, value: q.value, points: q.value,
      answerer: null, tried: new Set(), scored: false, stage: 'intro', media: [],
    };
    const P = buildPanel();
    zoomFrom(P, cell);
    if (Q.type === 'normal') return showQuestion();

    const sp = SPECIAL[Q.type];
    setHead(theme.name, fmt(q.value));
    Sound.stopAll();
    Sound.play(Q.type);
    const splash = h('div', { class: 'q-splash', onclick: () => { splash.classList.add('leave'); setTimeout(() => splash.remove(), 400); } },
      h('div', { class: 'rays' }),
      h('div', { class: 'emoji', text: sp.emoji }),
      h('div', { class: 'big-word', text: sp.word }),
      Q.type === 'cat' && q.catTheme ? h('div', { class: 'sub', text: `Тема: ${q.catTheme}` }) : null,
      h('div', { class: 'hint', text: 'щёлкните, чтобы продолжить' }));
    P.append(splash);
    showSetup();
  }

  function showSetup() {
    Q.stage = 'setup';
    const sp = SPECIAL[Q.type];
    const q = Q.q;
    const themeName = Q.type === 'cat' && q.catTheme ? q.catTheme : Q.theme.name;
    if (Q.type === 'norisk') { Q.points = Q.value * 2; Q.answerer = G.chooser; }
    $('#qpanel .q-body').replaceChildren(h('div', { class: 'setup' },
      h('div', { class: 'kind', text: sp.word }),
      h('div', { class: 'what', text: `Тема: ${themeName}` }),
      h('div', { class: 'rule', text: sp.rule })));

    // Аукцион: ставка от стоимости вопроса до всех очков игрока (если очков меньше стоимости — только стоимость)
    const auction = Q.type === 'auction';
    const maxBet = () => (Q.answerer == null ? Infinity : Math.max(G.players[Q.answerer].score, Q.value));
    const clamp = v => (auction ? Math.min(Math.max(v, Q.value), maxBet()) : Math.max(v, 0));
    const input = h('input', {
      type: 'number', value: Q.points, step: 100, min: auction ? Q.value : 0,
      oninput: () => {
        if (auction && (parseInt(input.value, 10) || 0) > maxBet()) input.value = maxBet();
        Q.points = clamp(parseInt(input.value, 10) || 0);
      },
      onchange: () => { input.value = Q.points = clamp(parseInt(input.value, 10) || 0); },
    });
    const maxLabel = auction ? h('span', { class: 'label' }) : null;
    const go = h('button', {
      class: 'btn gold', text: 'Показать вопрос →',
      onclick: () => { Q.points = clamp(parseInt(input.value, 10) || 0); showQuestion(); },
    });
    const allIn = auction
      ? h('button', {
        class: 'btn', text: 'Ва-банк', title: 'Ставка = все очки выбранного игрока',
        onclick: () => { if (Q.answerer != null) input.value = Q.points = maxBet(); },
      })
      : null;
    const refresh = () => {
      $$('#qpanel .q-controls [data-p]').forEach(b => b.classList.toggle('selected', +b.dataset.p === Q.answerer));
      go.disabled = Q.answerer == null;
      if (allIn) allIn.disabled = Q.answerer == null;
      if (auction && Q.answerer != null) {
        input.max = maxBet();
        input.value = Q.points = clamp(parseInt(input.value, 10) || 0);
        maxLabel.textContent = `макс. ${fmt(maxBet())}`;
      }
      updatePlayers();
    };
    Q.onPlayer = i => { Q.answerer = i; refresh(); };
    setControls(
      h('span', { class: 'label', text: sp.who }),
      playerButtons(i => Q.onPlayer(i)),
      h('span', { class: 'sep' }),
      h('span', { class: 'label', text: Q.type === 'auction' ? 'Ставка:' : 'Стоимость:' }),
      input, maxLabel, allIn,
      h('span', { class: 'sep' }),
      go, cancelButton());
    refresh();
  }

  function playerButtons(onPick, filter = () => true) {
    return G.players.map((p, i) => filter(i) ? h('button', {
      class: 'btn', 'data-p': i, title: `Клавиша ${i + 1}`,
      disabled: Q.tried.has(i),
      onclick: () => onPick(i),
    }, p.img ? h('img', { src: p.img, alt: '' }) : null, p.name) : null);
  }

  function cancelButton() {
    return Q.scored ? null : h('button', { class: 'btn ghost', text: '✕', title: 'Закрыть вопрос, не разыгрывая его (если открыли по ошибке)', onclick: closeQuestionSilently });
  }

  function addMedia(m) {
    m.muted = Sound.isMuted();
    Q.media.push(m);
    return m;
  }

  /* Тело вопроса: картинка, звук, текст, варианты. Видео до ответа звучит как аудио — картинку не видно. */
  function questionBody(q) {
    const media = h('div', { class: 'q-media' });
    if (q.image) media.append(h('img', { src: q.image, alt: '', onload: fitQuestion }));
    let sound = null;
    if (q.video) {
      Q.video = addMedia(h('video', { src: q.video, playsInline: true, preload: 'auto', onloadedmetadata: fitQuestion }));
      sound = audioControl(Q.video);
      sound.classList.add('video-sound');
    } else if (q.audio) {
      sound = audioControl(q.audio);
    }
    const options = q.options ? h('div', { class: 'q-options' }, q.options.map((o, i) => h('div', {
      class: 'q-option', 'data-i': i,
      title: 'Щёлкните, чтобы отметить выбор игрока',
      onclick: e => { if (Q.stage !== 'answer') e.currentTarget.classList.toggle('picked'); },
    }, h('span', { class: 'letter', text: LETTERS[i] }), h('span', { class: 'otext', text: o })))) : null;
    return [media, sound, h('div', { class: 'q-text', text: q.text }), options];
  }

  function audioControl(src, label = 'Слушать') {
    const a = typeof src === 'string' ? addMedia(new Audio(src)) : src;
    const btn = h('button', { class: 'btn gold', text: `▶ ${label}` });
    const progress = h('div');
    const bar = h('div', { class: 'bar', title: 'Перемотка' }, progress);
    btn.onclick = () => {
      if (a.paused) { Sound.stopAll(300); a.play().catch(() => {}); } else a.pause();
    };
    a.onplay = () => { btn.textContent = '❚❚ Пауза'; };
    a.onpause = a.onended = () => { btn.textContent = `▶ ${label}`; };
    a.ontimeupdate = () => { progress.style.width = (a.duration ? a.currentTime / a.duration * 100 : 0) + '%'; };
    bar.onclick = e => {
      const r = bar.getBoundingClientRect();
      if (a.duration) a.currentTime = (e.clientX - r.left) / r.width * a.duration;
    };
    return h('div', { class: 'audio-ctl' }, btn, bar);
  }

  function showQuestion() {
    Q.stage = 'asking';
    Q.onPlayer = null;
    const q = Q.q;
    const special = Q.type !== 'normal';
    const themeName = Q.type === 'cat' && q.catTheme ? q.catTheme : Q.theme.name;
    setHead(themeName, special ? `${SPECIAL[Q.type].word} · ${fmt(Q.points)}` : fmt(Q.value));
    fill($('#qpanel .q-body'), questionBody(q));
    fitQuestion();
    renderAskControls();
  }

  function renderAskControls() {
    const special = Q.type !== 'normal';
    const pts = special ? Q.points : Q.value;
    const lossText = Q.type === 'norisk' ? '✗ Неверно (0)' : `✗ Неверно −${fmt(pts)}`;
    const good = h('button', { class: 'btn good', text: `✓ Верно +${fmt(pts)}`, title: 'Клавиша +', disabled: Q.answerer == null, onclick: () => judge(true) });
    const bad = h('button', { class: 'btn bad', text: lossText, title: 'Клавиша −', disabled: Q.answerer == null, onclick: () => judge(false) });
    const reveal = h('button', { class: 'btn ghost', text: 'Показать ответ', title: 'Пробел', onclick: revealAnswer });

    if (special) {
      Q.onPlayer = null;
      setControls(
        h('span', { class: 'label', text: 'Отвечает:' }),
        h('b', { text: Q.answerer != null ? G.players[Q.answerer].name : '—' }),
        h('span', { class: 'sep' }), good, bad, h('span', { class: 'sep' }), reveal, cancelButton());
    } else {
      Q.onPlayer = i => { if (Q.stage === 'asking' && !Q.tried.has(i)) { Q.answerer = Q.answerer === i ? null : i; renderAskControls(); } };
      setControls(
        h('span', { class: 'label', text: 'Отвечает:' }),
        playerButtons(i => Q.onPlayer(i)),
        h('span', { class: 'sep' }), good, bad, h('span', { class: 'sep' }), reveal, cancelButton());
      $$('#qpanel .q-controls [data-p]').forEach(b => b.classList.toggle('selected', +b.dataset.p === Q.answerer));
    }
    updatePlayers();
  }

  function judge(correct) {
    if (!Q || Q.stage !== 'asking' || Q.answerer == null) return;
    const i = Q.answerer;
    const special = Q.type !== 'normal';
    const pts = special ? Q.points : Q.value;
    Q.scored = true;
    if (correct) {
      addScore(i, pts);
      G.chooser = i;
      return revealAnswer();
    }
    if (Q.type !== 'norisk') addScore(i, -pts);
    if (special) return revealAnswer();
    Q.tried.add(i);
    Q.answerer = null;
    if (Q.tried.size >= G.players.length) return revealAnswer();
    renderAskControls();
  }

  function revealAnswer() {
    if (!Q || Q.stage === 'answer') return;
    Q.stage = 'answer';
    Q.onPlayer = null;
    const q = Q.q;
    const body = $('#qpanel .q-body');
    let answerText = q.answer;
    if (q.options) {
      const idx = Loader.optionIndex(q);
      if (idx >= 0) answerText = `${LETTERS[idx]}: ${q.options[idx]}`;
    }
    // На экране ответа вопрос убирается, чтобы ответ и картинка были крупнее
    $('.q-text', body)?.remove();
    $('.q-options', body)?.remove();
    $$('.q-media img', body).forEach(i => i.remove());
    if (Q.video) { // видео показывается только вместе с ответом
      $('.video-sound', body)?.remove();
      const v = Q.video;
      v.controls = true;
      $('.q-media', body).append(v);
      v.currentTime = 0;
      v.addEventListener('resize', fitQuestion);
      setTimeout(fitQuestion, 60);
      Sound.stopAll(300);
      v.play().catch(() => {});
    }
    const ans = h('div', { class: 'q-answer' },
      h('small', { text: 'Правильный ответ' }),
      answerText,
      q.answerImage ? h('img', { src: q.answerImage, alt: '', onload: fitQuestion }) : null,
      q.note ? h('span', { class: 'note', text: q.note }) : null);
    body.append(ans);
    if (q.answerAudio) body.append(audioControl(q.answerAudio, 'Ответ'));
    if (Q.final) return fitQuestion();
    Q.answerer = null;
    setControls(h('button', { class: 'btn gold big', text: 'К табло →', title: 'Esc / Enter', onclick: closeQuestion }));
    updatePlayers();
    fitQuestion();
  }

  /* Подгоняет вопрос под экран: сначала уменьшает текст, потом картинки и видео */
  function fitQuestion() {
    const body = $('#qpanel .q-body');
    if (!body || $('#qpanel').hidden) return;
    const text = $('.q-text', body), ans = $('.q-answer', body), opts = $('.q-options', body);
    const media = $$('.q-media img, .q-media video', body);
    const ansImgs = $$('.q-answer img', body);
    const H = body.clientHeight, vh = window.innerHeight, vw = window.innerWidth;
    const overflows = () => body.scrollHeight > body.clientHeight + 1;

    if (!text && ans) { // экран ответа: только ответ, его картинка или видео
      const len = ans.childNodes[1] ? ans.childNodes[1].textContent.length : 10;
      let fs = Math.min(vw * (len > 40 ? 0.04 : len > 20 ? 0.052 : 0.065), vh * 0.1);
      let imgH = H * 0.78;
      const apply = () => {
        ans.style.fontSize = fs + 'px';
        ansImgs.forEach(m => { m.style.maxHeight = imgH + 'px'; });
        media.forEach(m => { m.style.maxHeight = imgH + 'px'; });
      };
      apply();
      for (let i = 0; i < 100 && overflows(); i++) {
        if (imgH > H * 0.55) imgH *= 0.95;
        else if (fs > vh * 0.045) fs *= 0.93;
        else if (imgH > 60) imgH *= 0.92;
        else if (fs > 12) fs *= 0.93;
        else break;
        apply();
      }
      return;
    }

    if (!text) return;
    let mediaH = H * 0.62;
    const len = (text.textContent || '').length;
    let fs = Math.min(vw * (len > 200 ? 0.026 : len > 90 ? 0.034 : 0.042), vh * (opts ? 0.06 : 0.075));
    const readable = Math.max(18, vh * 0.03);
    const apply = () => {
      text.style.fontSize = fs + 'px';
      if (opts) opts.style.fontSize = Math.max(fs * 0.75, 12) + 'px';
      media.forEach(m => { m.style.maxHeight = mediaH + 'px'; });
    };
    apply();
    for (let i = 0; i < 80 && overflows(); i++) {
      if (fs > readable) fs *= 0.93;
      else if (mediaH > 90) mediaH *= 0.9;
      else if (fs > 12) fs *= 0.93;
      else break;
      apply();
    }
  }

  function stopQuestionMedia() {
    if (!Q) return;
    Q.media.forEach(m => { try { m.pause(); } catch (e) { } });
    if (Q.timer) { Q.timer.stop(); Q.timer = null; }
  }

  function closeQuestion() {
    if (!Q) return;
    stopQuestionMedia();
    G.played[Q.key] = true;
    Q = null;
    save();
    $('#qpanel').hidden = true;
    renderBoard();
    updatePlayers();
    if (roundComplete()) setTimeout(endRound, 500);
  }

  function closeQuestionSilently() {
    if (!Q) return;
    stopQuestionMedia();
    Sound.stopAll(300);
    const wasFinal = Q.final;
    Q = null;
    $('#qpanel').hidden = true;
    if (!wasFinal) updatePlayers();
  }

  /* ================= Финал ================= */
  function startFinal() {
    closeQuestionSilently();
    const fin = G.data.deck.final;
    G.round = G.data.deck.rounds.length;
    save();
    if (!fin) return showWinner();
    let part = G.players.map((p, i) => i).filter(i => G.players[i].score > 0);
    if (!part.length) part = G.players.map((p, i) => i); // если ни у кого нет плюса — играют все
    G.fin = { part, left: fin.themes.map((_, i) => i), bets: {}, verdict: {}, applied: false };
    showThemes(fin.name, fin.themes, finalChooseTheme);
  }

  function finalScreen() {
    show('screen-game');
    $('#round-label').textContent = G.data.deck.final.name;
    $('#board').hidden = true;
    const P = $('#final-panel');
    P.hidden = false;
    renderPlayers();
    return P;
  }

  function finalChooseTheme() {
    const P = finalScreen();
    const fin = G.data.deck.final;
    if (G.fin.left.length === 1) return finalBets();
    const list = h('div', { class: 'final-themes' }, fin.themes.map((t, i) => {
      const line = h('div', { class: 'theme-line' + (t.hidden ? ' hidden-theme' : ''), text: t.hidden ? HIDDEN : t.name });
      line.onclick = () => {
        if (line.classList.contains('removed') || G.fin.left.length <= 1) return;
        line.classList.add('removed');
        G.fin.left = G.fin.left.filter(x => x !== i);
        if (G.fin.left.length === 1) {
          const lastLine = list.children[G.fin.left[0]];
          lastLine.style.borderColor = 'var(--gold)';
          lastLine.style.boxShadow = '0 0 30px rgba(255,210,60,.8)';
          setTimeout(finalBets, 1300);
        }
      };
      return line;
    }));
    P.replaceChildren(h('div', { class: 'final-body' },
      h('div', { class: 'final-caption', text: 'Игроки по очереди убирают темы. Щёлкните по теме, чтобы убрать её.' }),
      list));
  }

  function betInput(i) {
    const p = G.players[i];
    const inp = h('input', {
      class: 'secret', type: 'text', inputMode: 'numeric', autocomplete: 'off',
      value: G.fin.bets[i] ?? '',
      oninput: () => {
        const n = parseInt(inp.value.replace(/\D/g, ''), 10);
        G.fin.bets[i] = isNaN(n) ? '' : Math.min(n, Math.max(p.score, 0));
      },
      onblur: () => { inp.value = G.fin.bets[i] ?? ''; },
    });
    return inp;
  }

  function finalBets() {
    const P = finalScreen();
    const theme = G.data.deck.final.themes[G.fin.left[0]];
    const rows = G.fin.part.flatMap(i => {
      const p = G.players[i];
      return [
        h('div', { class: 'who' }, p.img ? h('img', { src: p.img, alt: '' }) : null, p.name),
        betInput(i),
        h('div', { class: 'max', text: `макс. ${fmt(Math.max(p.score, 0))}` }),
      ];
    });
    let visible = false;
    const eye = h('button', {
      class: 'btn ghost', text: '👁 Показать ставки',
      onclick: () => {
        visible = !visible;
        $$('#final-panel input').forEach(x => x.classList.toggle('secret', !visible));
        eye.textContent = visible ? '🙈 Скрыть ставки' : '👁 Показать ставки';
      },
    });
    P.replaceChildren(h('div', { class: 'final-body' },
      h('div', { class: 'final-caption', text: 'Тема финала' }),
      h('div', { class: 'final-theme-big', text: theme.name }),
      h('div', { class: 'final-caption', text: 'Участники делают ставки (ставки скрыты, их можно ввести и после ответа)' }),
      h('div', { class: 'final-bets' }, rows),
      h('div', { class: 'splash-buttons' }, eye, h('button', { class: 'btn gold big', text: 'Вопрос →', onclick: finalQuestion }))));
  }

  function finalQuestion() {
    const theme = G.data.deck.final.themes[G.fin.left[0]];
    const q = theme.questions[0];
    Q = { final: true, q, theme, type: 'normal', tried: new Set(), media: [], stage: 'asking', answerer: null, scored: true };
    const P = buildPanel();
    P.hidden = false;
    setHead(theme.name, 'Финал');
    fill($('#qpanel .q-body'), questionBody(q));
    fitQuestion();
    setControls(
      h('button', { class: 'btn gold big', text: `⏱ ${THINK_SECONDS} секунд`, onclick: startThinking }),
      h('span', { class: 'sep' }),
      h('button', { class: 'btn ghost', text: 'Без таймера → к ответам', onclick: finalJudge }));
  }

  function startThinking() {
    Q.media.forEach(m => m.pause());
    const timer = h('div', { class: 'timer' }, h('div', { class: 'num', text: THINK_SECONDS }), h('div', { class: 'track' }, h('div', { class: 'fill' })));
    setControls(timer);
    Sound.stopAll();
    Sound.play('think');
    const t0 = performance.now();
    const T = {};
    const stopTimer = () => { clearInterval(T.iv); clearTimeout(T.end); };
    const tick = () => {
      const left = Math.max(0, THINK_SECONDS - (performance.now() - t0) / 1000);
      $('.num', timer).textContent = Math.ceil(left);
      $('.fill', timer).style.transform = `scaleX(${left / THINK_SECONDS})`;
    };
    // Обычные таймеры, а не requestAnimationFrame: сигнал прозвучит вовремя, даже если окно свёрнуто
    T.iv = setInterval(tick, 100);
    T.end = setTimeout(() => {
      stopTimer();
      Sound.stop('think');
      Sound.play('timeout');
      timer.classList.add('over');
      $('.fill', timer).style.transform = 'scaleX(0)';
      $('.num', timer).textContent = 'Время!';
      if (Q) Q.timer = null;
      setTimeout(finalJudge, 1500);
    }, THINK_SECONDS * 1000);
    Q.timer = { stop: stopTimer };
    tick();
  }

  function finalJudge() {
    if (!Q || !Q.final) return;
    if (Q.timer) { Q.timer.stop(); Q.timer = null; Sound.stop('think'); }
    const syncs = [];
    const groups = G.fin.part.map(i => {
      const p = G.players[i];
      const yes = h('button', { class: 'btn good', text: '✓' });
      const no = h('button', { class: 'btn bad', text: '✗' });
      const sync = () => {
        yes.classList.toggle('selected', G.fin.verdict[i] === true);
        no.classList.toggle('selected', G.fin.verdict[i] === false);
        done.disabled = G.fin.applied || !G.fin.part.every(j => typeof G.fin.verdict[j] === 'boolean');
      };
      yes.onclick = () => { G.fin.verdict[i] = true; sync(); };
      no.onclick = () => { G.fin.verdict[i] = false; sync(); };
      syncs.push(sync);
      return h('span', { class: 'final-judge' }, h('b', { text: p.name }), betInput(i), yes, no, h('span', { class: 'sep' }));
    });
    const done = h('button', { class: 'btn gold', text: 'Подвести итоги', onclick: applyFinal });
    setControls(groups, h('button', { class: 'btn ghost', text: 'Показать ответ', onclick: revealAnswer }), done);
    syncs.forEach(s => s());
  }

  function applyFinal() {
    if (G.fin.applied) return;
    const missing = G.fin.part.filter(i => G.fin.bets[i] === '' || G.fin.bets[i] == null);
    if (missing.length && !confirm(`Нет ставки у: ${missing.map(i => G.players[i].name).join(', ')}. Считать ставку нулевой?`)) return;
    G.fin.applied = true;
    revealAnswer();
    G.fin.part.forEach(i => {
      const bet = +G.fin.bets[i] || 0;
      addScore(i, G.fin.verdict[i] ? bet : -bet);
    });
    G.finished = true;
    save();
    setControls(h('button', { class: 'btn gold big', text: 'Итоги игры →', onclick: showWinner }));
  }

  /* ================= Итоги ================= */
  function showWinner() {
    closeQuestionSilently();
    G.finished = true;
    save();
    show('screen-winner');
    Sound.stopAll();
    Sound.play('intro');
    const max = Math.max(...G.players.map(p => p.score));
    const champs = G.players.filter(p => p.score === max);
    const rest = G.players.filter(p => p.score !== max).sort((a, b) => b.score - a.score);
    fill($('#screen-winner .winner'),
      h('div', { class: 'title', text: champs.length > 1 ? 'Победители' : 'Победитель' }),
      h('div', { class: 'champs' }, champs.map(p => h('div', { class: 'champ' },
        h('div', { class: 'pi-photo' + (p.img ? '' : ' noimg') }, p.img ? h('img', { src: p.img, alt: '' }) : p.name[0]),
        h('div', { class: 'pi-name', text: p.name }),
        h('div', { class: 'score', text: fmt(p.score) })))),
      rest.length ? h('div', { class: 'rest' }, rest.map(p => h('div', {}, p.name, h('b', { text: fmt(p.score) })))) : null);
    advance = null;
  }

  /* ================= Панель ведущего и клавиши ================= */
  $('#toolbar').addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'undo') undo();
    if (act === 'mute') {
      Sound.setMuted(!Sound.isMuted());
      if (Q) Q.media.forEach(m => { m.muted = Sound.isMuted(); });
      e.target.textContent = Sound.isMuted() ? '🔇' : '🔊';
    }
    if (act === 'full') toggleFullscreen();
    if (act === 'help') $('#help').hidden = !$('#help').hidden;
    if (act === 'skip') skipRound();
    if (act === 'restart' && confirm('Начать новую игру? Текущий счёт будет потерян.')) {
      closeQuestionSilently(); Sound.stopAll(); themeTimers.forEach(clearTimeout); advance = null; clearSave(); ready(G.data);
    }
  });
  $('#help [data-close]').addEventListener('click', () => { $('#help').hidden = true; });

  function skipRound() {
    const inGame = $('#screen-game').classList.contains('active');
    if (!inGame || G.finished) return;
    if (G.fin) {
      if (confirm('Пропустить финал и показать итоги?')) showWinner();
      return;
    }
    if (confirm('Завершить этот раунд досрочно и перейти к следующему?')) endRound();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  document.addEventListener('keydown', e => {
    if (e.target.matches?.('input, textarea')) {
      if (e.key === 'Enter') e.target.blur();
      return;
    }
    if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') return toggleFullscreen();
    if (advance && [' ', 'Enter', 'ArrowRight'].includes(e.key) && $('.screen.clickable.active')) {
      e.preventDefault(); const f = advance; return f();
    }
    const over = $('.round-over');
    if (over && [' ', 'Enter'].includes(e.key)) { e.preventDefault(); return over.click(); }
    if (!Q) return;
    const splash = $('#qpanel .q-splash:not(.leave)');
    if (splash && [' ', 'Enter'].includes(e.key)) { e.preventDefault(); return splash.click(); }
    if (/^[1-9]$/.test(e.key) && Q.onPlayer) { const i = +e.key - 1; if (i < G.players.length) Q.onPlayer(i); return; }
    if (Q.final) return;
    if ((e.key === '+' || e.key === '=') && Q.stage === 'asking') return judge(true);
    if ((e.key === '-' || e.key === '_') && Q.stage === 'asking') return judge(false);
    if (e.key === ' ' && Q.stage === 'asking') { e.preventDefault(); return revealAnswer(); }
    if ((e.key === 'Escape' || e.key === 'Enter') && Q.stage === 'answer') { e.preventDefault(); return closeQuestion(); }
  });

  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { fitBoard(); fitQuestion(); }, 120); });

  boot();
})();
