/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './frontend/index.html',
    './frontend/src/**/*.{ts,tsx,js,jsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        brand: {
          primary: '#4140FD',       // Indigo 600 (Primary — CTAs, links, focus)
          indigo600: '#4140FD',     // Indigo 600
          indigo400: '#6572F2',     // Indigo 400 (Gradient mid, hover states)
          periwinkle300: '#A39CF9', // Periwinkle 300 (Gradient highlight, accents)
          mist100: '#EFF3FB',       // Mist 100 (Section backgrounds)
          ink900: '#1E1E2E',        // Ink 900 (Body text, dark surfaces)
        },
        gemini: {
          bg: '#ffffff',
          surface: '#EFF3FB',       // Mist 100
          darkBg: '#1E1E2E',        // Ink 900
          darkSurface: '#28283D',   // Elevated Ink 900 for dark mode cards & menus
          text: '#1E1E2E',          // Ink 900
          darkText: '#EFF3FB',      // Mist 100
          muted: '#5A5E72',
          darkMuted: '#A0A3BD',
          border: '#E2E6F0',
          darkBorder: '#35354A',
        },
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(115deg, #A39CF9 0%, #6572F2 50%, #4140FD 100%)',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95) translateY(4px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        'spin-slow': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'fade-in': 'fadeUp 0.5s cubic-bezier(0.16,1,0.3,1) forwards',
        'fade-in-fast': 'fadeIn 0.2s ease-out forwards',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.16,1,0.3,1) forwards',
        'spin-slow': 'spin-slow 3s linear infinite',
      },
    },
  },
  plugins: [],
};
