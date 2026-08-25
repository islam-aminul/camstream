import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  /**
   * amazon-cognito-identity-js is authored against Node globals — its SRP
   * implementation reaches for `global` and for Buffer. Vite targets the
   * browser and provides neither, so without these the bundle throws
   * "global is not defined" before React ever mounts.
   */
  define: {
    global: 'globalThis',
  },

  resolve: {
    alias: {
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
          ],
        },
      },
    },
  },
});
