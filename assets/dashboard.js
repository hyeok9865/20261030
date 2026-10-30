(function () {
  'use strict';

  var api = window.PNUSupabase;
  var won = new Intl.NumberFormat('ko-KR');
  var state = { days: 14, loading: false, data: null, feed: [] };

  var els = {
    kpi: document.getElementById('kpi-grid'),
    funnel: document.getElementById('funnel'),
    funnelChip: document.getElementById('funnel-chip'),
    insights: document.getElementById('insights'),
    chart: document.getElementById('daily-chart'),
    tickets: document.getElementById('ticket-mix'),
    buttons: document.getElementById('button-table'),
    devices: document.getElementById('devices'),
    feed: document.getElementById('event-feed'),
    feedCount: document.getElementById('feed-count'),
    range: document.getElementById('range-label'),
    updated: document.getElementById('updated-at'),
    error: document.getElementById('error-banner'),
    notice: document.getElementById('notice-banner'),
    refresh: document.getElementById('refresh-btn'),
    seed: document.getElementById('seed-btn'),
    period: document.querySelectorAll('[data-period]')
  };

  var EVENT_LABELS = {
    page_view: '페이지 방문',
    section_view: '섹션 도달',
    click: '버튼 클릭',
    checkout_open: '예매 시작',
    checkout_abandon: '예매 이탈',
    purchase: '예매 완료',
    page_leave: '세션 종료'
  };

  var TICKET_LABELS = {
    solo: 'SOLO · 1인',
    couple: 'COUPLE · 2인',
    group: 'GROUP · 4인',
    unknown: '기타'
  };

  var TICKET_COLORS = {
    solo: '#8b5cf6',
    couple: '#ff7a18',
    group: '#22d3ee'
  };

  var FALLBACK_COLORS = ['#f472b6', '#facc15', '#34d399', '#60a5fa'];

  function fmt(n) {
    return won.format(Math.round(Number(n) || 0));
  }

  function num(n) {
    return Math.round(Number(n) || 0);
  }

  function pct(part, whole) {
    if (!whole) return 0;
    return (Number(part) || 0) / Number(whole) * 100;
  }

  function pct1(value) {
    return (Math.round(value * 10) / 10).toFixed(1) + '%';
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function empty(message) {
    return '<div class="empty-state">' + message + '</div>';
  }

  function ticketLabel(key) {
    return TICKET_LABELS[key] || key || '기타';
  }

  function ticketColor(key, index) {
    return TICKET_COLORS[key] || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
  }

  /* ---------------------------------------------------------------------- kpi */
  function renderKpis(stats) {
    var t = stats.totals || {};
    var funnel = stats.funnel || [];
    var buyerSessions = funnel.length ? funnel[funnel.length - 1].count : 0;
    var conv = pct(t.orders, t.visits);
    var startConv = pct(t.orders, t.checkout_opens);

    var cards = [
      {
        label: '방문 세션', tag: 'SESSIONS', accent: 'purple',
        value: fmt(t.sessions), sub: '이벤트 페이지 순 방문'
      },
      {
        label: '예매 완료', tag: 'ORDERS', accent: 'green',
        value: fmt(t.orders),
        sub: '<strong>' + fmt(t.tickets_sold) + '</strong>매 판매'
      },
      {
        label: '구매 전환율', tag: 'CVR', accent: 'orange',
        value: pct1(conv),
        sub: '<strong>' + fmt(buyerSessions) + '</strong>세션 전환'
      },
      {
        label: '총 매출', tag: 'REVENUE', accent: 'amber',
        value: fmt(t.revenue) + '<small>원</small>',
        sub: '객단가 <strong>' + fmt(t.avg_order) + '원</strong>'
      },
      {
        label: '예매 시작 전환율', tag: 'CHECKOUT', accent: 'pink',
        value: pct1(startConv),
        sub: '예매 시작 <strong>' + fmt(t.checkout_opens) + '</strong>회'
      },
      {
        label: '이탈률', tag: 'BOUNCE', accent: 'blue',
        value: (Math.round(Number(t.bounce_rate) || 0) * 10 / 10) + '%',
        sub: '참여 세션 <strong>' + fmt(t.engaged_sessions) + '</strong>'
      }
    ];

    els.kpi.innerHTML = cards.map(function (c) {
      return '' +
        '<article class="kpi accent-' + c.accent + '">' +
          '<div class="kpi-top">' +
            '<span class="kpi-label">' + c.label + '</span>' +
            '<span class="kpi-tag">' + c.tag + '</span>' +
          '</div>' +
          '<strong class="kpi-value">' + c.value + '</strong>' +
          '<p class="kpi-sub">' + c.sub + '</p>' +
        '</article>';
    }).join('');
  }

  /* ------------------------------------------------------------------- funnel */
  function renderFunnel(stats) {
    var steps = stats.funnel || [];
    if (!steps.length || !num(steps[0].count)) {
      els.funnel.innerHTML = empty('아직 퍼널 데이터가 없습니다.');
      els.funnelChip.textContent = '데이터 없음';
      return;
    }

    var base = num(steps[0].count);
    var overall = pct(num(steps[steps.length - 1].count), base);
    els.funnelChip.textContent = '방문 → 예매 ' + pct1(overall);

    els.funnel.innerHTML = steps.map(function (step, index) {
      var count = num(step.count);
      var width = Math.max(base ? (count / base) * 100 : 0, count > 0 ? 2 : 0);
      var share = pct(count, base);
      var prev = index > 0 ? num(steps[index - 1].count) : 0;
      var dropHtml = '<span class="drop-badge is-first">기준</span><em>START</em>';

      if (index > 0) {
        if (prev > 0) {
          var drop = 100 - (count / prev) * 100;
          dropHtml = '<span class="drop-badge">−' + drop.toFixed(1) + '%</span><em>이탈</em>';
        } else {
          dropHtml = '<span class="drop-badge is-first">—</span><em>이탈</em>';
        }
      }

      return '' +
        '<div class="funnel-row">' +
          '<div class="funnel-label">' +
            '<span class="funnel-step">' + String(index + 1).padStart(2, '0') + '</span>' +
            '<div><strong>' + esc(step.label) + '</strong>' +
            '<em>' + fmt(count) + ' 세션</em></div>' +
          '</div>' +
          '<div class="funnel-track"><div class="funnel-bar" style="width:' + width.toFixed(1) + '%"></div></div>' +
          '<div class="funnel-rate"><strong>' + (index === 0 ? '100%' : pct1(share)) + '</strong><span>전환</span></div>' +
          '<div class="funnel-drop">' + dropHtml + '</div>' +
        '</div>';
    }).join('');
  }

  /* ----------------------------------------------------------------- insights */
  function renderInsights(stats) {
    var t = stats.totals || {};
    var funnel = stats.funnel || [];
    var buttons = stats.buttons || [];
    var devices = stats.devices || [];
    var items = [];

    if (!num(t.sessions)) {
      els.insights.innerHTML = '<li class="empty-state">데이터가 쌓이면 인사이트가 자동 생성됩니다.<br>이벤트 페이지를 방문하거나 데모 데이터를 생성해 보세요.</li>';
      return;
    }

    var worst = null;
    for (var i = 1; i < funnel.length; i += 1) {
      var prev = num(funnel[i - 1].count);
      var cur = num(funnel[i].count);
      if (prev > 0) {
        var drop = 100 - (cur / prev) * 100;
        if (!worst || drop > worst.drop) {
          worst = { drop: drop, from: funnel[i - 1].label, to: funnel[i].label, lost: prev - cur };
        }
      }
    }
    if (worst) {
      items.push({
        title: '가장 큰 병목: ' + worst.from + ' → ' + worst.to,
        desc: '<b>' + worst.drop.toFixed(1) + '%</b> 이탈 · ' + fmt(worst.lost) + '세션 유실'
      });
    }

    var conv = pct(num(funnel.length ? funnel[funnel.length - 1].count : 0), num(funnel.length ? funnel[0].count : 0));
    items.push({
      title: '방문 → 예매 전환율 ' + pct1(conv),
      desc: '<b>' + fmt(t.orders) + '건</b> 결제 · 매출 <b>' + fmt(t.revenue) + '원</b>'
    });

    if (buttons.length) {
      var top = buttons[0];
      items.push({
        title: '최다 클릭: ' + (top.label || top.element),
        desc: '<b>' + fmt(top.clicks) + '회</b> · ' + esc(top.section || '-') + ' 섹션'
      });
    }

    var mobile = null;
    devices.forEach(function (d) {
      if (d.device === 'mobile') mobile = d;
    });
    if (mobile && num(t.visits)) {
      items.push({
        title: '모바일 비중 ' + pct1(pct(num(mobile.sessions), num(t.visits))),
        desc: '<b>' + fmt(mobile.sessions) + '세션</b> · 모바일 퍼스트 최적화 우선'
      });
    }

    items.push({
      title: '평균 활동 시간 ' + fmt(t.avg_activity) + '초',
      desc: '이탈률 <b>' + (Number(t.bounce_rate) || 0) + '%</b> · 참여 세션 <b>' + fmt(t.engaged_sessions) + '</b>'
    });

    if (num(t.orders)) {
      items.push({
        title: '객단가 ' + fmt(t.avg_order) + '원',
        desc: '티켓 <b>' + fmt(t.tickets_sold) + '매</b> · 주문 <b>' + fmt(t.orders) + '건</b>'
      });
    }

    els.insights.innerHTML = items.slice(0, 6).map(function (item, index) {
      return '' +
        '<li class="insight">' +
          '<span class="insight-idx">' + String(index + 1).padStart(2, '0') + '</span>' +
          '<div><strong>' + item.title + '</strong><p>' + item.desc + '</p></div>' +
        '</li>';
    }).join('');
  }

  /* -------------------------------------------------------------------- chart */
  function renderChart(daily) {
    if (!daily || !daily.length) {
      els.chart.innerHTML = empty('차트를 그릴 일별 데이터가 없습니다.');
      return;
    }

    var W = 760;
    var H = 236;
    var pl = 42;
    var pr = 34;
    var pt = 16;
    var pb = 30;
    var iw = W - pl - pr;
    var ih = H - pt - pb;
    var n = daily.length;
    var step = iw / n;
    var barW = Math.min(30, Math.max(6, step * 0.48));
    var maxV = Math.max.apply(null, daily.map(function (d) { return num(d.visits); }).concat([1]));
    var maxO = Math.max.apply(null, daily.map(function (d) { return num(d.orders); }).concat([1]));
    var labelEvery = Math.ceil(n / 7);

    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="일별 방문 및 예매 추이">');
    svg.push('<defs>');
    svg.push('<linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">');
    svg.push('<stop offset="0" stop-color="#a78bfa" stop-opacity="0.95"/>');
    svg.push('<stop offset="1" stop-color="#6d28d9" stop-opacity="0.28"/>');
    svg.push('</linearGradient>');
    svg.push('</defs>');

    for (var g = 0; g <= 3; g += 1) {
      var gy = pt + ih - (ih * g / 3);
      svg.push('<line x1="' + pl + '" y1="' + gy.toFixed(1) + '" x2="' + (W - pr) + '" y2="' + gy.toFixed(1) +
        '" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>');
      svg.push('<text x="' + (pl - 9) + '" y="' + (gy + 3).toFixed(1) +
        '" text-anchor="end" fill="#6c607c" font-family="Space Grotesk, monospace" font-size="9">' +
        Math.round(maxV * g / 3) + '</text>');
    }

    if (maxO > 0) {
      svg.push('<text x="' + (W - pr + 6) + '" y="' + (pt + 4) +
        '" fill="#ffa24d" font-family="Space Grotesk, monospace" font-size="8.5">' + maxO + '</text>');
      svg.push('<text x="' + (W - pr + 6) + '" y="' + (pt + ih) +
        '" fill="#6c607c" font-family="Space Grotesk, monospace" font-size="8.5">0</text>');
    }

    daily.forEach(function (day, index) {
      var visits = num(day.visits);
      var orders = num(day.orders);
      var x = pl + step * index;
      var bh = maxV ? (visits / maxV) * ih : 0;
      var by = pt + ih - bh;
      var date = String(day.date || '').slice(5).replace('-', '/');

      svg.push('<g>');
      svg.push('<title>' + date + ' · 방문 ' + visits + ' · 예매 ' + orders + '</title>');
      svg.push('<rect x="' + (x + 1).toFixed(1) + '" y="' + pt + '" width="' + Math.max(step - 2, 1).toFixed(1) +
        '" height="' + ih + '" fill="transparent"/>');
      if (visits > 0) {
        svg.push('<rect x="' + (x + (step - barW) / 2).toFixed(1) + '" y="' + by.toFixed(1) +
          '" width="' + barW.toFixed(1) + '" height="' + Math.max(bh, 1.5).toFixed(1) +
          '" rx="4" fill="url(#barGrad)"/>');
      }
      svg.push('</g>');

      if (index % labelEvery === 0 || index === n - 1) {
        svg.push('<text x="' + (x + step / 2).toFixed(1) + '" y="' + (H - 9) +
          '" text-anchor="middle" fill="#6c607c" font-family="Space Grotesk, monospace" font-size="9">' +
          date + '</text>');
      }
    });

    var points = daily.map(function (day, index) {
      var x = pl + step * index + step / 2;
      var y = pt + ih - ((num(day.orders) / maxO) * (ih - 8));
      return [x, Math.max(pt + 4, y)];
    });

    var path = points.map(function (p, i) {
      return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    }).join(' ');

    svg.push('<path d="' + path + '" fill="none" stroke="#ff7a18" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>');

    points.forEach(function (p) {
      svg.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) +
        '" r="3" fill="#0a060f" stroke="#ff7a18" stroke-width="2"/>');
    });

    svg.push('</svg>');
    els.chart.innerHTML = svg.join('');
  }

  /* ------------------------------------------------------------------ tickets */
  function renderTickets(tickets) {
    if (!tickets || !tickets.length || !num(tickets.reduce(function (sum, t) { return sum + (Number(t.revenue) || 0); }, 0))) {
      els.tickets.innerHTML = empty('아직 판매된 티켓이 없습니다.');
      return;
    }

    var totalRevenue = tickets.reduce(function (sum, t) { return sum + (Number(t.revenue) || 0); }, 0);
    var cursor = 0;
    var stops = tickets.map(function (ticket, index) {
      var share = (Number(ticket.revenue) || 0) / totalRevenue * 100;
      var start = cursor;
      cursor += share;
      return ticketColor(ticket.ticket_type, index) + ' ' + start.toFixed(2) + '% ' + cursor.toFixed(2) + '%';
    });

    var legend = tickets.map(function (ticket, index) {
      var share = (Number(ticket.revenue) || 0) / totalRevenue * 100;
      return '' +
        '<li class="mix-item">' +
          '<i style="background:' + ticketColor(ticket.ticket_type, index) + '"></i>' +
          '<span class="mix-name">' + esc(ticketLabel(ticket.ticket_type)) + '</span>' +
          '<strong>' + fmt(ticket.orders) + '건</strong>' +
          '<em>' + share.toFixed(1) + '%</em>' +
        '</li>';
    }).join('');

    els.tickets.innerHTML = '' +
      '<div class="donut-wrap">' +
        '<div class="donut-ring" style="background:conic-gradient(' + stops.join(',') + ')"></div>' +
        '<div class="donut-center"><span>총 매출</span><strong>' + fmt(totalRevenue) + '원</strong>' +
        '<span>' + fmt(tickets.reduce(function (s, t) { return s + (Number(t.tickets) || 0); }, 0)) + '매</span></div>' +
      '</div>' +
      '<ul class="mix-legend">' + legend + '</ul>';
  }

  /* ------------------------------------------------------------------ buttons */
  function renderButtons(buttons) {
    if (!buttons || !buttons.length) {
      els.buttons.innerHTML = empty('수집된 클릭 이벤트가 없습니다.');
      return;
    }

    var maxClicks = Math.max.apply(null, buttons.map(function (b) { return num(b.clicks); }).concat([1]));

    var rows = buttons.map(function (button) {
      var width = num(button.clicks) / maxClicks * 100;
      return '' +
        '<div class="bt-row">' +
          '<div class="bt-name">' +
            '<strong>' + esc(button.label || button.element) + '</strong>' +
            '<em>#' + esc(button.element || 'unknown') + ' · ' + esc(button.section || '-') + '</em>' +
          '</div>' +
          '<div class="bt-bar">' +
            '<span class="track"><span class="fill" style="display:block;width:' + width.toFixed(1) + '%"></span></span>' +
            '<b>' + fmt(button.clicks) + '</b>' +
          '</div>' +
          '<div class="bt-sessions">' + fmt(button.sessions) + '</div>' +
        '</div>';
    }).join('');

    els.buttons.innerHTML = '' +
      '<div class="bt-head"><span>버튼</span><span>클릭 수</span><span>세션</span></div>' +
      rows;
  }

  /* ------------------------------------------------------------------ devices */
  function renderDevices(devices, totals) {
    var labels = { mobile: '모바일', desktop: '데스크톱', unknown: '기타' };
    var total = devices.reduce(function (sum, d) { return sum + num(d.sessions); }, 0);

    var rows = devices.map(function (device) {
      var share = pct(num(device.sessions), total);
      return '' +
        '<div class="device-row">' +
          '<div class="device-head">' +
            '<span>' + (labels[device.device] || esc(device.device)) + '</span>' +
            '<strong>' + pct1(share) + '</strong>' +
          '</div>' +
          '<div class="device-bar"><i style="width:' + share.toFixed(1) + '%"></i></div>' +
          '<span class="device-count">' + fmt(device.sessions) + ' 세션</span>' +
        '</div>';
    }).join('');

    var engagement = '' +
      '<div class="engagement-grid">' +
        '<div><span>참여 세션</span><strong>' + fmt(totals.engaged_sessions) + '</strong></div>' +
        '<div><span>평균 활동 시간</span><strong>' + fmt(totals.avg_activity) + '초</strong></div>' +
      '</div>';

    els.devices.innerHTML = (rows || empty('디바이스 데이터가 없습니다.')) + engagement;
  }

  /* --------------------------------------------------------------------- feed */
  function relTime(iso) {
    var date = new Date(iso);
    var diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) return '방금 전';
    if (diff < 3600) return Math.floor(diff / 60) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    return new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit' }).format(date);
  }

  function feedDetail(event) {
    var meta = event.metadata || {};
    if (event.event_name === 'click') return meta.label || event.element || '-';
    if (event.event_name === 'purchase') {
      return ticketLabel(meta.ticket_type) + ' × ' + fmt(meta.quantity || 1) + ' · ' + fmt(meta.amount) + '원';
    }
    if (event.event_name === 'checkout_open' || event.event_name === 'checkout_abandon') {
      return ticketLabel(meta.ticket_type);
    }
    if (event.event_name === 'page_leave') {
      return fmt(meta.seconds || 0) + '초 체류 · 스크롤 ' + fmt(meta.scroll_depth || 0) + '%';
    }
    if (event.event_name === 'section_view') return (event.section || '-') + ' 섹션';
    if (event.event_name === 'page_view') {
      var device = meta.device === 'mobile' ? '모바일' : '데스크톱';
      return meta.utm_source ? device + ' · ' + meta.utm_source : device + ' 유입';
    }
    return event.section || event.element || '-';
  }

  function renderFeed(events) {
    els.feedCount.textContent = fmt(events.length) + '건';

    if (!events.length) {
      els.feed.innerHTML = empty('아직 수집된 이벤트가 없습니다.');
      return;
    }

    var rows = events.map(function (event) {
      var isDemo = event.metadata && event.metadata.demo;
      var label = EVENT_LABELS[event.event_name] || event.event_name;
      return '' +
        '<li class="feed-item">' +
          '<span class="feed-dot" data-type="' + esc(event.event_name) + '"></span>' +
          '<div class="feed-main">' +
            '<div class="feed-line">' +
              '<strong>' + esc(label) + '</strong>' +
              '<span class="feed-detail">' + esc(feedDetail(event)) + '</span>' +
              (isDemo ? '<span class="demo-tag">DEMO</span>' : '') +
            '</div>' +
            '<div class="feed-sub">#' + esc(event.session_id) + ' · ' + esc(event.element || event.section || '-') + '</div>' +
          '</div>' +
          '<time class="feed-time">' + relTime(event.created_at) + '</time>' +
        '</li>';
    }).join('');

    els.feed.innerHTML = '<ul class="feed-list">' + rows + '</ul>';
  }

  /* ---------------------------------------------------------------------- meta */
  function formatDateShort(iso) {
    if (!iso) return '-';
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit'
    }).format(new Date(iso));
  }

  function updateMeta(stats) {
    var days = num(stats.window_days) || state.days;
    var now = new Date();
    var start = new Date(now.getTime() - (days - 1) * 86400000);
    els.range.textContent = formatDateShort(start) + ' – ' + formatDateShort(now) + ' (' + days + '일)';
    els.updated.textContent = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date()) + ' KST';

    var sessions = num((stats.totals || {}).sessions);
    if (sessions === 0) {
      els.notice.hidden = false;
      els.notice.innerHTML = '<strong>아직 수집된 데이터가 없습니다.</strong> 이벤트 페이지를 방문하면 실시간으로 로그가 쌓입니다. 우측 상단의 <strong>데모 데이터</strong> 버튼으로 합성 데이터를 생성해 대시보드를 확인할 수 있습니다.';
    } else {
      els.notice.hidden = true;
    }
  }

  function renderAll() {
    var stats = state.data || {};
    renderKpis(stats);
    renderFunnel(stats);
    renderInsights(stats);
    renderChart(stats.daily || []);
    renderTickets(stats.tickets || []);
    renderButtons(stats.buttons || []);
    renderDevices(stats.devices || [], stats.totals || {});
    renderFeed(state.feed || []);
    updateMeta(stats);
  }

  /* -------------------------------------------------------------------- status */
  function showError(message) {
    els.error.hidden = false;
    els.error.innerHTML = '<strong>데이터를 불러오지 못했습니다.</strong> ' + esc(message) +
      '<br>네트워크 연결과 Supabase RPC 권한을 확인해 주세요.';
  }

  function hideError() { els.error.hidden = true; }

  function setBusy(busy) {
    els.refresh.disabled = busy;
    els.refresh.textContent = busy ? '불러오는 중' : '새로고침';
  }

  function toast(message) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('is-show'); });
    setTimeout(function () {
      el.classList.remove('is-show');
      setTimeout(function () { el.remove(); }, 300);
    }, 2400);
  }

  /* ---------------------------------------------------------------------- load */
  function load() {
    if (state.loading) return;
    if (!api || !api.ready) {
      showError('assets/config.js의 Supabase URL과 키를 확인해 주세요.');
      return;
    }

    state.loading = true;
    setBusy(true);
    hideError();

    Promise.all([
      api.rpc('get_growth_stats', { p_days: state.days }),
      api.rpc('get_recent_events', { p_limit: 30 })
    ]).then(function (results) {
      state.data = results[0] || {};
      state.feed = results[1] || [];
      renderAll();
    }).catch(function (error) {
      showError(error && error.message ? error.message : '알 수 없는 오류');
    }).then(function () {
      state.loading = false;
      setBusy(false);
    });
  }

  /* -------------------------------------------------------------------- events */
  Array.prototype.forEach.call(els.period, function (button) {
    button.addEventListener('click', function () {
      var days = parseInt(button.getAttribute('data-period'), 10);
      if (!days || days === state.days) return;
      state.days = days;
      Array.prototype.forEach.call(els.period, function (other) {
        other.classList.toggle('is-active', other === button);
      });
      load();
    });
  });

  if (els.refresh) {
    els.refresh.addEventListener('click', function () { load(); });
  }

  if (els.seed) {
    els.seed.addEventListener('click', function () {
      var ok = window.confirm(
        '데모 데이터를 다시 생성할까요?\n\n' +
        '· 기존 데모 로그는 삭제되고 최근 ' + state.days + '일치 합성 세션이 생성됩니다.\n' +
        '· 실제 방문 로그는 유지됩니다.'
      );
      if (!ok) return;

      els.seed.disabled = true;
      els.seed.textContent = '생성 중...';

      api.rpc('seed_demo_data', { p_days: state.days, p_sessions_per_day: 35 })
        .then(function (result) {
          toast('데모 데이터 ' + fmt(result && result.inserted) + '건을 생성했습니다');
          return load();
        })
        .catch(function (error) {
          showError(error && error.message ? error.message : '데모 데이터 생성 실패');
        })
        .then(function () {
          els.seed.disabled = false;
          els.seed.textContent = '데모 데이터';
        });
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') load();
  });

  setInterval(function () {
    if (document.visibilityState === 'visible') load();
  }, 30000);

  load();
})();
