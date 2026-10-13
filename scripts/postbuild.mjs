// GitHub Pages не умеет SPA-fallback. Копируем index.html в 404.html,
// чтобы прямые ссылки (/product/slug, /admin/orders) открывались после обновления страницы.
import { copyFileSync, writeFileSync, existsSync } from 'node:fs';
if (!existsSync('dist/index.html')) throw new Error('dist/index.html not found');
copyFileSync('dist/index.html', 'dist/404.html');
writeFileSync('dist/.nojekyll', '');
console.log('postbuild: 404.html и .nojekyll созданы');
