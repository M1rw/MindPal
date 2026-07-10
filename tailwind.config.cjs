/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './frontend/index.html',
    './frontend/js/**/*.js',
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
    },
  },
  plugins: [],
};
