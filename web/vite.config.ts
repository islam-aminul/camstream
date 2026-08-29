import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],

  /**
   * amazon-cognito-identity-js is authored against Node globals — its SRP
   * implementation reaches for `global` and for Buffer. Vite targets the
   * browser and provides neither, so without these the bundle throws
   * "global is not defined" before the app ever mounts.
   */
  define: {
    global: 'globalThis',
  },

  resolve: {
    alias: {
      // Declared here rather than left to the bundler's tsconfig-path support,
      // which the test runner does not share.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The SRP maths operates on Buffers; the browser shim is a real
      // implementation, not a stub.
      buffer: 'buffer/',
    },
  },

  optimizeDeps: {
    include: ['buffer'],
  },

  build: {
    rolldownOptions: {
      output: {
        // Cognito's crypto and hls.js are both large and change on a different
        // cadence from the application, so splitting them keeps the common
        // case off the critical path.
        advancedChunks: {
          groups: [
            { name: 'cognito', test: /node_modules\/(amazon-cognito-identity-js|buffer|crypto-js)/ },
            { name: 'hls', test: /node_modules\/hls\.js/ },
            { name: 'primevue', test: /node_modules\/(primevue|@primeuix|primeicons)/ },
          ],
        },
      },
    },
  },
});
