(function () {
  'use strict';

  var cfg = window.PNU_CONFIG || {};
  var url = (cfg.SUPABASE_URL || '').replace(/\/+$/, '');
  var key = cfg.SUPABASE_KEY || '';
  var ready = /^https:\/\/.+\.supabase\.co$/.test(url) && key.length > 20;

  function headers(extra) {
    var base = {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { base[k] = extra[k]; });
    }
    return base;
  }

  function insert(table, rows) {
    if (!ready) return Promise.resolve(null);
    return fetch(url + '/rest/v1/' + table, {
      method: 'POST',
      headers: headers({ Prefer: 'return=minimal' }),
      body: JSON.stringify(rows)
    }).then(function (res) {
      if (!res.ok) throw new Error('insert failed: ' + res.status);
      return true;
    });
  }

  function rpc(name, args) {
    if (!ready) return Promise.reject(new Error('Supabase is not configured'));
    return fetch(url + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(args || {})
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) {
          var message = body && (body.message || body.hint || body.details);
          throw new Error(message || ('rpc failed: ' + res.status));
        }
        return body;
      });
    });
  }

  window.PNUSupabase = {
    ready: ready,
    insert: insert,
    rpc: rpc
  };
})();
