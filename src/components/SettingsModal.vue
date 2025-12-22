<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { PlaylistCache } from "../utils/cache";

const props = defineProps<{
  onClose?: () => void;
  standalone?: boolean; // Whether opened as standalone modal or in settings
}>();

const emits = defineEmits(["dialogClose", "close"]);

const settings = ref({
  enabled: true,
  expirationMinutes: 5,
});

const stats = ref({
  totalPlaylists: 0,
  expiredPlaylists: 0,
  modifiedPlaylists: 0,
  cacheSize: "0 KB",
  oldestCache: null as Date | null,
});

const presetOptions = [
  { label: "1 minute", value: 1 },
  { label: "5 minutes", value: 5 },
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "Custom", value: -1 },
];

const selectedPreset = ref(5);
const customMinutes = ref(5);
const showCustomInput = computed(() => selectedPreset.value === -1);
const saveSuccess = ref(false);

// Determine if we're in standalone modal mode
const isStandalone = computed(() => props.standalone !== false && !!props.onClose);

onMounted(() => {
  loadSettings();
  loadStats();
});

function loadSettings() {
  const cached = PlaylistCache.getSettings();
  settings.value = { ...cached };
  
  // Set preset or custom
  const preset = presetOptions.find(p => p.value === cached.expirationMinutes);
  if (preset && preset.value !== -1) {
    selectedPreset.value = preset.value;
  } else {
    selectedPreset.value = -1;
    customMinutes.value = cached.expirationMinutes;
  }
}

function loadStats() {
  stats.value = PlaylistCache.getStats();
}

function handlePresetChange() {
  if (selectedPreset.value !== -1) {
    settings.value.expirationMinutes = selectedPreset.value;
  }
}

function handleCustomChange() {
  if (customMinutes.value > 0) {
    settings.value.expirationMinutes = customMinutes.value;
  }
}

function saveSettings() {
  PlaylistCache.saveSettings(settings.value);
  
  // Show success indicator
  saveSuccess.value = true;
  setTimeout(() => {
    saveSuccess.value = false;
  }, 2000);
  
  // Only close if standalone modal
  if (isStandalone.value) {
    setTimeout(() => {
      closeModal();
    }, 500);
  }
}

function clearCache() {
  if (confirm("Are you sure you want to clear the entire cache? This will refresh all playlists on next open.")) {
    PlaylistCache.clearCache();
    loadStats();
  }
}

function formatDate(date: Date | null): string {
  if (!date) return "Never";
  
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function closeModal() {
  if (props.onClose) {
    props.onClose();
  }
  emits("dialogClose");
  emits("close");
}
</script>

<template>
  <div class="settings-modal" :class="{ 'modal-content plugin-base': isStandalone, 'embedded-settings': !isStandalone }">
    <cider-modal-title-bar
      v-if="isStandalone"
      title="Playlist Manager Settings"
      :back-btn="false"
      @close-pressed="closeModal"
    />

    <div class="settings-header" v-if="!isStandalone">
      <h2>Playlist Manager Settings</h2>
    </div>

    <div class="modal-body">
      <!-- Cache Settings -->
      <div class="section">
        <h3 class="section-title">Cache Settings</h3>
        
        <div class="setting-row">
          <div class="setting-info">
            <div class="setting-label">Enable Caching</div>
            <div class="setting-description">
              Cache playlist data to improve performance and reduce API calls
            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" v-model="settings.enabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-row" v-if="settings.enabled">
          <div class="setting-info">
            <div class="setting-label">Cache Expiration</div>
            <div class="setting-description">
              How long to keep cached data before refreshing
            </div>
          </div>
          <div class="expiration-controls">
            <select 
              v-model.number="selectedPreset" 
              @change="handlePresetChange"
              class="preset-select"
            >
              <option v-for="preset in presetOptions" :key="preset.value" :value="preset.value">
                {{ preset.label }}
              </option>
            </select>
            
            <div v-if="showCustomInput" class="custom-input-group">
              <input
                type="number"
                v-model.number="customMinutes"
                @input="handleCustomChange"
                min="1"
                max="1440"
                class="custom-input"
              />
              <span class="custom-label">minutes</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Cache Statistics -->
      <div class="section" v-if="settings.enabled">
        <h3 class="section-title">Cache Statistics</h3>
        
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-value">{{ stats.totalPlaylists }}</div>
            <div class="stat-label">Cached Playlists</div>
          </div>
          
          <div class="stat-item">
            <div class="stat-value">{{ stats.modifiedPlaylists }}</div>
            <div class="stat-label">Modified</div>
          </div>
          
          <div class="stat-item">
            <div class="stat-value">{{ stats.expiredPlaylists }}</div>
            <div class="stat-label">Expired</div>
          </div>
          
          <div class="stat-item">
            <div class="stat-value">{{ stats.cacheSize }}</div>
            <div class="stat-label">Cache Size</div>
          </div>
        </div>

        <div class="cache-info">
          <div class="info-row">
            <span class="info-label">Oldest cache:</span>
            <span class="info-value">{{ formatDate(stats.oldestCache) }}</span>
          </div>
        </div>

        <button class="clear-cache-btn" @click="clearCache">
          Clear All Cache
        </button>
      </div>

      <!-- Additional Settings -->
      <div class="section">
        <h3 class="section-title">About</h3>
        <div class="about-text">
          <p>
            This plugin intelligently caches playlist data to improve performance. 
            When you add or remove songs, only those specific playlists are refreshed 
            instead of reloading everything.
          </p>
          <p class="version-info">
            Version 1.3.0 • Created by brenden.i1
          </p>
        </div>
      </div>
    </div>

    <div class="modal-footer" v-if="isStandalone">
      <button class="c-btn" @click="closeModal">Cancel</button>
      <button class="c-btn primary" @click="saveSettings">
        <span v-if="saveSuccess">✓ Saved!</span>
        <span v-else>Save Settings</span>
      </button>
    </div>

    <div class="embedded-footer" v-else>
      <button class="c-btn primary save-btn" @click="saveSettings">
        <span v-if="saveSuccess">✓ Settings Saved!</span>
        <span v-else>Save Settings</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.settings-modal.modal-content {
  height: 600px;
  width: 500px;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background: var(--glass_backgroundColor, #1a1a1a);
  border-radius: 12px;
  overflow: hidden;
}

.settings-modal.embedded-settings {
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
}

.settings-header {
  padding: 24px 20px 0 20px;
}

.settings-header h2 {
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 8px 0;
}

.modal-body {
  overflow-y: auto;
  padding: 0 20px;
}

.embedded-settings .modal-body {
  padding: 20px 0;
}

.section {
  padding: 20px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.section:last-child {
  border-bottom: none;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 16px 0;
}

.setting-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 12px 0;
}

.setting-info {
  flex: 1;
}

.setting-label {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
}

.setting-description {
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.4;
}

.toggle-switch {
  position: relative;
  width: 48px;
  height: 26px;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(255, 255, 255, 0.2);
  transition: 0.3s;
  border-radius: 26px;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 20px;
  width: 20px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .toggle-slider {
  background-color: var(--keyColor, #ff0033);
}

input:checked + .toggle-slider:before {
  transform: translateX(22px);
}

.expiration-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}

.preset-select {
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  font-size: 13px;
  cursor: pointer;
  min-width: 140px;
}

.preset-select:focus {
  outline: none;
  border-color: var(--keyColor, #ff0033);
}

.custom-input-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.custom-input {
  width: 80px;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  font-size: 13px;
  text-align: center;
}

.custom-input:focus {
  outline: none;
  border-color: var(--keyColor, #ff0033);
}

.custom-label {
  font-size: 12px;
  opacity: 0.7;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.stat-item {
  background: rgba(255, 255, 255, 0.05);
  padding: 16px;
  border-radius: 8px;
  text-align: center;
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 4px;
}

.stat-label {
  font-size: 12px;
  opacity: 0.6;
}

.cache-info {
  background: rgba(255, 255, 255, 0.03);
  padding: 12px;
  border-radius: 6px;
  margin-bottom: 16px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.info-label {
  opacity: 0.6;
}

.info-value {
  font-weight: 500;
}

.clear-cache-btn {
  width: 100%;
  padding: 10px;
  border: 1px solid rgba(255, 0, 51, 0.5);
  border-radius: 6px;
  background: rgba(255, 0, 51, 0.1);
  color: #ff3355;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.clear-cache-btn:hover {
  background: rgba(255, 0, 51, 0.2);
  border-color: rgba(255, 0, 51, 0.7);
}

.about-text {
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.8;
}

.about-text p {
  margin: 0 0 12px 0;
}

.about-text p:last-child {
  margin-bottom: 0;
}

.version-info {
  font-size: 12px;
  opacity: 0.5;
  font-style: italic;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.2);
}

.embedded-footer {
  padding: 20px 0;
  display: flex;
  justify-content: flex-start;
}

.c-btn {
  padding: 8px 20px;
  border-radius: 6px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
}

.c-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.c-btn.primary {
  background: var(--keyColor, #ff0033);
  color: white;
}

.c-btn.primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

.save-btn {
  min-width: 140px;
}
</style>
