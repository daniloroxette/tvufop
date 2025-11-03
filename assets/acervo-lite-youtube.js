(function(){
  "use strict";

  /* ========= AJUSTE AQUI ========= */
  const IFRAME_OVERSCAN_PX = 0; // ex.: 30px (use 0 para desligar)
  // URLs possíveis do arquivo de correspondência "corres" (ID|arquivo.jpg) no GitHub:
  const CORRES_URLS = [
    "https://raw.githubusercontent.com/daniloroxette/tvufop/main/acervo/corres",
    "https://raw.githubusercontent.com/daniloroxette/tvufop/refs/heads/main/acervo/corres"
  ];
  // Base RAW das imagens (onde estão 001.jpg, 002.jpg, ...):
  const GH_RAW_BASE = "https://raw.githubusercontent.com/daniloroxette/tvufop/main/acervo/";

  /* ================== CSS (base da lib + overrides robustos) ================== */
  var CSS = `
  /* Base essencial (skin + 16:9) */
  lite-youtube{
    background-color:#000; position:relative; display:block; contain:content;
    background-position:center center; background-size:cover; cursor:pointer;
  }
  lite-youtube::before{
    content:attr(data-title); position:absolute; left:0; right:0; top:0;
    background-image:linear-gradient(180deg, rgb(0 0 0 / 67%) 0%,
                                            rgb(0 0 0 / 54%) 14%,
                                            rgb(0 0 0 / 15%) 54%,
                                            rgb(0 0 0 / 5%) 72%,
                                            rgb(0 0 0 / 0%) 94%);
    height:99px; color:#eee; text-shadow:0 0 2px rgba(0,0,0,.5);
    font: 18px/1 "YouTube Noto",Roboto,Arial,Helvetica,sans-serif;
    padding:25px 20px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
    box-sizing:border-box;
  }
  lite-youtube:hover::before{ color:#fff; }
  /* 16:9 por fallback; quando houver aspect-ratio, ele prevalece abaixo */
  lite-youtube::after{ content:""; display:block; padding-bottom:56.25%; }
  lite-youtube > iframe{ position:absolute; inset:0; width:100%; height:100%; border:0; }
  lite-youtube > .lty-playbtn{
    position:absolute; inset:0; z-index:1; border:0;
    background:no-repeat center/68px 48px;
    background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="red"/><path d="M45 24 27 14v20" fill="white"/></svg>');
    filter:grayscale(100%); transition:filter .1s cubic-bezier(0,0,0.2,1);
  }
  lite-youtube:hover > .lty-playbtn, lite-youtube .lty-playbtn:focus{ filter:none; }
  lite-youtube.lyt-activated{ cursor:unset; }
  lite-youtube.lyt-activated::before, lite-youtube.lyt-activated > .lty-playbtn{ opacity:0; pointer-events:none; }
  /* OCULTA A11Y LABEL MESMO SE O TEMA TENTAR REEXIBIR */
  .lyt-visually-hidden{
    position:absolute !important; width:1px !important; height:1px !important;
    padding:0 !important; margin:-1px !important; overflow:hidden !important;
    clip:rect(0,0,0,0) !important; clip-path:inset(50%) !important;
    white-space:nowrap !important; border:0 !important;
  }

  /* Tenta bordas arredondadas */
  lite-youtube { border-radius: 16px !important; }

  /* Overrides: largura 100% da célula, sem limite superior, proporção estável */
  lite-youtube{
    width:100% !important;
    max-width:none !important;                     /* NADA de teto fixo */
    aspect-ratio:var(--lty-ratio, 16/9);           /* razão vinda do <iframe> original */
    background-position:center !important;
    background-size:cover !important;
    background-repeat:no-repeat !important;
    overflow:hidden !important;                    /* recorta qualquer sobra */
  }
  @supports not (aspect-ratio:1/1){
    lite-youtube::after{ padding-bottom:56.25% !important; }
  }
  /* Faixa adaptativa em blocos baixos/estreitos */
  lite-youtube::before{
    height:min(99px,35%) !important;
    background-image:linear-gradient(180deg, rgba(0,0,0,.45) 0%, rgba(0,0,0,0) 70%) !important;
    pointer-events:none;
  }
  /* Botão proporcional ao tamanho do bloco */
  lite-youtube > .lty-playbtn{
    background-size:clamp(28px, 38%, 68px) auto !important;
    background-position:50% 50% !important;
  }
  /* Fallback caso algum CSS mate o background-image */
  lite-youtube > .lty-fallback-img{
    position:absolute; inset:0; width:100%; height:100%;
    object-fit:cover; pointer-events:none; z-index:0; display:block !important;
  }

  /* Wrappers <p> do Drupal não atrapalham layout */
  p > lite-youtube{ display:block; }
  p:has(> lite-youtube){ margin:0 !important; line-height:0 !important; }

  /* =================== OVERSCAN do <iframe> (parametrizado) =================== */
  lite-youtube > iframe{
    left: -${IFRAME_OVERSCAN_PX}px !important;
    width: calc(100% + ${IFRAME_OVERSCAN_PX * 2}px) !important;
  }

  /* Ao ativar, mate qualquer background de thumb por CSS também */
  lite-youtube.lyt-activated{
    background-image: none !important;
  }
  `;

  function injectCSS(){
    var s=document.createElement('style'); s.textContent=CSS; document.head.appendChild(s);
  }

  /* ================== Utilitários ================== */

  // cache do mapeamento e das checagens de imagem
  var __CORRES_PROMISE = null;
  var __IMG_OK_CACHE = new Map(); // url -> true/false

  function fetchText(url){
    return fetch(url, { cache: "no-store" }).then(function(r){
      if(!r.ok) throw new Error("HTTP "+r.status);
      return r.text();
    });
  }

  function fetchFirst(urls){
    var list = urls.slice();
    function next(){
      if(!list.length) return Promise.reject(new Error("Nenhuma URL de corres funcionou"));
      var u = list.shift();
      return fetchText(u).then(function(txt){ return { url:u, text:txt }; }).catch(next);
    }
    return next();
  }

  function parseCorres(text){
    var map = new Map();
    text.split(/\r?\n/).forEach(function(line){
      line = (line||"").trim();
      if(!line || line.startsWith("#")) return;
      var parts = line.split("|");
      if(parts.length >= 2){
        var id = (parts[0]||"").trim();
        var fname = (parts[1]||"").trim();
        if(id && fname) map.set(id, fname);
      }
    });
    return map;
  }

  function getCorresMap(){
    if(__CORRES_PROMISE) return __CORRES_PROMISE;
    __CORRES_PROMISE = fetchFirst(CORRES_URLS)
      .then(function(res){ return parseCorres(res.text); })
      .catch(function(){ return new Map(); }); // em falha, devolve mapa vazio
    return __CORRES_PROMISE;
  }

  // checa se uma imagem realmente carrega
  function checkImage(url){
    if(__IMG_OK_CACHE.has(url)) return Promise.resolve(__IMG_OK_CACHE.get(url));
    return new Promise(function(resolve){
      var img = new Image();
      // Para GitHub RAW, referrerPolicy é irrelevante, mas não atrapalha:
      img.referrerPolicy = "origin";
      img.onload = function(){ __IMG_OK_CACHE.set(url, true); resolve(true); };
      img.onerror = function(){ __IMG_OK_CACHE.set(url, false); resolve(false); };
      img.src = url;
    });
  }

  // seleciona poster do YouTube (fallback) evitando 120x90
  function pickPosterFromYouTube(id, cb){
    var urls = [
      "https://i.ytimg.com/vi_webp/"+id+"/sddefault.webp",
      "https://i.ytimg.com/vi/"+id+"/maxresdefault.jpg",
      "https://i.ytimg.com/vi/"+id+"/hqdefault.jpg"
    ];
    (function next(){
      if(!urls.length) return cb(null);
      var u = urls.shift(), img = new Image();
      img.referrerPolicy = "origin";
      img.onload = function(){
        if (img.naturalWidth===120 && img.naturalHeight===90) return next();
        cb(u);
      };
      img.onerror = next;
      img.src = u;
    })();
  }

  // resolve a URL final da thumb: 1) GitHub (se corres existir e imagem carregar) 2) YouTube
  function resolveThumbUrl(id){
    return getCorresMap().then(function(map){
      var ghUrl = null;
      if(map.has(id)){
        var fname = map.get(id); // ex.: "001.jpg"
        ghUrl = GH_RAW_BASE + fname;
      }
      if(ghUrl){
        return checkImage(ghUrl).then(function(ok){
          if(ok) return ghUrl;
          // imagem mapeada não existe -> fallback YouTube
          return new Promise(function(resolve){
            pickPosterFromYouTube(id, function(u){ resolve(u); });
          });
        });
      }else{
        // sem mapeamento -> só YouTube
        return new Promise(function(resolve){
          pickPosterFromYouTube(id, function(u){ resolve(u); });
        });
      }
    });
  }

  // aplica a thumb (background-image !important) e garante fallback <img>
  function setThumb(el, url){
    if(!url) return;
    el.style.setProperty("background-image",'url("'+url+'")',"important");
    var comp = getComputedStyle(el).getPropertyValue("background-image");
    if (!comp || comp==="none"){
      var img = el.querySelector(".lty-fallback-img") || document.createElement("img");
      img.className="lty-fallback-img"; img.alt=""; img.src=url; img.referrerPolicy="origin";
      if (!img.parentNode) el.appendChild(img);
    }
  }

  // define a thumb (GitHub -> fallback YouTube) e, se precisar, injeta <img> fallback
  function enforceThumb(el){
    var id = el.getAttribute("videoid");
    if(!id) return;
    resolveThumbUrl(id).then(function(url){ if(url) setThumb(el, url); });
  }

  // se o componente estiver dentro de <p>, neutraliza o efeito do wrapper
  function neutralizeWrapper(el){
    var p = el.parentElement;
    if (p && p.tagName === "P"){
      p.style.margin="0"; p.style.lineHeight="0"; p.style.padding="0";
    }
  }

  /* Remove o bg (e fallback) ao tocar/reproduzir e quando a classe mudar */
  function stripBgOnPlay(el){
    // garante que o elemento não entre em fluxo de arrasto nativo
    el.setAttribute('draggable','false');
    el.addEventListener('dragstart', function(ev){ ev.preventDefault(); }, {passive:false});

    function clear(){
      el.style.removeProperty('background-image');
      var img = el.querySelector('.lty-fallback-img');
      if (img) img.remove();
    }

    // Caso já venha ativado por algum motivo (raro), limpe imediatamente
    if (el.classList.contains('lyt-activated')) {
      clear();
      return;
    }

    // NÃO limpar no pointerdown (isso causava o bug ao "clicar e arrastar")
    // Limpe somente quando a lib realmente ativar o player
    var mo = new MutationObserver(function(muts){
      for (var m of muts){
        if (m.type === 'attributes' && el.classList.contains('lyt-activated')) {
          clear();
          mo.disconnect();
          break;
        }
      }
    });
    mo.observe(el, { attributes:true, attributeFilter:['class'] });

    // Em navegadores que aplicam a classe após o click:
    // aguarde um micro-tick e limpe apenas se já estiver ativado.
    el.addEventListener('click', function(){
      setTimeout(function(){
        if (el.classList.contains('lyt-activated')) clear();
      }, 0);
    }, {passive:true});
  }

  /* ================== Conversão ================== */
  function convertIframes(){
    var sel='iframe[src*="youtube.com/embed/"],iframe[src*="youtube-nocookie.com/embed/"]';
    document.querySelectorAll(sel).forEach(function(ifr){
      var src = ifr.getAttribute("src") || "";
      try{
        var u = new URL(src, location.href);
        var m = u.pathname.match(/\/embed\/([\w-]{11})/);
        if(!m) return;
        var id = m[1];

        // lê a razão do iframe original (ex.: 560x315 => 16:9)
        var w = parseInt(ifr.getAttribute("width")||"560",10) || 560;
        var h = parseInt(ifr.getAttribute("height")||"315",10) || 315;

        var keep = new URLSearchParams();
        ["start","t","list","cc_lang_pref","cc_load_policy","modestbranding","rel"]
          .forEach(function(k){ if(u.searchParams.has(k)) keep.set(k, u.searchParams.get(k)); });

        var lite = document.createElement("lite-youtube");
        lite.setAttribute("videoid", id);
        if (keep.toString()) lite.setAttribute("params", keep.toString());

        var ttl = ifr.getAttribute("title")||"";
        if (ttl){
          lite.setAttribute("title", ttl);
          lite.setAttribute("playlabel", ttl);
          lite.setAttribute("data-title", ttl); // garante a faixa de título
        }

        // só controlamos a RAZÃO; largura = 100% da célula (sem max-width)
        lite.style.setProperty("--lty-ratio",  w+" / "+h);

        ifr.parentNode.replaceChild(lite, ifr);

        neutralizeWrapper(lite);
        enforceThumb(lite);
        stripBgOnPlay(lite);
      }catch(e){}
    });

    // observa futuros <lite-youtube>
    var mo = new MutationObserver(function(muts){
      muts.forEach(function(m){
        [].forEach.call(m.addedNodes||[], function(n){
          if (n.nodeType!==1) return;
          if (n.tagName && n.tagName.toLowerCase()==="lite-youtube"){
            neutralizeWrapper(n); enforceThumb(n); stripBgOnPlay(n);
          }
          n.querySelectorAll && n.querySelectorAll("lite-youtube").forEach(function(el){
            neutralizeWrapper(el); enforceThumb(el); stripBgOnPlay(el);
          });
        });
      });
    });
    mo.observe(document.body,{childList:true,subtree:true});
  }

  function boot(){
    injectCSS();
    var s=document.createElement("script");
    s.src="https://cdn.jsdelivr.net/npm/lite-youtube-embed@0.3.2/src/lite-yt-embed.js";
    s.async=true; s.onload=convertIframes;
    document.head.appendChild(s);
  }

  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
