import type { Config } from 'tailwindcss';

export default {
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist Variable', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Bricolage Grotesque Variable', 'Geist Variable', 'sans-serif'],
        mono: ['Geist Mono Variable', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Signature accent — jade/teal "Midnight Atelier" palette.
        brand: {
          50: '#ecfdf8',
          100: '#cffbec',
          200: '#a3f4dc',
          300: '#67e8c9',
          400: '#34d3b0',
          500: '#15b896',
          600: '#0a937a',
          700: '#0c7565',
          800: '#0e5d51',
          900: '#104d44',
          950: '#022e28',
        },
        // Secondary accent — iris/violet. Used for selection targets, info, and
        // as a counterpoint to jade. Formalises the old element-target purple.
        iris: {
          50: '#f4f2ff',
          100: '#ece7ff',
          200: '#dbd2ff',
          300: '#c3adff',
          400: '#a684ff',
          500: '#8b5cf6',
          600: '#7a3df0',
          700: '#692bd4',
          800: '#5824ab',
          900: '#48238a',
          950: '#2c134f',
        },
        ink: {
          950: '#06080c',
          900: '#0b0e14',
          850: '#10131b',
          800: '#161a23',
          700: '#1e232e',
          600: '#2a3140',
        },
      },
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.75rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
      },
      spacing: {
        '0.5': '0.125rem',
        '1': '0.25rem',
        '1.5': '0.375rem',
        '2': '0.5rem',
        '3': '0.75rem',
        '4': '1rem',
        '6': '1.5rem',
        '8': '2rem',
        '12': '3rem',
        '16': '4rem',
        '20': '5rem',
        '24': '6rem',
      },
      borderRadius: {
        none: '0',
        xs: '0.25rem',
        sm: '0.375rem',
        base: '0.5rem',
        md: '0.625rem',
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
      },
      // Premium material system — the "lit from above" depth that separates a
      // mature browser chrome from a flat dark theme.
      boxShadow: {
        glass: '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 18px 50px -24px rgba(0,0,0,0.85)',
        'glass-lg': '0 1px 0 0 rgba(255,255,255,0.07) inset, 0 30px 80px -28px rgba(0,0,0,0.92)',
        'glass-sm': '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 8px 24px -14px rgba(0,0,0,0.8)',
        'inset-top': 'inset 0 1px 0 0 rgba(255,255,255,0.07)',
        'glow-brand': '0 0 0 1px rgba(45,212,191,0.30), 0 0 22px -4px rgba(45,212,191,0.55)',
        'glow-iris': '0 0 0 1px rgba(166,132,255,0.30), 0 0 22px -4px rgba(166,132,255,0.50)',
        'glow-rose': '0 0 0 1px rgba(244,63,94,0.30), 0 0 22px -4px rgba(244,63,94,0.45)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.16, 1, 0.3, 1)',
        'out-expo': 'cubic-bezier(0.19, 1, 0.22, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'tooltip-in': {
          from: { opacity: '0', transform: 'translateY(2px) scale(0.96)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'panel-in': {
          from: { opacity: '0', transform: 'translateY(-6px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.9)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        indeterminate: {
          '0%': { left: '-35%', right: '100%' },
          '60%': { left: '100%', right: '-12%' },
          '100%': { left: '100%', right: '-12%' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'tooltip-in': 'tooltip-in 120ms cubic-bezier(0.16, 1, 0.3, 1)',
        'panel-in': 'panel-in 150ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slide-up 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 130ms cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.6s infinite',
        indeterminate: 'indeterminate 1.15s cubic-bezier(0.65, 0.05, 0.36, 1) infinite',
        'pulse-soft': 'pulse-soft 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
