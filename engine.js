/* ページの表示と進行、さわって選ぶ部品。物語の中身は stories/ 以下に置く。 */
(function () {
  'use strict';

  const SAVE_KEY = 'homeage-save-v4';
  const FIRST_PAGE = 'kushami.start';
  const ALIGN = { '<': 'left', '^': 'center', '>': 'right' };
  const STEP = 70; // 1行ずつ出てくる間隔（ミリ秒）。style.css の --step と合わせる
  const MAX_STAGGER = 12; // これより後ろの行は、同時に出す

  const pages = {};
  let state = null;
  let timer = 0;
  let paused = false;
  let busy = false;
  let off = []; // ページを移るときに外すもの
  let toastTimer = 0;
  let pageEl = null;
  let crumbEl = null;

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  function later(fn, ms) {
    const id = setTimeout(fn, ms);
    off.push(() => clearTimeout(id));
  }
  function listen(el, type, fn, opt) {
    el.addEventListener(type, fn, opt);
    off.push(() => el.removeEventListener(type, fn, opt));
  }

  /* ---- 登録と保存 ---- */

  function add(list) {
    for (const p of list) pages[p.id] = p;
  }

  function freshState() {
    return { cur: FIRST_PAGE, flags: {}, vars: {}, log: [], items: [], seen: [] };
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

  // { if: 'flag' } / { unless: 'flag' } のついた行や選択肢を出し分ける
  function visible(item) {
    if (!item || typeof item !== 'object') return true;
    if (item.if && !state.flags[item.if]) return false;
    if (item.unless && state.flags[item.unless]) return false;
    return true;
  }

  // {{名前}} を、プレイヤーが入力した文字に置きかえる
  function fill(s, escape) {
    return s.replace(/\{\{(\w+)\}\}/g, (m, k) => (escape ? esc(state.vars[k] || '') : state.vars[k] || ''));
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
  W.radio = W.cards;

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
        later(() => {
          picked.forEach(apply);
          if (picked.length) apply({ log: (ui.log || '').replace('{n}', picked.length) });
          else apply({ log: ui.noneLog, set: ui.noneSet });
          goPage(ui.to);
        }, still() ? 0 : 220);
      });
    },
  };
  W.check = W.chips;

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
        live.textContent = input.value && ui.live ? ui.live : '';
        live.classList.toggle('on', Boolean(input.value && ui.live));
      });
      listen(form, 'submit', (e) => {
        e.preventDefault();
        if (busy) return;
        busy = true;
        const text = input.value.trim();
        if (text) {
          state.vars[ui.name] = text;
          apply({ log: ui.log, set: ui.set });
          goPage(ui.to);
        } else {
          apply({ log: ui.emptyLog, set: ui.emptySet });
          goPage(ui.empty || ui.to);
        }
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
          live.textContent = list[lv].text;
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
  W.split = W.swipe;

  // 押したまま左右にこする。ui.count 回こすると choices の1つめ
  W.rub = {
    html: (ui) =>
      '<div class="w-rub">' +
      `<div class="rub-pad" tabindex="0" role="button" aria-label="${esc(ui.label)}"><span class="rub-l">${ui.label}</span><span class="rub-meter" aria-hidden="true"><i></i></span></div>` +
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

  // 暗いところを、指やカーソルでなぞって見る。key のついたものを見つけるとボタンが押せる
  W.spot = {
    html: (ui, list) =>
      `<div class="w-spot${ui.bg ? ' bg-' + ui.bg : ''}" tabindex="0" aria-label="${esc(ui.hint || 'なぞって見まわす')}">` +
      '<div class="spot-layer">' +
      ui.hidden.map((h) => `<span class="spot-it${h.key ? ' key' : ''}" style="left:${h.x}%;top:${h.y}%">${h.text}</span>`).join('') +
      '</div><div class="spot-mask" aria-hidden="true"></div></div>' +
      hint(ui.hint || 'なぞって、見まわす') +
      goBtn(list[0].text, true),
    mount(root, ui, list) {
      const box = $('.w-spot', root);
      const go = $('[data-go]', root);
      const items = $$('.spot-it', root);
      let px = 0;
      let py = 0;
      const set = (x, y) => {
        px = x;
        py = y;
        box.style.setProperty('--x', `${x}px`);
        box.style.setProperty('--y', `${y}px`);
        const r = box.getBoundingClientRect();
        items.forEach((it) => {
          const ir = it.getBoundingClientRect();
          const cx = ir.left + ir.width / 2 - r.left;
          const cy = ir.top + ir.height / 2 - r.top;
          if (Math.hypot(cx - x, cy - y) < 70) it.classList.add('found');
        });
        const keys = items.filter((it) => it.classList.contains('key'));
        if (keys.length && keys.every((it) => it.classList.contains('found')) && go.disabled) {
          go.disabled = false;
          bump(go);
        }
      };
      const move = (e) => {
        const r = box.getBoundingClientRect();
        set(e.clientX - r.left, e.clientY - r.top);
      };
      listen(box, 'pointermove', move);
      listen(box, 'pointerdown', (e) => {
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
      // なぞれない人のために、しばらくしたら押せるようにする
      later(() => {
        go.disabled = false;
      }, 9000);
      magnetic(go);
      listen(go, 'click', (e) => pick(list[0], go, e));
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

  function recordHtml(title) {
    const logs = state.log.length
      ? state.log.map((l, i) => `<li style="--i:${i}">${esc(l)}</li>`).join('')
      : '<li class="empty">まだ何も選んでいません。</li>';
    const items = state.items.length
      ? state.items.map((it) => `<span class="item">${esc(it)}</span>`).join('')
      : '<span class="none">なし</span>';
    return (
      '<div class="rec">' +
      (title ? '<h1 class="rec-h">ここまでのきろく</h1>' : '') +
      `<ol class="tl">${logs}</ol>` +
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
    if (effects.get && !state.items.includes(effects.get)) {
      state.items.push(effects.get);
      toast('持ちものに追加：' + effects.get);
      badge(true);
    }
  }

  function badge(jump) {
    const b = $('#badge');
    b.textContent = String(state.items.length);
    b.hidden = state.items.length === 0;
    if (jump) bump(b);
  }

  function currentChoices() {
    return (pages[state.cur].choices || []).filter(visible);
  }

  function enter(id) {
    state.cur = id;
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

  function choose(c) {
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
    const type = W[ui.type] ? ui.type : 'links';

    let act = '';
    if (p.timer) act += timerHtml(p.timer, !main.length);
    if (p.special === 'kiroku') act += recordHtml(true);
    if (main.length || type === 'input') act += `<div class="w" data-w>${W[type].html(ui, main)}</div>`;
    if (alt.length) {
      act += '<div class="w-alt">' + alt.map((c, i) => `<a class="alt" href="#${c.to}" data-alt="${i}">${c.text}</a>`).join('') + '</div>';
    }

    pageEl.innerHTML =
      '<article class="scene">' +
      `<div class="text">${lines.map((l, i) => lineHtml(l, i, counter)).join('')}</div>` +
      `<div class="act" style="--n:${Math.min(lines.length, MAX_STAGGER)}">${act}</div>` +
      '</article>';
    crumbEl.textContent = p.place || '';
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

  window.HOMEAGE = { add, boot };
})();
