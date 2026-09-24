/**
 * Theme colours are CSS variables, and Tailwind cannot apply an opacity modifier
 * to a variable on its own: `bg-brand-primary/10`, `ring-brand-primary/40` and
 * about thirty others generated no CSS at all, silently (the voice transcript's
 * own-message bubble had no background because of it). As functions, these
 * colours answer an explicit modifier with color-mix and are unchanged otherwise.
 */
const withAlpha = (value) => ({ opacityValue }) =>
  opacityValue === undefined || String(opacityValue).startsWith('var(')
    ? value
    : `color-mix(in srgb, ${value} calc(${opacityValue} * 100%), transparent)`;

const alphaVars = (group) =>
  Object.fromEntries(
    Object.entries(group).map(([name, value]) => [
      name,
      typeof value === 'string' && value.startsWith('var(') ? withAlpha(value) : value,
    ]),
  );

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
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem', letterSpacing: '0.01em' }], // 10px
        'xs': ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.005em' }],       // 12px
        'sm': ['0.84375rem', { lineHeight: '1.25rem' }],                            // 13.5px
        'base': ['0.9375rem', { lineHeight: '1.5rem' }],                            // 15px
        'md': ['1rem', { lineHeight: '1.5rem' }],                                   // 16px
        'lg': ['1.125rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],  // 18px
        'xl': ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.015em' }],   // 20px
        '2xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.02em' }],       // 24px
        '3xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.025em' }], // 30px
        '4xl': ['2.25rem', { lineHeight: '2.5rem', letterSpacing: '-0.03em' }],    // 36px
        '5xl': ['3rem', { lineHeight: '1.1', letterSpacing: '-0.035em' }],         // 48px
      },
      colors: {
        brand: alphaVars({
          primary: 'var(--brand-primary, #4140FD)',
          hover: 'var(--brand-primary-hover, #3534DF)',
          active: 'var(--brand-primary-active, #2B2AC2)',
          subtle: 'var(--brand-primary-subtle, rgba(65, 64, 253, 0.08))',
          secondary: 'var(--brand-secondary, #6572F2)',
          accent: 'var(--brand-accent, #A39CF9)',
          mist: 'var(--brand-mist, #EFF3FB)',
          indigo600: '#4140FD',     // Legacy alias
          indigo400: '#6572F2',     // Legacy alias
          periwinkle300: '#A39CF9', // Legacy alias
          mist100: '#EFF3FB',       // Legacy alias
          ink900: '#0C0C0E',        // Legacy alias
        }),
        surface: alphaVars({
          canvas: 'var(--surface-canvas, #FFFFFF)',
          card: 'var(--surface-card, #FFFFFF)',
          elevated: 'var(--surface-elevated, #FFFFFF)',
          sunken: 'var(--surface-sunken, #F4F6FB)',
          subtle: 'var(--surface-subtle, #F0F4F9)',
          glass: 'var(--surface-glass, rgba(255, 255, 255, 0.85))',
          glassBorder: 'var(--surface-glass-border, rgba(0, 0, 0, 0.08))',
        }),
        edge: alphaVars({
          subtle: 'var(--border-subtle, rgba(0, 0, 0, 0.06))',
          default: 'var(--border-default, rgba(0, 0, 0, 0.10))',
          hover: 'var(--border-hover, rgba(0, 0, 0, 0.16))',
          highlight: 'var(--border-highlight, rgba(255, 255, 255, 0.9))',
          focus: 'var(--border-focus, #4140FD)',
        }),
        content: alphaVars({
          primary: 'var(--text-primary, #1A1A2E)',
          secondary: 'var(--text-secondary, #5A5E72)',
          tertiary: 'var(--text-tertiary, #888C9E)',
          muted: 'var(--text-muted, #9CA3AF)',
          inverse: 'var(--text-inverse, #F4F4F5)',
          brand: 'var(--text-brand, #4140FD)',
        }),
        feedback: alphaVars({
          success: 'var(--feedback-success, #10B981)',
          successSubtle: 'var(--feedback-success-subtle, rgba(16, 185, 129, 0.08))',
          warning: 'var(--feedback-warning, #F59E0B)',
          warningSubtle: 'var(--feedback-warning-subtle, rgba(245, 158, 11, 0.08))',
          danger: 'var(--feedback-danger, #EF4444)',
          dangerSubtle: 'var(--feedback-danger-subtle, rgba(239, 68, 68, 0.08))',
          info: 'var(--feedback-info, #3B82F6)',
          infoSubtle: 'var(--feedback-info-subtle, rgba(59, 130, 246, 0.08))',
        }),
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
      boxShadow: {
        card: 'var(--shadow-card)',
        modal: 'var(--shadow-modal)',
        'glow-brand': 'var(--shadow-glow-brand)',
        specular: 'var(--shadow-inner-specular)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(115deg, #A39CF9 0%, #6572F2 50%, #4140FD 100%)',
        'shimmer-gradient': 'linear-gradient(90deg, var(--skeleton-shimmer-from) 0%, var(--skeleton-shimmer-via) 50%, var(--skeleton-shimmer-to) 100%)',
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
        moodChipIn: {
          '0%': { opacity: '0', transform: 'translateY(10px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'spin-slow': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        soundWave: {
          '0%, 100%': { height: '6px' },
          '50%': { height: '22px' },
        },
        msgIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        streamPulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
      animation: {
        'fade-in': 'fadeUp 0.5s cubic-bezier(0.16,1,0.3,1) forwards',
        'fade-in-fast': 'fadeIn 0.2s ease-out forwards',
        'scale-in': 'scaleIn 0.2s cubic-bezier(0.16,1,0.3,1) forwards',
        'mood-chip': 'moodChipIn 0.4s cubic-bezier(0.16,1,0.3,1) both',
        'shimmer': 'shimmer 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin-slow 3s linear infinite',
        'sound-wave': 'soundWave 1.2s ease-in-out infinite',
        'msg-in': 'msgIn 0.35s cubic-bezier(0.16,1,0.3,1) both',
        'stream-pulse': 'streamPulse 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
