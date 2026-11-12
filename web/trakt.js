/* Trakt device authorization and Up Next for the Samsung home screen. */
var WebTrakt = (function () {
  'use strict';

  var client = TV.name === 'tizen' && CONFIG.traktClientId;
  var storageKey = 'fmtv.trakt.' + client;
  var queueKey = storageKey + '.queue';
  var session = null, attempt = 0, signingIn = false, loading = false;
  var cards = [], refreshedAt = 0;
  var images = {}, artworkStatus = '';

  // Trakt requires apps to cache the bytes instead of embedding CDN URLs.
  function cacheImage(path, id, done) {
    if (typeof path !== 'string' || !/^(?:https:\/\/)?(?:media\.trakt\.tv\/(?:shows|movies)\/|(?:[a-z0-9-]+\.)+trakt\.tv\/images\/)/i.test(path)) {
      done('missing image URL');
      return;
    }
    var url = /^https:\/\//i.test(path) ? path : 'https://' + path;
    if (images[url]) { done(null, images[url]); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.timeout = 8000;
    xhr.onload = function () {
      if (attempt !== id) return;
      if (xhr.status !== 200 || !xhr.response || !xhr.response.size) {
        done('image HTTP ' + xhr.status);
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        if (attempt !== id) return;
        // The CDN serves WebP, even when the HTTP response has a generic content type.
        var data = reader.result.replace(/^data:[^;]*;base64,/i, 'data:image/webp;base64,');
        var image = new Image();
        image.onload = function () {
          if (attempt !== id) return;
          images[url] = data;
          done(null, data);
        };
        image.onerror = function () { if (attempt === id) done('WebP decode failed'); };
        image.src = data;
      };
      reader.onerror = function () { if (attempt === id) done('image read failed'); };
      reader.readAsDataURL(xhr.response);
    };
    xhr.onerror = xhr.ontimeout = function () { if (attempt === id) done('image request failed'); };
    xhr.send();
  }

  function pruneImages(items) {
    var used = {};
    items.forEach(function (item) { if (item.traktImage) used[item.traktImage] = true; });
    Object.keys(images).forEach(function (url) {
      if (used[images[url]]) return;
      delete images[url];
    });
  }

  if (client) {
    try {
      session = JSON.parse(localStorage.getItem(storageKey));
      var saved = session && JSON.parse(localStorage.getItem(queueKey));
      if (Array.isArray(saved)) cards = saved;
    } catch (e) {}
  }

  function saveQueue() {
    // Keep enough room for the TV's other settings and caches.
    var artworkBudget = 1000000;
    var queue = cards.map(function (card) {
      var saved = {};
      Object.keys(card).forEach(function (key) { saved[key] = card[key]; });
      if (saved.traktImage && saved.traktImage.length <= artworkBudget) artworkBudget -= saved.traktImage.length;
      else delete saved.traktImage;
      return saved;
    });
    try { localStorage.setItem(queueKey, JSON.stringify(queue)); } catch (e) {
      queue.forEach(function (card) { delete card.traktImage; });
      try { localStorage.setItem(queueKey, JSON.stringify(queue)); } catch (ignored) {}
    }
  }

  function save(value) {
    session = value;
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch (e) {}
  }

  function request(path, body, token, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(body ? 'POST' : 'GET', 'https://api.trakt.tv' + path);
    xhr.timeout = 15000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('trakt-api-version', '2');
    xhr.setRequestHeader('trakt-api-key', client);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function () {
      var result;
      try { result = JSON.parse(xhr.responseText); } catch (e) {}
      done(xhr.status, result);
    };
    xhr.onerror = xhr.ontimeout = function () { done(0); };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  function base64url(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function signIn(changed) {
    var crypto = window.crypto;
    if (signingIn) return;
    if (!crypto || !crypto.subtle) { changed('unsupported'); return; }
    signingIn = true;
    var id = ++attempt;
    function finish(status) {
      if (attempt !== id) return;
      signingIn = false;
      changed(status);
    }
    var verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    var bytes = new Uint8Array(verifier.length);
    for (var i = 0; i < bytes.length; i++) bytes[i] = verifier.charCodeAt(i);
    changed('connecting');
    crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
      request('/oauth/device/code', {
        client_id: client, code_challenge: base64url(new Uint8Array(digest)), code_challenge_method: 'S256'
      }, null, function (status, code) {
        if (attempt !== id) return;
        if (status !== 200 || !code || !code.user_code || !code.device_code) { finish('error'); return; }
        var interval = Math.max(5, code.interval || 5) * 1000;
        var expires = Date.now() + (code.expires_in || 600) * 1000;
        changed('code', code.user_code);
        function poll() {
          if (attempt !== id) return;
          if (Date.now() >= expires) { finish('error'); return; }
          request('/oauth/device/token', {code: code.device_code, client_id: client, code_verifier: verifier},
            null, function (status, token) {
              if (attempt !== id) return;
              if (status === 200 && token && token.access_token) {
                save(token);
                finish('connected');
              } else if (status === 400 || status === 429 || !status) {
                if (status === 429) interval += 5000;
                setTimeout(poll, interval);
              } else finish('error');
            });
        }
        setTimeout(poll, interval);
      });
    }, function () { finish('error'); });
  }

  function refresh(enrich, changed) {
    if (!session || loading || Date.now() - refreshedAt < 300000) return;
    loading = true;
    var id = attempt, items = [], seen = {}, artworkError = '';
    function finish(ok) {
      if (attempt !== id) return;
      loading = false;
      refreshedAt = Date.now();
      if (ok) {
        cards = items;
        saveQueue();
        var loaded = items.filter(function (item) { return !!item.traktImage; }).length;
        artworkStatus = loaded + '/' + items.length + (artworkError ? ' · ' + artworkError : '');
      } else artworkStatus = 'queue request failed';
      changed(ok ? 'loaded' : 'error');
      pruneImages(cards);
    }

    function get(path, done) {
      request(path, null, session.access_token, function (status, data) {
        if (attempt !== id) return;
        if (status !== 401 || !session.refresh_token) { done(status, data); return; }
        request('/oauth/token', {
          refresh_token: session.refresh_token, client_id: client,
          redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'refresh_token'
        }, null, function (status, token) {
          if (attempt !== id) return;
          if (status !== 200 || !token || !token.access_token) { done(status); return; }
          save(token);
          request(path, null, token.access_token, function (status, data) {
            if (attempt === id) done(status, data);
          });
        });
      });
    }

    function add(media, kind, episode, progress) {
      if (!media || !media.ids || !Number(media.ids.trakt)) return;
      var key = kind + ':' + media.ids.trakt;
      if (seen[key] || items.length >= 8) return;
      seen[key] = true;
      items.push({
        id: media.ids.tmdb, traktId: Number(media.ids.trakt), kind: kind, title: media.title,
        meta: episode ? (progress ? trf('Continue: S{s} E{e}', {s: episode.season, e: episode.number}) :
          trf('Up next: S{s} E{e}', {s: episode.season, e: episode.number})) : '',
        progress: progress, fromTrakt: true
      });
    }

    function artwork(index) {
      if (attempt !== id) return;
      if (index === items.length) { finish(true); return; }
      var item = items[index];
      var path = (item.kind === 'movie' ? '/movies/' : '/shows/') + item.traktId;
      function load(extended) {
        get(path + '?extended=' + extended, function (status, media) {
          var art = status === 200 && media && media.images;
          var image = art && ((art.fanart || [])[0] || (art.thumb || [])[0] || (art.poster || [])[0]);
          if (status === 200 && !image && extended === 'full') { load('full,images'); return; }
          cacheImage(image, id, function (error, localUrl) {
            if (error) {
              var reason = status === 200 ? error : 'metadata HTTP ' + status;
              if (!artworkError) artworkError = reason;
              if (window.console) window.console.warn('Trakt artwork: ' + reason);
            }
            item.traktImage = localUrl;
            enrich(item, function () { artwork(index + 1); });
          });
        });
      }
      load('full');
    }

    get('/sync/watched/shows?extended=noseasons', function (status, shows) {
      if (status !== 200 || !Array.isArray(shows)) { finish(false); return; }
      shows.sort(function (a, b) { return String(b.last_watched_at).localeCompare(String(a.last_watched_at)); });
      get('/sync/playback?limit=20', function (status, playback) {
        if (status !== 200 || !Array.isArray(playback)) { finish(false); return; }
        var watched = {};
        shows.forEach(function (item) {
          if (item.show && item.show.ids) watched[item.show.ids.trakt] = item.last_watched_at;
        });
        playback.sort(function (a, b) { return String(b.paused_at).localeCompare(String(a.paused_at)); });
        playback.forEach(function (item) {
          if (!(item.progress > 0 && item.progress < 100)) return;
          if (item.type === 'movie') add(item.movie, 'movie', null, item.progress);
          else if (item.show && item.show.ids && !(watched[item.show.ids.trakt] >= item.paused_at)) {
            add(item.show, 'tv', item.episode, item.progress);
          }
        });
        function next(index) {
          if (index >= Math.min(shows.length, 12) || items.length >= 8) { artwork(0); return; }
          var show = shows[index].show;
          var traktId = show && show.ids && Number(show.ids.trakt);
          if (!traktId || seen['tv:' + traktId]) { next(index + 1); return; }
          get('/shows/' + traktId + '/progress/watched', function (status, data) {
            if (status === 200 && data && data.next_episode) add(show, 'tv', data.next_episode, 0);
            next(index + 1);
          });
        }
        next(0);
      });
    });
  }

  return {
    available: !!client,
    connected: function () { return !!session; },
    cards: function () { return cards; },
    artworkStatus: function () { return artworkStatus; },
    signIn: signIn,
    refresh: refresh,
    signOut: function () {
      attempt++;
      signingIn = loading = false;
      refreshedAt = 0;
      artworkStatus = '';
      cards = [];
      pruneImages(cards);
      save(null);
      try { localStorage.removeItem(queueKey); } catch (e) {}
    }
  };
})();
