# WhatsApp public command mapping

Generated from the existing registry and dispatcher. Manual-only commands are intentionally omitted.
Route checks prove registration/mapping, not external API availability or live WhatsApp delivery.

| Command | Valid aliases | Category/menu | Permission | Handler route (awaited calls) | Dispatcher line |
| --- | --- | --- | --- | --- | --- |
| fancy | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1442 |
| encrypt | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1443 |
| encrypt2 | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1444 |
| tempmail | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1445 |
| getmail | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1446 |
| upload | mirror, host | !menu upload | public | `sourceCommands.upload` | system/handler.js:1458 |
| store | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1449 |
| ad | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1450 |
| vd | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1451 |
| list | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1452 |
| del | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1453 |
| menu | help | !menu general | public | `handleMenuCommand` | system/handler.js:1464 |
| ping | p | !menu general | public | `sourceCommands.ping` | system/handler.js:1469 |
| request | reportbug | !menu general | public | `handleReport` | system/handler.js:1475 |
| public | — | !menu mode | owner | `requireOwner`, `modeStore.set`, `sendResult` | system/handler.js:1481 |
| self | private | !menu mode | owner | `requireOwner`, `modeStore.set`, `sendResult` | system/handler.js:1483 |
| mode | botmode | !menu mode | owner | `requireOwner`, `handleModeCommand` | system/handler.js:1495 |
| play | — | !menu downloader | public | `sourceCommands.download` | system/handler.js:1505 |
| ytmp3 | audio, mp3 | !menu downloader | public | `sourceCommands.download` | system/handler.js:1509 |
| video | ytmp4, mp4, ytvideo | !menu downloader | public | `sourceCommands.download` | system/handler.js:1515 |
| spotify | — | !menu downloader | public | `handleSpotifyCommand` | system/handler.js:1522 |
| media | download, dl | !menu downloader | public | `handleMediaCommand` | system/handler.js:1526 |
| getpp | pp, profilepic, avatar | !menu media | public | `handleGetProfilePhoto` | system/handler.js:1533 |
| setpp | — | !menu media | owner | `handleSetBotProfilePhoto` | system/handler.js:1540 |
| vv | hey, revealonce, retrieve, viewonce | !menu media | public | `handleVVCommand` | system/handler.js:1551 |
| save | savestatus, downloadstatus | !menu media | public | `recovery.saveStatus` | system/handler.js:1544 |
| tovid | sticker2vid | !menu converter | public | `sendResult`, `downloadMediaBuffer`, `takeSticker`, `socket.sendMessage`, `convertToVideo`, `sourceCommands.react` | system/handler.js:1584 |
| take | steal | !menu sticker | public | `sendResult`, `downloadMediaBuffer`, `takeSticker`, `socket.sendMessage`, `convertToVideo`, `sourceCommands.react` | system/handler.js:1582 |
| toimg | sticker2img, img | !menu converter | public | `sendResult`, `downloadMediaBuffer`, `convertStickerToImage`, `socket.sendMessage` | system/handler.js:1601 |
| convert | converter | !menu converter | public | `sendResult` | system/handler.js:1624 |
| tts | — | !menu converter | public | `handleTTSCommand` | system/handler.js:1639 |
| qr | qrcode | !menu converter | public | `handleQRCommand` | system/handler.js:1643 |
| tourl | uploader, url, imgtourl, imageurl | !menu upload | public | `handleTourlCommand` | system/handler.js:1649 |
| ai | ask, ia, groq, loveai, love, dark | !menu ai | public | `handleAiCommand` | system/handler.js:1661 |
| translate | tr, trans | !menu ai | public | `handleTranslateCommand` | system/handler.js:1668 |
| jid | chatid | !menu tools | public | `socket.groupMetadata`, `sendResult` | system/handler.js:1675 |
| idch | cekidch | !menu tools | public | `socket.newsletterMetadata`, `sendResult`, `socket.sendMessage` | system/handler.js:1692 |
| calc | calculate, math | !menu tools | public | `handleCalcCommand` | system/handler.js:1731 |
| ss | screenshot | !menu tools | public | `handleSSCommand` | system/handler.js:1737 |
| short | shorten, tinyurl | !menu tools | public | `handleShortCommand` | system/handler.js:1742 |
| uid | — | !menu tools | public | `sendResult` | system/handler.js:2143 |
| tools | utils | !menu tools | public | `sendResult` | system/handler.js:1748 |
| hidetag | ht, tag | !menu group | admin | `requireGroupAdmin`, `socket.groupMetadata`, `socket.profilePictureUrl`, `socket.sendMessage` | system/handler.js:1766 |
| tagall | everyone | !menu group | admin | `requireGroupAdmin`, `socket.groupMetadata`, `socket.profilePictureUrl`, `socket.sendMessage` | system/handler.js:1769 |
| greet | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:1794 |
| welcome | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:1792 |
| goodbye | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:1793 |
| group | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1801 |
| gname | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1802 |
| gdesc | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1803 |
| add | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1804 |
| kick | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1805 |
| promote | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1806 |
| demote | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1807 |
| lock | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1808 |
| unlock | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1809 |
| grouplink | linkgc | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:1810 |
| warn | warning | !menu group | admin | `requireGroupAdmin`, `handleWarnCommand` | system/handler.js:1818 |
| unwarn | delwarn | !menu group | admin | `requireGroupAdmin`, `handleUnwarnCommand` | system/handler.js:1826 |
| warns | warnings | !menu group | admin | `handleWarnsCommand` | system/handler.js:1834 |
| antilink | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:1841 |
| antispam | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:1842 |
| antimention | antigroupmention | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:1843 |
| antitag | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:1844 |
| antidelete | antisupp | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:1847 |
| autoreact | autoreaction | !menu automation | admin | `requireGroupAdmin`, `sendResult`, `handleAutomationToggle` | system/handler.js:1866 |
| autowrite | autotype, fakewrite | !menu automation | public | `requireGroupAdmin`, `sendResult`, `handleAutomationToggle` | system/handler.js:1867 |
| autostatus | autostatusview, autostatusreact | !menu automation | owner | `handleAutomationToggle` | system/handler.js:1878 |
| purge | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2288 |
| autopromote | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2293 |
| antidemote | — | !menu anti | admin | `requireGroupAdmin`, `automationStore.setChat`, `sendResult`, `automationStore.getChat` | system/handler.js:2318 |
| antipromote | — | !menu anti | admin | `requireGroupAdmin`, `automationStore.setChat`, `sendResult`, `automationStore.getChat` | system/handler.js:2319 |
| sticker | s, stiker | !menu sticker | public | `sendResult`, `downloadMediaBuffer`, `socket.sendMessage` | system/handler.js:1558 |
| dice | roll | !menu games | public | `handleDiceCommand` | system/handler.js:1883 |
| coin | flip | !menu games | public | `handleCoinCommand` | system/handler.js:1888 |
| rps | — | !menu games | public | `handleRPSCommand` | system/handler.js:1893 |
| guess | guessthenumber | !menu games | public | `sendResult`, `socket.sendMessage` | system/handler.js:2101 |
| balance | bal, wallet | !menu rpg | public | `handleBalanceCommand` | system/handler.js:1898 |
| daily | claim | !menu rpg | public | `handleDailyCommand` | system/handler.js:1904 |
| work | earn | !menu rpg | public | `handleWorkCommand` | system/handler.js:1909 |
| give | — | !menu rpg | public | `handleGiveCommand` | system/handler.js:1914 |
| rpg | economy | !menu rpg | public | `sendResult` | system/handler.js:1918 |
| restart | rst | !menu owner | owner | `requireOwner`, `sendResult` | system/handler.js:1975 |
| setname | — | !menu owner | owner | `requireOwner`, `handleSetNameCommand` | system/handler.js:1988 |
| setprefix | — | !menu owner | owner | `requireOwner`, `handleSetPrefixCommand` | system/handler.js:1994 |
| broadcast | bc | !menu owner | owner | `requireOwner`, `handleBroadcastCommand` | system/handler.js:2000 |
| sudo | addsudo, makesudo | !menu sudo | owner | `requireOwner`, `handleSudoCommand` | system/handler.js:2010 |
| delsudo | removesudo, unsudo | !menu sudo | owner | `requireOwner`, `handleDelsudoCommand` | system/handler.js:2018 |
| sudolist | listsudo, sudos | !menu sudo | sudo | `requireSudoOrOwner`, `handleSudolistCommand` | system/handler.js:2024 |
| addprem | — | !menu premium | owner | `requireOwner`, `socket.sendMessage`, `premiumStore.add`, `sendResult` | system/handler.js:2033 |
| delprem | — | !menu premium | owner | `requireOwner`, `socket.sendMessage`, `premiumStore.remove`, `sendResult` | system/handler.js:2052 |
| listprem | — | !menu premium | owner | `requireOwner`, `premiumStore.list`, `sendResult` | system/handler.js:2071 |
| premium | — | !menu premium | public | `handlePremiumCommand` | system/handler.js:2085 |
| alive | — | !menu info | public | `sourceCommands.alive` | system/handler.js:1942 |
| status | runtime | !menu info | public | `sendResult` | system/handler.js:1945 |
| owner | creator | !menu info | public | `sendOwnerCard` | system/handler.js:1959 |
| sessions | — | !menu sessions | public | `handleSessionsCommand` | system/handler.js:2090 |
| stopsession | stop | !menu sessions | owner | `requireOwner`, `handleStopSessionCommand` | system/handler.js:2094 |
| pairing | tgpair | !menu telegram | public | `sendResult` | system/handler.js:1964 |
| telegram | tg | !menu telegram | public | `sendResult` | system/handler.js:1966 |
| anime | — | !menu anime | public | `handleAnimeCommand` | system/handler.js:2150 |
| manga | — | !menu anime | public | `handleMangaCommand` | system/handler.js:2154 |
| character | char | !menu anime | public | `handleCharacterCommand` | system/handler.js:2158 |
| waifu | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2176 |
| husbando | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2177 |
| dailywaifu | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2178 |
| animequote | quote | !menu anime | public | `handleQuoteCommand` | system/handler.js:2164 |
| animevs | — | !menu anime | public | `handleAnimevsCommand` | system/handler.js:2168 |
| profile | otakuprofile | !menu anime | public | `handleProfileCommand` | system/handler.js:2182 |
| badges | badge | !menu anime | public | `handleBadgesCommand` | system/handler.js:2187 |
| leaderboard | lb, topplayers | !menu anime | public | `handleLeaderboardCommand` | system/handler.js:2192 |
| quizjoin | — | !menu quiz | public | `quizModule.joinQuiz`, `socket.sendMessage` | system/handler.js:2215 |
| quizstop | — | !menu quiz | public | `quizModule.stopQuiz` | system/handler.js:2221 |
| kickall | kickall2 | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2289 |
| demoteall | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2291 |
| promoteall | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2292 |
| opentime | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `socket.sendMessage`, `socket.groupSettingUpdate` | system/handler.js:2329 |
| closetime | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `socket.sendMessage`, `socket.groupSettingUpdate` | system/handler.js:2356 |
| quiz | startquiz | !menu quiz | public | `quizModule.stopQuiz`, `quizModule.joinQuiz`, `socket.sendMessage`, `quizModule.startQuiz` | system/handler.js:2202 |
| couple | lovemeter | !menu funextra | public | `handleCoupleCommand` | system/handler.js:2251 |
| ship | — | !menu funextra | public | `handleShipCommand` | system/handler.js:2172 |
| truth | — | !menu funextra | public | `handleTruthCommand` | system/handler.js:2256 |
| dare | — | !menu funextra | public | `handleDareCommand` | system/handler.js:2260 |
| fact | randomfact | !menu funextra | public | `handleFactCommand` | system/handler.js:2264 |
| pickup | pickupline | !menu funextra | public | `handlePickupCommand` | system/handler.js:2269 |
| meteo | weather | !menu funextra | public | `handleMeteoCommand` | system/handler.js:2274 |
| lyrics | lyric | !menu funextra | public | `handleLyricsCommand` | system/handler.js:2279 |
| tiktok | tt, ttdl | !menu downloader | public | `handleTiktokCommand` | system/handler.js:2229 |
| facebook | fb, fbdl | !menu downloader | public | `handleFacebookCommand` | system/handler.js:2235 |
| twitter | xdl, twdl | !menu downloader | public | `handleXdlCommand` | system/handler.js:2243 |
