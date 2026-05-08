(function () {
  // ===== Preferências de origem do JSON =====
  function candidateUrls() {
    const base = document.baseURI || location.href;
    const here = base.replace(/[#?].*$/, "");
    const root = here.replace(/\/[^/]*$/, "/");

    // Prioridade: servidor mais atual
    const arr = [
      "https://app.tvufop.com.br/epg/schedule_now.json",
    ];

    return Array.from(new Set(arr));
  }

  // ===== Utilidades =====
  const pad = n => String(n).padStart(2, "0");
  const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const onlyDate = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  function extractSchedule(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.schedule)) return data.schedule;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && Array.isArray(data.programs)) return data.programs;
    throw new Error('JSON válido, porém sem campo "schedule" ou lista reconhecida.');
  }

  // ===== Fetch com timeout e corrida =====
  function fetchWithTimeout(url, ms, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  function firstFulfilled(promises) {
    return new Promise((resolve, reject) => {
      let pend = promises.length;
      let lastErr;

      for (const p of promises) {
        Promise.resolve(p).then(
          resolve,
          e => {
            lastErr = e;
            if (--pend === 0) reject(lastErr);
          }
        );
      }
    });
  }

  async function fetchScheduleStaggered(
    urls,
    onProgress,
    perUrlTimeoutMs = 2500,
    overallTimeoutMs = 7000,
    staggerMs = 220
  ) {
    onProgress?.("");

    const overallTimeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("Tempo excedido carregando a programação")), overallTimeoutMs)
    );

    const attempts = urls.map((u, i) => new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          const res = await fetchWithTimeout(u, perUrlTimeoutMs, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status} em ${u}`);

          const json = await res.json();
          const schedule = extractSchedule(json);

          resolve({ url: u, schedule });
        } catch (e) {
          reject(new Error(`${u}: ${e.message || e}`));
        }
      }, i * staggerMs);
    }));

    const winner = await firstFulfilled([overallTimeout, ...attempts]);
    onProgress?.("");
    return winner;
  }

  // ===== Loader, cache e pré-carregamento de miniaturas =====

  const THUMB_PRELOAD_LIMIT_PER_RENDER = 60;
  const THUMB_PRELOAD_CONCURRENCY = 4;
  const THUMB_FAILED_RETRY_MS = 2 * 60 * 1000;

  const thumbCache = new Map();
  const thumbQueue = [];
  const thumbQueuedKeys = new Set();

  let thumbActive = 0;

  function thumbBaseFromUrl(originalThumbUrl) {
    let base = "";

    if (originalThumbUrl) {
      const last = String(originalThumbUrl).split("/").pop() || "";
      base = (last.split("?")[0] || "").trim();

      try {
        base = decodeURIComponent(base);
      } catch {
        // mantém o nome original se não for possível decodificar
      }
    }

    return base;
  }

  function thumbCandidatesFromBase(base) {
    if (!base) return [];

    const enc = encodeURIComponent(base);

    // Prioridade mantida:
    // 1. domínio público principal
    // 2. pasta local /thumbs
    // 3. servidor app.tvufop.com.br
    return [
      `https://tvufop.com.br/thumbs/${enc}`,
      `thumbs/${enc}`,
      `https://app.tvufop.com.br/epg/${enc}`
    ];
  }

  function loadWithImgTimeout(url, ms) {
    return new Promise((resolve, reject) => {
      const img = new Image();

      const to = setTimeout(() => {
        img.onload = null;
        img.onerror = null;
        img.src = "";
        reject(new Error("timeout"));
      }, ms);

      img.onload = () => {
        clearTimeout(to);
        resolve(url);
      };

      img.onerror = () => {
        clearTimeout(to);
        reject(new Error("error"));
      };

      img.decoding = "async";
      img.loading = "eager";
      img.referrerPolicy = "no-referrer-when-downgrade";
      img.src = url;
    });
  }

  function stagedImageRace(
    urls,
    stepDelay = 160,
    perUrlTimeout = 2500,
    overallTimeout = 6000
  ) {
    const runners = urls.map((u, i) => new Promise((resolve, reject) => {
      setTimeout(() => {
        loadWithImgTimeout(u, perUrlTimeout)
          .then(resolve)
          .catch(reject);
      }, i * stepDelay);
    }));

    const kill = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("img overall timeout")), overallTimeout)
    );

    return firstFulfilled([kill, ...runners]);
  }

  function resolveThumbUrl(originalThumbUrl, opts = {}) {
    const base = thumbBaseFromUrl(originalThumbUrl);
    if (!base) return Promise.reject(new Error("thumb sem nome de arquivo"));

    const cached = thumbCache.get(base);

    if (cached) {
      if (cached.status === "loaded" && cached.url) {
        return Promise.resolve(cached.url);
      }

      if (cached.status === "pending" && cached.promise) {
        return cached.promise;
      }

      if (cached.status === "failed") {
        const failedAt = cached.failedAt || 0;
        const canRetry = Date.now() - failedAt > THUMB_FAILED_RETRY_MS;

        if (!canRetry) {
          return Promise.reject(cached.error || new Error("thumb indisponível"));
        }
      }
    }

    const candidates = thumbCandidatesFromBase(base);

    const promise = stagedImageRace(
      candidates,
      opts.stepDelay ?? 160,
      opts.perUrlTimeout ?? 2500,
      opts.overallTimeout ?? 6000
    )
      .then(url => {
        thumbCache.set(base, {
          status: "loaded",
          url,
          promise: Promise.resolve(url)
        });

        return url;
      })
      .catch(error => {
        thumbCache.set(base, {
          status: "failed",
          error,
          failedAt: Date.now()
        });

        throw error;
      });

    thumbCache.set(base, {
      status: "pending",
      promise
    });

    return promise;
  }

  function applyThumbToImg(originalThumbUrl, imgEl, title) {
    if (!imgEl) return;

    const base = thumbBaseFromUrl(originalThumbUrl);

    imgEl.alt = title || "";
    imgEl.decoding = "async";
    imgEl.loading = "eager";
    imgEl.dataset.thumbKey = base || "";

    imgEl.style.display = "none";
    imgEl.removeAttribute("src");

    if (!base) return;

    const cached = thumbCache.get(base);

    if (cached && cached.status === "loaded" && cached.url) {
      imgEl.src = cached.url;
      imgEl.style.display = "";
      return;
    }

    resolveThumbUrl(originalThumbUrl, {
      stepDelay: 120,
      perUrlTimeout: 2200,
      overallTimeout: 5200
    })
      .then(url => {
        if (imgEl.dataset.thumbKey !== base) return;

        imgEl.src = url;
        imgEl.style.display = "";
      })
      .catch(() => {
        if (imgEl.dataset.thumbKey !== base) return;

        imgEl.style.display = "none";
        imgEl.removeAttribute("src");
      });
  }

  function enqueueThumbPreload(originalThumbUrl) {
    const base = thumbBaseFromUrl(originalThumbUrl);
    if (!base) return;

    const cached = thumbCache.get(base);

    if (cached && (cached.status === "loaded" || cached.status === "pending")) {
      return;
    }

    if (thumbQueuedKeys.has(base)) return;

    thumbQueuedKeys.add(base);
    thumbQueue.push({
      base,
      thumb: originalThumbUrl
    });

    pumpThumbPreloadQueue();
  }

  function pumpThumbPreloadQueue() {
    while (thumbActive < THUMB_PRELOAD_CONCURRENCY && thumbQueue.length) {
      const item = thumbQueue.shift();
      thumbQueuedKeys.delete(item.base);

      thumbActive++;

      resolveThumbUrl(item.thumb, {
        stepDelay: 180,
        perUrlTimeout: 2300,
        overallTimeout: 6000
      })
        .catch(() => {
          // Falha silenciosa. O modal ainda poderá tentar de novo depois.
        })
        .finally(() => {
          thumbActive--;
          pumpThumbPreloadQueue();
        });
    }
  }

  function requestIdle(fn) {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(fn, { timeout: 1200 });
    } else {
      setTimeout(fn, 250);
    }
  }

  function uniqueProgramsByThumb(rows) {
    const seen = new Set();
    const out = [];

    for (const p of rows) {
      const base = thumbBaseFromUrl(p.thumb);
      if (!base || seen.has(base)) continue;

      seen.add(base);
      out.push(p);
    }

    return out;
  }

  function prioritizeRowsForThumbPreload(rows) {
    const unique = uniqueProgramsByThumb(rows);
    if (!unique.length) return [];

    const now = new Date();

    let idx = unique.findIndex(p => now >= p.start && now < p.stop);

    if (idx < 0) {
      idx = unique.findIndex(p => p.start >= now);
    }

    if (idx < 0) {
      return unique;
    }

    const next = unique.slice(idx, idx + 30);
    const previous = unique.slice(Math.max(0, idx - 8), idx);
    const beforePrevious = unique.slice(0, Math.max(0, idx - 8));
    const later = unique.slice(idx + 30);

    return [...next, ...previous, ...later, ...beforePrevious];
  }

  function scheduleThumbPreload(rows) {
    const ordered = prioritizeRowsForThumbPreload(rows)
      .slice(0, THUMB_PRELOAD_LIMIT_PER_RENDER);

    if (!ordered.length) return;

    requestIdle(() => {
      ordered.forEach(p => enqueueThumbPreload(p.thumb));
    });
  }

  function warmThumbNow(program) {
    if (!program || !program.thumb) return;

    enqueueThumbPreload(program.thumb);
    pumpThumbPreloadQueue();
  }

  // ===== UI =====
  function mount(container) {
    if (container.__wired) return;
    container.__wired = true;

    container.innerHTML =
      '<div class="tv-header"><div class="wrap toolbar">'
      +   '<div class="title">Programação</div>'
      +   '<div class="datebox">'
      +     '<button class="btn ghost" data-role="prev" title="Dia anterior" aria-label="Dia anterior">◀</button>'
      +     '<div class="date" data-role="dateLabel">—</div>'
      +     '<button class="btn ghost" data-role="next" title="Próximo dia" aria-label="Próximo dia">▶</button>'
      +   '</div>'
      +   '<div class="search"><input data-role="q" placeholder="Filtrar por título…"></div>'
      +   '<button class="btn primary" data-role="nowBtn" title="Ir para o programa em execução">Agora</button>'
      + '</div></div>'
      + '<div class="tv-main"><div class="wrap">'
      +   '<div class="status" data-role="status" style="display:none"></div>'
      +   '<div class="scroller" aria-label="Lista de programas">'
      +     '<div class="list" data-role="list" role="list"></div>'
      +     '<div class="empty" data-role="empty" hidden>Nenhuma entrada para o dia selecionado.</div>'
      +   '</div>'
      + '</div></div>'
      + '<dialog data-role="dlg"><div class="modal">'
      +   '<div class="m-row">'
      +     '<img class="m-thumb" data-role="dlgThumb" alt="" />'
      +     '<div class="m-col">'
      +       '<div class="m-title" data-role="dlgTitle">—</div>'
      +       '<div class="times" data-role="dlgTimes">—</div>'
      +       '<div class="desc" data-role="dlgDesc" style="display:none"></div>'
      +     '</div>'
      +   '</div>'
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
      dlgThumb: container.querySelector('[data-role="dlgThumb"]'),
      scroller: container.querySelector('.scroller'),
    };

    let programs = [];
    let days = [];
    let dayIndex = 0;

    // Banner silencioso: só aparece em erro
    const showStatus = (msg, { error = false } = {}) => {
      if (!error) {
        els.status.textContent = "";
        els.status.style.display = "none";
        return;
      }

      els.status.textContent = msg || "";
      els.status.style.display = msg ? "block" : "none";
    };

    function hydrate(list) {
      programs = list.map(p => {
        const start = new Date(p.start);
        const stop = new Date(p.stop);

        return {
          start,
          stop,
          title: (p.title || "").trim(),
          desc: (p.desc || "").trim(),
          rating: (p.rating || "").trim(),
          thumb: (p.thumb || "").trim(),
          duration: Number.isFinite(stop - start) ? Math.round((stop - start) / 60000) : null
        };
      }).sort((a, b) => a.start - b.start);

      const set = new Set(programs.map(p => onlyDate(p.start).toISOString()));
      days = Array.from(set).map(s => new Date(s)).sort((a, b) => a - b);

      const idxToday = indexForToday();
      dayIndex = (idxToday >= 0) ? idxToday : 0;

      renderDay();
    }

    function indexForToday() {
      if (!days.length) return -1;

      const today = onlyDate(new Date());
      const exact = days.findIndex(d => d.toISOString() === today.toISOString());

      if (exact >= 0) return exact;

      let best = 0;
      let bestDiff = Math.abs(days[0] - today);

      for (let i = 1; i < days.length; i++) {
        const diff = Math.abs(days[i] - today);

        if (diff < bestDiff) {
          best = i;
          bestDiff = diff;
        }
      }

      return best;
    }

    function renderDay() {
      if (!days.length) {
        els.list.innerHTML = "";
        els.empty.hidden = false;
        els.dateLabel.textContent = "—";
        return;
      }

      const day = days[dayIndex];
      els.dateLabel.textContent = fmtDate(day);

      const dayEnd = new Date(day);
      dayEnd.setDate(day.getDate() + 1);

      const rows = programs.filter(p => p.start >= day && p.start < dayEnd);

      renderList(rows, els.q.value.trim());

      els.prev.disabled = dayIndex <= 0;
      els.next.disabled = dayIndex >= days.length - 1;
    }

    function renderList(rows, query) {
      const list = els.list;
      list.innerHTML = "";

      const q = (query || "").toLowerCase();
      const kept = rows.filter(p => !q || p.title.toLowerCase().includes(q));

      els.empty.hidden = kept.length > 0;

      const now = new Date();
      let lastHour = -1;

      kept.forEach(p => {
        const h = p.start.getHours();

        if (h !== lastHour) {
          lastHour = h;

          const sep = document.createElement("div");
          sep.className = "hour-sep";
          sep.textContent = `${pad(h)}:00`;
          list.appendChild(sep);
        }

        const card = document.createElement("div");
        card.className = "card";
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.dataset.start = p.start.toISOString();
        card.dataset.stop = p.stop.toISOString();

        card.addEventListener("click", () => openModal(p));

        card.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openModal(p);
          }
        });

        // Aquecimento rápido: quando o usuário encosta, passa o mouse ou foca,
        // a miniatura já começa a ser carregada antes do clique definitivo.
        card.addEventListener("pointerenter", () => warmThumbNow(p), { passive: true });
        card.addEventListener("touchstart", () => warmThumbNow(p), { passive: true });
        card.addEventListener("focus", () => warmThumbNow(p));

        const when = document.createElement("div");
        when.className = "when";
        when.innerHTML = `<span class="start">${fmtTime(p.start)}</span>`;

        const info = document.createElement("div");
        info.className = "info";

        const title = document.createElement("div");
        title.className = "title";
        title.textContent = p.title || "(Sem título)";

        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${p.duration ?? "–"} min`;

        info.appendChild(title);
        info.appendChild(meta);

        card.appendChild(when);
        card.appendChild(info);

        if (now >= p.start && now < p.stop) {
          card.classList.add("now");

          const badge = document.createElement("span");
          badge.className = "badge-now";
          badge.textContent = "AGORA";

          title.appendChild(badge);
        }

        list.appendChild(card);
      });

      // Ponto principal da otimização:
      // depois que a lista é montada, começa a pré-carregar as miniaturas
      // em segundo plano, sem exibir imagens na lista.
      scheduleThumbPreload(kept);
    }

    function openModal(p) {
      // Texto primeiro, para o modal abrir imediatamente.
      els.dlgTitle.textContent = p.title || "(Sem título)";

      const rating = p.rating ? `  •  ${p.rating}` : "";
      els.dlgTimes.textContent = `${fmtTime(p.start)} – ${fmtTime(p.stop)}  •  ${p.duration ?? "–"} min${rating}`;

      if (p.desc && p.desc.trim()) {
        els.dlgDesc.textContent = p.desc.trim();
        els.dlgDesc.style.display = "block";
      } else {
        els.dlgDesc.textContent = "";
        els.dlgDesc.style.display = "none";
      }

      // Se a miniatura já tiver sido pré-carregada, aparece quase instantaneamente.
      // Se ainda não tiver, carrega usando a mesma lógica com cache.
      applyThumbToImg(p.thumb, els.dlgThumb, p.title);

      if (els.dlg.showModal) {
        els.dlg.showModal();
      } else {
        els.dlg.setAttribute("open", "");
      }
    }

    function scrollToNow() {
      const scroller = els.scroller;
      if (!scroller) return;

      const now = new Date();

      let target = els.list.querySelector(".card.now");

      if (!target) {
        const cards = [...els.list.querySelectorAll(".card")];

        const next = cards
          .map(c => ({ el: c, st: new Date(c.dataset.start) }))
          .filter(x => !isNaN(x.st))
          .sort((a, b) => a.st - b.st)
          .find(x => x.st >= now);

        if (next) target = next.el;
      }

      if (!target) target = els.list.querySelector(".card:last-of-type");
      if (!target) return;

      const y =
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        8;

      scroller.scrollTo({
        top: y,
        behavior: "smooth"
      });

      target.focus({
        preventScroll: true
      });
    }

    function tickNow() {
      const now = new Date();

      els.list.querySelectorAll(".card").forEach(card => {
        const st = new Date(card.dataset.start);
        const en = new Date(card.dataset.stop);

        const isNow = now >= st && now < en;
        const wasNow = card.classList.contains("now");

        if (isNow && !wasNow) {
          card.classList.add("now");

          const t = card.querySelector(".title");

          if (t && !t.querySelector(".badge-now")) {
            const b = document.createElement("span");
            b.className = "badge-now";
            b.textContent = "AGORA";
            t.appendChild(b);
          }
        } else if (!isNow && wasNow) {
          card.classList.remove("now");

          const b = card.querySelector(".badge-now");
          if (b) b.remove();
        }
      });
    }

    // ===== Controles =====

    els.prev.addEventListener("click", () => {
      if (dayIndex > 0) {
        dayIndex--;
        renderDay();
      }
    });

    els.next.addEventListener("click", () => {
      if (dayIndex < days.length - 1) {
        dayIndex++;
        renderDay();
      }
    });

    els.q.addEventListener("input", () => {
      renderDay();
    });

    els.nowBtn.addEventListener("click", () => {
      const idx = indexForToday();

      if (idx >= 0) {
        dayIndex = idx;
        renderDay();
        requestAnimationFrame(() => scrollToNow());
      }
    });

    els.dlg.addEventListener("click", e => {
      if (e.target === els.dlg) els.dlg.close();
    });

    (async function init() {
      try {
        const { url, schedule } = await fetchScheduleStaggered(candidateUrls(), showStatus);

        hydrate(schedule);

        console.info("EPG de:", url);
        showStatus("");

        // Remove o banner do DOM para nunca mais aparecer depois do sucesso.
        if (els.status && els.status.parentNode) {
          els.status.parentNode.removeChild(els.status);
        }
      } catch (e) {
        console.error(e);
        showStatus(`Falha ao carregar a programação. ${e.message || e}`, { error: true });
      }

      clearInterval(container.__tick);
      container.__tick = setInterval(tickNow, 60 * 1000);
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      const host = document.getElementById("tvufop-epg");
      if (host) mount(host);
    });
  } else {
    const host = document.getElementById("tvufop-epg");
    if (host) mount(host);
  }
})();
