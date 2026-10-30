(function () {
  'use strict';

  var cfg = window.PNU_CONFIG || {};
  var track = window.PNUTrack ? window.PNUTrack.event : function () {};
  var experiments = window.PNUExperiments || { exp_price_frame: 'A', exp_quick_checkout: 'A' };
  var won = new Intl.NumberFormat('ko-KR');

  document.body.classList.toggle('exp-price-b', experiments.exp_price_frame === 'B');

  var TICKETS = {
    solo: { type: 'SOLO', note: '1인 입장', price: 12000, persons: 1 },
    couple: { type: 'COUPLE', note: '2인 입장', price: 20000, persons: 2 },
    group: { type: 'GROUP', note: '4인 입장', price: 45000, persons: 4 }
  };

  /* ------------------------------------------------------------- reveal anim */
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    Array.prototype.forEach.call(reveals, function (el) { revealObserver.observe(el); });
  } else {
    Array.prototype.forEach.call(reveals, function (el) { el.classList.add('is-visible'); });
  }

  /* ------------------------------------------------------------------- nav */
  var nav = document.getElementById('nav');
  function onScroll() {
    if (!nav) return;
    nav.classList.toggle('is-scrolled', window.scrollY > 18);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------- countdown */
  var target = new Date(cfg.EVENT_DATE || '2026-10-31T18:00:00+09:00').getTime();
  var end = new Date(cfg.EVENT_END || '2026-10-31T23:00:00+09:00').getTime();
  var cells = {
    days: document.querySelector('[data-cd="days"]'),
    hours: document.querySelector('[data-cd="hours"]'),
    minutes: document.querySelector('[data-cd="minutes"]'),
    seconds: document.querySelector('[data-cd="seconds"]')
  };
  var ddayEl = document.getElementById('dday-value');

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function tick() {
    var now = Date.now();
    var diff = target - now;

    if (diff <= 0) {
      if (cells.days) {
        cells.days.textContent = '00';
        cells.hours.textContent = '00';
        cells.minutes.textContent = '00';
        cells.seconds.textContent = '00';
      }
      if (ddayEl) ddayEl.textContent = now <= end ? 'ON AIR' : 'END';
      return;
    }

    var days = Math.floor(diff / 86400000);
    var hours = Math.floor((diff % 86400000) / 3600000);
    var minutes = Math.floor((diff % 3600000) / 60000);
    var seconds = Math.floor((diff % 60000) / 1000);

    if (cells.days) {
      cells.days.textContent = pad(days);
      cells.hours.textContent = pad(hours);
      cells.minutes.textContent = pad(minutes);
      cells.seconds.textContent = pad(seconds);
    }
    if (ddayEl) ddayEl.textContent = days > 0 ? 'D-' + days : 'D-DAY';
  }

  if (cells.days) {
    tick();
    setInterval(tick, 1000);
  }

  /* ------------------------------------------------------------------ share */
  var shareBtn = document.getElementById('share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', function () {
      var payload = {
        title: '유령이 된 캠퍼스 · PNU 할로윈 나이트',
        text: '2026.10.31 SAT 18:00 · 부산대학교 대운동장',
        url: window.location.href
      };
      if (navigator.share) {
        navigator.share(payload).catch(function () { /* cancelled */ });
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(window.location.href).then(function () {
          toast('링크를 복사했습니다');
        }).catch(function () {
          toast('주소창의 링크를 복사해 주세요');
        });
        return;
      }
      toast('주소창의 링크를 복사해 주세요');
    });
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
    }, 2200);
  }

  /* ---------------------------------------------------------------- checkout */
  var modal = document.getElementById('checkout-modal');
  var formStep = document.getElementById('checkout-form-step');
  var successStep = document.getElementById('checkout-success');
  var form = document.getElementById('checkout-form');
  var submitBtn = document.getElementById('checkout-submit');
  var selType = document.getElementById('sel-type');
  var selNote = document.getElementById('sel-note');
  var selPrice = document.getElementById('sel-price');
  var qtyValue = document.getElementById('qty-value');
  var totalEl = document.getElementById('total-amount');
  var orderIdEl = document.getElementById('order-id');
  var orderTicketEl = document.getElementById('order-ticket');
  var orderAmountEl = document.getElementById('order-amount');

  var currentTier = null;
  var qty = 1;
  var purchased = false;
  var processing = false;
  var lastTrigger = null;

  function amountFor(tier, count) {
    var t = TICKETS[tier];
    return t ? t.price * count : 0;
  }

  function renderSelection() {
    var t = TICKETS[currentTier];
    if (!t) return;
    selType.textContent = t.type;
    selNote.textContent = t.note;
    if (experiments.exp_price_frame === 'B') {
      var perPerson = Math.round(t.price / t.persons);
      selPrice.innerHTML = won.format(perPerson) + '원 <small>/ 1인</small>';
    } else {
      selPrice.textContent = won.format(t.price) + '원';
    }
    qtyValue.textContent = String(qty);
    totalEl.textContent = won.format(amountFor(currentTier, qty)) + '원';
  }

  function openCheckout(tier, trigger) {
    if (!TICKETS[tier] || !modal) return;
    currentTier = tier;
    qty = 1;
    purchased = false;
    processing = false;
    lastTrigger = trigger || null;

    form.reset();
    submitBtn.disabled = false;
    submitBtn.textContent = '결제하고 예매 완료';
    formStep.hidden = false;
    successStep.hidden = true;
    renderSelection();

    var quick = experiments.exp_quick_checkout === 'B';
    var card = modal.querySelector('.modal-card');
    if (card) card.classList.toggle('is-quick', quick);

    var nameInput = form.querySelector('input[name="name"]');
    var phoneInput = form.querySelector('input[name="phone"]');
    if (nameInput) nameInput.required = !quick;
    if (phoneInput) phoneInput.required = !quick;

    var title = document.getElementById('checkout-title');
    if (title) title.textContent = quick ? '1초 만에 예매를 완료하세요' : '예매를 마무리해 주세요';
    submitBtn.textContent = quick ? '1초 만에 예매 완료' : '결제하고 예매 완료';

    var note = form.querySelector('.demo-note');
    if (note) {
      note.textContent = quick
        ? '원클릭 예매 변형입니다. 이름·연락처 입력 없이 예매가 완료되며, 실제 결제는 이루어지지 않습니다.'
        : '데모 페이지입니다. 이름과 연락처는 서버로 전송되지 않으며, 실제 결제도 이루어지지 않습니다.';
    }

    modal.hidden = false;
    document.body.classList.add('modal-open');
    var closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) closeBtn.focus();

    if (window.PNUTrack && window.PNUTrack.exposure) {
      window.PNUTrack.exposure('exp_price_frame', '티켓 가격 프레이밍');
      window.PNUTrack.exposure('exp_quick_checkout', '결제 마찰 (원클릭 예매)');
    }

    track('checkout_open', {
      section: 'tickets',
      element: 'checkout_open',
      metadata: {
        ticket_type: tier,
        ticket_label: TICKETS[tier].type,
        price: TICKETS[tier].price
      }
    });
  }

  function closeCheckout(reason) {
    if (!modal || modal.hidden) return;

    if (!purchased && currentTier) {
      track('checkout_abandon', {
        section: 'checkout',
        element: 'checkout_close',
        metadata: {
          ticket_type: currentTier,
          quantity: qty,
          amount: amountFor(currentTier, qty),
          reason: reason || 'close'
        }
      });
    }

    modal.hidden = true;
    document.body.classList.remove('modal-open');

    if (lastTrigger && typeof lastTrigger.focus === 'function') {
      lastTrigger.focus();
    }
    lastTrigger = null;
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest ? event.target.closest('[data-open-checkout]') : null;
    if (opener) {
      openCheckout(opener.getAttribute('data-open-checkout'), opener);
      return;
    }

    var closer = event.target.closest ? event.target.closest('[data-close-modal]') : null;
    if (closer) {
      closeCheckout('close_button');
    }
  });

  document.addEventListener('keydown', function (event) {
    if (!modal || modal.hidden) return;

    if (event.key === 'Escape') {
      closeCheckout('escape');
      return;
    }

    if (event.key === 'Tab') {
      var focusables = modal.querySelectorAll(
        'button:not([disabled]), input, a[href], [tabindex]:not([tabindex="-1"])'
      );
      var list = Array.prototype.filter.call(focusables, function (el) {
        return el.offsetParent !== null;
      });
      if (!list.length) return;
      var first = list[0];
      var last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  var qtyButtons = document.querySelectorAll('[data-qty]');
  Array.prototype.forEach.call(qtyButtons, function (btn) {
    btn.addEventListener('click', function () {
      var delta = parseInt(btn.getAttribute('data-qty'), 10) || 0;
      qty = Math.max(1, Math.min(6, qty + delta));
      renderSelection();
    });
  });

  function newOrderId() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < 6; i += 1) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 'PNU-' + out;
  }

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (processing || purchased || !currentTier) return;
      if (!form.reportValidity()) return;

      processing = true;
      submitBtn.disabled = true;
      submitBtn.textContent = '처리 중...';

      var ticket = TICKETS[currentTier];
      var total = amountFor(currentTier, qty);
      var orderId = newOrderId();

      setTimeout(function () {
        track('click', {
          section: 'checkout',
          element: 'checkout_submit',
          metadata: { label: '예매 확정', ticket_type: currentTier }
        });
        track('purchase', {
          section: 'checkout',
          element: 'checkout_submit',
          metadata: {
            ticket_type: currentTier,
            ticket_label: ticket.type,
            quantity: qty,
            amount: total,
            order_id: orderId
          }
        });

        orderIdEl.textContent = orderId;
        orderTicketEl.textContent = ticket.type + ' × ' + qty;
        orderAmountEl.textContent = won.format(total) + '원';

        formStep.hidden = true;
        successStep.hidden = false;
        purchased = true;
        processing = false;
        submitBtn.disabled = false;
        submitBtn.textContent = experiments.exp_quick_checkout === 'B'
          ? '1초 만에 예매 완료'
          : '결제하고 예매 완료';

        var confirmBtn = successStep.querySelector('[data-close-modal]');
        if (confirmBtn) confirmBtn.focus();
      }, 900);
    });
  }
})();
