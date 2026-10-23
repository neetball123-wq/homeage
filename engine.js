/* ページの表示と進行、さわって選ぶ部品。物語の中身は stories/ 以下に置く（書き方は README.md）。 */
(function () {
  'use strict';

  const SAVE_KEY = 'homeage-save-v5';
  const FIRST_PAGE = 'hajime.boot';
  const ALIGN = { '<': 'left', '^': 'center', '>': 'right' };
  const STEP = 70; // 1行ずつ出てくる間隔（ミリ秒）。style.css の --step と合わせる
  const MAX_STAGGER = 12; // これより後ろの行は、同時に出す
  const LAYERS = 6; // 1回の旅で通る段の数

  const pages = {};
  const stories = {};
  const order = [];
  let state = null;
  let timer = 0;
  let paused = false;
  let busy = false;
  let off = []; // ページを移るときに外すもの
  let toastTimer = 0;
  let pageEl = null;
  let crumbEl = null;
  const debug = { fast: false };

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const still = () => debug.fast || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const plain = (s) => String(s).replace(/<[^>]+>/g, '');

  function later(fn, ms) {
    const id = setTimeout(fn, ms);
    off.push(() => clearTimeout(id));
  }
  function listen(el, type, fn, opt) {
    el.addEventListener(type, fn, opt);
    off.push(() => el.removeEventListener(type, fn, opt));
  }

  /* ---- 短編の読みこみ ---- */

  function add(list) {
    for (const p of list) pages[p.id] = p;
  }

  // 行き先の書き方：name（同じ短編のページ）、@kushami（その短編のはじめ）、@end（おわり）
  function resolve(t, sid) {
    if (!t || t === '@reset' || t.includes('.') || t === 'koujichu') return t;
    if (t === '@end') return 'owari.start';
    if (t.startsWith('@')) return t.slice(1) + '.start';
    return `${sid}.${t}`;
  }

  // 「a=1 b=2 alt」を { a: '1', b: '2', alt: true } に
  function kv(s) {
    const o = {};
    for (const tok of (s || '').trim().split(/\s+/).filter(Boolean)) {
      const at = tok.indexOf('=');
      if (at < 0) o[tok] = true;
      else o[tok.slice(0, at)] = tok.slice(at + 1);
    }
    return o;
  }
  const flagsOf = (s) => Object.fromEntries(String(s).split(',').filter(Boolean).map((f) => [f, true]));

  // 行頭の ?flag ?!flag ?+持ちもの ?-持ちもの
  function condOf(line) {
    const m = line.match(/^\?(!)?([+-])?([^\s]+)(?:\s(.*))?$/);
    if (!m) return [null, line];
    const [, neg, sign, key, rest] = m;
    const cond = sign === '+' ? { need: key } : sign === '-' ? { without: key } : neg ? { unless: key } : { if: key };
    return [cond, rest || ''];
  }

  function choiceOf(body, sid) {
    const m = body.match(/^\*\s+(.+?)\s*->\s*(\S+)\s*(?:\|\s*(.*))?$/);
    if (!m) throw new Error(`選択肢の書き方がちがいます: ${body}`);
    const o = kv(m[3]);
    const c = { text: m[1], to: resolve(m[2], sid) };
    for (const k of ['log', 'get', 'lose', 'need', 'without', 'if', 'unless', 'shape', 'fx']) if (o[k]) c[k] = o[k];
    if (o.set) c.set = flagsOf(o.set);
    if (o.unset) c.unset = String(o.unset).split(',');
    if (o.x) c.x = Number(o.x);
    if (o.y) c.y = Number(o.y);
    if (o.alt) c.alt = true;
    if (o.clear) c.vars = Object.fromEntries(String(o.clear).split(',').map((k) => [k, '']));
    return c;
  }

  function story(src) {
    const meta = {};
    const list = [];
    let cur = null;
    for (const raw of src.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (line.startsWith('//')) continue;
      if (line.startsWith('# ')) {
        cur = { id: `${meta.id}.${line.slice(2).trim()}`, text: [], choices: [], notes: [] };
        list.push(cur);
        continue;
      }
      if (!cur) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) meta[m[1]] = m[2];
        continue;
      }
      const [cond, body] = condOf(line);
      const sid = meta.id;
      if (body.startsWith('* ')) {
        cur.choices.push(Object.assign(choiceOf(body, sid), cond));
        continue;
      }
      const mm = !cond && body.match(/^(place|log|get|lose|set|unset|var|note|ui|hide\*?|decor|timer|special|dynamic|next):\s?(.*)$/);
      if (!mm) {
        cur.text.push(cond ? Object.assign({ text: body }, cond) : body);
        continue;
      }
      const [, key, val] = mm;
      if (key === 'note') cur.notes.push(val);
      else if (key === 'set') cur.set = flagsOf(val.replace(/\s+/g, ','));
      else if (key === 'unset') cur.unset = val.split(/[\s,]+/);
      else if (key === 'var') cur.vars = Object.assign(cur.vars || {}, kv(val));
      else if (key === 'ui') {
        const [type, ...rest] = val.split(/\s+/);
        const o = kv(rest.join(' '));
        if (o.steps) o.steps = String(o.steps).split(',').map(Number);
        for (const k of ['count', 'max']) if (o[k]) o[k] = Number(o[k]);
        if (o.set) o.set = flagsOf(o.set);
        if (o.emptySet) o.emptySet = flagsOf(o.emptySet);
        if (o.noneSet) o.noneSet = flagsOf(o.noneSet);
        if (o.to) o.to = resolve(o.to, sid);
        if (o.empty) o.empty = resolve(o.empty, sid);
        cur.ui = Object.assign(cur.ui || {}, o, { type });
      } else if (key === 'hide' || key === 'hide*' || key === 'decor') {
        const parts = val.split(/\s+/);
        const y = Number(parts.pop());
        const x = Number(parts.pop());
        const it = { text: parts.join(' '), x, y };
        cur.ui = cur.ui || {};
        if (key === 'decor') (cur.ui.decor = cur.ui.decor || []).push(it);
        else (cur.ui.hidden = cur.ui.hidden || []).push(Object.assign(it, { key: key === 'hide*' }));
      } else if (key === 'timer') {
        const m = val.match(/^(\d+)\s*->\s*(\S+)\s*(?:\|\s*(.*))?$/);
        const o = kv(m[3]);
        cur.timer = { sec: Number(m[1]), to: resolve(m[2], sid) };
        if (o.log) cur.timer.log = o.log;
        if (o.label) cur.timer.label = o.label;
        if (o.set) cur.timer.set = flagsOf(o.set);
      } else if (key === 'next') cur.next = resolve(val, sid);
      else cur[key] = val;
    }
    for (const p of list) {
      while (p.text[0] === '') p.text.shift();
      while (p.text[p.text.length - 1] === '') p.text.pop();
      pages[p.id] = p;
    }
    stories[meta.id] = { id: meta.id, title: meta.title, species: meta.species, rule: meta.rule, layer: Number(meta.layer || 0) };
    order.push(meta.id);
  }

  /* ---- 保存 ---- */

  function freshState() {
    return { cur: FIRST_PAGE, flags: {}, vars: {}, log: [], items: [], seen: [], route: [], story: null };
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && pages[s.cur] ? Object.assign(freshState(), s) : null;
    } catch (e) {
      return null;
    }
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (e) {
      // 保存できない環境でも、そのまま読み進められればいい
    }
  }

  /* ---- 文字 ---- */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // フラグと持ちもので、行や選択肢を出し分ける
  function visible(item) {
    if (!item || typeof item !== 'object') return true;
    if (item.if && !state.flags[item.if]) return false;
    if (item.unless && state.flags[item.unless]) return false;
    if (item.need && !state.items.includes(item.need)) return false;
    if (item.without && state.items.includes(item.without)) return false;
    return true;
  }

  // {{名前}} や {{名前|なかったときの言葉}} を、入力された文字に置きかえる
  function fill(s, escape) {
    return s.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (m, k, d) => {
      const v = state.vars[k] ? state.vars[k] : d || '';
      return escape && state.vars[k] ? esc(v) : v;
    });
  }

  // 行頭の記号。@1〜@7 文字の大きさ、< ^ > 左・中央・右、! 小石が落ちる、~ 砂がこぼれる、* ゆれる
  function lineHtml(raw, i, counter) {
    const m = raw.match(/^(?:@([1-7]))?([<^>](?![a-zA-Z/]))?([!~*]*)/);
    const body = raw.slice(m[0].length);
    if (body === '') return '<p class="ln gap"></p>';
    const fx = m[3];
    const html = body
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (x, text, to) => `<a href="#${to}" data-to="${to}">${text}</a>`)
      .replace(/※/g, () => {
        counter.n += 1;
        return `<button type="button" class="ref" data-note="${counter.n - 1}" aria-label="注釈を読む">※</button>`;
      });
    const cls = ['ln', 's' + (m[1] || 3), ALIGN[m[2]] || 'center'];
    if (fx.includes('*')) cls.push('shake');
    const drop = fx.includes('!') ? ' data-drop="stone"' : fx.includes('~') ? ' data-drop="sand"' : '';
    return `<p class="${cls.join(' ')}" style="--i:${Math.min(i, MAX_STAGGER)}"${drop}>${fill(html, true)}</p>`;
  }

  /* ---- 手ざわり ---- */

  function ripple(el, ev) {
    if (still() || !el) return;
    const r = el.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.2;
    const keyboard = !ev || (ev.clientX === 0 && ev.clientY === 0);
    const x = keyboard ? r.width / 2 : ev.clientX - r.left;
    const y = keyboard ? r.height / 2 : ev.clientY - r.top;
    const s = document.createElement('span');
    s.className = 'rip';
    s.style.cssText = `width:${d}px;height:${d}px;left:${x - d / 2}px;top:${y - d / 2}px`;
    el.appendChild(s);
    setTimeout(() => s.remove(), 700);
  }

  // カーソルが乗ると、少しだけ寄ってくる
  function magnetic(el) {
    if (!el || !fine() || still()) return;
    listen(el, 'pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2);
      const y = e.clientY - (r.top + r.height / 2);
      el.style.translate = `${x * 0.22}px ${y * 0.3}px`;
    });
    listen(el, 'pointerleave', () => {
      el.style.translate = '';
    });
  }

  // カーソルの向きに少し傾く
  function tilt(el) {
    if (!fine() || still()) return;
    listen(el, 'pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `rotateX(${-y * 8}deg) rotateY(${x * 10}deg)`;
    });
    listen(el, 'pointerleave', () => {
      el.style.transform = '';
    });
  }

  function bump(el) {
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    t.classList.remove('in');
    void t.offsetWidth;
    t.classList.add('in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, 2600);
  }

  /* ---- 選ぶ部品 ---- */

  // 選んだあと、波紋や動きが見えるくらい待ってから次へ
  function pick(c, el, ev, wait) {
    if (!c || busy) return;
    busy = true;
    stopTimer();
    if (el) ripple(el, ev);
    const ms = wait !== undefined ? wait : el ? 220 : 0;
    later(() => choose(c), still() ? 0 : ms);
  }

  function submitChips(ui, picked) {
    picked.forEach(apply);
    if (picked.length) apply({ log: (ui.log || '').replace('{n}', picked.length) });
    else apply({ log: ui.noneLog, set: ui.noneSet });
    goPage(ui.to);
  }

  // 入れた文字の数も残す。ui.lens="3,8" なら 名前_s（3文字まで）、名前_m、名前_l のフラグが立つ
  function submitInput(ui, text) {
    if (text) {
      const n = [...text].length;
      const [a, b] = String(ui.lens || '3,8').split(',').map(Number);
      state.vars[ui.name] = text;
      state.vars[ui.name + '_n'] = String(n);
      state.flags[`${ui.name}_${n <= a ? 's' : n <= b ? 'm' : 'l'}`] = true;
      apply({ log: ui.log, set: ui.set });
      goPage(ui.to);
    } else {
      apply({ log: ui.emptyLog, set: ui.emptySet });
      goPage(ui.empty || ui.to);
    }
  }

  const label = (ui) => (ui.label ? `<p class="w-label">${ui.label}</p>` : '');
  const hint = (text) => (text ? `<p class="w-hint">${text}</p>` : '');
  const goBtn = (text, disabled) =>
    `<div class="w-go"><button type="button" class="btn primary" data-go${disabled ? ' disabled' : ''}><span>${text}</span></button></div>`;

  const W = {};

  W.links = {
    html: (ui, list) =>
      '<div class="w-links">' +
      list.map((c, i) => `<a class="lnk" href="#${c.to}" data-i="${i}"><span>${c.text}</span><span class="arr" aria-hidden="true">→</span></a>`).join('') +
      '</div>',
    mount(root, ui, list) {
      $$('[data-i]', root).forEach((a) =>
        listen(a, 'click', (e) => {
          e.preventDefault();
          pick(list[+a.dataset.i], null, null, 120);
        })
      );
    },
  };

  W.buttons = {
    html: (ui, list) =>
      label(ui) +
      '<div class="w-buttons">' +
      list.map((c, i) => `<button type="button" class="btn" data-i="${i}"><span>${c.text}</span></button>`).join('') +
      '</div>',
    mount(root, ui, list) {
      $$('[data-i]', root).forEach((b) => {
        magnetic(b);
        listen(b, 'click', (e) => pick(list[+b.dataset.i], b, e));
      });
    },
  };

  // 1つ選んでから決める
  W.cards = {
    html: (ui, list) =>
      label(ui) +
      '<div class="w-cards" role="radiogroup">' +
      list
        .map((c, i) => `<button type="button" class="card" role="radio" aria-checked="false" data-i="${i}"><span class="card-dot" aria-hidden="true"></span><span>${c.text}</span></button>`)
        .join('') +
      '</div>' +
      goBtn(ui.submit || '決定', true),
    mount(root, ui, list) {
      const go = $('[data-go]', root);
      let sel = -1;
      $$('.card', root).forEach((card) => {
        tilt(card);
        listen(card, 'click', () => {
          sel = +card.dataset.i;
          $$('.card', root).forEach((x) => x.setAttribute('aria-checked', String(x === card)));
          go.disabled = false;
        });
      });
      magnetic(go);
      listen(go, 'click', (e) => sel >= 0 && pick(list[sel], go, e));
    },
  };

  // いくつでも選べる。選んだ数がボタンのバッジに出る
  W.chips = {
    html: (ui, list) =>
      label(ui) +
      '<div class="w-chips">' +
      list.map((c, i) => `<button type="button" class="chip" aria-pressed="false" data-i="${i}"><span class="tick" aria-hidden="true"></span><span>${c.text}</span></button>`).join('') +
      '</div>' +
      `<div class="w-go"><button type="button" class="btn primary" data-go><span>${ui.submit || '決定'}</span><span class="cnt" data-cnt>0</span></button></div>`,
    mount(root, ui, list) {
      const chosen = new Set();
      const cnt = $('[data-cnt]', root);
      const go = $('[data-go]', root);
      $$('.chip', root).forEach((ch) =>
        listen(ch, 'click', () => {
          const i = +ch.dataset.i;
          if (chosen.has(i)) chosen.delete(i);
          else chosen.add(i);
          ch.setAttribute('aria-pressed', String(chosen.has(i)));
          cnt.textContent = String(chosen.size);
          bump(cnt);
        })
      );
      magnetic(go);
      listen(go, 'click', (e) => {
        if (busy) return;
        busy = true;
        ripple(go, e);
        const picked = [...chosen].sort((a, b) => a - b).map((i) => list[i]);
        later(() => submitChips(ui, picked), still() ? 0 : 220);
      });
    },
  };

  W.select = {
    html: (ui, list) =>
      '<div class="w-select">' +
      label(ui) +
      '<div class="dd"><button type="button" class="dd-b" aria-haspopup="listbox" aria-expanded="false"><span class="dd-v">選んでください</span><span class="chev" aria-hidden="true"></span></button>' +
      '<ul class="dd-list" role="listbox">' +
      list.map((c, i) => `<li><button type="button" role="option" aria-selected="false" data-i="${i}">${c.text}</button></li>`).join('') +
      '</ul></div></div>' +
      goBtn(ui.submit || '決定', true),
    mount(root, ui, list) {
      const dd = $('.dd', root);
      const b = $('.dd-b', root);
      const v = $('.dd-v', root);
      const go = $('[data-go]', root);
      let sel = -1;
      const open = (on) => {
        dd.classList.toggle('open', on);
        b.setAttribute('aria-expanded', String(on));
      };
      listen(b, 'click', () => open(!dd.classList.contains('open')));
      $$('[role="option"]', root).forEach((o) =>
        listen(o, 'click', () => {
          sel = +o.dataset.i;
          v.textContent = o.textContent;
          v.classList.add('set');
          $$('[role="option"]', root).forEach((x) => x.setAttribute('aria-selected', String(x === o)));
          open(false);
          go.disabled = false;
          bump(v);
        })
      );
      listen(document, 'click', (e) => {
        if (!dd.contains(e.target)) open(false);
      });
      magnetic(go);
      listen(go, 'click', (e) => sel >= 0 && pick(list[sel], go, e));
    },
  };

  // 文字を入れる。空のまま送ると ui.empty へ
  W.input = {
    html: (ui) =>
      '<form class="w-input" novalidate>' +
      `<label class="fl"><input type="text" name="t" maxlength="${ui.max || 20}" autocomplete="off" placeholder=" "><span>${ui.label || 'ここに書く'}</span></label>` +
      '<p class="w-live" aria-live="polite"></p>' +
      `<div class="w-go"><button type="submit" class="btn primary"><span>${ui.submit || '送信'}</span></button></div></form>`,
    mount(root, ui) {
      const form = $('form', root);
      const input = $('input', root);
      const live = $('.w-live', root);
      listen(input, 'input', () => {
        const v = input.value;
        const msg = ui.live ? ui.live.replace('{n}', [...v].length) : '';
        live.textContent = v && msg ? msg : '';
        live.classList.toggle('on', Boolean(v && msg));
      });
      listen(form, 'submit', (e) => {
        e.preventDefault();
        if (busy) return;
        busy = true;
        submitInput(ui, input.value.trim());
      });
    },
  };

  // つまんで、どれかの枠へ運ぶ。枠を押すだけでもいい
  W.drag = {
    html: (ui, list) =>
      '<div class="w-drag">' +
      `<div class="dz-row" style="--cols:${list.length}">` +
      list.map((c, i) => `<button type="button" class="dz" data-i="${i}">${c.text}</button>`).join('') +
      '</div>' +
      `<div class="tok-home"><span class="tok tok-${ui.item || 'stone'}" aria-hidden="true"></span></div>` +
      hint(ui.hint || 'つまんで、運ぶ') +
      '</div>',
    mount(root, ui, list) {
      const tok = $('.tok', root);
      const zones = $$('.dz', root);
      let on = false;
      let sx = 0;
      let sy = 0;
      let over = null;
      const hit = (x, y) =>
        zones.find((z) => {
          const r = z.getBoundingClientRect();
          return x > r.left - 10 && x < r.right + 10 && y > r.top - 10 && y < r.bottom + 10;
        }) || null;
      listen(tok, 'pointerdown', (e) => {
        if (busy) return;
        on = true;
        sx = e.clientX;
        sy = e.clientY;
        tok.setPointerCapture(e.pointerId);
        tok.classList.add('held');
        e.preventDefault();
      });
      listen(tok, 'pointermove', (e) => {
        if (!on) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        tok.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 0.2}deg) scale(1.08)`;
        const z = hit(e.clientX, e.clientY);
        if (z !== over) {
          if (over) over.classList.remove('over');
          over = z;
          if (over) over.classList.add('over');
        }
      });
      const end = (e) => {
        if (!on) return;
        on = false;
        tok.classList.remove('held');
        if (!over) {
          tok.style.transform = '';
          return;
        }
        const zr = over.getBoundingClientRect();
        const hr = tok.parentElement.getBoundingClientRect();
        const dx = zr.left + zr.width / 2 - (hr.left + hr.width / 2);
        const dy = zr.top + zr.height / 2 - (hr.top + hr.height / 2);
        tok.classList.add('in');
        tok.style.transform = `translate(${dx}px, ${dy}px) scale(.4)`;
        over.classList.add('got');
        pick(list[+over.dataset.i], null, e, 340);
      };
      listen(tok, 'pointerup', end);
      listen(tok, 'pointercancel', end);
      zones.forEach((z) =>
        listen(z, 'click', (e) => {
          z.classList.add('got');
          pick(list[+z.dataset.i], z, e, 260);
        })
      );
    },
  };

  // 長く押すほど、選ぶものが変わる。ui.steps は切りかわる秒数
  W.hold = {
    html: (ui) =>
      '<div class="w-hold">' +
      '<button type="button" class="hold-b">' +
      '<svg class="ring" viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-bg" cx="60" cy="60" r="54"/><circle class="ring-fg" cx="60" cy="60" r="54" pathLength="1"/></svg>' +
      `<span class="hold-l">${ui.label}</span></button>` +
      `<p class="w-live hold-live" aria-live="polite">${ui.hint || '長押し'}</p></div>`,
    mount(root, ui, list) {
      const b = $('.hold-b', root);
      const fg = $('.ring-fg', root);
      const live = $('.hold-live', root);
      const steps = ui.steps || [1];
      const max = steps[steps.length - 1] + 1;
      let t0 = 0;
      let raf = 0;
      let on = false;
      const level = (s) => {
        let i = 0;
        while (i < steps.length && s >= steps[i]) i++;
        return Math.min(i, list.length - 1);
      };
      const tick = () => {
        const s = (performance.now() - t0) / 1000;
        const k = Math.min(1, s / max);
        fg.style.strokeDashoffset = String(1 - k);
        b.style.setProperty('--k', String(k));
        const lv = level(s);
        if (live.dataset.lv !== String(lv)) {
          live.dataset.lv = String(lv);
          live.textContent = plain(list[lv].text);
          bump(live);
        }
        raf = requestAnimationFrame(tick);
      };
      const start = (e) => {
        if (on || busy) return;
        on = true;
        t0 = performance.now();
        live.dataset.lv = '';
        b.classList.add('held');
        if (e.pointerId !== undefined) b.setPointerCapture(e.pointerId);
        tick();
      };
      const stop = () => {
        if (!on) return;
        on = false;
        cancelAnimationFrame(raf);
        b.classList.remove('held');
        const s = (performance.now() - t0) / 1000;
        if (s < 0.2) {
          fg.style.strokeDashoffset = '1';
          live.textContent = ui.hint || '長押し';
          return;
        }
        pick(list[level(s)], null, null, 240);
      };
      listen(b, 'pointerdown', (e) => {
        e.preventDefault();
        start(e);
      });
      listen(b, 'pointerup', stop);
      listen(b, 'pointercancel', stop);
      listen(b, 'contextmenu', (e) => e.preventDefault());
      listen(b, 'keydown', (e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          start(e);
        }
      });
      listen(b, 'keyup', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          stop();
        }
      });
      off.push(() => cancelAnimationFrame(raf));
    },
  };

  // カードを左右にはらう。choices の1つめが左、2つめが右
  W.swipe = {
    html: (ui, list) =>
      '<div class="w-swipe">' +
      `<button type="button" class="sw-side l" data-i="0">← ${list[0].text}</button>` +
      `<div class="sw-card" tabindex="0" aria-label="左右にはらって選ぶ">${ui.card || ''}</div>` +
      `<button type="button" class="sw-side r" data-i="1">${list[1].text} →</button>` +
      '</div>' +
      hint(ui.hint || '左右にはらう'),
    mount(root, ui, list) {
      const card = $('.sw-card', root);
      const sides = $$('.sw-side', root);
      let on = false;
      let sx = 0;
      let dx = 0;
      const fly = (dir) => {
        if (busy) return;
        card.classList.add('fly');
        card.style.transform = `translateX(${dir * 120}%) rotate(${dir * 16}deg)`;
        sides[dir < 0 ? 0 : 1].classList.add('hot');
        pick(list[dir < 0 ? 0 : 1], null, null, 300);
      };
      listen(card, 'pointerdown', (e) => {
        on = true;
        sx = e.clientX;
        dx = 0;
        card.setPointerCapture(e.pointerId);
        card.classList.add('held');
      });
      listen(card, 'pointermove', (e) => {
        if (!on) return;
        dx = e.clientX - sx;
        card.style.transform = `translateX(${dx}px) rotate(${dx * 0.06}deg)`;
        sides[0].classList.toggle('hot', dx < -30);
        sides[1].classList.toggle('hot', dx > 30);
      });
      const end = () => {
        if (!on) return;
        on = false;
        card.classList.remove('held');
        if (Math.abs(dx) > 80) fly(Math.sign(dx));
        else {
          card.style.transform = '';
          sides.forEach((s) => s.classList.remove('hot'));
        }
      };
      listen(card, 'pointerup', end);
      listen(card, 'pointercancel', end);
      listen(card, 'keydown', (e) => {
        if (e.key === 'ArrowLeft') fly(-1);
        if (e.key === 'ArrowRight') fly(1);
      });
      sides.forEach((s) => listen(s, 'click', () => fly(s.dataset.i === '1' ? 1 : -1)));
    },
  };

  // 押したまま左右にこする。ui.count 回こすると choices の1つめ
  W.rub = {
    html: (ui) =>
      '<div class="w-rub">' +
      `<div class="rub-pad" tabindex="0" role="button" aria-label="${esc(plain(ui.label))}"><span class="rub-l">${ui.label}</span><span class="rub-meter" aria-hidden="true"><i></i></span></div>` +
      hint(ui.hint || '押したまま、左右に動かす') +
      '</div>',
    mount(root, ui, list) {
      const pad = $('.rub-pad', root);
      const bar = $('.rub-meter i', root);
      const lab = $('.rub-l', root);
      const need = ui.count || 4;
      let on = false;
      let lastX = 0;
      let dir = 0;
      let run = 0;
      let n = 0;
      const count = () => {
        n += 1;
        bar.style.width = `${Math.min(100, (n / need) * 100)}%`;
        bump(lab);
        if (n >= need) {
          pad.classList.add('done');
          pick(list[0], null, null, 320);
        }
      };
      listen(pad, 'pointerdown', (e) => {
        on = true;
        lastX = e.clientX;
        dir = 0;
        run = 0;
        pad.setPointerCapture(e.pointerId);
        pad.classList.add('held');
      });
      listen(pad, 'pointermove', (e) => {
        if (!on || n >= need) return;
        const r = pad.getBoundingClientRect();
        lab.style.translate = `${Math.max(-60, Math.min(60, (e.clientX - r.left - r.width / 2) * 0.35))}px 0`;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        const d = Math.sign(dx);
        if (!d) return;
        if (d === dir) run += Math.abs(dx);
        else {
          if (run > 24) count();
          dir = d;
          run = Math.abs(dx);
        }
      });
      const end = () => {
        if (on && run > 24 && n < need) count();
        on = false;
        run = 0;
        pad.classList.remove('held');
        lab.style.translate = '';
      };
      listen(pad, 'pointerup', end);
      listen(pad, 'pointercancel', end);
      let lastKey = '';
      listen(pad, 'keydown', (e) => {
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.key !== lastKey && n < need) {
          lastKey = e.key;
          count();
        }
      });
    },
  };

  // 暗いところを、なぞって照らす。spot と field で使う
  function spotlight(box, onMove) {
    let px = 0;
    let py = 0;
    const set = (x, y) => {
      px = x;
      py = y;
      box.style.setProperty('--x', `${x}px`);
      box.style.setProperty('--y', `${y}px`);
      onMove(x, y);
    };
    const move = (e) => {
      const r = box.getBoundingClientRect();
      set(e.clientX - r.left, e.clientY - r.top);
    };
    listen(box, 'pointermove', move);
    listen(box, 'pointerdown', (e) => {
      if (e.target.closest('button')) return;
      box.setPointerCapture(e.pointerId);
      move(e);
    });
    listen(box, 'keydown', (e) => {
      const d = { ArrowLeft: [-28, 0], ArrowRight: [28, 0], ArrowUp: [0, -28], ArrowDown: [0, 28] }[e.key];
      if (!d) return;
      e.preventDefault();
      set(px + d[0], py + d[1]);
    });
    requestAnimationFrame(() => {
      const r = box.getBoundingClientRect();
      set(r.width * 0.5, r.height * 0.86);
    });
  }

  const near = (box, el, x, y, d) => {
    const r = box.getBoundingClientRect();
    const ir = el.getBoundingClientRect();
    return Math.hypot(ir.left + ir.width / 2 - r.left - x, ir.top + ir.height / 2 - r.top - y) < d;
  };

  // 暗い中をなぞってのぞく。key のついたものを見つけるとボタンが押せる
  W.spot = {
    html: (ui, list) =>
      `<div class="w-spot${ui.bg ? ' bg-' + ui.bg : ''}" tabindex="0" aria-label="${esc(ui.hint || 'なぞって見まわす')}">` +
      '<div class="spot-layer">' +
      (ui.hidden || []).map((h) => `<span class="spot-it${h.key ? ' key' : ''}" style="left:${h.x}%;top:${h.y}%">${h.text}</span>`).join('') +
      '</div><div class="spot-mask" aria-hidden="true"></div></div>' +
      hint(ui.hint || 'なぞって、見まわす') +
      goBtn(list[0].text, true),
    mount(root, ui, list) {
      const box = $('.w-spot', root);
      const go = $('[data-go]', root);
      const items = $$('.spot-it', root);
      spotlight(box, (x, y) => {
        items.forEach((it) => near(box, it, x, y, 70) && it.classList.add('found'));
        const keys = items.filter((it) => it.classList.contains('key'));
        if (keys.length && keys.every((it) => it.classList.contains('found')) && go.disabled) {
          go.disabled = false;
          bump(go);
        }
      });
      // なぞれない人のために、しばらくしたら押せるようにする
      later(() => {
        go.disabled = false;
      }, 9000);
      magnetic(go);
      listen(go, 'click', (e) => pick(list[0], go, e));
    },
  };

  // 暗い中に、行き先がいくつか隠れている。照らして見つけたものを押す
  W.field = {
    html: (ui, list) =>
      '<div class="w-field" tabindex="0">' +
      '<div class="fd-mask" aria-hidden="true"></div>' +
      list
        .map((c, i) => `<button type="button" class="fd-pt" style="left:${c.x}%;top:${c.y}%" data-i="${i}" tabindex="-1"><span class="fd-dot" aria-hidden="true"></span><span class="fd-l">${c.text}</span></button>`)
        .join('') +
      '</div>' +
      hint(ui.hint),
    mount(root, ui, list) {
      const box = $('.w-field', root);
      const pts = $$('.fd-pt', root);
      const show = (p) => {
        if (p.classList.contains('found')) return;
        p.classList.add('found');
        p.tabIndex = 0;
      };
      spotlight(box, (x, y) => pts.forEach((p) => near(box, p, x, y, 64) && show(p)));
      later(() => pts.forEach(show), 12000);
      pts.forEach((p) =>
        listen(p, 'click', () => {
          if (!p.classList.contains('found')) return;
          p.classList.add('hit');
          pick(list[+p.dataset.i], null, null, 420);
        })
      );
    },
  };

  // 場面の中に置いた点を押す。choices に x, y（%）を書く
  W.spots = {
    html: (ui, list) =>
      `<div class="w-spots" style="aspect-ratio:${ui.ratio || '16 / 9'}">` +
      (ui.decor || []).map((d) => `<span class="hs-decor" style="left:${d.x}%;top:${d.y}%">${d.text}</span>`).join('') +
      list
        .map(
          (c, i) =>
            `<button type="button" class="hs${c.shape ? ' hs-' + c.shape : ''}${c.fx ? ' fx-' + c.fx : ''}" style="left:${c.x}%;top:${c.y}%" data-i="${i}">` +
            `<span class="hs-dot" aria-hidden="true"></span><span class="hs-l">${c.text}</span></button>`
        )
        .join('') +
      '</div>' +
      hint(ui.hint),
    mount(root, ui, list) {
      $$('.hs', root).forEach((h) =>
        listen(h, 'click', () => {
          h.classList.add('hit');
          pick(list[+h.dataset.i], null, null, 300);
        })
      );
    },
  };

  // はじまりの読みこみ。99% で止まって、長押しで100%になる
  W.boot = {
    html: (ui) =>
      '<div class="w-boot">' +
      '<p class="boot-n"><span data-n>0</span><small>%</small></p>' +
      '<div class="boot-bar" aria-hidden="true"><i></i></div>' +
      `<p class="boot-live" aria-live="polite">${ui.label || '読み込み中'}</p>` +
      `<button type="button" class="hold-b boot-hold" hidden><svg class="ring" viewBox="0 0 120 120" aria-hidden="true"><circle class="ring-bg" cx="60" cy="60" r="54"/><circle class="ring-fg" cx="60" cy="60" r="54" pathLength="1"/></svg><span class="hold-l">${ui.hold || '長押し'}</span></button>` +
      '</div>',
    mount(root, ui, list) {
      const n = $('[data-n]', root);
      const bar = $('.boot-bar i', root);
      const live = $('.boot-live', root);
      const btn = $('.boot-hold', root);
      const fg = $('.ring-fg', root);
      let v = 0;
      const show = (x) => {
        n.textContent = x >= 100 ? '100' : x >= 99 ? x.toFixed(1) : String(Math.floor(x));
        bar.style.width = `${Math.min(100, x)}%`;
      };
      const step = () => {
        if (v >= 99) {
          live.textContent = ui.stuck || '';
          btn.hidden = false;
          bump(btn);
          return;
        }
        v = Math.min(99, v + (v < 30 ? 3 : v < 70 ? 1 + Math.round(Math.random() * 4) : v < 93 ? 1 : Math.random() < 0.5 ? 0 : 1));
        show(v);
        later(step, still() ? 0 : v > 90 ? 220 + Math.random() * 520 : 30 + Math.random() * 90);
      };
      later(step, still() ? 0 : 400);
      let t0 = 0;
      let raf = 0;
      let on = false;
      const need = 1.6;
      const tick = () => {
        const k = Math.min(1, (performance.now() - t0) / 1000 / need);
        fg.style.strokeDashoffset = String(1 - k);
        show(99 + k * 0.99);
        if (k >= 1) {
          on = false;
          show(100);
          document.body.classList.add('curtain');
          setTimeout(() => document.body.classList.remove('curtain'), still() ? 0 : 1400);
          pick(list[0], null, null, 700);
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      const start = (e) => {
        if (on || busy) return;
        on = true;
        t0 = performance.now();
        btn.classList.add('held');
        if (e.pointerId !== undefined) btn.setPointerCapture(e.pointerId);
        tick();
      };
      const stop = () => {
        if (!on) return;
        on = false;
        cancelAnimationFrame(raf);
        btn.classList.remove('held');
        fg.style.strokeDashoffset = '1';
        show(99);
      };
      listen(btn, 'pointerdown', (e) => {
        e.preventDefault();
        start(e);
      });
      listen(btn, 'pointerup', stop);
      listen(btn, 'pointercancel', stop);
      listen(btn, 'contextmenu', (e) => e.preventDefault());
      listen(btn, 'keydown', (e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          start(e);
        }
      });
      listen(btn, 'keyup', (e) => {
        if (e.key === ' ' || e.key === 'Enter') stop();
      });
      off.push(() => cancelAnimationFrame(raf));
    },
  };

  /* ---- 時間制限 ---- */

  function timerHtml(t, big) {
    return (
      `<div class="tm${big ? ' big' : ''}" role="timer">` +
      '<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="tm-bg" cx="22" cy="22" r="19"/><circle class="tm-fg" cx="22" cy="22" r="19" pathLength="1"/></svg>' +
      `<span class="tm-n">${t.sec}</span>` +
      (t.label ? `<span class="tm-l">${t.label}</span>` : '') +
      '</div>'
    );
  }

  // タブが裏にある間と、きろくや確認の窓を開いている間は数えない
  function startTimer(t) {
    const box = $('.tm', pageEl);
    const fg = $('.tm-fg', pageEl);
    const n = $('.tm-n', pageEl);
    const total = t.sec * 1000;
    let left = total;
    let last = performance.now();
    const loop = (now) => {
      const dt = now - last;
      last = now;
      if (!document.hidden && !paused) left -= dt;
      if (fg) fg.style.strokeDashoffset = String(1 - Math.max(0, left) / total);
      if (n) n.textContent = String(Math.max(0, Math.ceil(left / 1000)));
      if (box) box.classList.toggle('hurry', left < 4000);
      if (left <= 0) {
        timer = 0;
        if (busy) return;
        busy = true;
        apply(t);
        goPage(t.to);
        return;
      }
      timer = requestAnimationFrame(loop);
    };
    timer = requestAnimationFrame(loop);
  }

  function stopTimer() {
    if (timer) cancelAnimationFrame(timer);
    timer = 0;
  }

  /* ---- 小石と砂 ---- */

  function drops() {
    const text = $('.text', pageEl);
    $$('[data-drop]', pageEl).forEach((ln) => {
      const i = Number(ln.style.getPropertyValue('--i')) || 0;
      later(() => spawn(text, ln, ln.dataset.drop), still() ? 0 : i * STEP + 420);
    });
  }

  function spawn(text, ln, kind) {
    const tr = text.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(ln);
    const rr = range.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(ln).fontSize);
    const n = kind === 'sand' ? 10 : 1;
    for (let k = 0; k < n; k++) {
      const s = document.createElement('span');
      const size = kind === 'sand' ? 2 + Math.random() * 2 : Math.round(fs * 0.5 + Math.random() * 5);
      const x = rr.left - tr.left + rr.width * (0.25 + Math.random() * 0.5);
      const y = rr.bottom - tr.top - size;
      s.className = kind === 'sand' ? 'grain' : 'pebble';
      s.style.cssText =
        `width:${size}px;height:${size * (kind === 'sand' ? 1 : 0.8)}px;left:${x}px;top:${y}px;` +
        `--fall:${tr.height - y - size - 4}px;--roll:${(Math.random() * 2 - 1) * (kind === 'sand' ? 14 : 46)}px;` +
        `--spin:${(Math.random() * 2 - 1) * 240}deg;animation-delay:${kind === 'sand' ? Math.random() * 260 : 0}ms`;
      if (kind !== 'sand') s.innerHTML = '<i></i>';
      text.appendChild(s);
    }
  }

  /* ---- 注釈 ---- */

  function showNote(btn, text) {
    const pop = $('#pop');
    if (!pop.hidden && pop.dataset.for === btn.dataset.note) {
      hideNote();
      return;
    }
    pop.textContent = text;
    pop.dataset.for = btn.dataset.note;
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 32);
    const left = Math.max(16, Math.min(window.innerWidth - w - 16, r.left + r.width / 2 - w / 2));
    pop.style.width = `${w}px`;
    pop.style.left = `${left + window.scrollX}px`;
    pop.style.top = `${r.bottom + window.scrollY + 10}px`;
    pop.style.setProperty('--ax', `${r.left + r.width / 2 - left}px`);
    pop.classList.remove('in');
    void pop.offsetWidth;
    pop.classList.add('in');
  }

  function hideNote() {
    $('#pop').hidden = true;
  }

  /* ---- きろく ---- */

  // 50の短編を段ごとに並べて、通ってきた道だけを光らせる
  function mapHtml() {
    const rows = [];
    for (let l = 1; l <= LAYERS; l++) rows.push(order.filter((id) => stories[id].layer === l));
    const H = 14 + (LAYERS - 1) * 17 + 12;
    const pos = {};
    rows.forEach((ids, r) =>
      ids.forEach((id, i) => {
        pos[id] = [6 + (88 * (i + 0.5)) / ids.length, 12 + r * 17];
      })
    );
    const route = state.route.map((x) => x.id).filter((id) => pos[id]);
    const pts = route.map((id) => pos[id].join(',')).join(' ');
    let svg = `<svg class="map" viewBox="0 0 100 ${H}" role="img" aria-label="通ってきた道">`;
    if (route.length > 1) svg += `<polyline class="map-path" points="${pts}" pathLength="1"/>`;
    for (const id of Object.keys(pos)) {
      const [x, y] = pos[id];
      const on = route.includes(id);
      svg += `<circle class="map-dot${on ? ' on' : ''}" cx="${x}" cy="${y}" r="${on ? 2.1 : 1}"/>`;
      if (on) svg += `<text class="map-t" x="${x}" y="${y + 5.6}" text-anchor="middle">${esc(stories[id].species)}</text>`;
    }
    return svg + '</svg>';
  }

  function recordHtml(full) {
    const inRun = (id) => stories[id] && stories[id].layer >= 1 && stories[id].layer <= LAYERS;
    const met = state.route.filter((r) => inRun(r.id));
    const total = order.filter(inRun).length;
    const logs = state.log.length
      ? state.log.map((l, i) => `<li style="--i:${i}">${esc(l)}</li>`).join('')
      : '<li class="empty">まだ何も選んでいません。</li>';
    const items = state.items.length
      ? state.items.map((it) => `<span class="item">${esc(it)}</span>`).join('')
      : '<span class="none">なし</span>';
    const ways = met
      .map((r, i) => {
        const st = stories[r.id];
        const not = (r.others || []).map((o) => `<span class="way-not">${esc(o)}</span>`).join('');
        return (
          `<li style="--i:${i}"><span class="way-n">${i + 1}</span><div><p class="way-t">${esc(st.title)}<small>${esc(st.species)}</small></p>` +
          (r.exit ? `<p class="way-x">${esc(r.exit)}${not ? `<span class="way-or">選ばなかった道</span>${not}` : ''}</p>` : '') +
          '</div></li>'
        );
      })
      .join('');
    const take = full
      ? `<h2 class="rec-sub">持って帰ったきまり</h2><p class="take">${state.vars.takehome ? `${esc(state.vars.takehome)}のきまり　<small>${esc(state.vars.takerule)}</small>` : 'なし'}</p>`
      : '';
    return (
      '<div class="rec">' +
      (full ? '<h1 class="rec-h">旅のきろく</h1>' : '') +
      mapHtml() +
      `<p class="met">出会った種族　<b>${met.length}</b> / ${total}</p>` +
      (ways ? `<h2 class="rec-sub">通ってきた話</h2><ol class="ways">${ways}</ol>` : '') +
      take +
      `<h2 class="rec-sub">あなたが選んだこと</h2><ol class="tl">${logs}</ol>` +
      `<h2 class="rec-sub">持っているもの</h2><div class="items">${items}</div></div>`
    );
  }

  function openSheet() {
    const sheet = $('#sheet');
    $('.sheet-body', sheet).innerHTML = recordHtml(false);
    sheet.hidden = false;
    sheet.classList.remove('closing');
    paused = true;
    $('.sheet-panel', sheet).style.transform = '';
  }

  function closeSheet() {
    const sheet = $('#sheet');
    if (sheet.hidden) return;
    sheet.classList.add('closing');
    setTimeout(() => {
      sheet.hidden = true;
      sheet.classList.remove('closing');
      $('.sheet-panel', sheet).style.transform = '';
      paused = !$('#modal').hidden;
    }, still() ? 0 : 280);
  }

  // つまみを下へ引くと閉じる
  function sheetGrip() {
    const panel = $('#sheet .sheet-panel');
    const grip = $('#sheet .sheet-grip');
    let on = false;
    let sy = 0;
    let dy = 0;
    grip.addEventListener('pointerdown', (e) => {
      on = true;
      sy = e.clientY;
      dy = 0;
      grip.setPointerCapture(e.pointerId);
      panel.style.transition = 'none';
    });
    grip.addEventListener('pointermove', (e) => {
      if (!on) return;
      dy = Math.max(0, e.clientY - sy);
      panel.style.transform = `translateY(${dy}px)`;
    });
    const end = () => {
      if (!on) return;
      on = false;
      panel.style.transition = '';
      if (dy > 80) closeSheet();
      else panel.style.transform = '';
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  /* ---- 進行 ---- */

  function apply(effects) {
    if (!effects) return;
    if (effects.log) state.log.push(fill(effects.log, false));
    if (effects.set) Object.assign(state.flags, effects.set);
    if (effects.unset) effects.unset.forEach((f) => delete state.flags[f]);
    if (effects.vars) Object.assign(state.vars, effects.vars);
    if (effects.lose && state.items.includes(effects.lose)) {
      state.items = state.items.filter((it) => it !== effects.lose);
      toast('手ばなした：' + effects.lose);
      badge(true);
    }
    if (effects.get && !state.items.includes(effects.get)) {
      state.items.push(effects.get);
      toast('持ちものに追加：' + effects.get);
      badge(true);
    }
  }

  function badge(jump) {
    const b = $('#badge');
    if (!b) return;
    b.textContent = String(state.items.length);
    b.hidden = state.items.length === 0;
    if (jump) bump(b);
  }

  // dynamic: rules は、通ってきた種族のきまりを選択肢にする
  function currentChoices() {
    const p = pages[state.cur];
    if (p.dynamic === 'rules') {
      const list = state.route
        .map((r) => stories[r.id])
        .filter((st) => st && st.layer >= 1 && st.layer <= LAYERS)
        .map((st) => ({
          text: `${st.species}のきまり<small class="sub">${st.rule}</small>`,
          to: p.next,
          log: `${st.species}のきまりを、持って帰ることにした。`,
          vars: { takehome: st.species, takerule: st.rule },
          set: { took: true },
        }));
      list.push({ text: '何も持って帰らない', to: p.next, log: '何も持って帰らなかった。', vars: { takehome: '', takerule: '' } });
      return list;
    }
    return (p.choices || []).filter(visible);
  }

  function enter(id) {
    state.cur = id;
    const sid = id.split('.')[0];
    if (sid !== state.story) {
      state.story = sid;
      const st = stories[sid];
      if (st && st.layer >= 1 && st.layer <= LAYERS && !state.route.some((r) => r.id === sid)) state.route.push({ id: sid, exit: '', others: [] });
    }
    if (!state.seen.includes(id)) {
      state.seen.push(id);
      apply(pages[id]);
    }
    save();
  }

  function push() {
    try {
      history.pushState({ cur: state.cur }, '', '#' + state.cur);
    } catch (e) {}
  }

  // ほかの短編へ出ていくときは、選んだ道と選ばなかった道を残す
  function choose(c) {
    const from = state.cur.split('.')[0];
    const to = String(c.to).split('.')[0];
    const r = state.route[state.route.length - 1];
    if (to !== from && r && r.id === from) {
      r.exit = plain(c.text);
      r.others = currentChoices()
        .filter((x) => x !== c && String(x.to).split('.')[0] !== from)
        .map((x) => plain(x.text));
    }
    apply(c);
    goPage(c.to);
  }

  function goPage(id) {
    if (id === '@reset') {
      state = freshState();
      enter(FIRST_PAGE);
    } else if (pages[id]) {
      enter(id);
    } else {
      console.warn('ページがありません:', id);
      busy = false;
      return;
    }
    hideNote();
    const swap = () => {
      pageEl.classList.remove('leave');
      render();
      push();
      window.scrollTo(0, 0);
    };
    if (still()) swap();
    else {
      pageEl.classList.add('leave');
      setTimeout(swap, 180);
    }
  }

  function render() {
    off.forEach((f) => f());
    off = [];
    stopTimer();
    busy = false;

    const p = pages[state.cur];
    const counter = { n: 0 };
    const lines = (p.text || []).filter(visible).map((l) => (typeof l === 'string' ? l : l.text));
    const list = currentChoices();
    const main = list.filter((c) => !c.alt);
    const alt = list.filter((c) => c.alt);
    const ui = p.ui || {};
    const type = W[ui.type] ? ui.type : p.dynamic === 'rules' ? 'cards' : 'links';

    let act = '';
    if (p.timer) act += timerHtml(p.timer, !main.length);
    if (p.special === 'kiroku') act += recordHtml(true);
    if (main.length || type === 'input') act += `<div class="w" data-w>${W[type].html(ui, main)}</div>`;
    if (alt.length) {
      act += '<div class="w-alt">' + alt.map((c, i) => `<a class="alt" href="#${c.to}" data-alt="${i}">${c.text}</a>`).join('') + '</div>';
    }

    pageEl.innerHTML =
      `<article class="scene${p.special ? ' sp-' + p.special : ''}${ui.type ? ' ui-' + ui.type : ''}">` +
      `<div class="text">${lines.map((l, i) => lineHtml(l, i, counter)).join('')}</div>` +
      `<div class="act" style="--n:${Math.min(lines.length, MAX_STAGGER)}">${act}</div>` +
      '</article>';
    crumbEl.textContent = fill(p.place || '', false);
    badge(false);

    const w = $('[data-w]', pageEl);
    if (w) W[type].mount(w, ui, main);
    $$('[data-alt]', pageEl).forEach((a) =>
      listen(a, 'click', (e) => {
        e.preventDefault();
        pick(alt[+a.dataset.alt], null, null, 0);
      })
    );
    $$('a[data-to]', pageEl).forEach((a) =>
      listen(a, 'click', (e) => {
        e.preventDefault();
        if (!busy) {
          busy = true;
          goPage(a.dataset.to);
        }
      })
    );
    $$('.ref', pageEl).forEach((b) =>
      listen(b, 'click', (e) => {
        e.stopPropagation();
        showNote(b, (p.notes || [])[+b.dataset.note] || '');
      })
    );

    drops();
    if (p.timer) later(() => startTimer(p.timer), still() ? 0 : Math.min(lines.length, MAX_STAGGER) * STEP + 400);
  }

  /* ---- ためしに動かす（テスト用） ---- */

  // 今のページで、ランダムに1つ選んで進める
  debug.auto = function (rng = Math.random) {
    const p = pages[state.cur];
    const ui = p.ui || {};
    const list = currentChoices();
    const main = list.filter((c) => !c.alt);
    stopTimer();
    busy = false;
    if (ui.type === 'input') {
      submitInput(ui, rng() < 0.3 ? '' : 'テスト');
      return 'input';
    }
    if (ui.type === 'chips') {
      submitChips(ui, main.filter(() => rng() < 0.5));
      return 'chips';
    }
    if (!list.length) {
      if (p.timer) {
        apply(p.timer);
        goPage(p.timer.to);
        return 'timer';
      }
      return 'stuck';
    }
    if (p.timer && rng() < 0.2) {
      apply(p.timer);
      goPage(p.timer.to);
      return 'timer';
    }
    const c = list[Math.floor(rng() * list.length)];
    choose(c);
    return plain(c.text);
  };
  Object.defineProperty(debug, 'state', { get: () => state });
  debug.pages = pages;
  debug.stories = stories;

  /* ---- はじめに ---- */

  function boot() {
    pageEl = $('#page');
    crumbEl = $('#crumb');

    // 落ちた小石は、さわるとはねる
    pageEl.addEventListener('pointerdown', (e) => {
      const s = e.target.closest('.pebble');
      if (s) bump(s.firstElementChild);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#pop, .ref')) hideNote();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      hideNote();
      closeSheet();
    });

    $('#rec-open').addEventListener('click', openSheet);
    $$('[data-close-sheet]').forEach((b) => b.addEventListener('click', closeSheet));
    sheetGrip();

    // ブラウザの「戻る」で前のページには戻れない
    window.addEventListener('popstate', () => {
      $('#modal').hidden = false;
      paused = true;
      $('#modal-ok').focus();
    });
    $('#modal-ok').addEventListener('click', () => {
      $('#modal').hidden = true;
      paused = !$('#sheet').hidden;
      push();
    });

    const start = (data) => {
      state = data && data.cur && pages[data.cur] ? Object.assign(freshState(), data) : load();
      if (!state) {
        state = freshState();
        enter(FIRST_PAGE);
      }
      render();
      try {
        history.replaceState({ cur: state.cur }, '', '#' + state.cur);
      } catch (e) {}
    };

    const hot = window.claude && window.claude.hot;
    if (hot && hot.snapshot) hot.snapshot(() => state);
    if (hot && hot.ready) hot.ready(start);
    else start(hot && hot.data ? hot.data : {});
  }

  window.HOMEAGE = { add, story, boot, debug };
})();
