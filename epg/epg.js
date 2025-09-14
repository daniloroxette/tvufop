(function () {
  // Candidatos de caminho (todos no mesmo domínio, sem mixed content)
  const CANDIDATE_URLS = (() => {
    const base = document.baseURI || location.href;
    const here = base.replace(/[#?].*$/, '');
    const root = here.replace(/\/[^/]*$/, '/');          // .../tvufop/
    return [
      'epg/schedule_now.json',                           // relativo
      root + 'epg/schedule_now.json',                    // absoluto no repo
      '/tvufop/epg/schedule_now.json'                    // caminho fixo
    ];
  })();

  const pad = n => String(n).padStart(2, '0');
  const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtDate = d => `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  const onlyDate = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  function extractSchedule(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.schedule)) return data.schedule;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && Array.isArray(data.programs)) return data.programs;
    throw new Error('JSON válido, porém sem campo "schedule" (ou lista reconhecida).');
  }

  async function tryFetch(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    let json;
    try { json = await res.json(); }
    catch { throw new Error(`Falha ao interpretar JSON (${url})`); }
    const schedule = extractSchedule(json);
    if (!Array.isArray(schedule)) throw new Error('Estrutura inesperada do JSON.');
    return { url, schedule };
  }

  async function fetchFirstOk(urls, onProgress) {
    let lastErr = null;
    for (const u of urls) {
      try {
        onProgress?.(`Carregando: ${u}`);
        const ok = await tryFetch(u);
        onProgress?.('');
        return ok;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Nenhum caminho funcionou.');
  }

  function mount(container) {
    if (container.__wired) return; container.__wired = true;

    container.innerHTML =
      '<div class="tv-header"><div class="wrap toolbar">'
      +   '<div class="title">TV UFOP — Programação</div>'
      +   '<div class="datebox">'
      +     '<button class="btn ghost" data-role="prev" title="Dia anterior" aria-label="Dia anterior">◀</button>'
      +     '<div class="date" data-role="dateLabel">—</div>'
      +     '<button class="btn ghost" data-role="next" title="Próximo dia" aria-label="Próximo dia">▶</button>'
      +   '</div>'
      +   '<div class="search"><input data-role="q" placeholder="Filtrar por título…"></div>'
      +   '<button class="btn primary" data-role="nowBtn" title="Ir para o programa em execução">Agora</button>'
      + '</div></div>'
      + '<div class="tv-main"><div class="wrap">'
      +   '<div class="status" data-role="status"></div>'
      +   '<div class="scroller" aria-label="Lista de programas">'
      +     '<div class="list" data-role="list" role="list"></div>'
      +     '<div class="empty" data-role="empty" hidden>Nenhuma entrada para o dia selecionado.</div>'
      +   '</div>'
      + '</div></div>'
      + '<dialog data-role="dlg"><div class="modal">'
      +   '<div class="m-title" data-role="dlgTitle">—</div>'
      +   '<div class="times" data-role="dlgTimes">—</div>'
      +   '<div class="desc" data-role="dlgDesc" style="display:none"></div>'
      + '</div></dialog>';

    const els = {
      list: container.querySelector('[data-role="list"]'),
      empty: container.querySelector('[data-role="empty"]'),
      dateLabel: container.querySelector('[data-role="dateLabel"]'),
      prev: container.querySelector('[data-role="prev"]'),
      next: container.querySelector('[data-role="next"]'),
      q: container.querySelector('[data-role="q"]'),
      nowBtn: container.querySelector('[data-role="nowBtn"]'),
      status: container.querySelector('[data-role="status"]'),
      dlg: container.querySelector('[data-role="dlg"]'),
      dlgTitle: container.querySelector('[data-role="dlgTitle"]'),
      dlgTimes: container.querySelector('[data-role="dlgTimes"]'),
      dlgDesc: container.querySelector('[data-role="dlgDesc"]'),
      scroller: container.querySelector('.scroller')
    };

    let programs = [];
    let days = [];
    let dayIndex = 0;

    const showStatus = (msg) => {
      els.status.textContent = msg || '';
      els.status.style.display = msg ? 'block' : 'none';
    };

    function hydrate(list) {
      programs = list.map(p => {
        const start = new Date(p.start);
        const stop  = new Date(p.stop);
        return {
          start, stop,
          title: (p.title || '').trim(),
          desc:  (p.desc  || '').trim(),
          duration: Number.isFinite(stop - start) ? Math.round((stop - start)/60000) : null
        };
      }).sort((a,b) => a.start - b.start);

      const set = new Set(programs.map(p => onlyDate(p.start).toISOString()));
      days = Array.from(set).map(s => new Date(s)).sort((a,b) => a - b);

      // Seleciona hoje se existir; caso contrário, o primeiro
      const idxToday = indexForToday();
      dayIndex = (idxToday >= 0) ? idxToday : 0;

      renderDay();
    }

    function indexForToday() {
      if (!days.length) return -1;
      const today = onlyDate(new Date());
      const exact = days.findIndex(d => d.toISOString() === today.toISOString());
      if (exact >= 0) return exact;

      // Se não houver hoje, escolhe o dia mais próximo
      let best = 0, bestDiff = Math.abs(days[0] - today);
      for (let i = 1; i < days.length; i++) {
        const diff = Math.abs(days[i] - today);
        if (diff < bestDiff) { best = i; bestDiff = diff; }
      }
      return best;
    }

    function renderDay() {
      if (!days.length) {
        els.list.innerHTML = '';
        els.empty.hidden = false;
        els.dateLabel.textContent = '—';
        return;
      }
      const day = days[dayIndex];
      els.dateLabel.textContent = fmtDate(day);
      const dayEnd = new Date(day); dayEnd.setDate(day.getDate() + 1);

      const rows = programs.filter(p => p.start >= day && p.start < dayEnd);
      renderList(rows, els.q.value.trim());

      els.prev.disabled = dayIndex <= 0;
      els.next.disabled = dayIndex >= days.length - 1;
      // Agora permanece sempre habilitado; ele leva de volta para hoje quando clicado.
    }

    function renderList(rows, query) {
      const list = els.list;
      list.innerHTML = '';
      const q = (query || '').toLowerCase();

      const kept = rows.filter(p => !q || p.title.toLowerCase().includes(q));
      els.empty.hidden = kept.length > 0;

      const now = new Date();
      let lastHour = -1;

      kept.forEach(p => {
        const h = p.start.getHours();
        if (h !== lastHour) {
          lastHour = h;
          const sep = document.createElement('div');
          sep.className = 'hour-sep';
          sep.textContent = `${pad(h)}:00`;
          list.appendChild(sep);
        }

        const card = document.createElement('div');
        card.className = 'card';
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.dataset.start = p.start.toISOString();
        card.dataset.stop = p.stop.toISOString();

        card.addEventListener('click', () => openModal(p));
        card.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(p); }
        });

        const when = document.createElement('div');
        when.className = 'when';
        when.innerHTML = `<span class="start">${fmtTime(p.start)}</span>`;

        const info = document.createElement('div');
        info.className = 'info';
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = p.title || '(Sem título)';
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${p.duration ?? '–'} min`;

        info.appendChild(title);
        info.appendChild(meta);

        card.appendChild(when);
        card.appendChild(info);

        if (now >= p.start && now < p.stop) {
          card.classList.add('now');
          const badge = document.createElement('span');
          badge.className = 'badge-now';
          badge.textContent = 'AGORA';
          title.appendChild(badge);
        }

        list.appendChild(card);
      });
    }

    function openModal(p) {
      const startS = fmtTime(p.start);
      const stopS  = fmtTime(p.stop);
      els.dlgTitle.textContent = p.title || '(Sem título)';
      els.dlgTimes.textContent  = `${startS} – ${stopS}  •  ${p.duration ?? '–'} min`;

      if (p.desc && p.desc.trim()) {
        els.dlgDesc.textContent = p.desc.trim();
        els.dlgDesc.style.display = 'block';
      } else {
        els.dlgDesc.textContent = '';
        els.dlgDesc.style.display = 'none';
      }

      if (els.dlg.showModal) els.dlg.showModal(); else els.dlg.setAttribute('open','');
    }

    // Rolagem suave até o programa "de agora"
    function scrollToNow() {
      const scroller = els.scroller;
      if (!scroller) return;
      const now = new Date();

      // 1) Prioriza cartão com .now
      let target = els.list.querySelector('.card.now');

      // 2) Se não houver, pega o próximo a iniciar (>= agora)
      if (!target) {
        const cards = [...els.list.querySelectorAll('.card')];
        const next = cards
          .map(c => ({ el: c, st: new Date(c.dataset.start) }))
          .filter(x => !isNaN(x.st))
          .sort((a,b) => a.st - b.st)
          .find(x => x.st >= now);
        if (next) target = next.el;
      }

      // 3) Se ainda não houver (fim do dia), usa o último do dia
      if (!target) target = els.list.querySelector('.card:last-of-type');
      if (!target) return;

      const y = target.getBoundingClientRect().top
              - scroller.getBoundingClientRect().top
              + scroller.scrollTop - 8;
      scroller.scrollTo({ top: y, behavior: 'smooth' });
      target.focus({ preventScroll: true });
    }

    // Destaque "AGORA" a cada minuto
    function tickNow() {
      const now = new Date();
      const cards = els.list.querySelectorAll('.card');
      cards.forEach(card => {
        const st = new Date(card.dataset.start);
        const en = new Date(card.dataset.stop);
        const isNow = now >= st && now < en;
        const wasNow = card.classList.contains('now');

        if (isNow && !wasNow) {
          card.classList.add('now');
          const t = card.querySelector('.title');
          if (t && !t.querySelector('.badge-now')) {
            const b = document.createElement('span');
            b.className = 'badge-now';
            b.textContent = 'AGORA';
            t.appendChild(b);
          }
        } else if (!isNow && wasNow) {
          card.classList.remove('now');
          const b2 = card.querySelector('.badge-now'); if (b2) b2.remove();
        }
      });
    }

    // Eventos
    els.prev.addEventListener('click', () => { if (dayIndex > 0) { dayIndex--; renderDay(); } });
    els.next.addEventListener('click', () => { if (dayIndex < days.length - 1) { dayIndex++; renderDay(); } });
    els.q.addEventListener('input',  () => { renderDay(); });

    // "Agora": volta para hoje (ou dia mais próximo) e rola até o programa em execução
    els.nowBtn.addEventListener('click', () => {
      const idx = indexForToday();
      if (idx >= 0) {
        dayIndex = idx;
        renderDay();
        // Aguarda layout preencher para rolar com precisão
        requestAnimationFrame(() => scrollToNow());
      }
    });

    els.dlg.addEventListener('click', (e) => { if (e.target === els.dlg) els.dlg.close(); });

    async function init() {
      try {
        const { url, schedule } = await fetchFirstOk(CANDIDATE_URLS, showStatus);
        hydrate(schedule);
        console.info('EPG carregado de:', url);
        showStatus('');
      } catch (e) {
        console.error(e);
        showStatus(`Falha ao carregar a programação. ${e.message || e}`);
      }
      clearInterval(container.__tick);
      container.__tick = setInterval(tickNow, 60 * 1000);
    }

    init();
  }

  function ready(fn) {
    (document.readyState === 'loading')
      ? document.addEventListener('DOMContentLoaded', fn)
      : fn();
  }
  ready(() => {
    const host = document.getElementById('tvufop-epg');
    if (host) mount(host);
  });
})();
