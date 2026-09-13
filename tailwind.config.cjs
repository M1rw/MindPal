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
          ink900: '#0C0C0E',        // Deep neutral dark
        },
        gemini: {
          bg: '#ffffff',
          surface: '#EFF3FB',       // Mist 100
          darkBg: '#0C0C0E',        // Tier-1 deep charcoal neutral
          darkSurface: '#18181B',   // Elevated card & menu surface
          text: '#1A1A2E',
          darkText: '#F4F4F5',      // Crisp near-white
          muted: '#5A5E72',
          darkMuted: '#A1A1AA',     // Neutral secondary
          border: '#E2E6F0',
          darkBorder: '#27272A',    // Subtle zinc border
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
        soundWave: {
          '0%, 100%': { height: '6px' },
          '50%': { height: '22px' },
        },
      },
      animation: {
        'fade-in': 'fadeUp 0.5s cubic-bezier(0.16,1,0.3,1) forwards',
        'fade-in-fast': 'fadeIn 0.2s ease-out forwards',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.16,1,0.3,1) forwards',
        'spin-slow': 'spin-slow 3s linear infinite',
        'sound-wave': 'soundWave 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
