(function () {
  'use strict';

  var api = window.PNUSupabase;

  if (!api || !api.ready) {
    console.warn('[tracker] Supabase is not configured. Analytics disabled.');
    window.PNUTrack = {
      event: function () {},
      flush: function () {},
      sessionId: 'disabled',
      attribution: {}
    };
    return;
  }

  var SESSION_KEY = 'pnu_hw_session_id';
  var ATTR_KEY = 'pnu_hw_attribution';
  var queue = [];
  var timer = null;
  var startedAt = Date.now();
  var maxScroll = 0;
  var leaveSent = false;
  var exposed = {};

  function uuid() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) { /* noop */ }
    return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function storageGet(store, key) {
    try { return window[store].getItem(key); } catch (e) { return null; }
  }

  function storageSet(store, key, value) {
    try { window[store].setItem(key, value); } catch (e) { /* noop */ }
  }

  var sessionId = storageGet('sessionStorage', SESSION_KEY);
  if (!sessionId) {
    sessionId = uuid();
    storageSet('sessionStorage', SESSION_KEY, sessionId);
  }

  function getAttribution() {
    var raw = storageGet('sessionStorage', ATTR_KEY);
    if (raw) {
      try { return JSON.parse(raw); } catch (e) { /* noop */ }
    }
    var params = new URLSearchParams(window.location.search);
    var attr = {
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      utm_content: params.get('utm_content') || '',
      landing_ref: (document.referrer || '').slice(0, 300)
    };
    storageSet('sessionStorage', ATTR_KEY, JSON.stringify(attr));
    return attr;
  }

  var attribution = getAttribution();

  // A/B 실험 배정: 세션 단위 50/50, sessionStorage로 고정 ---------------------
  function assignExperiment(key) {
    var storageKey = 'pnu_exp_' + key;
    var existing = storageGet('sessionStorage', storageKey);
    if (existing === 'A' || existing === 'B') return existing;
    var variant = Math.random() < 0.5 ? 'A' : 'B';
    storageSet('sessionStorage', storageKey, variant);
    return variant;
  }

  var experiments = {
    exp_price_frame: assignExperiment('exp_price_frame'),
    exp_quick_checkout: assignExperiment('exp_quick_checkout')
  };

  window.PNUExperiments = experiments;

  function isMobile() {
    return window.matchMedia('(max-width: 820px)').matches;
  }

  function baseMetadata() {
    return {
      device: isMobile() ? 'mobile' : 'desktop',
      language: navigator.language || '',
      screen: window.screen ? (window.screen.width + 'x' + window.screen.height) : '',
      viewport: window.innerWidth + 'x' + window.innerHeight,
      utm_source: attribution.utm_source,
      utm_medium: attribution.utm_medium,
      utm_campaign: attribution.utm_campaign,
      utm_content: attribution.utm_content,
      experiments: experiments
    };
  }

  function buildRow(eventName, opts) {
    opts = opts || {};
    var metadata = baseMetadata();
    if (opts.metadata) {
      Object.keys(opts.metadata).forEach(function (k) {
        metadata[k] = opts.metadata[k];
      });
    }
    return {
      session_id: sessionId,
      event_name: String(eventName).slice(0, 64),
      page: (window.location.pathname + window.location.hash).slice(0, 120),
      section: opts.section ? String(opts.section).slice(0, 64) : null,
      element: opts.element ? String(opts.element).slice(0, 64) : null,
      referrer: (document.referrer || '').slice(0, 500),
      user_agent: (navigator.userAgent || '').slice(0, 400),
      metadata: metadata
    };
  }

  function flush(immediate) {
    if (!queue.length) return;
    var rows = queue.slice(0);
    queue.length = 0;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    api.insert('event_logs', rows).catch(function () {
      // Analytics must never break the page. Drop the batch silently.
    });
  }

  function enqueue(eventName, opts) {
    queue.push(buildRow(eventName, opts));
    if (queue.length >= 8) {
      flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(function () { flush(); }, 4000);
    }
  }

  function track(eventName, opts) {
    enqueue(eventName, opts);
    if (eventName === 'purchase') flush();
  }

  function trackPageView() {
    enqueue('page_view', {
      metadata: {
        title: (document.title || '').slice(0, 160),
        path: window.location.pathname
      }
    });
  }

  function exposure(key, name) {
    if (exposed[key]) return;
    exposed[key] = true;
    enqueue('experiment_exposure', {
      section: 'experiment',
      element: key,
      metadata: {
        exp_key: key,
        exp_name: name,
        variant: experiments[key] || 'A'
      }
    });
  }

  function setupSectionViews() {
    var sections = document.querySelectorAll('[data-section]');
    if (!sections.length) return;

    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(sections, function (el) {
        var name = el.getAttribute('data-section');
        enqueue('section_view', { section: name });
        if (name === 'tickets') exposure('exp_price_frame', '티켓 가격 프레이밍');
      });
      return;
    }

    var seen = {};
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var name = entry.target.getAttribute('data-section');
        if (entry.isIntersecting && !seen[name]) {
          seen[name] = true;
          enqueue('section_view', { section: name });
          if (name === 'tickets') exposure('exp_price_frame', '티켓 가격 프레이밍');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.35 });

    Array.prototype.forEach.call(sections, function (el) { observer.observe(el); });
  }

  function setupClicks() {
    document.addEventListener('click', function (event) {
      var target = event.target.closest ? event.target.closest('[data-track]') : null;
      if (!target) return;
      var label = target.getAttribute('data-track-label') ||
        (target.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      enqueue('click', {
        section: target.getAttribute('data-track-section') || null,
        element: target.getAttribute('data-track'),
        metadata: { label: label }
      });
    }, true);
  }

  function setupScrollDepth() {
    function update() {
      var doc = document.documentElement;
      var height = Math.max(doc.scrollHeight - window.innerHeight, 1);
      var percent = Math.min(100, Math.round((window.scrollY / height) * 100));
      if (percent > maxScroll) maxScroll = percent;
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  function pageLeave() {
    if (leaveSent) return;
    leaveSent = true;
    var seconds = Math.round((Date.now() - startedAt) / 1000);
    track('page_leave', {
      metadata: {
        seconds: seconds,
        scroll_depth: maxScroll
      }
    });
  }

  function setupLifecycle() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        pageLeave();
        flush(true);
      }
    });
    window.addEventListener('pagehide', function () {
      pageLeave();
      flush(true);
    });
  }

  trackPageView();
  setupSectionViews();
  setupClicks();
  setupScrollDepth();
  setupLifecycle();

  window.PNUTrack = {
    event: track,
    exposure: exposure,
    flush: flush,
    sessionId: sessionId,
    attribution: attribution,
    experiments: experiments,
    getElapsedSeconds: function () { return Math.round((Date.now() - startedAt) / 1000); },
    getScrollDepth: function () { return maxScroll; }
  };
})();
