/*!
 * 赵建华的个人博客 · 交互脚本
 * 纯原生 JS，零依赖
 */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var root = document.documentElement;

  /* ------------------------- 主题切换 ------------------------- */
  var themeBtn = $('#themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      var apply = function () {
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) {}
      };
      /* 支持的浏览器用圆形扩散过渡，其余直接切换 */
      if (document.startViewTransition) document.startViewTransition(apply);
      else apply();
    });
  }

  /* ------------------------- 顶栏滚动态 ------------------------- */
  var header = $('#siteHeader');
  var onScrollNav = function () {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  onScrollNav();
  window.addEventListener('scroll', onScrollNav, { passive: true });

  /* ------------------------- 移动端菜单 ------------------------- */
  var navToggle = $('#navToggle');
  var nav = $('#nav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (!nav.contains(e.target) && !navToggle.contains(e.target)) {
        nav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ------------------------- 回到顶部 ------------------------- */
  var toTop = $('#toTop');
  if (toTop) {
    window.addEventListener('scroll', function () {
      toTop.hidden = window.scrollY < 480;
    }, { passive: true });
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ------------------------- 站内搜索 ------------------------- */
  var modal = $('#searchModal');
  var input = $('#searchInput');
  var resultsBox = $('#searchResults');
  var searchBtn = $('#searchBtn');
  var cache = null;
  var activeIndex = -1;
  var pending = null;

  function openSearch() {
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    if (input) { input.value = ''; input.focus(); }
    loadIndex();
    renderTip('输入关键词开始搜索，支持标题与正文');
    activeIndex = -1;
  }

  function closeSearch() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    if (pending) { pending.abort(); pending = null; }
  }

  function loadIndex() {
    if (cache || pending) return;
    pending = new AbortController();
    fetch('/search.json', { signal: pending.signal })
      .then(function (r) { return r.json(); })
      .then(function (data) { cache = data; pending = null; })
      .catch(function () { pending = null; });
  }

  function renderTip(text) {
    if (resultsBox) resultsBox.innerHTML = '<p class="search-tip">' + text + '</p>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function highlight(text, kw) {
    var safe = escapeHtml(text);
    if (!kw) return safe;
    try {
      return safe.replace(new RegExp('(' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>');
    } catch (e) { return safe; }
  }

  function search(kw) {
    if (!resultsBox) return;
    activeIndex = -1;
    if (!cache) { renderTip('索引加载中…'); return; }
    kw = kw.trim();
    if (!kw) { renderTip('输入关键词开始搜索，支持标题与正文'); return; }

    var lower = kw.toLowerCase();
    var hits = cache.filter(function (p) {
      return (p.title || '').toLowerCase().indexOf(lower) > -1 ||
             (p.text || '').toLowerCase().indexOf(lower) > -1;
    }).slice(0, 20);

    if (!hits.length) { renderTip('没有找到「' + escapeHtml(kw) + '」相关内容'); return; }

    resultsBox.innerHTML = hits.map(function (p) {
      return '<a class="search-item" href="' + p.url + '">' +
             '<b>' + highlight(p.title, kw) + '</b>' +
             '<span>' + escapeHtml(p.cat || '') + ' · ' + escapeHtml(p.date || '') + '</span>' +
             '</a>';
    }).join('');
  }

  if (searchBtn) searchBtn.addEventListener('click', openSearch);
  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeSearch();
    });
  }
  if (input) {
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var v = input.value;
      timer = setTimeout(function () { search(v); }, 90);
    });
    input.addEventListener('keydown', function (e) {
      var items = $$('.search-item', resultsBox);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        activeIndex = e.key === 'ArrowDown'
          ? Math.min(activeIndex + 1, items.length - 1)
          : Math.max(activeIndex - 1, 0);
        items.forEach(function (el, i) { el.classList.toggle('is-active', i === activeIndex); });
        if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && activeIndex > -1 && items[activeIndex]) {
        window.location.href = items[activeIndex].getAttribute('href');
      }
    });
  }

  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if (e.key === '/' && !typing) { e.preventDefault(); openSearch(); }
    if (e.key === 'Escape') closeSearch();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  });

  /* ------------------------- 阅读进度条 ------------------------- */
  var bar = $('#progressBar');
  var article = $('#postContent');
  if (bar && article) {
    var updateProgress = function () {
      var rect = article.getBoundingClientRect();
      var total = rect.height - window.innerHeight * 0.4;
      var scrolled = Math.min(Math.max(-rect.top + window.innerHeight * 0.4, 0), Math.max(total, 1));
      bar.style.width = (scrolled / Math.max(total, 1)) * 100 + '%';
    };
    updateProgress();
    window.addEventListener('scroll', updateProgress, { passive: true });
    window.addEventListener('resize', updateProgress);
  }

  /* ------------------------- 自动生成目录 ------------------------- */
  var tocList = $('#tocList');
  if (tocList && article) {
    var heads = $$('h2, h3', article);
    if (!heads.length) {
      var tocBox = $('#toc');
      if (tocBox) tocBox.style.display = 'none';
    } else {
      heads.forEach(function (h, i) {
        if (!h.id) h.id = 'sec-' + i;
        var a = document.createElement('a');
        a.href = '#' + h.id;
        a.textContent = h.textContent.replace(/^#+\s*/, '').trim();
        if (h.tagName === 'H3') a.className = 'toc-h3';
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var top = h.getBoundingClientRect().top + window.pageYOffset - 76;
          window.scrollTo({ top: top, behavior: 'smooth' });
          history.replaceState(null, '', '#' + h.id);
        });
        tocList.appendChild(a);
      });

      var links = $$('a', tocList);
      var spy = function () {
        var current = null;
        heads.forEach(function (h, i) {
          if (h.getBoundingClientRect().top < 120) current = i;
        });
        links.forEach(function (a, i) { a.classList.toggle('active', i === current); });
      };
      spy();
      window.addEventListener('scroll', spy, { passive: true });
    }
  }

  /* ------------------------- 代码复制 & 图片处理 ------------------------- */
  if (article) {
    /* 图片：懒加载 + 点击放大 */
    $$('img', article).forEach(function (img) {
      if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy');
      if (!img.getAttribute('decoding')) img.setAttribute('decoding', 'async');
      img.addEventListener('click', function () { openLightbox(img.src, img.alt); });
    });

    /* 代码块：复制按钮（以 pre 为唯一入口，避免 .highlight 在 div 与 pre 上重复匹配） */
    $$('pre.highlight', article).forEach(function (pre) {
      var block = pre.closest('.highlight') || pre;
      if (block.dataset.copyReady === '1') return;
      block.dataset.copyReady = '1';

      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.textContent = '复制';
      btn.addEventListener('click', function () {
        var text = pre.innerText;
        var done = function () {
          btn.textContent = '已复制 ✓';
          setTimeout(function () { btn.textContent = '复制'; }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else {
          fallback();
        }
        function fallback() {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); done(); } catch (e) {}
          document.body.removeChild(ta);
        }
      });
      block.appendChild(btn);
    });
  }

  /* ------------------------- 图片灯箱 ------------------------- */
  var lightbox = $('#lightbox');
  var lightboxImg = lightbox ? lightbox.querySelector('img') : null;

  function openLightbox(src, alt) {
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src;
    lightboxImg.alt = alt || '';
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  if (lightbox) {
    lightbox.addEventListener('click', function () {
      lightbox.hidden = true;
      document.body.style.overflow = '';
    });
  }

  /* ------------------------- 项目页：同步 Star 数 ------------------------- */
  var starNodes = $$('[data-repo]');
  if (starNodes.length) {
    var cacheKey = 'gh-repos-v1';
    var renderStars = function (repoMap) {
      starNodes.forEach(function (card) {
        var repo = card.getAttribute('data-repo');
        var info = repoMap[repo.toLowerCase()];
        var el = card.querySelector('[data-stars]');
        if (info && el) el.textContent = info.stars;
      });
    };

    try {
      var saved = sessionStorage.getItem(cacheKey);
      if (saved) renderStars(JSON.parse(saved));
      else throw new Error('no cache');
    } catch (e) {
      fetch('https://api.github.com/users/sakurajh/repos?per_page=100&sort=updated')
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (list) {
          var map = {};
          list.forEach(function (r) {
            map[r.name.toLowerCase()] = { stars: r.stargazers_count, updated: r.pushed_at };
          });
          try { sessionStorage.setItem(cacheKey, JSON.stringify(map)); } catch (err) {}
          renderStars(map);
        })
        .catch(function () { /* 失败则保持占位符 */ });
    }
  }
})();
