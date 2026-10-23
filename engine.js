/* ページの表示と進行。物語の中身は stories/ 以下に置く。 */
(function () {
  'use strict';

  const SAVE_KEY = 'homeage-save-v3';
  const FIRST_PAGE = 'kushami.start';
  const ALIGN = { '<': 'left', '^': 'center', '>': 'right' };

  const pages = {};
  let state = null;
  let timer = null;
  let pageEl = null;
  let crumbEl = null;

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

  // 行頭の @1〜@7 で文字の大きさ、< ^ > で左・中央・右。何もなければ @3 の中央
  function lineHtml(raw, counter) {
    const m = raw.match(/^(?:@([1-7]))?([<^>])?/);
    const body = raw.slice(m[0].length);
    if (body === '') return '<p class="ln gap"></p>';
    const html = body
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (x, text, to) => `<a href="#${to}" data-to="${to}">${text}</a>`)
      .replace(/※/g, () => {
        counter.n += 1;
        return `<a class="ref" href="#note-${counter.n}" data-note="${counter.n}">※${counter.n}</a>`;
      });
    return `<p class="ln s${m[1] || 3} ${ALIGN[m[2]] || 'center'}">${fill(html, true)}</p>`;
  }

  function currentChoices() {
    return (pages[state.cur].choices || []).filter(visible);
  }

  // 選択肢の出し方。ui.type がなければリンクの一覧
  function uiHtml(p) {
    const ui = p.ui || {};
    const list = currentChoices();
    const label = ui.label ? `<span class="ui-label">${ui.label}</span>` : '';
    const item = (c, i, tag) => `<${tag} href="#${c.to}" data-choice="${i}">${c.text}</${tag}>`;

    switch (ui.type) {
      case 'buttons':
        return `<div class="ui ui-buttons">${list.map((c, i) => `<button type="button" data-choice="${i}">${c.text}</button>`).join('')}</div>`;
      case 'split':
        return `<div class="ui ui-split">${list.map((c, i) => item(c, i, 'a')).join('')}</div>`;
      case 'select':
        return (
          `<form class="ui ui-select" data-ui="1">${label}<select name="c" aria-label="${esc(ui.label || '選択')}">` +
          '<option value="">選んでください</option>' +
          list.map((c, i) => `<option value="${i}">${c.text}</option>`).join('') +
          `</select> <button type="submit">${ui.submit || '決定'}</button>` +
          '<p class="ui-err" hidden>選んでください。</p></form>'
        );
      case 'radio':
      case 'check': {
        const kind = ui.type === 'radio' ? 'radio' : 'checkbox';
        return (
          `<form class="ui ui-${ui.type}" data-ui="1"><fieldset>${ui.label ? `<legend>${ui.label}</legend>` : ''}` +
          list.map((c, i) => `<label><input type="${kind}" name="c" value="${i}">${c.text}</label>`).join('') +
          `</fieldset><div><button type="submit">${ui.submit || '送信'}</button></div>` +
          '<p class="ui-err" hidden>どれか1つを選んでください。</p></form>'
        );
      }
      case 'input':
        return (
          `<form class="ui ui-input" data-ui="1">${label}` +
          `<input type="text" name="t" maxlength="${ui.max || 20}" autocomplete="off" aria-label="${esc(ui.label || '入力')}" placeholder="${esc(ui.placeholder || '')}">` +
          ` <button type="submit">${ui.submit || '送信'}</button></form>`
        );
      default:
        return list.length ? `<ul class="ui ui-links">${list.map((c, i) => `<li>${item(c, i, 'a')}</li>`).join('')}</ul>` : '';
    }
  }

  function apply(effects) {
    if (!effects) return;
    if (effects.log) state.log.push(fill(effects.log, false));
    if (effects.get && !state.items.includes(effects.get)) state.items.push(effects.get);
    if (effects.set) Object.assign(state.flags, effects.set);
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

  function go(id) {
    if (id === '@reset') {
      state = freshState();
      enter(FIRST_PAGE);
    } else if (pages[id]) {
      enter(id);
    } else {
      console.warn('ページがありません:', id);
      return;
    }
    render();
    push();
    window.scrollTo(0, 0);
  }

  function choose(c) {
    if (!c) return;
    apply(c);
    go(c.to);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // 「このページは○秒後に自動的に移動します」。タブが裏にある間は数えない
  function startTimer(t) {
    let left = t.sec;
    timer = setInterval(() => {
      if (document.hidden) return;
      left -= 1;
      const el = pageEl.querySelector('.redirect .sec');
      if (el) el.textContent = String(left);
      if (left <= 0) {
        stopTimer();
        apply(t);
        go(t.to);
      }
    }, 1000);
  }

  function kirokuHtml() {
    const logs = state.log.length
      ? state.log.map((l) => `<li>${esc(l)}</li>`).join('')
      : '<li>まだ何も記録されていません。</li>';
    const items = state.items.length ? state.items.map((i) => `<li>${esc(i)}</li>`).join('') : '<li>なし</li>';
    return (
      '<div class="kiroku"><h1>ここまでのきろく</h1>' +
      `<h2>したこと</h2><ol>${logs}</ol>` +
      `<h2>持っているもの</h2><ul>${items}</ul></div>`
    );
  }

  function render() {
    stopTimer();
    const p = pages[state.cur];
    const counter = { n: 0 };
    let html = '';

    if (p.special === 'kiroku') html += kirokuHtml();
    if (p.text) {
      html += '<div class="text">' + p.text.filter(visible).map((l) => lineHtml(typeof l === 'string' ? l : l.text, counter)).join('') + '</div>';
    }
    html += uiHtml(p);
    if (p.timer) {
      html += `<p class="redirect" role="status">このページは <span class="sec">${p.timer.sec}</span> 秒後に自動的に移動します。</p>`;
    }
    if (p.notes && p.notes.length) {
      html +=
        '<aside class="notes"><ol>' +
        p.notes.map((n, i) => `<li id="note-${i + 1}"><span class="mark">※${i + 1}</span>${n}</li>`).join('') +
        '</ol></aside>';
    }

    pageEl.innerHTML = html;
    crumbEl.textContent = p.place || '';
    if (p.timer) startTimer(p.timer);
  }

  // ブラウザの「戻る」で前のページには戻れない
  function renderExpired() {
    stopTimer();
    crumbEl.textContent = 'エラー';
    pageEl.innerHTML =
      '<div class="text"><p class="ln s4 center"><b>このページの有効期限は切れています。</b></p><p class="ln gap"></p>' +
      '<p class="ln s3 center">前のページには戻れません。</p>' +
      '<p class="ln s3 center">おそれいりますが、下のリンクから表示中のページへお進みください。</p></div>' +
      `<ul class="ui ui-links"><li><a href="#${state.cur}" data-back="1">表示中のページへ</a></li></ul>`;
  }

  function onClick(e) {
    const a = e.target.closest('a, button');
    if (!a || !pageEl.contains(a)) return;
    const d = a.dataset;

    if (d.note) {
      e.preventDefault();
      const note = document.getElementById('note-' + d.note);
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (note) note.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    } else if (d.back) {
      e.preventDefault();
      render();
      push();
    } else if (d.choice !== undefined) {
      e.preventDefault();
      choose(currentChoices()[Number(d.choice)]);
    } else if (d.to) {
      e.preventDefault();
      go(d.to);
    }
  }

  function onSubmit(e) {
    const form = e.target.closest('form[data-ui]');
    if (!form) return;
    e.preventDefault();
    const ui = pages[state.cur].ui;
    const list = currentChoices();
    const err = form.querySelector('.ui-err');

    if (ui.type === 'select' || ui.type === 'radio') {
      const el = form.querySelector(ui.type === 'select' ? 'select' : 'input:checked');
      if (!el || el.value === '') {
        if (err) err.hidden = false;
        return;
      }
      choose(list[Number(el.value)]);
    } else if (ui.type === 'check') {
      const picked = [...form.querySelectorAll('input:checked')].map((x) => list[Number(x.value)]);
      picked.forEach(apply);
      if (picked.length) apply({ log: (ui.log || '').replace('{n}', picked.length) });
      else apply({ log: ui.noneLog, set: ui.noneSet });
      go(ui.to);
    } else if (ui.type === 'input') {
      const text = form.querySelector('input').value.trim();
      if (text) {
        state.vars[ui.name] = text;
        apply({ log: ui.log, set: ui.set });
        go(ui.to);
      } else {
        apply({ log: ui.emptyLog, set: ui.emptySet });
        go(ui.empty || ui.to);
      }
    }
  }

  function boot() {
    pageEl = document.getElementById('page');
    crumbEl = document.getElementById('crumb');
    pageEl.addEventListener('click', onClick);
    pageEl.addEventListener('submit', onSubmit);
    pageEl.addEventListener('change', () => {
      const err = pageEl.querySelector('.ui-err');
      if (err) err.hidden = true;
    });
    window.addEventListener('popstate', renderExpired);

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
