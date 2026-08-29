import { createRouter, createWebHistory } from 'vue-router';

/**
 * Selection travels in the query string rather than the path, because it is
 * orthogonal to which page you are on: switching from the live view to the
 * camera list should keep the site you were looking at.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/live' },
    { path: '/live', name: 'live', component: () => import('./views/LiveView.vue') },
    { path: '/cameras', name: 'cameras', component: () => import('./views/CamerasView.vue') },
    { path: '/agents', name: 'agents', component: () => import('./views/AgentsView.vue') },
    { path: '/premises', name: 'premises', component: () => import('./views/PremisesView.vue') },
    { path: '/users', name: 'users', component: () => import('./views/UsersView.vue') },
  ],
});
