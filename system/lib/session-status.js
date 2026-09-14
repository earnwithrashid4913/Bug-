'use strict';

const { maskInternationalNumber } = require('./pairing-number');

const SESSION_STATES = Object.freeze({
  STARTING: 'starting',
  CONNECTING: 'connecting',
  RECONNECTING: 'reconnecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  LOGGED_OUT: 'logged_out',
  ERROR: 'error',
  PAIRING: 'pairing'
});

function createSessionStatus(id = 'primary') {
  const now = Date.now();
  return {
    id: String(id),
    state: SESSION_STATES.STARTING,
    connected: false,
    connectedAt: null,
    reconnects: 0,
    hasConnected: false,
    lastEvent: 'Starting',
    lastUpdate: now,
    safeNumber: null,
    sessionLabel: 'unknown'
  };
}

function transitionSessionStatus(status, state, event = state) {
  const next = String(state || SESSION_STATES.ERROR).toLowerCase();
  const wasConnected = status.state === SESSION_STATES.CONNECTED || status.connected === true;
  const now = Date.now();
  if (next === SESSION_STATES.CONNECTED) {
    if (!wasConnected) {
      if (status.hasConnected) status.reconnects += 1;
      status.connectedAt = now;
      status.hasConnected = true;
    }
    status.connected = true;
  } else {
    status.connected = false;
  }
  status.state = next;
  status.lastEvent = String(event || next);
  status.lastUpdate = now;
  return status;
}

function formatDuration(from, now = Date.now()) {
  const timestamp = Number(from);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || now < timestamp) return 'Unavailable';
  const total = Math.floor((now - timestamp) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  return `${String(date.getUTCDate()).padStart(2, '0')} ${date.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${date.getUTCFullYear()} • ${date.toISOString().slice(11, 19)} UTC`;
}

function safeSessionNumber(number) {
  if (!number) return 'Unavailable';
  try { return maskInternationalNumber(number); } catch { return 'Unavailable'; }
}

function sessionDashboard(status, { number, compact = false } = {}) {
  const state = status?.state || SESSION_STATES.ERROR;
  const icon = state === SESSION_STATES.CONNECTED ? '🟢' : state === SESSION_STATES.CONNECTING ? '🟡' : state === SESSION_STATES.RECONNECTING ? '🔵' : state === SESSION_STATES.LOGGED_OUT ? '⚪' : state === SESSION_STATES.DISCONNECTED ? '🔴' : '⚠️';
  const label = state.replace('_', ' ').toUpperCase();
  const lines = [
    `${icon} Status: ${label}`,
    `📱 Session: ${safeSessionNumber(number || status?.safeNumber)}`,
    `⏱️ Uptime: ${status?.connected ? formatDuration(status.connectedAt) : 'Unavailable'}`,
    `📅 Connected Since: ${status?.connected ? formatTimestamp(status.connectedAt) : 'Unavailable'}`,
    `🔄 Reconnects: ${Number(status?.reconnects || 0)}`,
    `⚡ Last Event: ${status?.lastEvent || 'Unavailable'}`,
    `🕐 Last Update: ${formatTimestamp(status?.lastUpdate)}`
  ];
  return compact ? lines.slice(0, 4).join('\n') : lines.join('\n');
}

function snapshotSessionStatus(status, number) {
  return {
    id: status?.id || 'unknown',
    state: status?.state || SESSION_STATES.ERROR,
    connected: Boolean(status?.connected),
    connectedAt: status?.connectedAt || null,
    uptime: status?.connected ? formatDuration(status.connectedAt) : 'Unavailable',
    connectedSince: status?.connected ? formatTimestamp(status.connectedAt) : 'Unavailable',
    reconnects: Number(status?.reconnects || 0),
    lastEvent: status?.lastEvent || 'Unavailable',
    lastUpdate: status?.lastUpdate || null,
    session: safeSessionNumber(number || status?.safeNumber)
  };
}

module.exports = { SESSION_STATES, createSessionStatus, formatDuration, formatTimestamp, safeSessionNumber, sessionDashboard, snapshotSessionStatus, transitionSessionStatus };
