/*!
 * 交互增强层 —— 参考 Josh Comeau / Rauno Freiberg / Brittany Chiang 的常见做法
 * 全部原生实现，无依赖；触屏与「减少动态效果」自动降级
 */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var root = document.documentElement;

  /* 跨文档 View Transition（Chrome 126+）—— 支持时改用浏览器原生页面过渡 */
  var uaMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
  var crossDocVT = !!(uaMatch && parseInt(uaMatch[1], 10) >= 126) && !reduce;

  /* ============ 1. 自定义光标 ============ */
  if (fine && !reduce) {
    var dot = document.createElement('div');
    var ring = document.createElement('div');
    dot.className = 'cursor-dot';
    ring.className = 'cursor-ring';
    document.body.appendChild(dot);
    document.body.appendChild(ring);

    var mx = window.innerWidth / 2, my = window.innerHeight / 2;
    var rx = mx, ry = my;
    var started = false;

    document.addEventListener('mousemove', function (e) {
      mx = e.clientX; my = e.clientY;
      if (!started) { started = true; dot.style.opacity = '1'; ring.style.opacity = '1'; }
      dot.style.transform = 'translate3d(' + mx + 'px,' + my + 'px,0)';
    }, { passive: true });

    (function loop() {
      rx += (mx - rx) * 0.16;
      ry += (my - ry) * 0.16;
      ring.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)';
      requestAnimationFrame(loop);
    })();

    var hoverSel = 'a, button, summary, .pill, .social-btn, .chip, .filter-btn, .related-item, .post-card, .project-card, .strip-card';
    document.querySelectorAll(hoverSel).forEach(function (el) { el.classList.add('cursor-target'); });

    document.addEventListener('mouseover', function (e) {
      var t = e.target;
      if (t.closest && t.closest(hoverSel)) ring.classList.add('is-hover');
      if (t.closest && t.closest('input, textarea')) ring.classList.add('is-text');
    });
    document.addEventListener('mouseout', function (e) {
      var t = e.target;
      if (t.closest && t.closest(hoverSel)) ring.classList.remove('is-hover');
      if (t.closest && t.closest('input, textarea')) ring.classList.remove('is-text');
    });
    document.addEventListener('mouseleave', function () { document.body.classList.add('cursor-hidden'); });
    document.addEventListener('mouseenter', function () { document.body.classList.remove('cursor-hidden'); });
  }

  /* ============ 2. 首屏聚光 ============ */
  var hero = document.querySelector('.hero2');
  if (hero && fine) {
    hero.addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect();
      hero.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      hero.style.setProperty('--my', (e.clientY - r.top) + 'px');
      hero.classList.add('is-active');
    });
    hero.addEventListener('mouseleave', function () { hero.classList.remove('is-active'); });
  }

  /* ============ 3. 标题逐字入场 ============ */
  var title = document.querySelector('[data-split]');
  if (title && !reduce) {
    var html = title.innerHTML;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var out = '';
    Array.prototype.forEach.call(tmp.childNodes, function (node) {
      if (node.nodeType === 3) {
        node.textContent.split('').forEach(function (ch, i) {
          if (ch.trim() === '') { out += ' '; return; }
          out += '<span class="char" style="animation-delay:' + (i * 0.035) + 's">' + ch + '</span>';
        });
      } else {
        out += node.outerHTML;
      }
    });
    title.innerHTML = out;
  }

  /* ============ 4. 滚动入场 ============ */
  var revealEls = document.querySelectorAll('[data-reveal]');
  if (revealEls.length) {
    if (reduce || !('IntersectionObserver' in window)) {
      revealEls.forEach(function (el) { el.classList.add('is-in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var siblings = el.parentNode ? Array.prototype.slice.call(el.parentNode.querySelectorAll('[data-reveal]')) : [];
          var idx = siblings.indexOf(el);
          if (idx < 0) idx = 0;
          el.style.transitionDelay = Math.min(idx, 8) * 70 + 'ms';
          el.classList.add('is-in');
          io.unobserve(el);
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
      revealEls.forEach(function (el) { io.observe(el); });

      /* 兜底：首屏内（含 1 屏缓冲）的元素立即显示，避免观察器延迟导致空白 */
      requestAnimationFrame(function () {
        revealEls.forEach(function (el, i) {
          var r = el.getBoundingClientRect();
          if (r.top < window.innerHeight * 1.15 && r.bottom > -80) {
            el.style.transitionDelay = Math.min(i, 10) * 45 + 'ms';
            el.classList.add('is-in');
            io.unobserve(el);
          }
        });
      });
    }
  }

  /* ============ 5. 卡片倾斜 + 光斑 ============ */
  var tiltCards = document.querySelectorAll('.post-card, .project-card, .strip-card, .post-feature');
  if (fine && !reduce) {
    tiltCards.forEach(function (card) {
      if (!card.querySelector('.card-glare')) {
        var glare = document.createElement('div');
        glare.className = 'card-glare';
        card.appendChild(glare);
      }
      var raf = null;
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width;
        var py = (e.clientY - r.top) / r.height;
        card.classList.add('tilt', 'is-tilting');
        card.style.setProperty('--gx', px * 100 + '%');
        card.style.setProperty('--gy', py * 100 + '%');
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () {
          card.style.transform = 'perspective(900px) rotateX(' + ((0.5 - py) * 5).toFixed(2) + 'deg) rotateY(' + ((px - 0.5) * 6).toFixed(2) + 'deg) translateY(-4px)';
        });
      });
      card.addEventListener('mouseleave', function () {
        card.classList.remove('is-tilting');
        card.style.transform = '';
        setTimeout(function () { card.classList.remove('tilt'); }, 320);
      });
    });
  }

  /* ============ 6. 磁吸按钮 ============ */
  if (fine && !reduce) {
    document.querySelectorAll('.btn-primary, .btn-ghost, .pill, .social-btn').forEach(function (el) {
      el.classList.add('magnetic');
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        var dx = (e.clientX - r.left - r.width / 2) / (r.width / 2);
        var dy = (e.clientY - r.top - r.height / 2) / (r.height / 2);
        el.style.transform = 'translate(' + (dx * 5).toFixed(1) + 'px,' + (dy * 5).toFixed(1) + 'px)';
      });
      el.addEventListener('mouseleave', function () { el.style.transform = ''; });
    });
  }

  /* ============ 7. 顶栏智能隐藏 ============ */
  var header = document.getElementById('siteHeader');
  if (header) {
    var lastY = window.scrollY;
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var y = window.scrollY;
        var down = y > lastY;
        header.classList.toggle('is-hidden', down && y > 220);
        header.classList.toggle('is-scrolled', y > 8);
        lastY = y;
        ticking = false;
      });
    }, { passive: true });
  }

  /* ============ 8. 页面过渡 ============ */
  if (!reduce && !crossDocVT) {
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a');
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href.indexOf('#') === 0 || href.indexOf('mailto:') === 0 ||
          href.indexOf('javascript:') === 0 || a.target === '_blank' ||
          a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      if (a.host && a.host !== window.location.host) return;
      e.preventDefault();
      document.body.classList.add('is-leaving');
      setTimeout(function () { window.location.href = a.href; }, 170);
    });
  }

  /* ============ 9. 回到顶部：环形进度 ============ */
  var toTop = document.getElementById('toTop');
  if (toTop) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ring');
    svg.setAttribute('viewBox', '0 0 44 44');
    var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '22');
    circle.setAttribute('cy', '22');
    circle.setAttribute('r', '20');
    svg.appendChild(circle);
    toTop.appendChild(svg);
    var len = 2 * Math.PI * 20;
    circle.style.strokeDasharray = len;
    circle.style.strokeDashoffset = len;
    window.addEventListener('scroll', function () {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var p = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
      circle.style.strokeDashoffset = len * (1 - p);
    }, { passive: true });
  }

  /* ============ 10. 主题切换：圆形扩散 ============ */
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn && document.startViewTransition && !reduce) {
    themeBtn.addEventListener('click', function (e) {
      var r = themeBtn.getBoundingClientRect();
      document.documentElement.style.setProperty('--tx', ((r.left + r.width / 2) / window.innerWidth * 100) + '%');
      document.documentElement.style.setProperty('--ty', ((r.top + r.height / 2) / window.innerHeight * 100) + '%');
    }, true);
  }

  /* ============ 11. 项目页筛选 ============ */
  var filterBar = document.getElementById('filterBar');
  if (filterBar) {
    var cards = document.querySelectorAll('.project-card');
    filterBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.filter-btn');
      if (!btn) return;
      var key = btn.getAttribute('data-filter');
      filterBar.querySelectorAll('.filter-btn').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      cards.forEach(function (card) {
        var tags = (card.getAttribute('data-tags') || '').split('|');
        var show = key === 'all' || tags.indexOf(key) > -1;
        card.classList.toggle('is-hidden', !show);
        if (show) {
          card.classList.remove('is-appear');
          void card.offsetWidth;
          card.classList.add('is-appear');
        }
      });
    });
  }

  /* ============ 12. 阅读进度环 ============ */
  var ringBox = document.getElementById('readingRing');
  var postBody = document.getElementById('postContent');
  if (ringBox && postBody) {
    var fgCircle = ringBox.querySelector('.fg');
    var ringLabel = ringBox.querySelector('span');
    var radius = 19;
    var circumference = 2 * Math.PI * radius;
    fgCircle.style.strokeDasharray = circumference;
    fgCircle.style.strokeDashoffset = circumference;

    var updateRing = function () {
      var rect = postBody.getBoundingClientRect();
      var total = rect.height - window.innerHeight * 0.5;
      var passed = Math.max(-rect.top + window.innerHeight * 0.3, 0);
      var progress = total > 0 ? Math.min(passed / total, 1) : 1;
      fgCircle.style.strokeDashoffset = circumference * (1 - progress);
      ringLabel.textContent = Math.round(progress * 100) + '%';
      ringBox.classList.toggle('is-visible', window.scrollY > 320 && progress < 0.99);
    };
    updateRing();
    window.addEventListener('scroll', updateRing, { passive: true });
    window.addEventListener('resize', updateRing);
  }

  /* ============ 13. 代码块行号 ============ */
  document.querySelectorAll('pre code').forEach(function (code) {
    /* Rouge 的 .highlight 同时出现在外层 div 与 pre 上，这里以 code 为唯一入口，避免重复处理 */
    if (code.querySelector('.cl')) return;
    var html = code.innerHTML;
    if (html.indexOf('\n') === -1) return;
    var parts = html.split('\n');
    while (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
    code.innerHTML = parts.map(function (line) {
      return '<span class="cl">' + (line.length ? line : '&nbsp;') + '</span>';
    }).join('\n');
    var wrap = code.closest('.highlight') || code.parentNode;
    if (wrap) wrap.classList.add('has-lines');
  });

  /* ============ 14. 评论（Giscus，滚动到附近才加载） ============ */
  var giscusBox = document.getElementById('giscusBox');
  if (giscusBox && 'IntersectionObserver' in window) {
    var giscusTheme = function () {
      return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    };
    var loadGiscus = function () {
      var s = document.createElement('script');
      s.src = 'https://giscus.app/client.js';
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.setAttribute('data-repo', giscusBox.getAttribute('data-repo'));
      s.setAttribute('data-repo-id', giscusBox.getAttribute('data-repo-id'));
      s.setAttribute('data-category', giscusBox.getAttribute('data-category'));
      s.setAttribute('data-category-id', giscusBox.getAttribute('data-category-id'));
      s.setAttribute('data-mapping', giscusBox.getAttribute('data-mapping') || 'pathname');
      s.setAttribute('data-lang', giscusBox.getAttribute('data-lang') || 'zh-CN');
      s.setAttribute('data-theme', giscusTheme());
      s.setAttribute('data-reactions-enabled', '1');
      s.setAttribute('data-input-position', 'top');
      s.setAttribute('data-loading', 'lazy');
      giscusBox.appendChild(s);
    };

    var giscusObserver = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        loadGiscus();
        giscusObserver.disconnect();
      }
    }, { rootMargin: '320px' });
    giscusObserver.observe(giscusBox);

    /* 主题切换时同步评论框配色 */
    new MutationObserver(function () {
      var iframe = document.querySelector('iframe.giscus-frame');
      if (!iframe) return;
      iframe.contentWindow.postMessage(
        { giscus: { setConfig: { theme: giscusTheme() } } },
        'https://giscus.app'
      );
    }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  }

  /* ============ 15. 共享元素过渡：卡片标题 → 文章标题 ============ */
  if (crossDocVT) {
    document.querySelectorAll('.post-card, .post-feature, .related-item').forEach(function (card) {
      var target = card.querySelector('h3, h2, b');
      card.addEventListener('click', function () {
        if (target) target.style.viewTransitionName = 'post-title';
      });
    });
  }
})();
