<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Message from 'primevue/message';
import Dialog from 'primevue/dialog';
import { useSelectionStore } from '@/stores/selection';
import { api, type Discovered, type Platform, type StoredCredential } from '@/api';
import { sealCredential, cryptoAvailable } from '@/crypto';
import { idFrom, isValidDisplayName, nameComplaint } from '@/naming';

/**
 * Bringing a site into the system: install an agent, give it the credentials
 * for the cameras, let it find them, approve the ones that belong.
 *
 * This is the page the console could not do without — an estate cannot be
 * built by hand in the database — and it is deliberately one page rather than
 * four, because it is one task done in order. The order is the page: enrol,
 * credential, scan, approve.
 */
const selection = useSelectionStore();

const rows = ref<Discovered[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/** The agent being acted on, defaulting to the rail's if it named one. */
const agent = ref<string | null>(null);
const platform = ref<Platform>('linux');

/**
 * The credential dialog, and what it is scoped to.
 *
 * Open is its own flag rather than "is a camera selected", because the common
 * case — one credential for every camera the agent probes — has no camera.
 */
const credentialOpen = ref(false);
/** The factory default on most cameras; still editable. */
const username = ref('admin');
const password = ref('');
const scope = ref('*');
const sealing = ref(false);

/** What is already filed against this agent, so it can be reviewed and corrected. */
const credentials = ref<StoredCredential[]>([]);
const maxSiteCredentials = ref(5);
const siteWide = computed(() => credentials.value.filter((c) => c.siteWide));
const canAddAnother = computed(() => siteWide.value.length < maxSiteCredentials.value);

async function loadCredentials() {
  if (!agent.value) { credentials.value = []; return; }
  try {
    const result = await api.credentials(agent.value);
    credentials.value = result.credentials;
    maxSiteCredentials.value = result.maxSiteCredentials;
  } catch (err) {
    error.value = (err as Error).message;
  }
}

/**
 * The next free site-wide slot.
 *
 * "*" first, then "*-2" upward. The order is what the agent tries them in, so
 * a new one is appended: the existing order is the installer's judgement about
 * which is most likely to work, and adding should not disturb it.
 */
function nextFreeSlot(): string | null {
  const taken = new Set(siteWide.value.map((c) => c.scope));
  for (const slot of ['*', '*-2', '*-3', '*-4', '*-5']) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

/** Where a credential sits in the order the agent will try them. */
function slotLabel(s: string): string {
  if (!s.startsWith('*')) return `this camera only`;
  const n = s === '*' ? 1 : Number(s.slice(2));
  return `tried ${['first', 'second', 'third', 'fourth', 'fifth'][n - 1] ?? `${n}th`}`;
}

async function removeCredential(entry: StoredCredential) {
  if (!agent.value) return;
  error.value = null;
  try {
    await api.removeCredential(agent.value, entry.scope);
    notice.value = `Removed the ${entry.username ?? 'stored'} credential.`;
    await loadCredentials();
  } catch (err) {
    error.value = (err as Error).message;
  }
}


const downloading = ref(false);
const approving = ref<Discovered | null>(null);
const displayName = ref('');
const subProfile = ref<string | undefined>(undefined);
const mainProfile = ref<string | undefined>(undefined);

const agentOptions = computed(() => selection.agents.map((a) => ({
  value: a.thingName,
  label: a.siteName || a.thingName,
  enrolled: a.enrolled,
})));

/** The chosen agent's record, which carries the key credentials are sealed to. */
const chosen = computed(() => selection.agents.find((a) => a.thingName === agent.value) ?? null);

const nameComplaintFor = computed(() =>
  (displayName.value ? nameComplaint(displayName.value) : null));

async function refresh() {
  if (!selection.premisesId) { rows.value = []; return; }
  loading.value = true;
  error.value = null;
  try {
    rows.value = await api.discovered({
      tenantId: selection.tenantParam, premisesId: selection.premisesId,
    });
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function downloadInstaller() {
  if (!agent.value) return;
  downloading.value = true;
  error.value = null;
  try {
    await api.installer(agent.value, platform.value);
    notice.value = 'Downloaded. Unzip it on the agent machine and run the launcher — '
      + 'the folder also holds the note describing the Java and FFmpeg archives to supply. '
      + 'Its enrolment token is one-use.';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    downloading.value = false;
  }
}

async function scan() {
  if (!agent.value) return;
  notice.value = null;
  try {
    await api.scan(agent.value);
    // The sweep happens on the agent's own schedule once asked; there is
    // nothing to wait for synchronously and pretending otherwise would show a
    // spinner that means nothing.
    notice.value = 'Scan requested. Results appear here as the agent reports them — refresh in a moment.';
  } catch (err) {
    error.value = (err as Error).message;
  }
}

/**
 * Opens the dialog to add a credential, edit one, or set one for a camera.
 *
 * Editing re-enters the password rather than showing it: nothing in this
 * system can read one back, which is the point of sealing them in the browser.
 */
function openCredential(target: { camera?: Discovered; edit?: StoredCredential } = {}) {
  const existing = target.edit;
  scope.value = existing?.scope ?? target.camera?.identity ?? nextFreeSlot() ?? '*';
  username.value = existing?.username || 'admin';
  password.value = '';
  credentialOpen.value = true;
}

async function saveCredential() {
  const key = chosen.value?.credentialPublicKey;
  if (!agent.value || !key) return;
  sealing.value = true;
  error.value = null;
  try {
    // Sealed here, in this browser, against that one agent's public key. The
    // control plane stores ciphertext it has no key to open.
    const ciphertext = await sealCredential(key, username.value, password.value);
    await api.storeCredential({
      thingName: agent.value, scope: scope.value, ciphertext, username: username.value,
    });
    await loadCredentials();
    notice.value = scope.value === '*'
      ? 'Credential stored for every camera this agent probes.'
      : `Credential stored for ${scope.value}.`;
    credentialOpen.value = false;
    password.value = '';
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    sealing.value = false;
  }
}

function openApprove(camera: Discovered) {
  approving.value = camera;
  displayName.value = camera.model ?? camera.identity;
  const reach = camera.reachableBy.find((r) => r.thingName === agent.value)
    ?? camera.reachableBy[0];
  // Smallest profile for the wall, largest for the one opened full size.
  const profiles = [...(reach?.profiles ?? [])]
    .sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0));
  subProfile.value = profiles[0]?.token;
  mainProfile.value = profiles.at(-1)?.token;
}

async function approve() {
  const camera = approving.value;
  const owner = agent.value ?? camera?.reachableBy[0]?.thingName;
  if (!camera || !owner || !isValidDisplayName(displayName.value)) return;
  error.value = null;
  try {
    await api.approveCamera({
      identity: camera.identity,
      assignedTo: owner,
      cameraId: idFrom(displayName.value) ?? undefined,
      displayName: displayName.value.trim(),
      subProfileToken: subProfile.value,
      mainProfileToken: mainProfile.value,
    });
    approving.value = null;
    notice.value = `${displayName.value.trim()} added. It appears on the live view once the agent starts publishing it.`;
    await refresh();
  } catch (err) {
    error.value = (err as Error).message;
  }
}

/** Which agents can see a camera, which is what makes an assignment valid. */
function reachSummary(camera: Discovered): string {
  return camera.reachableBy
    .map((r) => `${r.thingName.split('--').at(-1)} (${r.ipAddress ?? 'no address'})`)
    .join(', ');
}

function authState(camera: Discovered): { label: string; severity: string } {
  const states = camera.reachableBy.map((r) => r.authState).filter(Boolean);
  if (states.includes('ok')) return { label: 'credentials ok', severity: 'success' };
  if (states.includes('unauthorized')) return { label: 'needs credentials', severity: 'warn' };
  return { label: 'not probed', severity: 'secondary' };
}

watch(() => [selection.premisesId, selection.agentId], () => {
  agent.value = selection.agentId ?? agentOptions.value[0]?.value ?? null;
  void refresh();
  void loadCredentials();
});

watch(agent, () => { void loadCredentials(); });

onMounted(() => {
  agent.value = selection.agentId ?? agentOptions.value[0]?.value ?? null;
  void refresh();
  void loadCredentials();
});
</script>

<template>
  <div>
    <div class="page-head"><h1>Add cameras</h1></div>

    <p v-if="!selection.ready" class="empty">Choose a premises on the left to begin.</p>

    <template v-else>
      <ol class="steps">
        <li>
          <h2>1 — Install the agent</h2>
          <p class="steps__note">
            A zip holding the installer, a launcher you can double-click, and a note listing
            the Java and FFmpeg archives to put beside it. It carries a one-use enrolment
            token, so download it when you are ready to install. Create the agent on the
            Agents page first if it is not listed here.
          </p>
          <div class="row">
            <Select
              v-model="agent" :options="agentOptions" option-label="label" option-value="value"
              placeholder="Which agent" aria-label="Agent" class="grow"
            />
            <Select
              v-model="platform" :options="['linux', 'windows', 'macos']"
              aria-label="Platform"
            />
            <Button
              v-tooltip.top="'A folder to copy to the machine at the site and run there'"
              label="Download installer" icon="pi pi-download" size="small"
              :disabled="!agent" :loading="downloading" @click="downloadInstaller"
            />
          </div>
          <p v-if="chosen && !chosen.enrolled" class="steps__note steps__note--warn">
            This agent has not checked in yet. Until it does it has no key, so credentials
            cannot be sealed to it.
          </p>
        </li>

        <li>
          <h2>2 — Give it the camera credentials</h2>
          <p class="steps__note">
            Sealed in this browser against that agent's own key. The plaintext never reaches
            the network, and nothing in the cloud can read it. A site may hold up to five,
            tried in the order shown — the agent moves to the next only when a camera
            refuses the one before it.
          </p>
          <ul v-if="credentials.length" class="creds">
            <li v-for="entry in credentials" :key="entry.scope" class="creds__row">
              <span class="creds__who">{{ entry.username || '(account not recorded)' }}</span>
              <span class="creds__slot">{{ slotLabel(entry.scope) }}</span>
              <span class="creds__actions">
                <Button
                  v-tooltip.top="'Replace this credential. The camera is retried with the new one.'"
                  size="small" text label="Change"
                  :disabled="!chosen?.credentialPublicKey"
                  @click="openCredential({ edit: entry })"
                />
                <Button
                  v-tooltip.top="'Remove this credential'"
                  size="small" text severity="danger" icon="pi pi-trash"
                  :aria-label="`Remove the ${entry.username} credential`"
                  @click="removeCredential(entry)"
                />
              </span>
            </li>
          </ul>

          <div class="row">
            <Button
              :label="credentials.length ? 'Add another' : 'Set a site-wide credential'"
              size="small" severity="secondary"
              :disabled="!chosen?.credentialPublicKey || !canAddAnother"
              @click="openCredential()"
            />
            <span v-if="!canAddAnother" class="steps__note">
              Five is the limit. Each one a camera refuses is another failed sign-in against
              it, and many lock an account out after a handful.
            </span>
            <span v-if="!cryptoAvailable()" class="steps__note steps__note--warn">
              This browser cannot encrypt here — WebCrypto needs a secure origin.
            </span>
          </div>
        </li>

        <li>
          <h2>3 — Find the cameras</h2>
          <div class="row">
            <Button
              v-tooltip.top="'Ask the agent to sweep its network now, rather than waiting for the next scan'"
              label="Scan now" icon="pi pi-search" size="small" severity="secondary"
              :disabled="!agent" @click="scan"
            />
            <Button
              v-tooltip.top="'Fetch what the agent has found so far'"
              label="Refresh" icon="pi pi-refresh" size="small" text severity="secondary"
              :loading="loading" @click="refresh"
            />
          </div>
        </li>
      </ol>

      <Message v-if="error" severity="error" size="small" variant="simple">{{ error }}</Message>
      <Message v-if="notice" severity="info" size="small" variant="simple">{{ notice }}</Message>

      <h2 class="found">4 — Approve what belongs</h2>
      <DataTable :value="rows" data-key="identity" size="small" striped-rows>
        <Column header="Camera">
          <template #body="{ data }">
            <div>{{ data.manufacturer ? `${data.manufacturer} ${data.model ?? ''}` : (data.model ?? 'Unknown model') }}</div>
            <div class="sub">
              <code>{{ data.identity }}</code>
              <span v-if="!data.identityStable" class="warn"> · address-derived, may move</span>
            </div>
          </template>
        </Column>
        <Column header="Seen by">
          <template #body="{ data }"><span class="sub">{{ reachSummary(data) }}</span></template>
        </Column>
        <Column header="Access">
          <template #body="{ data }">
            <Tag :value="authState(data).label" :severity="authState(data).severity" />
          </template>
        </Column>
        <Column header="" style="width: 15rem">
          <template #body="{ data }">
            <span v-if="data.approved" class="sub">
              Added as {{ data.approved.displayName }}
            </span>
            <span v-else class="row">
              <Button
                v-tooltip.top="'Put this camera into service and give it a name'"
                size="small" label="Approve" @click="openApprove(data)"
              />
              <Button
                v-tooltip.top="'Give this camera its own username and password, instead of the site-wide one'"
                size="small" text severity="secondary" label="Credentials"
                :disabled="!chosen?.credentialPublicKey"
                @click="openCredential({ camera: data })"
              />
            </span>
          </template>
        </Column>
        <template #empty>
          <p class="empty">
            {{ loading ? 'Loading…' : 'Nothing found yet. Install an agent, give it credentials, then scan.' }}
          </p>
        </template>
      </DataTable>
    </template>

    <Dialog
      v-model:visible="credentialOpen"
      modal header="Camera credentials" :style="{ width: '26rem' }"
    >
      <p class="sub">
        Sealed in this browser against <code>{{ agent }}</code> and stored as ciphertext the
        cloud cannot open — which is also why an existing password cannot be shown back to
        you, only replaced.
      </p>
      <div class="stack">
        <label for="cred-scope">Applies to</label>
        <InputText id="cred-scope" v-model="scope" fluid />
        <label for="cred-user">Username</label>
        <InputText id="cred-user" v-model="username" autocomplete="off" fluid />
        <label for="cred-pass">Password</label>
        <Password id="cred-pass" v-model="password" :feedback="false" toggle-mask fluid />
      </div>
      <template #footer>
        <Button label="Cancel" text severity="secondary" @click="credentialOpen = false" />
        <Button
          label="Seal and store" :loading="sealing"
          :disabled="!username || !password || !chosen?.credentialPublicKey"
          @click="saveCredential"
        />
      </template>
    </Dialog>

    <Dialog
      :visible="approving !== null" modal header="Approve this camera"
      :style="{ width: '26rem' }" @update:visible="approving = null"
    >
      <div class="stack">
        <label for="cam-name">Name</label>
        <InputText id="cam-name" v-model="displayName" :invalid="Boolean(nameComplaintFor)" fluid />
        <span v-if="nameComplaintFor" class="warn">{{ nameComplaintFor }}</span>
        <span v-else-if="idFrom(displayName)" class="sub">
          Known as <code>{{ idFrom(displayName) }}</code>
        </span>

        <template v-if="approving">
          <label for="cam-sub">Wall stream</label>
          <Select
            id="cam-sub" v-model="subProfile"
            :options="approving.reachableBy.flatMap((r) => r.profiles)"
            option-label="name" option-value="token" fluid
          />
          <label for="cam-main">Full-size stream</label>
          <Select
            id="cam-main" v-model="mainProfile"
            :options="approving.reachableBy.flatMap((r) => r.profiles)"
            option-label="name" option-value="token" fluid
          />
        </template>
      </div>
      <template #footer>
        <Button label="Cancel" text severity="secondary" @click="approving = null" />
        <Button label="Approve" :disabled="!isValidDisplayName(displayName)" @click="approve" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.steps {
  display: grid;
  gap: 1rem;
  margin: 0 0 1.25rem;
  padding: 0;
  list-style: none;
}

.steps h2,
.found {
  margin: 0 0 0.3rem;
  font-size: 0.86rem;
  font-weight: 600;
}

.found {
  margin-top: 1rem;
}

.steps__note,
.sub {
  margin: 0 0 0.4rem;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--p-text-muted-color);
}

.steps__note--warn,
.warn {
  color: var(--p-orange-400);
}

.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.creds {
  margin: 0 0 0.5rem;
  padding: 0;
  list-style: none;
  max-width: 34rem;
}

.creds__row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.15rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}

.creds__who {
  font-size: 0.85rem;
}

.creds__slot {
  font-size: 0.72rem;
  color: var(--p-text-muted-color);
}

.creds__actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.1rem;
}

.grow {
  flex: 1 1 14rem;
  max-width: 22rem;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.stack label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.74rem;
}
</style>

