'use strict';
// Source BotTracker adapted to the existing atomic RuntimeSettingsStore.
// No connection/session lifecycle hooks and no second database.
class BotTracker {
  constructor(settings, { apiUrl = process.env.BOT_API_URL || '', phoneNumber = 'unknown' } = {}) {
    this.settings = settings;
    this.apiUrl = apiUrl;
    this.stats = { phoneNumber, startTime: Date.now(), commandsExecuted: 0, lastHeartbeat: Date.now(), isActive: true, version: '1.0.0', lastCommand: null, commandHistory: [] };
    this.heartbeatInterval = null;
    this.saveInterval = null;
    this.isApiAvailable = true;
  }
  async loadStats() {
    const saved = await this.settings.get('botTracker');
    this.stats.commandsExecuted = saved?.commandsExecuted || 0;
  }
  async saveStats() {
    await this.settings.set('botTracker', { commandsExecuted: this.stats.commandsExecuted, startTime: this.stats.startTime, lastSave: Date.now() });
  }
  async start() {
    if (this.heartbeatInterval) return;
    this.stats.isActive = true;
    await this.loadStats();
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat().catch(error => console.warn('[tracker]', error.message)), 3600000);
    this.saveInterval = setInterval(() => this.saveStats().catch(error => console.warn('[tracker]', error.message)), 300000);
    this.heartbeatInterval.unref(); this.saveInterval.unref();
    await this.sendHeartbeat();
  }
  async stop() {
    clearInterval(this.heartbeatInterval); clearInterval(this.saveInterval);
    this.heartbeatInterval = null; this.saveInterval = null;
    this.stats.isActive = false;
    await this.sendHeartbeat(); await this.saveStats();
  }
  incrementCommands(name) {
    this.stats.commandsExecuted++;
    this.stats.lastHeartbeat = Date.now();
    this.stats.lastCommand = { name, time: Date.now(), timestamp: new Date().toISOString() };
    this.stats.commandHistory.unshift(this.stats.lastCommand);
    this.stats.commandHistory = this.stats.commandHistory.slice(0, 100);
  }
  getUptime() {
    const milliseconds = Date.now() - this.stats.startTime;
    return { hours: Math.floor(milliseconds / 3600000), minutes: Math.floor(milliseconds % 3600000 / 60000), seconds: Math.floor(milliseconds % 60000 / 1000), milliseconds };
  }
  async sendHeartbeat() {
    const uptime = this.getUptime();
    const payload = { phoneNumber: this.stats.phoneNumber, commandsExecuted: this.stats.commandsExecuted, uptimeHours: uptime.hours, uptimeMinutes: uptime.minutes, uptimeSeconds: uptime.seconds, uptimeMs: uptime.milliseconds, lastHeartbeat: Date.now(), isActive: this.stats.isActive, version: this.stats.version, timestamp: new Date().toISOString(), lastCommand: this.stats.lastCommand };
    if (this.apiUrl) {
      try {
        const url = new URL(this.apiUrl);
        if (url.protocol !== 'https:') throw new Error('Tracker API must use HTTPS');
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.isApiAvailable = true;
        return;
      } catch { this.isApiAvailable = false; }
    }
    await this.logHeartbeatLocally(payload);
  }
  async logHeartbeatLocally(payload) {
    await this.settings.update(data => { data.botHeartbeats = [...(data.botHeartbeats || []), { ...payload, localLogTime: Date.now() }].slice(-1000); });
  }
  getStats() { return { ...this.stats, uptime: this.getUptime(), apiAvailable: this.isApiAvailable, apiUrlConfigured: Boolean(this.apiUrl) }; }
  showStats() { console.info('[BotTracker]', this.getStats()); }
  async forceHeartbeat() { this.isApiAvailable = true; await this.sendHeartbeat(); this.showStats(); }
}
module.exports = { BotTracker };
