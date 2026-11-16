/* Звуки игры.
   Файлы из папки sounds/ подхватываются по ключевым словам в имени (см. KEYWORDS).
   Если файла нет — играет встроенный синтезированный вариант. */
const Sound = (() => {
  // Порядок важен: "categories" проверяется раньше "cat", начало/конец раунда — раньше остальных.
  const KEYWORDS = [
    ['roundend', /round.?end|конец.?раунда/i],
    ['roundstart', /round|раунд/i],
    ['categories', /categor|themes|тем[ыа]/i],
    ['intro', /intro|заставк|начало/i],
    ['cat', /(^|[^a-zа-яё])(cat|кот)([^a-zа-яё]|$)/i],
    ['auction', /auction|аукцион/i],
    ['norisk', /risk|риск/i],
    ['timeout', /time-?_?out|тайм-?аут|время вышло/i],
    ['think', /30|think|размышл|final|финал/i],
  ];

  const urls = {};
  const playing = {};
  let muted = false;
  let ctx = null, master = null;

  function audioCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function registerFiles(fileNames, urlFor) {
    for (const file of fileNames) {
      if (!/\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i.test(file)) continue;
      for (const [name, re] of KEYWORDS) {
        if (re.test(file)) { if (!urls[name]) urls[name] = urlFor(file); break; }
      }
    }
  }

  function fadeAudio(a, ms, done) {
    const start = a.volume, t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      a.volume = start * (1 - k);
      if (k < 1) requestAnimationFrame(step); else { a.pause(); done && done(); }
    };
    step();
  }

  /* opts.onEnd вызывается, когда звук доиграл (или не смог загрузиться) — но не при stop() */
  function play(name, opts = {}) {
    stop(name);
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      if (playing[name] === h) delete playing[name];
      if (opts.onEnd) opts.onEnd();
    };
    let h = null;
    if (urls[name]) {
      const a = new Audio(urls[name]);
      a.loop = !!opts.loop;
      a.volume = opts.volume ?? 1;
      a.muted = muted; // при выключенном звуке звук идёт беззвучно, чтобы после включения продолжиться с нужного места
      a.play().catch(() => {});
      h = { stop: (ms) => { ended = true; ms ? fadeAudio(a, ms) : a.pause(); }, el: a };
      a.addEventListener('ended', finish);
      a.addEventListener('error', finish);
    } else if (SYNTH[name]) {
      const b = SYNTH[name](audioCtx());
      const timer = setTimeout(finish, (b.duration || 3) * 1000);
      h = { stop: (ms) => { ended = true; clearTimeout(timer); b.stop(ms); } };
    } else {
      setTimeout(finish, 0);
      return;
    }
    playing[name] = h;
  }

  function stop(name, fadeMs = 0) {
    const h = playing[name];
    if (h) { h.stop(fadeMs); delete playing[name]; }
  }

  function stopAll(fadeMs = 0) { Object.keys(playing).forEach(n => stop(n, fadeMs)); }

  function setMuted(m) {
    muted = m;
    Object.values(playing).forEach(h => { if (h.el) h.el.muted = m; });
    if (master) master.gain.setValueAtTime(m ? 0 : 1, ctx.currentTime);
  }

  /* ---------- Встроенные (синтезированные) звуки ---------- */
  const N = (s) => { // 'A4' -> Гц
    const m = s.match(/^([A-G])(#|b)?(\d)$/);
    const semis = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return 440 * Math.pow(2, (semis + (m[3] - 4) * 12) / 12);
  };

  function voice(c, out, freq, t, dur, type = 'sawtooth', vol = 0.2, cutoff = 2400) {
    const o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
    o.type = type; o.frequency.value = freq;
    f.type = 'lowpass'; f.frequency.value = cutoff;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.setValueAtTime(vol, t + Math.max(0.03, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.05);
    return o;
  }

  function noise(c, out, t, dur, vol = 0.3, freq = 1200) {
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq; g.gain.value = vol;
    s.connect(f); f.connect(g); g.connect(out); s.start(t);
  }

  function bus(c) {
    const g = c.createGain(); g.gain.value = 0.9; g.connect(master);
    return {
      out: g,
      stop(ms) {
        const t = c.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + (ms ? ms / 1000 : 0.03));
        setTimeout(() => g.disconnect(), (ms || 30) + 100);
      },
    };
  }

  // Последовательность аккордов/нот: [[ноты], длительность]
  function seq(c, out, t0, steps, type, vol, cutoff) {
    let t = t0;
    for (const [notes, dur] of steps) {
      for (const n of [].concat(notes)) if (n) voice(c, out, N(n), t, dur * 0.95, type, vol, cutoff);
      t += dur;
    }
    return t;
  }

  const SYNTH = {
    roundstart(c) {
      const b = bus(c), t = c.currentTime + 0.05;
      seq(c, b.out, t, [[['G3', 'C4', 'E4'], 0.15], [['G3', 'C4', 'E4'], 0.15], [['C4', 'E4', 'G4', 'C5'], 1.2]], 'sawtooth', 0.08, 2600);
      b.duration = 1.6;
      return b;
    },
    roundend(c) {
      const b = bus(c), t = c.currentTime + 0.05;
      seq(c, b.out, t, [[['C5', 'E5'], 0.3], [['G4', 'C5'], 0.3], [['E4', 'G4'], 0.3], [['C4', 'E4', 'G4'], 1.4]], 'triangle', 0.12, 4000);
      b.duration = 2.3;
      return b;
    },
    intro(c) {
      const b = bus(c), t = c.currentTime + 0.05;
      let e = seq(c, b.out, t, [
        [['C4', 'E4', 'G4'], 0.18], [['C4', 'E4', 'G4'], 0.18], [['C4', 'E4', 'G4'], 0.18], [['C4', 'F4', 'A4'], 0.54],
        [['D4', 'G4', 'B4'], 0.18], [['D4', 'G4', 'B4'], 0.18], [['E4', 'G4', 'C5'], 0.9],
        [['A3', 'C4', 'F4', 'A4'], 0.36], [['B3', 'D4', 'G4', 'B4'], 0.36], [['C4', 'E4', 'G4', 'C5', 'E5'], 1.6],
      ], 'sawtooth', 0.07, 2200);
      seq(c, b.out, t, [['C2', 1.08], ['G2', 1.26], ['F2', 0.36], ['G2', 0.36], ['C2', 1.6]], 'triangle', 0.25, 800);
      noise(c, b.out, e - 1.6, 1.6, 0.15, 6000);
      b.duration = 5.5;
      return b;
    },
    categories(c) {
      const b = bus(c), t = c.currentTime + 0.05;
      const arp = ['C5', 'E5', 'G5', 'C6', 'G5', 'E5'];
      const chords = [['C3', 'G3'], ['A2', 'E3'], ['F2', 'C3'], ['G2', 'D3']];
      for (let bar = 0; bar < 8; bar++) {
        const shift = [0, -3, -7, -5][bar % 4];
        arp.forEach((n, i) => voice(c, b.out, N(n) * Math.pow(2, shift / 12), t + bar * 1.2 + i * 0.2, 0.35, 'triangle', 0.08, 5000));
        chords[bar % 4].forEach(n => voice(c, b.out, N(n), t + bar * 1.2, 1.15, 'sawtooth', 0.05, 900));
      }
      b.duration = 10;
      return b;
    },
    cat(c) {
      const b = bus(c), t = c.currentTime + 0.05;
      seq(c, b.out, t, [['E5', 0.15], ['G5', 0.15], ['E5', 0.15], ['C5', 0.15], ['D5', 0.15], ['F5', 0.15], ['D5', 0.15], ['B4', 0.15], ['C5', 0.6]], 'square', 0.06, 3000);
      [1.6, 2.2].forEach((dt, i) => { // «мяу»
        const o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
        o.type = 'sawtooth'; f.type = 'bandpass'; f.Q.value = 3;
        o.frequency.setValueAtTime(500 + i * 150, t + dt);
        o.frequency.linearRampToValueAtTime(900 + i * 150, t + dt + 0.15);
        o.frequency.linearRampToValueAtTime(450 + i * 100, t + dt + 0.5);
        f.frequency.setValueAtTime(800, t + dt); f.frequency.linearRampToValueAtTime(1800, t + dt + 0.2); f.frequency.linearRampToValueAtTime(700, t + dt + 0.5);
        g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.4, t + dt + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.55);
        o.connect(f); f.connect(g); g.connect(b.out); o.start(t + dt); o.stop(t + dt + 0.6);
      });
      b.duration = 3;
      return b;
    },
    auction(c) {
      const b = bus(c), t = c.currentTime + 0.05;
      [0, 0.35, 0.7].forEach(dt => { noise(c, b.out, t + dt, 0.25, 0.8, 400); voice(c, b.out, 90, t + dt, 0.2, 'sine', 0.5, 400); });
      seq(c, b.out, t + 1.1, [[['G3', 'C4', 'E4'], 0.25], [['A3', 'D4', 'F4'], 0.25], [['B3', 'D4', 'G4'], 0.25], [['C4', 'E4', 'G4', 'C5'], 1.2]], 'sawtooth', 0.07, 2500);
      b.duration = 3;
      return b;
    },
    norisk(c) {
      const b = bus(c), t = c.currentTime + 0.05;
      seq(c, b.out, t, [['C5', 0.12], ['E5', 0.12], ['G5', 0.12], ['C6', 0.12], ['E6', 0.12], ['G6', 0.8]], 'triangle', 0.15, 8000);
      b.duration = 1.6;
      return b;
    },
    think(c) {
      const b = bus(c), t = c.currentTime + 0.05;
      for (let i = 0; i < 60; i++) noise(c, b.out, t + i * 0.5, 0.04, i % 2 ? 0.25 : 0.4, i % 2 ? 2500 : 3500);
      const phrase = ['A4', 'C5', 'E5', 'D5', 'C5', 'B4', 'G#4', 'B4'];
      for (let r = 0; r < 7; r++) {
        phrase.forEach((n, i) => voice(c, b.out, N(n), t + r * 4 + i * 0.5, 0.45, 'triangle', 0.08, 3000));
        voice(c, b.out, N(r % 2 ? 'E2' : 'A2'), t + r * 4, 3.9, 'sine', 0.2, 600);
      }
      b.duration = 30;
      return b;
    },
    timeout(c) {
      const b = bus(c), t = c.currentTime + 0.02;
      voice(c, b.out, 110, t, 1.3, 'square', 0.15, 1200);
      voice(c, b.out, 116, t, 1.3, 'square', 0.15, 1200);
      b.duration = 1.4;
      return b;
    },
  };

  return { registerFiles, play, stop, stopAll, setMuted, isMuted: () => muted, hasFile: n => !!urls[n] };
})();
