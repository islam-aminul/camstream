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
  /**
   * The site the cookies are currently cut to.
   *
   * Held here because every refresh has to re-assert it: a refresh that forgot
   * would silently widen the cookie back out, or narrow it to the wrong site
   * and stop the video.
   */
  const watching = ref<string | null>(null);
  /**
   * The customer whose video the cookies cover.
   *
   * Only ever different from the account's own for the platform operator, who
   * selects a customer in the console; the server ignores it for anyone else.
   */
  const watchingTenant = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const ready = ref(false);

  let timer: ReturnType<typeof setInterval> | undefined;

  async function start(): Promise<boolean> {
    const existing = await currentSession();
    if (!existing) { ready.value = true; return false; }

    info.value = await api.session(
      undefined, watching.value ?? undefined, watchingTenant.value ?? undefined);
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
      void api.session(
        info.value?.sessionId, watching.value ?? undefined, watchingTenant.value ?? undefined)
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

  /**
   * Re-cuts the cookies to a different site.
   *
   * Called when the rail changes premises, and awaited before anything tries to
   * play: the previous cookie does not cover the new site, so a player that
   * started first would be refused by CloudFront and show a stall it could not
   * explain.
   */
  async function watch(premisesId: string | null, tenantId?: string | null) {
    const tenant = tenantId ?? null;
    if (watching.value === premisesId && watchingTenant.value === tenant) return;

    // Nothing is recorded until the cookie has actually been re-cut. Recording
    // the intent first looked harmless and was not: the live view can ask for
    // a site before the session exists, and the early return then left the
    // request marked as done. Every later attempt matched the guard and
    // returned, so the cookie stayed cut to the account's own tenant and every
    // segment came back 403 - with the agent publishing perfectly well.
    if (!info.value) return;

    info.value = await api.session(
      info.value.sessionId, premisesId ?? undefined, tenant ?? undefined);
    watching.value = premisesId;
    watchingTenant.value = tenant;
    schedule();
  }

  /** Acknowledges a notice. It reports something that already happened. */
  function clearNotice() {
    notice.value = null;
  }

  return { me, info, notice, ready, watching, watchingTenant, start, end, watch, clearNotice };
});
