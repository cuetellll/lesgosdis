/* Mahyar Gap landing — minimal progressive enhancement (no libraries).
   1. Remembers the visitor's language choice (cookie + localStorage).
   2. Toggles the mobile navigation. Nothing else runs. */
(function () {
  'use strict';

  // Persist language choice: the server reads the cookie on "/" to redirect.
  var html = document.documentElement;
  var lang = html.getAttribute('lang') === 'en' ? 'en' : 'fa';
  try {
    localStorage.setItem('mahyar_lang', lang);
    document.cookie = 'mahyar_lang=' + lang + ';path=/;max-age=31536000;samesite=lax';
  } catch (_) { /* storage blocked — server default (/fa) still works */ }

  var burger = document.getElementById('nav-burger');
  var menu = document.getElementById('mobile-menu');
  if (burger && menu) {
    burger.addEventListener('click', function () {
      var open = menu.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(open));
    });
  }
})();
