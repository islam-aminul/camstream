import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, type Me, type SessionInfo } from '@/api';
import { currentSession, signOut } from '@/api/auth';
import { SessionSuperseded } from '@/api/client';

/**
 * Who is signed in, and the CloudFront cookies that let them fetch video.
 *
 * The cookies are what actually authorise a segment request, and they are
 * short-lived on purpose: CloudFront validates a signed cookie against nothing
 * but its own expiry, so there is no revocation list and the lifetime *is* the
 * revocation bound. Refreshing keeps them alive while somebody is watching.
 */
export const useSessionStore = defineStore('session', () => {
  const me = ref<Me | null>(null);
  const info = ref<SessionInfo | null>(null);
  const notice = ref<string | null>(null);
  const ready = ref(false);

  let timer: ReturnType<typeof setInterval> | undefined;

  async function start(): Promise<boolean> {
    const existing = await currentSession();
    if (!existing) { ready.value = true; return false; }

    info.value = await api.session();
    me.value = await api.me();
    notice.value = info.value.displacedPreviousSession
      ? 'Your previous session was signed out.'
      : null;
    schedule();
    ready.value = true;
    return true;
  }

  /**
   * Keeps the cookies alive, and treats losing the race as a sign-out.
   *
   * Another sign-in taking the slot is not an error — it is the single-session
   * rule working, and the honest response is to stop rather than to retry.
   */
  function schedule() {
    if (timer) clearInterval(timer);
    const seconds = info.value?.refreshInSeconds ?? 240;
    timer = setInterval(() => {
      void api.session(info.value?.sessionId)
        .then((next) => { info.value = next; })
        .catch((err) => {
          if (err instanceof SessionSuperseded) {
            void end('You were signed out because this account signed in elsewhere.');
          }
        });
    }, seconds * 1000);
  }

  async function end(message: string | null) {
    if (timer) clearInterval(timer);
    timer = undefined;
    await signOut();
    me.value = null;
    info.value = null;
    notice.value = message;
  }

  return { me, info, notice, ready, start, end };
});
