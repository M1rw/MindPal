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
        gemini: {
          bg: '#ffffff',
          surface: '#f0f4f9',
          darkBg: '#131314',
          darkSurface: '#1e1f20',
          text: '#1f1f1f',
          darkText: '#e3e3e3',
          muted: '#444746',
          darkMuted: '#c4c7c5',
          border: '#e0e0e0',
          darkBorder: '#444746',
        },
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
