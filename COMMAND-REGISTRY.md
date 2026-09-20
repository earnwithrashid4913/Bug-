# WhatsApp public command mapping

Generated from the existing registry and dispatcher. Manual-only commands are intentionally omitted.
Route checks prove registration/mapping, not external API availability or live WhatsApp delivery.

| Command | Valid aliases | Category/menu | Permission | Handler route (awaited calls) | Dispatcher line |
| --- | --- | --- | --- | --- | --- |
| fancy | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1720 |
| encrypt | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1721 |
| encrypt2 | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1722 |
| tempmail | — | !menu tools | public | `tempMail.handleTempMailCommand` | system/handler.js:1727 |
| getmail | — | !menu tools | public | `tempMail.handleGetMailCommand` | system/handler.js:1731 |
| upload | mirror, host | !menu upload | public | `sourceCommands.upload` | system/handler.js:1743 |
| store | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1734 |
| ad | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1735 |
| vd | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1736 |
| list | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1737 |
| del | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1738 |
| menu | help, m, cmds | !menu general | public | `handleMenuCommand` | system/handler.js:1749 |
| ping | p | !menu general | public | `sourceCommands.ping` | system/handler.js:1756 |
| request | reportbug | !menu general | public | `handleReport` | system/handler.js:1762 |
| public | — | !menu mode | owner | `requireOwner`, `modeStore.set`, `sendResult` | system/handler.js:1768 |
| self | private | !menu mode | owner | `requireOwner`, `modeStore.set`, `sendResult` | system/handler.js:1770 |
| mode | botmode | !menu mode | owner | `requireOwner`, `handleModeCommand` | system/handler.js:1782 |
| play | song, music | !menu downloader | public | `sourceCommands.download` | system/handler.js:1792 |
| ytmp3 | audio, mp3, yta, ytaudio | !menu downloader | public | `sourceCommands.download` | system/handler.js:1798 |
| video | ytmp4, mp4, ytvideo, yt, youtube, ytv | !menu downloader | public | `sourceCommands.download` | system/handler.js:1806 |
| spotify | sp, spot | !menu downloader | public | `handleSpotifyCommand` | system/handler.js:1816 |
| media | download, dl | !menu downloader | public | `handleMediaCommand` | system/handler.js:1822 |
| aio | allinone, alldownload, alldl, anydl | !menu downloader | public | `handleAioCommand` | system/handler.js:1828 |
| getpp | pp, profilepic, avatar | !menu media | public | `handleGetProfilePhoto` | system/handler.js:1837 |
| setpp | — | !menu media | owner | `handleSetBotProfilePhoto` | system/handler.js:1844 |
| vv | hey, revealonce, retrieve, viewonce | !menu media | public | `handleVVCommand` | system/handler.js:1855 |
| save | savestatus, downloadstatus | !menu media | public | `recovery.saveStatus` | system/handler.js:1848 |
| tovid | sticker2vid, tomp4 | !menu converter | public | `sendResult`, `downloadMediaBuffer`, `takeSticker`, `socket.sendMessage`, `convertToVideo`, `sourceCommands.react` | system/handler.js:1888 |
| take | steal | !menu sticker | public | `sendResult`, `downloadMediaBuffer`, `takeSticker`, `socket.sendMessage`, `convertToVideo`, `sourceCommands.react` | system/handler.js:1886 |
| toimg | sticker2img, img, toimage | !menu converter | public | `sendResult`, `downloadMediaBuffer`, `convertStickerToImage`, `socket.sendMessage` | system/handler.js:1906 |
| convert | converter | !menu converter | public | `sendResult` | system/handler.js:1930 |
| tts | — | !menu converter | public | `handleTTSCommand` | system/handler.js:1945 |
| qr | qrcode | !menu converter | public | `handleQRCommand` | system/handler.js:1949 |
| tourl | uploader, url, imgtourl, imageurl | !menu upload | public | `handleTourlCommand` | system/handler.js:1955 |
| ai | ask, ia, groq, loveai, love, dark | !menu ai | public | `handleAiCommand` | system/handler.js:1967 |
| translate | tr, trans | !menu ai | public | `handleTranslateCommand` | system/handler.js:1974 |
| image | aiimage, imagine | !menu ai | public | `imageGeneration.handleImageCommand` | system/handler.js:1981 |
| ephoto | ephoto360 | !menu ai | public | `imageGeneration.handleEphotoCommand` | system/handler.js:1987 |
| imgedit | imageedit, aiedit | !menu ai | public | `imageGeneration.handleImageEditCommand` | system/handler.js:1992 |
| jid | chatid | !menu tools | public | `socket.groupMetadata`, `sendResult` | system/handler.js:2003 |
| idch | cekidch | !menu tools | public | `socket.newsletterMetadata`, `sendResult`, `socket.sendMessage` | system/handler.js:2020 |
| calc | calculate, math | !menu tools | public | `handleCalcCommand` | system/handler.js:2059 |
| ss | screenshot | !menu tools | public | `handleSSCommand` | system/handler.js:2065 |
| short | shorten, tinyurl | !menu tools | public | `handleShortCommand` | system/handler.js:2070 |
| uid | — | !menu tools | public | `sendResult` | system/handler.js:2477 |
| tools | utils | !menu tools | public | `sendResult` | system/handler.js:2076 |
| hidetag | ht, tag | !menu group | admin | `requireGroupAdmin`, `socket.groupMetadata`, `socket.profilePictureUrl`, `socket.sendMessage` | system/handler.js:2094 |
| tagall | everyone | !menu group | admin | `requireGroupAdmin`, `socket.groupMetadata`, `socket.profilePictureUrl`, `socket.sendMessage` | system/handler.js:2097 |
| greet | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2122 |
| welcome | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2120 |
| goodbye | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2121 |
| group | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2129 |
| gname | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2130 |
| gdesc | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2131 |
| add | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2132 |
| kick | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2133 |
| promote | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2134 |
| demote | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2135 |
| lock | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2136 |
| unlock | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2137 |
| grouplink | linkgc | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2138 |
| warn | warning | !menu group | admin | `requireGroupAdmin`, `handleWarnCommand` | system/handler.js:2146 |
| unwarn | delwarn | !menu group | admin | `requireGroupAdmin`, `handleUnwarnCommand` | system/handler.js:2154 |
| warns | warnings | !menu group | admin | `requireGroupAdmin`, `handleWarnsCommand` | system/handler.js:2162 |
| antilink | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2173 |
| antispam | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2174 |
| antimention | antigroupmention | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2175 |
| antitag | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2176 |
| antidelete | antisupp | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2179 |
| autoreact | autoreaction | !menu automation | admin | `requireGroupAdmin`, `sendResult`, `handleAutomationToggle` | system/handler.js:2198 |
| autowrite | autotype, fakewrite | !menu automation | public | `requireGroupAdmin`, `sendResult`, `handleAutomationToggle` | system/handler.js:2199 |
| autostatus | autostatusview, autostatusreact | !menu automation | owner | `handleAutomationToggle` | system/handler.js:2210 |
| purge | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2696 |
| autopromote | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2701 |
| antidemote | — | !menu anti | admin | `requireGroupAdmin`, `automationStore.setChat`, `sendResult`, `automationStore.getChat` | system/handler.js:2726 |
| antipromote | — | !menu anti | admin | `requireGroupAdmin`, `automationStore.setChat`, `sendResult`, `automationStore.getChat` | system/handler.js:2727 |
| sticker | s, stiker | !menu sticker | public | `sendResult`, `downloadMediaBuffer`, `socket.sendMessage` | system/handler.js:1862 |
| dice | roll | !menu games | public | `handleDiceCommand` | system/handler.js:2215 |
| coin | flip | !menu games | public | `handleCoinCommand` | system/handler.js:2220 |
| rps | — | !menu games | public | `handleRPSCommand` | system/handler.js:2225 |
| guess | guessthenumber | !menu games | public | `sendResult`, `socket.sendMessage` | system/handler.js:2435 |
| balance | bal, wallet | !menu rpg | public | `handleBalanceCommand` | system/handler.js:2230 |
| daily | claim | !menu rpg | public | `handleDailyCommand` | system/handler.js:2236 |
| work | earn | !menu rpg | public | `handleWorkCommand` | system/handler.js:2241 |
| give | — | !menu rpg | public | `handleGiveCommand` | system/handler.js:2246 |
| rpg | economy | !menu rpg | public | `sendResult` | system/handler.js:2250 |
| restart | rst | !menu owner | owner | `requireOwner`, `sendResult` | system/handler.js:2309 |
| setname | — | !menu owner | owner | `requireOwner`, `handleSetNameCommand` | system/handler.js:2322 |
| setprefix | — | !menu owner | owner | `requireOwner`, `handleSetPrefixCommand` | system/handler.js:2328 |
| broadcast | bc | !menu owner | owner | `requireOwner`, `handleBroadcastCommand` | system/handler.js:2334 |
| sudo | addsudo, makesudo | !menu sudo | owner | `requireOwner`, `handleSudoCommand` | system/handler.js:2344 |
| delsudo | removesudo, unsudo | !menu sudo | owner | `requireOwner`, `handleDelsudoCommand` | system/handler.js:2352 |
| sudolist | listsudo, sudos | !menu sudo | sudo | `requireSudoOrOwner`, `handleSudolistCommand` | system/handler.js:2358 |
| addprem | — | !menu premium | owner | `requireOwner`, `socket.sendMessage`, `premiumStore.add`, `sendResult` | system/handler.js:2367 |
| delprem | — | !menu premium | owner | `requireOwner`, `socket.sendMessage`, `premiumStore.remove`, `sendResult` | system/handler.js:2386 |
| listprem | — | !menu premium | owner | `requireOwner`, `premiumStore.list`, `sendResult` | system/handler.js:2405 |
| premium | — | !menu premium | public | `handlePremiumCommand` | system/handler.js:2419 |
| alive | — | !menu info | public | `sourceCommands.alive` | system/handler.js:2274 |
| status | runtime, st | !menu info | public | `sendResult` | system/handler.js:2277 |
| owner | creator | !menu info | public | `sendOwnerCard` | system/handler.js:2293 |
| sessions | — | !menu sessions | public | `handleSessionsCommand` | system/handler.js:2424 |
| stopsession | stop | !menu sessions | owner | `requireOwner`, `handleStopSessionCommand` | system/handler.js:2428 |
| pairing | tgpair | !menu telegram | public | `sendResult` | system/handler.js:2298 |
| telegram | tg | !menu telegram | public | `sendResult` | system/handler.js:2300 |
| anime | ani | !menu anime | public | `handleAnimeCommand` | system/handler.js:2484 |
| manga | — | !menu anime | public | `handleMangaCommand` | system/handler.js:2489 |
| character | char | !menu anime | public | `handleCharacterCommand` | system/handler.js:2493 |
| waifu | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2511 |
| husbando | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2512 |
| dailywaifu | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2513 |
| animequote | quote | !menu anime | public | `handleQuoteCommand` | system/handler.js:2499 |
| animevs | — | !menu anime | public | `handleAnimevsCommand` | system/handler.js:2503 |
| profile | otakuprofile | !menu anime | public | `handleProfileCommand` | system/handler.js:2517 |
| badges | badge | !menu anime | public | `handleBadgesCommand` | system/handler.js:2522 |
| leaderboard | lb, topplayers | !menu anime | public | `handleLeaderboardCommand` | system/handler.js:2527 |
| quizjoin | — | !menu quiz | public | `quizModule.joinQuiz`, `socket.sendMessage` | system/handler.js:2550 |
| quizstop | — | !menu quiz | public | `quizModule.stopQuiz` | system/handler.js:2556 |
| kickall | kickall2 | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2697 |
| demoteall | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2699 |
| promoteall | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2700 |
| opentime | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `socket.sendMessage`, `socket.groupSettingUpdate` | system/handler.js:2737 |
| closetime | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `socket.sendMessage`, `socket.groupSettingUpdate` | system/handler.js:2764 |
| quiz | startquiz | !menu quiz | public | `quizModule.stopQuiz`, `quizModule.joinQuiz`, `socket.sendMessage`, `quizModule.startQuiz` | system/handler.js:2537 |
| couple | lovemeter | !menu funextra | public | `handleCoupleCommand` | system/handler.js:2659 |
| ship | — | !menu funextra | public | `handleShipCommand` | system/handler.js:2507 |
| truth | — | !menu funextra | public | `handleTruthCommand` | system/handler.js:2664 |
| dare | — | !menu funextra | public | `handleDareCommand` | system/handler.js:2668 |
| fact | randomfact | !menu funextra | public | `handleFactCommand` | system/handler.js:2672 |
| pickup | pickupline | !menu funextra | public | `handlePickupCommand` | system/handler.js:2677 |
| meteo | weather | !menu funextra | public | `handleMeteoCommand` | system/handler.js:2682 |
| lyrics | lyric | !menu funextra | public | `handleLyricsCommand` | system/handler.js:2687 |
| tiktok | tt, ttdl, tk | !menu downloader | public | `handleTiktokCommand` | system/handler.js:2564 |
| facebook | fb, fbdl, fbvideo | !menu downloader | public | `handleFacebookCommand` | system/handler.js:2571 |
| twitter | xdl, twdl, x, tw | !menu downloader | public | `handleXdlCommand` | system/handler.js:2580 |
| instagram | ig, igdl, insta | !menu downloader | public | `handleInstagramCommand` | system/handler.js:2588 |
| pinterest | pin, pindl | !menu downloader | public | `handlePinterestCommand` | system/handler.js:2594 |
| soundcloud | scdl, sc | !menu downloader | public | `handleSoundcloudCommand` | system/handler.js:2599 |
| mediafire | mfdl, mf | !menu downloader | public | `handleMediafireCommand` | system/handler.js:2605 |
| gdrive | gddl, gd, drive | !menu downloader | public | `handleGdriveCommand` | system/handler.js:2611 |
| terabox | tbdl, tb, tera | !menu downloader | public | `handleTeraboxCommand` | system/handler.js:2618 |
| movie | film, moviesearch, mv | !menu downloader | public | `handleMovieSearchCommand` | system/handler.js:2629 |
| movielatest | latestmovies, newmovies | !menu downloader | public | `handleMovieLatestCommand` | system/handler.js:2636 |
| series | tv, tvseries, srs | !menu downloader | public | `handleSeriesSearchCommand` | system/handler.js:2642 |
| serieslatest | latestseries, newseries | !menu downloader | public | `handleSeriesLatestCommand` | system/handler.js:2649 |
