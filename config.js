'use strict';

// =============================================================================
// ANIME MD CONFIGURATION
// =============================================================================
// This is the only file you need to edit to configure the bot. Do not put
// secrets in a .env file. Replace only the YOUR_... placeholders below.

module.exports = {
  // ========================================== BOT SETTINGS ==================
  bot: {
    // Display name shown in bot messages. OPTIONAL. Example: "ANIME MD".
    name: 'ANIME MD',
    // Command prefix (1-4 characters, no spaces). REQUIRED. Example: "!".
    prefix: '!',
    // true lets everyone use commands; false restricts them to the owner. OPTIONAL.
    publicMode: true,
    // Display name used in messages such as !owner. OPTIONAL. Example: "Your Name".
    ownerName: 'Rashid Hussain'
  },

  // ======================================== OWNER SETTINGS =================
  owner: {
    // WhatsApp channel displayed by !owner. OPTIONAL. Example: "https://whatsapp.com/channel/...".
    whatsappChannel: 'https://whatsapp.com/channel/0029VbBepCNBVJl5vGUHET3T'
  },

  // ======================================= SECURITY SETTINGS ===============
  security: {
    // Optional signed identity-manifest file used by maintainers for protected
    // admin grants. Leave blank for normal deployments. Example: "/private/identity.json".
    trustedIdentityFile: '',
    // Optional HMAC key for that manifest. REQUIRED only with trustedIdentityFile.
    // Never commit a real key; use a private deployment-specific config.js instead.
    trustedIdentityHmacKey: ''
  },

  // ===================================== WHATSAPP SETTINGS =================
  whatsapp: {
    // "pairing" uses a pairing code; "qr" prints a terminal QR code. REQUIRED.
    authMethod: 'pairing',
    // Do NOT enter a phone number here: Telegram /pair <number> keeps it dynamic.
    // Folder where WhatsApp credentials are stored. REQUIRED. Example: "./session".
    authDir: './session',
    // Optional existing creds.json as raw JSON/base64 for hosts without a disk. Leave blank normally.
    sessionId: '',
    // true replaces an existing session with sessionId. OPTIONAL; normally false.
    sessionOverwrite: false,
    // Image sent after the primary WhatsApp session connects. OPTIONAL HTTPS URL.
    connectionSuccessImage: 'https://files.catbox.moe/6ghm7j.png'
  },

  // ===================================== TELEGRAM SETTINGS =================
  telegram: {
    // Set true after entering the token and owner ID; false disables Telegram. OPTIONAL. Example: true.
    enabled: false,
    // Get this from @BotFather. REQUIRED only when enabled for pairing.
    botToken: 'YOUR_TELEGRAM_BOT_TOKEN',
    // Public bot link. OPTIONAL. Example: "https://t.me/YourBotUsername".
    botLink: 'https://t.me/YOUR_BOT_USERNAME',
    // Numeric Telegram IDs allowed to pair/manage sessions. REQUIRED when enabled.
    // Example: ["123456789"].
    ownerIds: ['YOUR_TELEGRAM_OWNER_ID'],
    // Database path for Telegram controllers. OPTIONAL. Example: "./data/telegram-controllers.json".
    controllerDbPath: './data/telegram-controllers.json',
    // Optional HTTPS images shown by Telegram.
    startImage: 'https://files.catbox.moe/cvdoo3.png',
    connectedImage: 'https://files.catbox.moe/uuuqdm.png'
  },

  // ========================================= API SETTINGS ==================
  api: {
    // Groq key for !ai. OPTIONAL. Get it from https://console.groq.com.
    groqApiKey: 'YOUR_GROQ_API_KEY',
    // Groq model for !ai. OPTIONAL. Example: "openai/gpt-oss-20b".
    groqModel: 'openai/gpt-oss-20b',
    // Cobalt server for video downloads. OPTIONAL HTTPS URL.
    cobaltApiUrl: 'https://cobalt-api.kwiatekmiki.com',
    // Catbox endpoint for !tourl uploads. OPTIONAL HTTPS URL.
    uploadApiUrl: 'https://catbox.moe/user/api.php'
  },

  // ======================================== DATABASE SETTINGS ===============
  database: {
    // Persistent data folder. REQUIRED. On Pterodactyl, use a persistent path.
    dataDir: './data',
    // Premium-user database path. OPTIONAL. Example: "./data/premium.json".
    premiumDbPath: '',
    // Group greeting/settings database path. OPTIONAL. Example: "./data/groups.json".
    groupSettingsDbPath: '',
    // Public/self bot-mode database path. OPTIONAL. Example: "./data/mode.json".
    modeDbPath: '',
    // Sudo/admin database path. OPTIONAL. Example: "./data/sudo.json".
    sudoDbPath: '',
    // Warning records database path. OPTIONAL. Example: "./data/warnings.json".
    warningDbPath: '',
    // Economy database path. OPTIONAL. Example: "./data/economy.json".
    economyDbPath: '',
    // Runtime command-setting database path. OPTIONAL. Example: "./data/settings.json".
    settingsDbPath: '',
    // Automation-rule database path. OPTIONAL. Example: "./data/automation.json".
    automationDbPath: ''
  },

  // ========================================= THEME SETTINGS =================
  theme: {
    // Reserved for theme-aware clients. OPTIONAL. Example: "default".
    // The current bot has no theme engine, so this is safely retained as metadata.
    name: 'default'
  },

  // ====================================== COMMAND SETTINGS ==================
  commands: {
    // Sticker metadata. OPTIONAL. Example: "My Anime Bot".
    stickerPackname: 'ANIME MD',
    // Sticker author line. OPTIONAL. Example: "Your Name".
    stickerAuthor: 'F!xa Dev',
    // Greeting templates; @user and @group are replaced at runtime. OPTIONAL.
    welcomeMessage: 'Welcome @user to *@group*!',
    goodbyeMessage: 'Goodbye @user from *@group*.'
  },

  // =============================== PTERODACTYL / DEPLOYMENT SETTINGS =======
  deployment: {
    // Logging level. OPTIONAL. Example: "info".
    logLevel: 'info',
    // true validates configuration without opening a WhatsApp connection. OPTIONAL; use for testing.
    dryRun: false,
    // First reconnect delay in milliseconds. OPTIONAL. Example: 3000.
    reconnectBaseDelayMs: 3000,
    // Maximum reconnect delay in milliseconds. OPTIONAL. Example: 60000.
    reconnectMaxDelayMs: 60000
  }
};
