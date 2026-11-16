/* Загрузка колоды, игроков и звуков.
   Режим «http» — страница открыта через сервер (Запустить игру.bat): файлы читаются запросами.
   Режим «picker» — страница открыта двойным щелчком (file://): пользователь выбирает папку игры. */
const Loader = (() => {
  let mode = 'http';
  let files = null; // нормализованный путь -> File (режим picker)
  const objectUrls = {};

  const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i;
  const norm = p => p.replace(/\\/g, '/').replace(/^\.\//, '').normalize('NFC').toLowerCase();

  function url(path) {
    if (!path) return null;
    if (/^(https?:|data:|blob:)/i.test(path)) return path;
    if (mode === 'picker') {
      const key = norm(path);
      const f = files[key];
      if (!f) return null;
      return objectUrls[key] || (objectUrls[key] = URL.createObjectURL(f));
    }
    return path.split('/').map(encodeURIComponent).join('/');
  }

  function exists(path) {
    if (mode !== 'picker' || /^(https?:|data:|blob:)/i.test(path)) return true; // в http-режиме проверит сам браузер
    return !!files[norm(path)];
  }

  async function readText(path) {
    if (mode === 'picker') {
      const f = files[norm(path)];
      return f ? await f.text() : null;
    }
    try {
      const r = await fetch(url(path), { cache: 'no-store' });
      return r.ok ? await r.text() : null;
    } catch (e) { return null; }
  }

  async function listDir(dir) {
    if (mode === 'picker') {
      const prefix = norm(dir) + '/';
      return Object.values(files)
        .filter(f => norm(f._rel).startsWith(prefix) && !f._rel.slice(prefix.length).includes('/'))
        .map(f => f._rel.slice(prefix.length));
    }
    try {
      const r = await fetch(url(dir) + '/', { cache: 'no-store' });
      if (!r.ok) return [];
      const html = await r.text();
      const out = [];
      for (const m of html.matchAll(/href\s*=\s*"([^"?#]+)"/gi)) {
        if (m[1].endsWith('/')) continue; // подпапки не нужны
        const name = decodeURIComponent(m[1]).split('/').pop();
        if (!name || name === '..') continue;
        if (!out.includes(name)) out.push(name);
      }
      return out;
    } catch (e) { return []; }
  }

  /* Режим выбора папки: возвращает true, если в выбранной папке найдена deck/questions.txt */
  function usePickedFiles(fileList) {
    const all = Array.from(fileList);
    const deckFile = all.find(f => /(^|\/)deck\/questions\.txt$/i.test(f.webkitRelativePath.normalize('NFC')));
    if (!deckFile) return false;
    const base = deckFile.webkitRelativePath.normalize('NFC').replace(/deck\/questions\.txt$/i, '');
    files = {};
    for (const f of all) {
      const p = f.webkitRelativePath.normalize('NFC');
      if (!p.startsWith(base)) continue;
      f._rel = p.slice(base.length);
      files[norm(f._rel)] = f;
    }
    mode = 'picker';
    return true;
  }

  /* ---------- Игроки ---------- */
  async function loadPlayers() {
    const listed = await listDir('players');
    const txt = await readText('players/players.txt');
    const players = [];
    if (txt) {
      // Формат строки: Имя | файл картинки   (картинку можно не указывать)
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const [name, img] = line.split('|').map(s => s.trim());
        if (!name) continue;
        players.push({ name, img: img ? url('players/' + img) : null });
      }
    }
    if (!players.length) {
      const imgs = listed.filter(n => IMG_RE.test(n)).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
      for (const f of imgs) {
        const name = f.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]*/, '').replace(/_/g, ' ').trim() || f;
        players.push({ name, img: url('players/' + f) });
      }
    }
    return players;
  }

  async function loadSounds() {
    Sound.registerFiles(await listDir('sounds'), f => url('sounds/' + f));
  }

  /* ---------- Разбор файла вопросов ---------- */
  const TAGS = [
    [/^(кот|кот в мешке|cat)$/, (q, v) => { q.type = 'cat'; if (v) q.catTheme = v; }],
    [/^(аукцион|auction)$/, q => { q.type = 'auction'; }],
    [/^(без риска|нориск|norisk|no risk)$/, q => { q.type = 'norisk'; }],
    [/^(картинка|изображение|фото|img|image|picture)$/, (q, v) => { q.image = v; }],
    [/^(аудио|звук|музыка|audio|sound|music)$/, (q, v) => { q.audio = v; }],
    [/^(видео|video)$/, (q, v) => { q.video = v; }],
    [/^(ответ-картинка|картинка-ответ|ответ картинка|answer-image|answer-img)$/, (q, v) => { q.answerImage = v; }],
    [/^(ответ-аудио|аудио-ответ|answer-audio)$/, (q, v) => { q.answerAudio = v; }],
    [/^(комментарий|ведущему|note|comment)$/, (q, v) => { q.note = v; }],
    [/^(варианты|варианты ответа|options|choices)$/, (q, v) => { q.options = v.split(';').map(x => x.trim()).filter(Boolean); }],
  ];
  const MEDIA_KEYS = ['image', 'audio', 'video', 'answerImage', 'answerAudio'];

  /* Какой вариант правильный: ответ может быть текстом варианта или буквой/номером (А, Б, В, Г / A–D / 1–4) */
  const LETTERS = ['АA1', 'БB2', 'ВC3', 'ГD4', 'ДE5', 'ЕF6'];
  function optionIndex(q) {
    const a = (q.answer || '').trim().toLowerCase().replace(/ё/g, 'е');
    if (!a) return -1;
    const byText = q.options.findIndex(o => o.toLowerCase().replace(/ё/g, 'е') === a);
    if (byText >= 0) return byText;
    const letter = a.replace(/[).:]$/, '').toUpperCase();
    if (letter.length === 1) return LETTERS.findIndex((l, i) => i < q.options.length && l.includes(letter));
    return -1;
  }

  function parseDeck(text) {
    const rounds = [];
    let final = null, round = null, theme = null, title = null;
    const warnings = [];
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);

    lines.forEach((raw, i) => {
      const ln = i + 1;
      let line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return;
      let m;
      if ((m = line.match(/^(название|игра|title)\s*:\s*(.*)$/i))) { title = m[2].trim(); return; }
      if ((m = line.match(/^(раунд|round)\s*:(.*)$/i))) {
        round = { name: m[2].trim() || `Раунд ${rounds.length + 1}`, themes: [] };
        rounds.push(round); theme = null; return;
      }
      if ((m = line.match(/^(финал|final)\s*(:(.*))?$/i))) {
        final = round = { name: (m[3] || '').trim() || 'Финал', themes: [], final: true };
        theme = null; return;
      }
      if ((m = line.match(/^(тема|theme|category|категория)\s*:(.*)$/i))) {
        if (!round) { round = { name: `Раунд ${rounds.length + 1}`, themes: [] }; rounds.push(round); }
        let hidden = false;
        const name = m[2].replace(/\[\s*(скрытая|скрыта|hidden)\s*\]/ig, () => { hidden = true; return ''; }).trim();
        theme = { name: name || 'Без названия', hidden, questions: [] };
        round.themes.push(theme); return;
      }
      if (!theme) { warnings.push(`Строка ${ln}: вопрос до объявления темы (ТЕМА: ...) — пропущен`); return; }

      const q = { type: 'normal', line: ln };
      line = line.replace(/\[([^\]]*)\]/g, (_, inner) => {
        const idx = inner.indexOf(':');
        const key = (idx < 0 ? inner : inner.slice(0, idx)).trim().toLowerCase().replace(/ё/g, 'е');
        const val = idx < 0 ? '' : inner.slice(idx + 1).trim();
        const tag = TAGS.find(([re]) => re.test(key));
        if (tag) tag[1](q, val); else warnings.push(`Строка ${ln}: неизвестный тег [${inner}]`);
        return ' ';
      });
      const parts = line.split('|').map(s => s.trim().replace(/\\n/g, '\n').replace(/[ \t]{2,}/g, ' '));
      if (/^\d+$/.test(parts[0])) q.value = parseInt(parts.shift(), 10);
      q.text = parts[0] || '';
      q.answer = parts[1] || '';
      if (parts.length > 2) warnings.push(`Строка ${ln}: лишние символы «|» — всё после ответа проигнорировано`);
      if (!q.text && !q.image && !q.audio && !q.video) warnings.push(`Строка ${ln}: пустой вопрос`);
      if (!q.answer) warnings.push(`Строка ${ln}: не указан ответ`);
      if (q.options) {
        if (q.options.length < 2) warnings.push(`Строка ${ln}: в [варианты: ...] нужно хотя бы 2 варианта через «;»`);
        else if (q.answer && optionIndex(q) < 0) warnings.push(`Строка ${ln}: ответ «${q.answer}» не совпадает ни с одним вариантом`);
      }
      for (const k of MEDIA_KEYS) {
        if (!q[k]) continue;
        const path = /^(https?:|data:)/i.test(q[k]) ? q[k] : 'deck/' + q[k].replace(/\\/g, '/');
        if (!exists(path)) warnings.push(`Строка ${ln}: файл не найден — ${q[k]}`);
        q[k] = url(path) || path;
      }
      if (round.final && q.type !== 'normal') { warnings.push(`Строка ${ln}: в финале особые типы вопросов не используются`); q.type = 'normal'; }
      theme.questions.push(q);
    });

    // Стоимость по умолчанию: 100·N·(номер раунда)
    rounds.forEach((r, ri) => r.themes.forEach(t => t.questions.forEach((q, qi) => {
      if (q.value == null) q.value = (qi + 1) * 100 * (ri + 1);
    })));
    const emptyRounds = rounds.filter(r => !r.themes.some(t => t.questions.length));
    emptyRounds.forEach(r => warnings.push(`Раунд «${r.name}» пустой — пропущен`));
    const okRounds = rounds.filter(r => !emptyRounds.includes(r));
    if (final) {
      final.themes = final.themes.filter(t => {
        if (!t.questions.length) { warnings.push(`Финал: тема «${t.name}» без вопроса — пропущена`); return false; }
        return true;
      });
      if (!final.themes.length) final = null;
    }
    return { title, rounds: okRounds, final, warnings };
  }

  async function loadAll() {
    const text = await readText('deck/questions.txt');
    if (text == null) return null;
    const deck = parseDeck(text);
    const players = await loadPlayers();
    await loadSounds();
    return { deck, players, hash: hashString(text) };
  }

  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  return { loadAll, usePickedFiles, optionIndex, isFileProtocol: () => location.protocol === 'file:' };
})();
