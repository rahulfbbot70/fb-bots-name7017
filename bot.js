const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs");
const path = require("path");
const HttpsProxyAgent = require("https-proxy-agent");

// Optional Proxy (fallback safe)
const INDIAN_PROXY = "http://103.119.112.54:80";
let proxyAgent;
try {
  proxyAgent = new HttpsProxyAgent(INDIAN_PROXY);
} catch {
  proxyAgent = null;
}

const uid = process.argv[2];
const userDir = path.join(__dirname, "users", uid);
const appStatePath = path.join(userDir, "appstate.json");
const adminPath = path.join(userDir, "admin.txt");
const logPath = path.join(userDir, "logs.txt");

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + "\n");
}

// Load AppState
let appState;
try {
  const raw = fs.readFileSync(appStatePath, "utf-8");
  if (!raw.trim()) throw new Error("File empty");
  appState = JSON.parse(raw);
} catch {
  log("❌ appstate.json invalid or empty.");
  process.exit(1);
}

// Load Admin UID
let BOSS_UID;
try {
  BOSS_UID = fs.readFileSync(adminPath, "utf-8").trim();
  if (!BOSS_UID) throw new Error("UID missing");
} catch {
  log("❌ admin.txt invalid or empty.");
  process.exit(1);
}

// State Variables
let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let lockedNick = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;

// Login Options
const loginOptions = {
  appState,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/400.0.0.0.0",
  agent: proxyAgent,
};

// Start Bot
function startBot() {
  login(loginOptions, (err, api) => {
    if (err) {
      log("❌ [LOGIN FAILED]: " + err);
      setTimeout(startBot, 10000); // retry after 10s
      return;
    }

    api.setOptions({
      listenEvents: true,
      selfListen: true,
      updatePresence: true,
    });

    log("🤖 BOT ONLINE — Running now");

    // Anti-Sleep
    setInterval(() => {
      if (GROUP_THREAD_ID) {
        api.sendTypingIndicator(GROUP_THREAD_ID, true);
        setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1500);
        log("💤 Anti-Sleep Triggered");
      }
    }, 300000);

    // Auto-save AppState
    setInterval(() => {
      try {
        const newAppState = api.getAppState();
        fs.writeFileSync(appStatePath, JSON.stringify(newAppState, null, 2));
        log("💾 AppState saved ✅");
      } catch (e) {
        log("❌ Failed saving AppState: " + e);
      }
    }, 600000);

    // Listener with auto-reconnect
    function listen() {
      try {
        api.listenMqtt(async (err, event) => {
          if (err) {
            log("❌ Listen error: " + err);
            setTimeout(listen, 5000); // auto reconnect
            return;
          }

          const senderID = event.senderID;
          const threadID = event.threadID;
          const body = (event.body || "").toLowerCase();

          if (event.type === "message") {
            log(`📩 ${senderID}: ${event.body} (Group: ${threadID})`);
          }

          // -------------------
          // COMMAND HANDLERS
          // -------------------

          // /gclock
          if (body.startsWith("/gclock") && senderID === BOSS_UID) {
            try {
              const newName = event.body.slice(7).trim();
              GROUP_THREAD_ID = threadID;
              LOCKED_GROUP_NAME = newName;
              gcAutoRemoveEnabled = false;
              await api.setTitle(newName, threadID);
              api.sendMessage(`🔒 Group name locked: "${newName}"`, threadID);
            } catch {
              api.sendMessage("❌ Failed to lock name", threadID);
            }
          }

          // /gcremove
          if (body === "/gcremove" && senderID === BOSS_UID) {
            try {
              await api.setTitle("", threadID);
              LOCKED_GROUP_NAME = null;
              GROUP_THREAD_ID = threadID;
              gcAutoRemoveEnabled = true;
              api.sendMessage("🧹 Name removed. Auto-remove ON ✅", threadID);
            } catch {
              api.sendMessage("❌ Failed to remove name", threadID);
            }
          }

          // Handle group name changes
          if (event.logMessageType === "log:thread-name") {
            const changed = event.logMessageData.name;
            if (LOCKED_GROUP_NAME && threadID === GROUP_THREAD_ID && changed !== LOCKED_GROUP_NAME) {
              try {
                await api.setTitle(LOCKED_GROUP_NAME, threadID);
              } catch {
                log("❌ Failed reverting GC name");
              }
            } else if (gcAutoRemoveEnabled) {
              try {
                await api.setTitle("", threadID);
                log(`🧹 GC name auto-removed: "${changed}"`);
              } catch {
                log("❌ Failed auto-remove GC name");
              }
            }
          }

          // /nicklock on <name>
          if (body.startsWith("/nicklock on") && senderID === BOSS_UID) {
            lockedNick = event.body.slice(13).trim();
            nickLockEnabled = true;
            try {
              const info = await api.getThreadInfo(threadID);
              for (const u of info.userInfo) {
                await api.changeNickname(lockedNick, threadID, u.id);
              }
              api.sendMessage(`🔐 Nickname locked: "${lockedNick}"`, threadID);
            } catch {
              api.sendMessage("❌ Failed setting nick", threadID);
            }
          }

          // /nicklock off
          if (body === "/nicklock off" && senderID === BOSS_UID) {
            nickLockEnabled = false;
            lockedNick = null;
            api.sendMessage("🔓 Nickname lock disabled", threadID);
          }

          // /nickremoveall
          if (body === "/nickremoveall" && senderID === BOSS_UID) {
            nickRemoveEnabled = true;
            try {
              const info = await api.getThreadInfo(threadID);
              for (const u of info.userInfo) {
                await api.changeNickname("", threadID, u.id);
              }
              api.sendMessage("💥 Nicknames cleared. Auto-remove ON", threadID);
            } catch {
              api.sendMessage("❌ Failed removing nicknames", threadID);
            }
          }

          // /nickremoveoff
          if (body === "/nickremoveoff" && senderID === BOSS_UID) {
            nickRemoveEnabled = false;
            api.sendMessage("🛑 Nick auto-remove OFF", threadID);
          }

          // Handle nickname changes
          if (event.logMessageType === "log:user-nickname") {
            const changedUID = event.logMessageData.participant_id;
            const newNick = event.logMessageData.nickname;

            if (nickLockEnabled && newNick !== lockedNick) {
              try {
                await api.changeNickname(lockedNick, threadID, changedUID);
              } catch {
                log("❌ Failed reverting nickname");
              }
            }

            if (nickRemoveEnabled && newNick !== "") {
              try {
                await api.changeNickname("", threadID, changedUID);
              } catch {
                log("❌ Failed auto-remove nickname");
              }
            }
          }

          // /status
          if (body === "/status" && senderID === BOSS_UID) {
            const msg = `
BOT STATUS:
• GC Lock: ${LOCKED_GROUP_NAME || "OFF"}
• GC AutoRemove: ${gcAutoRemoveEnabled ? "ON" : "OFF"}
• Nick Lock: ${nickLockEnabled ? `ON (${lockedNick})` : "OFF"}
• Nick AutoRemove: ${nickRemoveEnabled ? "ON" : "OFF"}
`;
            api.sendMessage(msg.trim(), threadID);
          }
        });
      } catch (e) {
        log("❌ Listener crashed: " + e);
        setTimeout(listen, 5000);
      }
    }

    listen(); // start listening
  });
}

startBot();
