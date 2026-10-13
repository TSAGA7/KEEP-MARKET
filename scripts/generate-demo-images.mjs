// Генерирует нейтральные демо-иллюстрации товаров (SVG) в public/demo.
// Это заглушки для демо-данных: без логотипов, брендов и фотографий третьих лиц.
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'public/demo';
mkdirSync(OUT, { recursive: true });

const shapes = {
  tee: 'M150 120 L205 100 Q240 125 275 100 L330 120 L370 190 L330 210 L320 185 L320 420 L160 420 L160 185 L150 210 L110 190 Z',
  hoodie: 'M150 140 L195 112 Q200 70 240 66 Q280 70 285 112 L330 140 L372 330 L336 340 L320 220 L320 430 L160 430 L160 220 L144 340 L108 330 Z M215 118 Q240 150 265 118',
  pants: 'M170 90 L310 90 L322 440 L262 440 L240 190 L218 440 L158 440 Z M170 120 L310 120',
  sneakers: 'M90 300 Q100 240 160 236 L210 230 Q250 268 300 270 L372 286 Q398 300 390 330 L96 330 Q86 318 90 300 Z M96 330 L390 330 L390 346 L96 346 Z',
  boots: 'M170 110 L262 110 L268 286 Q330 296 360 320 Q376 340 366 360 L160 360 L160 300 Z M160 360 L366 360 L366 382 L160 382 Z',
  tote: 'M140 190 L340 190 L360 430 L120 430 Z M190 190 Q190 110 240 110 Q290 110 290 190',
  crossbody: 'M150 250 L330 250 Q350 250 350 270 L350 380 Q350 400 330 400 L150 400 Q130 400 130 380 L130 270 Q130 250 150 250 Z M130 300 L350 300 M150 250 L250 90 L330 250',
  beanie: 'M140 330 Q140 150 240 140 Q340 150 340 330 Z M130 320 L350 320 L350 380 L130 380 Z',
};

function svg(shape, variant, bg, fg) {
  const flip = variant === 2 ? 'transform="translate(480 0) scale(-1 1)"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 600" width="480" height="600">
  <rect width="480" height="600" fill="${bg}"/>
  <g ${flip}><path d="${shape}" fill="${fg}" stroke="${fg}" stroke-width="2" stroke-linejoin="round" fill-rule="evenodd" transform="translate(0 40)"/></g>
  <text x="24" y="572" font-family="system-ui, sans-serif" font-size="18" fill="#8a8984" letter-spacing="1">ДЕМО</text>
</svg>`;
}

for (const [name, d] of Object.entries(shapes)) {
  writeFileSync(`${OUT}/${name}-1.svg`, svg(d, 1, '#ecebe7', '#1c1c1b'));
  writeFileSync(`${OUT}/${name}-2.svg`, svg(d, 2, '#dcdbd6', '#6a6965'));
}

const banner = (bg, fg, path) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 600" width="480" height="600">
  <rect width="480" height="600" fill="${bg}"/>
  <path d="${path}" fill="${fg}"/>
  <text x="24" y="40" font-family="system-ui, sans-serif" font-size="16" fill="#9b9a95">ДЕМО</text>
</svg>`;
writeFileSync(`${OUT}/banner-1.svg`, banner('#2a2a28', '#4a4a46', 'M0 600 L0 360 Q120 300 240 340 Q360 380 480 320 L480 600 Z M110 100 h120 v170 h-120z'));
writeFileSync(`${OUT}/banner-2.svg`, banner('#d6d4cd', '#b9b7af', 'M60 120 h160 v220 h-160z M260 200 h160 v260 h-160z'));
console.log('demo images generated');
