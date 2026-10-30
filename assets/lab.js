(function () {
  'use strict';

  var api = window.PNUSupabase;
  var won = new Intl.NumberFormat('ko-KR');
  var state = { days: 14, loading: false, growth: null, seg: null, exp: null, results: [] };

  var els = {
    kpis: document.getElementById('lab-kpis'),
    funnel: document.getElementById('lab-funnel'),
    funnelChip: document.getElementById('funnel-chip'),
    bottleneck: document.getElementById('bottleneck'),
    bottleneckChip: document.getElementById('bottleneck-chip'),
    correlations: document.getElementById('correlations'),
    corrN: document.getElementById('corr-n'),
    corrTrap: document.getElementById('corr-trap'),
    segments: document.getElementById('segment-body'),
    hypotheses: document.getElementById('hypo-grid'),
    design: document.getElementById('design-grid'),
    results: document.getElementById('result-grid'),
    sample: document.getElementById('sample-label'),
    range: document.getElementById('range-label'),
    updated: document.getElementById('updated-at'),
    error: document.getElementById('error-banner'),
    notice: document.getElementById('notice-banner'),
    refresh: document.getElementById('refresh-btn'),
    seed: document.getElementById('seed-btn'),
    period: document.querySelectorAll('[data-period]')
  };

  var CONFIGS = [
    {
      key: 'exp_price_frame',
      tag: 'EXP-01',
      name: '티켓 가격 프레이밍',
      question: '총액 대신 1인당 가격을 보여주면 예매 시작이 늘어날까?',
      metric: '티켓 확인 → 예매 시작',
      variants: {
        A: '총액 표시 — COUPLE 20,000원',
        B: '1인당 표시 — 1인 10,000원 (총 20,000원)'
      },
      baseline: 0.414,
      mde: 0.06,
      guardrail: '구매 전환율 · 객단가'
    },
    {
      key: 'exp_quick_checkout',
      tag: 'EXP-02',
      name: '결제 마찰 (원클릭)',
      question: '이름·연락처 입력을 없애면 결제 완료가 늘어날까?',
      metric: '예매 시작 → 예매 완료',
      variants: {
        A: '입력 폼 — 이름 · 연락처 · 동의',
        B: '원클릭 예매 — 동의 후 바로 완료'
      },
      baseline: 0.486,
      mde: 0.09,
      guardrail: '객단가 · 허위 예매율'
    }
  ];

  var DIM_ORDER = ['device', 'source', 'time', 'clicks', 'sections'];
  var DIM_LABELS = {
    device: '디바이스',
    source: '유입 채널',
    time: '시간대',
    clicks: '클릭 수',
    sections: '도달 섹션 수'
  };
  var SEG_LABELS = {
    mobile: '모바일',
    desktop: '데스크톱',
    unknown: '기타',
    instagram: '인스타그램',
    search: '검색',
    direct: '직접 유입',
    campus: '교내',
    other: '기타',
    evening: '저녁 18–24',
    afternoon: '오후 12–18',
    morning: '오전 6–12',
    night: '새벽 0–6',
    '0': '0회',
    '1': '1회',
    '2': '2회',
    '3+': '3회 이상'
  };

  var CORR_DEFS = [
    { key: 'clicks', label: '클릭 수 ↔ 구매', hint: '참여 행동' },
    { key: 'sections', label: '도달 섹션 수 ↔ 구매', hint: '콘텐츠 소비' },
    { key: 'mobile', label: '모바일 ↔ 구매', hint: '디바이스' },
    { key: 'instagram', label: '인스타그램 유입 ↔ 구매', hint: '유입 채널' },
    { key: 'evening', label: '저녁 18시 이후 ↔ 구매', hint: '시간대' },
    { key: 'activity', label: '활동 시간 ↔ 구매', hint: '함정 · 역인과', trap: true }
  ];

  /* --------------------------------------------------------------- helpers */
  function num(value) { return Number(value) || 0; }
  function fmt(value) { return won.format(Math.round(Number(value) || 0)); }
  function pct1(rate) { return (Math.round(rate * 1000) / 10).toFixed(1) + '%'; }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function signed(value, digits) {
    var n = Number(value) || 0;
    return (n > 0 ? '+' : '') + n.toFixed(digits == null ? 1 : digits);
  }

  function pFmt(p) {
    if (p == null || isNaN(p)) return '—';
    if (p < 0.001) return '<0.001';
    return Number(p).toFixed(3);
  }

  function pLabel(p) {
    var formatted = pFmt(p);
    return formatted.charAt(0) === '<' ? 'p' + formatted : 'p=' + formatted;
  }

  function erf(x) {
    var sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var a1 = 0.254829592;
    var a2 = -0.284496736;
    var a3 = 1.421413741;
    var a4 = -1.453152027;
    var a5 = 1.061405429;
    var p = 0.3275911;
    var t = 1 / (1 + p * x);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

  function compare(x1, n1, x2, n2) {
    var p1 = n1 ? x1 / n1 : 0;
    var p2 = n2 ? x2 / n2 : 0;
    var pooled = (n1 + n2) ? (x1 + x2) / (n1 + n2) : 0;
    var se = Math.sqrt(pooled * (1 - pooled) * ((n1 ? 1 / n1 : 0) + (n2 ? 1 / n2 : 0)));
    var z = se > 0 ? (p2 - p1) / se : 0;
    var pValue = 2 * (1 - normalCdf(Math.abs(z)));
    var seUn = Math.sqrt((n1 ? p1 * (1 - p1) / n1 : 0) + (n2 ? p2 * (1 - p2) / n2 : 0));
    var diff = p2 - p1;
    return {
      p1: p1,
      p2: p2,
      diff: diff,
      z: z,
      p: Math.min(1, Math.max(0, pValue)),
      ciLow: diff - 1.959964 * seUn,
      ciHigh: diff + 1.959964 * seUn
    };
  }

  function srmP(n1, n2) {
    var total = n1 + n2;
    if (!total) return 1;
    var z = (n1 - total / 2) / Math.sqrt(total * 0.25);
    return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  }

  function corrP(r, n) {
    if (r == null || !n || n < 3) return 1;
    var z = Number(r) * Math.sqrt(n);
    return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  }

  function requiredSample(p1, mde) {
    var p2 = Math.min(0.99, p1 + mde);
    var pbar = (p1 + p2) / 2;
    var zAlpha = 1.959964;
    var zBeta = 0.841621;
    var numerator = Math.pow(
      zAlpha * Math.sqrt(2 * pbar * (1 - pbar)) +
      zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)), 2
    );
    return Math.ceil(numerator / Math.pow(p2 - p1, 2));
  }

  function corrStrength(r) {
    var a = Math.abs(r);
    if (a < 0.05) return '거의 없음';
    if (a < 0.1) return '매우 약함';
    if (a < 0.3) return '약함';
    if (a < 0.5) return '중간';
    return '강함';
  }

  function segRate(dim, key) {
    var rows = (state.seg && state.seg.segments) || [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].dimension === dim && rows[i].key === key) {
        return rows[i].sessions ? rows[i].buyers / rows[i].sessions : 0;
      }
    }
    return 0;
  }

  function segFind(dim, key) {
    var rows = (state.seg && state.seg.segments) || [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].dimension === dim && rows[i].key === key) return rows[i];
    }
    return null;
  }

  function biggestDrop(funnel) {
    var best = null;
    for (var i = 1; i < funnel.length; i += 1) {
      var prev = num(funnel[i - 1].count);
      var cur = num(funnel[i].count);
      if (prev > 0) {
        var drop = 100 - (cur / prev) * 100;
        if (!best || drop > best.drop) {
          best = {
            drop: drop,
            from: funnel[i - 1].label,
            to: funnel[i].label,
            lost: prev - cur,
            prev: prev,
            cur: cur,
            index: i
          };
        }
      }
    }
    return best;
  }

  function stageDrop(funnel, key) {
    for (var i = 1; i < funnel.length; i += 1) {
      if (funnel[i].key === key) {
        var prev = num(funnel[i - 1].count);
        var cur = num(funnel[i].count);
        if (prev <= 0) return null;
        return {
          drop: 100 - (cur / prev) * 100,
          lost: prev - cur,
          from: funnel[i - 1].label,
          to: funnel[i].label,
          index: i
        };
      }
    }
    return null;
  }

  function findExp(key) {
    var list = state.exp || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].key === key) return list[i];
    }
    return null;
  }

  function findVariant(exp, variant) {
    if (!exp || !exp.variants) return { variant: variant };
    for (var i = 0; i < exp.variants.length; i += 1) {
      if (exp.variants[i].variant === variant) return exp.variants[i];
    }
    return { variant: variant };
  }

  /* -------------------------------------------------------------------- kpi */
  function renderKpis() {
    var t = (state.growth && state.growth.totals) || {};
    var f = (state.growth && state.growth.funnel) || [];
    var drop = biggestDrop(f);
    var visits = f.length ? num(f[0].count) : 0;
    var buyers = f.length ? num(f[f.length - 1].count) : 0;
    var conv = visits ? buyers / visits : 0;
    var wins = state.results.filter(function (r) { return r && r.decision && r.decision.type === 'win'; }).length;

    var cards = [
      {
        accent: 'purple',
        label: '분석 세션', tag: 'SAMPLE',
        value: fmt(t.sessions),
        sub: '실험 표본 포함 · <strong>' + fmt(t.events) + '</strong> 이벤트'
      },
      {
        accent: 'green',
        label: '전체 전환율', tag: 'CVR',
        value: pct1(conv),
        sub: '<strong>' + fmt(buyers) + '</strong>명 예매 · <strong>' + fmt(t.revenue) + '원</strong>'
      },
      {
        accent: 'orange',
        label: '최대 병목', tag: 'BOTTLENECK',
        value: drop ? drop.drop.toFixed(1) + '%' : '—',
        sub: drop ? esc(drop.from) + ' → ' + esc(drop.to) : '데이터 없음'
      },
      {
        accent: 'pink',
        label: '검증된 개선', tag: 'WINS',
        value: wins + '건',
        sub: '사전 등록 실험 <strong>2</strong>건 중'
      }
    ];

    els.kpis.innerHTML = cards.map(function (c) {
      return '' +
        '<article class="kpi accent-' + c.accent + '">' +
          '<div class="kpi-top"><span class="kpi-label">' + c.label + '</span>' +
          '<span class="kpi-tag">' + c.tag + '</span></div>' +
          '<strong class="kpi-value">' + c.value + '</strong>' +
          '<p class="kpi-sub">' + c.sub + '</p>' +
        '</article>';
    }).join('');
  }

  /* ----------------------------------------------------------------- funnel */
  function renderFunnel() {
    var steps = (state.growth && state.growth.funnel) || [];
    if (!steps.length || !num(steps[0].count)) {
      els.funnel.innerHTML = '<div class="empty-state">퍼널 데이터가 없습니다.</div>';
      els.funnelChip.textContent = '데이터 없음';
      return;
    }

    var base = num(steps[0].count);
    var drop = biggestDrop(steps);
    els.funnelChip.textContent = '방문 → 예매 ' + pct1(num(steps[steps.length - 1].count) / base);

    els.funnel.innerHTML = steps.map(function (step, index) {
      var count = num(step.count);
      var width = Math.max((count / base) * 100, count > 0 ? 2 : 0);
      var prev = index > 0 ? num(steps[index - 1].count) : 0;
      var dropHtml = '<span class="drop-badge is-first">기준</span><em>START</em>';

      if (index > 0) {
        if (prev > 0) {
          var value = 100 - (count / prev) * 100;
          dropHtml = '<span class="drop-badge">−' + value.toFixed(1) + '%</span><em>이탈</em>';
        } else {
          dropHtml = '<span class="drop-badge is-first">—</span><em>이탈</em>';
        }
      }

      var isBottleneck = drop && drop.index === index;
      return '' +
        '<div class="funnel-row' + (isBottleneck ? ' is-bottleneck' : '') + '">' +
          '<div class="funnel-label">' +
            '<span class="funnel-step">' + String(index + 1).padStart(2, '0') + '</span>' +
            '<div><strong>' + esc(step.label) + '</strong>' +
            '<em>' + fmt(count) + ' 세션</em></div>' +
          '</div>' +
          '<div class="funnel-track"><div class="funnel-bar" style="width:' + width.toFixed(1) + '%"></div></div>' +
          '<div class="funnel-rate"><strong>' + (index === 0 ? '100%' : pct1(count / base)) + '</strong><span>전환</span></div>' +
          '<div class="funnel-drop">' + dropHtml + '</div>' +
        '</div>';
    }).join('');
  }

  /* ------------------------------------------------------------- bottleneck */
  function renderBottleneck() {
    var funnel = (state.growth && state.growth.funnel) || [];
    var drop = biggestDrop(funnel);
    if (!drop) {
      els.bottleneck.innerHTML = '<div class="empty-state">병목을 계산할 데이터가 없습니다.</div>';
      els.bottleneckChip.textContent = '—';
      return;
    }

    els.bottleneckChip.textContent = '−' + drop.drop.toFixed(1) + '%';

    var mobile = segFind('device', 'mobile');
    var desktop = segFind('device', 'desktop');
    var mobileRate = mobile ? mobile.buyers / mobile.sessions : 0;
    var desktopRate = desktop ? desktop.buyers / desktop.sessions : 0;
    var deviceGap = (mobileRate - desktopRate) * 100;

    var ticketDrop = stageDrop(funnel, 'checkout');
    var click0 = segFind('clicks', '0');
    var click2 = segFind('clicks', '2');
    var click0Rate = click0 ? click0.buyers / click0.sessions : 0;
    var click2Rate = click2 ? click2.buyers / click2.sessions : 0;

    els.bottleneck.innerHTML = '' +
      '<div class="bottleneck-path"><b>' + esc(drop.from) + '</b><i>→</i><b>' + esc(drop.to) + '</b></div>' +
      '<div class="bottleneck-number">' + drop.drop.toFixed(1) + '%<em>이탈</em></div>' +
      '<p class="bottleneck-sub">' + fmt(drop.lost) + '세션 유실 · 퍼널 최대 낙차</p>' +
      '<ul class="bottleneck-evidence">' +
        '<li>모바일 구매 전환 <b>' + pct1(mobileRate) + '</b> vs 데스크톱 <b>' + pct1(desktopRate) +
          '</b> · <b>' + signed(deviceGap, 1) + 'pp</b></li>' +
        '<li>두 번째 병목: 티켓 확인 → 예매 시작 <b>' +
          (ticketDrop ? ticketDrop.drop.toFixed(1) + '%' : '—') + '</b> · <b>' +
          fmt(ticketDrop ? ticketDrop.lost : 0) + '</b>세션 유실</li>' +
        '<li>클릭 0회 전환 <b>' + pct1(click0Rate) + '</b> → 2회 <b>' + pct1(click2Rate) +
          '</b>. 참여도가 높을수록 구매 가능성이 큽니다.</li>' +
      '</ul>';
  }

  /* ----------------------------------------------------------- correlations */
  function renderCorrelations() {
    var corr = (state.seg && state.seg.correlations) || {};
    var n = num(corr.n);
    els.corrN.textContent = n ? 'n=' + fmt(n) : '—';

    els.correlations.innerHTML = CORR_DEFS.map(function (def) {
      var r = corr[def.key];
      if (r == null || isNaN(r)) {
        return '' +
          '<div class="corr-card"><div class="corr-top"><span class="corr-label">' + def.label +
          '</span><span class="corr-r zero">—</span></div>' +
          '<div class="corr-bar"></div>' +
          '<div class="corr-meta"><span>표본 부족</span><span>' + def.hint + '</span></div></div>';
      }
      r = Number(r);
      var pValue = corrP(r, n);
      var cls = r > 0 ? 'pos' : (r < 0 ? 'neg' : 'zero');
      var color = r > 0 ? 'var(--green)' : 'var(--red)';
      var width = Math.min(100, Math.max(2, Math.abs(r) * 100));

      return '' +
        '<div class="corr-card' + (def.trap ? ' is-trap' : '') + '">' +
          '<div class="corr-top">' +
            '<span class="corr-label">' + def.label + (def.trap ? ' <b style="color:var(--red)">!</b>' : '') + '</span>' +
            '<span class="corr-r ' + cls + '">' + (r > 0 ? '+' : '') + r.toFixed(3) + '</span>' +
          '</div>' +
          '<div class="corr-bar"><i style="width:' + width.toFixed(1) + '%;background:' + color + '"></i></div>' +
          '<div class="corr-meta"><span>' + pLabel(pValue) + ' · ' + corrStrength(r) + '</span><span>' + def.hint + '</span></div>' +
        '</div>';
    }).join('');

    var active = corr.activity;
    var clickR = Number(corr.clicks) || 0;
    var clickP = corrP(clickR, n);
    if (active != null) {
      els.corrTrap.hidden = false;
      els.corrTrap.innerHTML = '<strong>함정 · 활동 시간 r=' + Number(active).toFixed(2) +
        '</strong> 구매 이벤트가 세션 길이를 늘리는 역인과입니다. 인과 해석 금지, 분석에서 제외. <br>' +
        '또한 <strong>유의성 ≠ 효과 크기</strong>: 클릭 수 r=' + clickR.toFixed(3) +
        '은 ' + pLabel(clickP) + '이지만 설명력은 ' + (clickR * clickR * 100).toFixed(1) + '% 수준입니다.';
    }
  }

  /* -------------------------------------------------------------- segments */
  function renderSegments() {
    var seg = state.seg;
    if (!seg || !seg.overall || !seg.overall.sessions) {
      els.segments.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--dim)">세그먼트 데이터가 없습니다.</td></tr>';
      return;
    }

    var overall = seg.overall;
    var rows = seg.segments || [];
    var html = '';

    DIM_ORDER.forEach(function (dim) {
      var group = rows.filter(function (row) { return row.dimension === dim; });
      if (!group.length) return;

      group.sort(function (a, b) {
        var ra = a.sessions ? a.buyers / a.sessions : 0;
        var rb = b.sessions ? b.buyers / b.sessions : 0;
        return rb - ra;
      });

      html += '<tr class="seg-group"><td colspan="6">' + DIM_LABELS[dim] + '</td></tr>';

      group.forEach(function (row) {
        var sessions = num(row.sessions);
        var buyers = num(row.buyers);
        var rate = sessions ? buyers / sessions : 0;
        var restSessions = overall.sessions - sessions;
        var restBuyers = overall.buyers - buyers;
        var restRate = restSessions > 0 ? restBuyers / restSessions : 0;
        var cmp = compare(buyers, sessions, restBuyers, restSessions);
        var lift = (rate - restRate) * 100;
        var label = SEG_LABELS[row.key] || String(row.key);
        var significant = cmp.p < 0.05 && sessions >= 30;

        html += '' +
          '<tr>' +
            '<td>' + esc(label) + (sessions < 30 ? ' <span style="color:var(--dim);font-size:8px">n<30</span>' : '') + '</td>' +
            '<td>' + fmt(sessions) + '</td>' +
            '<td>' + fmt(buyers) + '</td>' +
            '<td class="cvr">' + pct1(rate) + '</td>' +
            '<td class="seg-lift ' + (lift >= 0 ? 'pos' : 'neg') + '">' + signed(lift, 1) + 'pp</td>' +
            '<td class="seg-p' + (significant ? ' sig' : '') + '">' + pFmt(cmp.p) + '</td>' +
          '</tr>';
      });
    });

    els.segments.innerHTML = html;
  }

  /* ------------------------------------------------------------ hypotheses */
  function renderHypotheses() {
    var funnel = (state.growth && state.growth.funnel) || [];
    var e1Drop = stageDrop(funnel, 'checkout');
    var e2Drop = stageDrop(funnel, 'purchase');

    var mobile = segFind('device', 'mobile');
    var desktop = segFind('device', 'desktop');
    var mobileRate = mobile ? mobile.buyers / mobile.sessions : 0;
    var desktopRate = desktop ? desktop.buyers / desktop.sessions : 0;
    var click0 = segFind('clicks', '0');
    var click2 = segFind('clicks', '2');
    var click0Rate = click0 ? click0.buyers / click0.sessions : 0;
    var click2Rate = click2 ? click2.buyers / click2.sessions : 0;

    var e1 = state.results.filter(function (r) { return r && r.config.key === 'exp_price_frame'; })[0];
    var e2 = state.results.filter(function (r) { return r && r.config.key === 'exp_quick_checkout'; })[0];
    var e1Lift = e1 && e1.cmp ? e1.cmp.diff / e1.cmp.p1 * 100 : 0;
    var e2Lift = e2 && e2.cmp ? e2.cmp.diff / e2.cmp.p1 * 100 : 0;

    var cards = [
      {
        idx: 'H1 · EXP-01',
        status: e1 && e1.decision && e1.decision.type === 'win' ? '검증됨' : '검증 중',
        future: false,
        title: '총액 대신 1인당 가격을 보여주면 예매 시작이 늘어난다',
        evidence: '티켓 확인 → 예매 시작 <b>' + (e1Drop ? e1Drop.drop.toFixed(1) + '%' : '—') +
          '</b> 이탈 · 모바일 전환 <b>' + pct1(mobileRate) + '</b> vs 데스크톱 <b>' + pct1(desktopRate) + '</b>',
        change: '개입: <strong>COUPLE 20,000원 → 1인 10,000원</strong>으로 가격 프레이밍 전환',
        footLeft: 'PRIMARY · 티켓 확인 → 예매 시작',
        footRight: '관측 ' + (e1 ? signed(e1Lift, 1) + '%' : '—')
      },
      {
        idx: 'H2 · EXP-02',
        status: e2 && e2.decision && e2.decision.type === 'win' ? '검증됨' : '검증 중',
        future: false,
        title: '이름·연락처 입력이 마지막 결제를 막는다',
        evidence: '예매 시작 → 완료 <b>' + (e2Drop ? e2Drop.drop.toFixed(1) + '%' : '—') +
          '</b> 이탈 · 원클릭 B안 <b>' + signed(e2Lift, 1) + '%</b> 개선',
        change: '개입: <strong>원클릭 예매</strong> — 입력 폼 제거, 동의 후 즉시 완료',
        footLeft: 'PRIMARY · 예매 시작 → 예매 완료',
        footRight: '관측 ' + (e2 ? signed(e2Lift, 1) + '%' : '—')
      },
      {
        idx: 'H3 · NEXT',
        status: '다음 실험',
        future: true,
        title: '잔여 수량과 마감 시각을 보여주면 망설임이 줄어든다',
        evidence: '클릭 0회 전환 <b>' + pct1(click0Rate) + '</b> → 2회 <b>' + pct1(click2Rate) +
          '</b> · 참여도가 높을수록 전환↑',
        change: '개입: <strong>잔여 37매 · 오늘 자정 마감</strong> 배지 + 카운트다운',
        footLeft: 'PLANNED · EXP-03',
        footRight: '목표 +3~5pp'
      }
    ];

    els.hypotheses.innerHTML = cards.map(function (c) {
      return '' +
        '<article class="hypo-card' + (c.future ? ' is-future' : '') + '">' +
          '<div class="hypo-top">' +
            '<span class="hypo-idx">' + c.idx + '</span>' +
            '<span class="hypo-status' + (c.future ? ' is-future' : '') + '">' + c.status + '</span>' +
          '</div>' +
          '<h3>' + c.title + '</h3>' +
          '<div class="hypo-evidence">근거: ' + c.evidence + '</div>' +
          '<p class="hypo-change">' + c.change + '</p>' +
          '<div class="hypo-foot"><span>' + c.footLeft + '</span><span>' + c.footRight + '</span></div>' +
        '</article>';
    }).join('');
  }

  /* ---------------------------------------------------------------- results */
  function computeResult(config) {
    var exp = findExp(config.key);
    if (!exp || !exp.variants || exp.variants.length < 2) return null;

    var a = findVariant(exp, 'A');
    var b = findVariant(exp, 'B');
    var sim = (num(a.sim_sessions) + num(b.sim_sessions)) > 0;

    var A = sim
      ? { n: num(a.sim_sessions), x: num(a.sim_conversions), rev: num(a.sim_revenue), buys: num(a.sim_purchases) }
      : { n: num(a.live_sessions), x: num(a.live_conversions), rev: num(a.live_revenue), buys: num(a.live_purchases) };
    var B = sim
      ? { n: num(b.sim_sessions), x: num(b.sim_conversions), rev: num(b.sim_revenue), buys: num(b.sim_purchases) }
      : { n: num(b.live_sessions), x: num(b.live_conversions), rev: num(b.live_revenue), buys: num(b.live_purchases) };

    var live = {
      a: num(a.live_sessions),
      b: num(b.live_sessions)
    };
    var simN = {
      a: num(a.sim_sessions),
      b: num(b.sim_sessions)
    };

    if (!A.n || !B.n) {
      return {
        config: config,
        A: A,
        B: B,
        sim: sim,
        live: live,
        simN: simN,
        empty: true
      };
    }

    var cmp = compare(A.x, A.n, B.x, B.n);
    var required = requiredSample(config.baseline, config.mde);
    var powered = A.n >= required && B.n >= required;
    var srm = srmP(A.n, B.n);
    var aovA = A.buys ? A.rev / A.buys : 0;
    var aovB = B.buys ? B.rev / B.buys : 0;
    var revChange = A.rev ? (B.rev - A.rev) / A.rev * 100 : 0;
    var aovChange = aovA ? (aovB - aovA) / aovA * 100 : 0;

    var decision;
    if (cmp.p < 0.05 && powered) {
      decision = {
        type: 'win',
        label: 'B 채택',
        text: '<strong>B 채택</strong> · ' + config.metric + ' ' + pct1(cmp.p2) + ' vs ' + pct1(cmp.p1) +
          ' (' + signed(cmp.diff * 100, 1) + 'pp, ' + pLabel(cmp.p) + ') · 매출 ' + signed(revChange, 1) + '%' +
          (aovChange < -3 ? '<br>가드레일: 객단가 ' + signed(aovChange, 1) + '% — 모니터링 필요' : '')
      };
    } else if (cmp.p < 0.05) {
      decision = {
        type: 'early',
        label: '조기 신호',
        text: '<strong>조기 신호</strong> · ' + pLabel(cmp.p) + '이지만 설계 표본 ' + fmt(required) +
          '/변형에 미달합니다. 실험을 계속 진행하세요.'
      };
    } else if (powered) {
      decision = {
        type: 'flat',
        label: '차이 없음',
        text: '<strong>유의미한 차이 없음</strong> · ' + pLabel(cmp.p) + '. 다른 가설이 필요합니다.'
      };
    } else {
      decision = {
        type: 'pending',
        label: '진행 중',
        text: '<strong>진행 중</strong> · 현재 표본 ' + fmt(A.n) + '/' + fmt(B.n) +
          ' · 설계 표본 ' + fmt(required) + '/변형'
      };
    }

    return {
      config: config,
      A: A,
      B: B,
      cmp: cmp,
      required: required,
      powered: powered,
      srm: srm,
      aovA: aovA,
      aovB: aovB,
      revChange: revChange,
      aovChange: aovChange,
      decision: decision,
      sim: sim,
      live: live,
      simN: simN,
      empty: false
    };
  }

  function renderDesign() {
    els.design.innerHTML = CONFIGS.map(function (config) {
      var result = state.results.filter(function (r) { return r && r.config.key === config.key; })[0];
      var required = requiredSample(config.baseline, config.mde);
      var nA = result ? result.A.n : 0;
      var nB = result ? result.B.n : 0;
      var status = (nA >= required && nB >= required) ? '표본 충족' : '수집 중';

      return '' +
        '<article class="exp-card">' +
          '<div class="exp-head"><span class="exp-tag">' + config.tag + '</span>' +
          '<span class="panel-chip">' + status + '</span></div>' +
          '<h3>' + config.name + '</h3>' +
          '<p class="exp-question">' + config.question + '</p>' +
          '<div class="variant-list">' +
            '<div class="variant"><b>A</b><span>' + config.variants.A + '</span></div>' +
            '<div class="variant is-b"><b>B</b><span>' + config.variants.B + '</span></div>' +
          '</div>' +
          '<div class="exp-spec">' +
            '<div><span>1차 지표</span><strong>' + config.metric + '</strong></div>' +
            '<div><span>설계 표본</span><strong>' + fmt(required) + ' / 변형</strong></div>' +
            '<div><span>검정력</span><strong>80% · α 0.05</strong></div>' +
            '<div><span>가드레일</span><strong>' + config.guardrail + '</strong></div>' +
            '<div><span>현재 표본 A / B</span><strong>' + fmt(nA) + ' / ' + fmt(nB) + '</strong></div>' +
            '<div><span>기간</span><strong>' + state.days + '일</strong></div>' +
          '</div>' +
        '</article>';
    }).join('');
  }

  function renderResults() {
    els.results.innerHTML = state.results.map(function (r) {
      if (!r) return '';
      var config = r.config;

      if (r.empty) {
        return '' +
          '<article class="result-card">' +
            '<div class="result-head"><div><span class="exp-tag">' + config.tag + '</span>' +
            '<h3>' + config.name + '</h3></div><span class="result-badge">NO DATA</span></div>' +
            '<div class="empty-state" style="padding:32px 8px">실험 데이터가 없습니다.<br>상단의 <strong>실험 데이터 생성</strong> 버튼으로 시뮬레이션을 실행해 주세요.</div>' +
          '</article>';
      }

      var cmp = r.cmp;
      var win = r.decision.type === 'win';
      var bWins = cmp.diff > 0;
      var lift = cmp.p1 ? cmp.diff / cmp.p1 * 100 : 0;
      var simLabel = r.sim ? 'SIMULATED PILOT' : 'LIVE';

      return '' +
        '<article class="result-card">' +
          '<div class="result-head"><div><span class="exp-tag">' + config.tag + '</span>' +
          '<h3>' + config.name + '</h3></div>' +
          '<span class="result-badge' + (r.sim ? '' : ' is-live') + '">' + simLabel + '</span></div>' +
          '<div class="result-variants">' +
            '<div class="result-variant"><span>CONTROL · A</span><strong>' + pct1(cmp.p1) + '</strong>' +
              '<em>' + fmt(r.A.x) + ' / ' + fmt(r.A.n) + '</em></div>' +
            '<div class="result-variant' + (win && bWins ? ' is-winner' : '') + '"><span>VARIANT · B</span>' +
              '<strong>' + pct1(cmp.p2) + '</strong><em>' + fmt(r.B.x) + ' / ' + fmt(r.B.n) + '</em></div>' +
          '</div>' +
          '<div class="result-stats">' +
            '<div class="result-stat"><span>상대 개선</span><strong class="' + (lift >= 0 ? 'pos' : 'neg') + '">' + signed(lift, 1) + '%</strong></div>' +
            '<div class="result-stat"><span>95% CI</span><strong>' + signed(cmp.ciLow * 100, 1) + ' ~ ' + signed(cmp.ciHigh * 100, 1) + 'pp</strong></div>' +
            '<div class="result-stat"><span>p-value</span><strong class="' + (cmp.p < 0.05 ? 'pos' : '') + '">' + pFmt(cmp.p) + '</strong></div>' +
            '<div class="result-stat"><span>SRM</span><strong class="' + (r.srm > 0.05 ? 'pos' : 'neg') + '">' + pFmt(r.srm) + '</strong></div>' +
            '<div class="result-stat"><span>매출 변화</span><strong class="' + (r.revChange >= 0 ? 'pos' : 'neg') + '">' + signed(r.revChange, 1) + '%</strong></div>' +
            '<div class="result-stat"><span>객단가 변화</span><strong class="' + (r.aovChange >= 0 ? 'pos' : 'neg') + '">' + signed(r.aovChange, 1) + '%</strong></div>' +
          '</div>' +
          '<div class="decision ' + (r.decision.type === 'win' ? 'is-win' : (r.decision.type === 'early' ? 'is-early' : '')) + '">' +
            r.decision.text + '</div>' +
          '<div class="result-foot">' +
            '<span>실트래픽 ' + fmt(r.live.a + r.live.b) + '명</span>' +
            '<span>시뮬레이션 ' + fmt(r.simN.a + r.simN.b) + '명 · 설계 ' + fmt(r.required) + '/변형</span>' +
          '</div>' +
        '</article>';
    }).join('');
  }

  /* -------------------------------------------------------------------- meta */
  function formatDateShort(date) {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit'
    }).format(date);
  }

  function updateMeta() {
    var totals = (state.growth && state.growth.totals) || {};
    var days = num(state.growth && state.growth.window_days) || state.days;
    var now = new Date();
    var start = new Date(now.getTime() - (days - 1) * 86400000);

    els.sample.textContent = fmt(totals.sessions) + ' 세션';
    els.range.textContent = formatDateShort(start) + ' – ' + formatDateShort(now) + ' (' + days + '일)';
    els.updated.textContent = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date()) + ' KST';

    if (!num(totals.sessions)) {
      els.notice.hidden = false;
      els.notice.innerHTML = '<strong>분석할 데이터가 없습니다.</strong> 이벤트 페이지를 방문하거나 <strong>실험 데이터 생성</strong>으로 시뮬레이션을 실행해 주세요.';
    } else {
      els.notice.hidden = false;
      els.notice.innerHTML = '실험 결과는 <strong>시뮬레이션 파일럿</strong>입니다. 실제 트래픽이 쌓이면 같은 파이프라인으로 자동 갱신되며, 실트래픽 표본은 결과 카드에 함께 표시됩니다.';
    }
  }

  function renderAll() {
    state.results = CONFIGS.map(computeResult).filter(Boolean);
    renderKpis();
    renderFunnel();
    renderBottleneck();
    renderCorrelations();
    renderSegments();
    renderHypotheses();
    renderDesign();
    renderResults();
    updateMeta();
  }

  /* ------------------------------------------------------------------ status */
  function showError(message) {
    els.error.hidden = false;
    els.error.innerHTML = '<strong>데이터를 불러오지 못했습니다.</strong> ' + esc(message) +
      '<br>네트워크 연결과 Supabase RPC 권한을 확인해 주세요.';
  }

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
    }, 2600);
  }

  /* -------------------------------------------------------------------- load */
  function load() {
    if (state.loading) return;
    if (!api || !api.ready) {
      showError('assets/config.js의 Supabase URL과 키를 확인해 주세요.');
      return;
    }

    state.loading = true;
    setBusy(true);
    els.error.hidden = true;

    Promise.all([
      api.rpc('get_growth_stats', { p_days: state.days, p_include_sim: true }),
      api.rpc('get_segment_stats', { p_days: state.days }),
      api.rpc('get_experiment_stats', { p_days: state.days })
    ]).then(function (results) {
      state.growth = results[0] || {};
      state.seg = results[1] || {};
      state.exp = results[2] || [];
      renderAll();
    }).catch(function (error) {
      showError(error && error.message ? error.message : '알 수 없는 오류');
    }).then(function () {
      state.loading = false;
      setBusy(false);
    });
  }

  /* ------------------------------------------------------------------ events */
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

  els.refresh.addEventListener('click', function () { load(); });

  els.seed.addEventListener('click', function () {
    var ok = window.confirm(
      '실험 시뮬레이션 데이터를 다시 생성할까요?\n\n' +
      '· 기존 시뮬레이션 로그는 삭제됩니다.\n' +
      '· 최근 ' + state.days + '일치 실험 세션이 새로 생성됩니다.\n' +
      '· 메인 대시보드 퍼널에는 포함되지 않습니다.'
    );
    if (!ok) return;

    els.seed.disabled = true;
    els.seed.textContent = '생성 중...';

    api.rpc('seed_experiment_demo', { p_days: state.days, p_per_variant: 1200 })
      .then(function (result) {
        toast('실험 시뮬레이션 ' + fmt(result && result.events) + '건을 생성했습니다');
        return load();
      })
      .catch(function (error) {
        showError(error && error.message ? error.message : '시뮬레이션 생성 실패');
      })
      .then(function () {
        els.seed.disabled = false;
        els.seed.textContent = '실험 데이터 생성';
      });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') load();
  });

  setInterval(function () {
    if (document.visibilityState === 'visible') load();
  }, 60000);

  load();
})();
