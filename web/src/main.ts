import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import Tooltip from 'primevue/tooltip';
import Aura from '@primevue/themes/aura';
import 'primeicons/primeicons.css';
import App from './App.vue';
import { router } from './router';
import './styles.css';

createApp(App)
  .use(createPinia())
  .use(router)
  // Deleting a site or an account asks first, and the dialog needs its
  // service registered here rather than per page.
  .use(ConfirmationService)
  // Every control that is an icon, and every control whose consequence is not
  // obvious from its label, carries a sentence on hover. Registered globally
  // because it is used on nearly every page.
  .directive('tooltip', Tooltip)
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
