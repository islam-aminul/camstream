import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import 'primeicons/primeicons.css';
import App from './App.vue';
import { router } from './router';
import './styles.css';

createApp(App)
  .use(createPinia())
  .use(router)
  .use(PrimeVue, {
    theme: {
      preset: Aura,
      options: {
        // The console follows the operator's own theme rather than imposing
        // one; a control room is often deliberately dark.
        darkModeSelector: '@media (prefers-color-scheme: dark)',
      },
    },
  })
  .mount('#app');
