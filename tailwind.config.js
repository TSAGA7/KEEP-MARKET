/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        paper: 'rgb(var(--c-paper) / <alpha-value>)',
        concrete: 'rgb(var(--c-concrete) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        graphite: 'rgb(var(--c-graphite) / <alpha-value>)',
        fog: 'rgb(var(--c-fog) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        moss: 'rgb(var(--c-moss) / <alpha-value>)',
        rust: 'rgb(var(--c-rust) / <alpha-value>)',
        amber: 'rgb(var(--c-amber) / <alpha-value>)',
      },
      fontFamily: {
        display: ['Unbounded', 'system-ui', 'sans-serif'],
        sans: ['"Golos Text"', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        // Шкала ~1.2 от 15px
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['15px', '22px'],
        md: ['17px', '24px'],
        lg: ['20px', '26px'],
        xl: ['24px', '30px'],
        '2xl': ['29px', '34px'],
        '3xl': ['35px', '38px'],
      },
      spacing: { safeb: 'var(--safe-bottom)', safet: 'var(--safe-top)' },
      maxWidth: { shop: '520px' },
      keyframes: {
        sheet: { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
        fade: { from: { opacity: '0' }, to: { opacity: '1' } },
        tag: { '0%': { transform: 'rotate(-6deg) translateY(-6px)', opacity: '0' }, '100%': { transform: 'rotate(-2deg) translateY(0)', opacity: '1' } },
      },
      animation: {
        sheet: 'sheet 240ms cubic-bezier(.2,.8,.2,1)',
        fade: 'fade 180ms ease-out',
        tag: 'tag 420ms cubic-bezier(.2,.9,.3,1.2) both',
      },
    },
  },
  plugins: [],
};
