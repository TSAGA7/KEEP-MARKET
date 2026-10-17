// Если за 20 секунд магазин не появился — показываем экран с кнопкой «Обновить» вместо вечной загрузки.
(function () {
  setTimeout(function () {
    var root = document.getElementById('root');
    var box = document.getElementById('boot-fallback');
    if (!root || !box || root.hasChildNodes()) return;
    try { if (window.Telegram && window.Telegram.WebApp) window.Telegram.WebApp.ready(); } catch (e) { /* noop */ }
    box.style.display = 'flex';
    var btn = document.getElementById('boot-reload');
    if (btn) btn.addEventListener('click', function () { location.reload(); });
  }, 20000);
})();
