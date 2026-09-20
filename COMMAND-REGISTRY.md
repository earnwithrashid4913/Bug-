# WhatsApp public command mapping

Generated from the existing registry and dispatcher. Manual-only commands are intentionally omitted.
Route checks prove registration/mapping, not external API availability or live WhatsApp delivery.

| Command | Valid aliases | Category/menu | Permission | Handler route (awaited calls) | Dispatcher line |
| --- | --- | --- | --- | --- | --- |
| fancy | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1789 |
| encrypt | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1790 |
| encrypt2 | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1791 |
| tempmail | — | !menu tools | public | `tempMail.handleTempMailCommand` | system/handler.js:1796 |
| getmail | — | !menu tools | public | `tempMail.handleGetMailCommand` | system/handler.js:1800 |
| upload | mirror, host | !menu upload | public | `sourceCommands.upload` | system/handler.js:1812 |
| store | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1803 |
| ad | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1804 |
| vd | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1805 |
| list | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1806 |
| del | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1807 |
| menu | help, m, cmds | !menu general | public | `handleMenuCommand` | system/handler.js:1818 |
| ping | p | !menu general | public | `sourceCommands.ping` | system/handler.js:1825 |
| request | reportbug | !menu general | public | `handleReport` | system/handler.js:1831 |
| public | — | !menu mode | owner | `requireOwner`, `modeStore.set`, `sendResult` | system/handler.js:1837 |
| self | private | !menu mode | owner | `requireOwner`, `modeStore.set`, `sendResult` | system/handler.js:1839 |
| mode | botmode | !menu mode | owner | `requireOwner`, `handleModeCommand` | system/handler.js:1851 |
| play | song, music | !menu downloader | public | `sourceCommands.download` | system/handler.js:1861 |
| ytmp3 | audio, mp3, yta, ytaudio | !menu downloader | public | `sourceCommands.download` | system/handler.js:1867 |
| video | ytmp4, mp4, ytvideo, yt, youtube, ytv | !menu downloader | public | `sourceCommands.download` | system/handler.js:1875 |
| spotify | sp, spot | !menu downloader | public | `handleSpotifyCommand` | system/handler.js:1885 |
| media | download, dl | !menu downloader | public | `handleMediaCommand` | system/handler.js:1891 |
| aio | allinone, alldownload, alldl, anydl | !menu downloader | public | `handleAioCommand` | system/handler.js:1897 |
| getpp | pp, profilepic, avatar | !menu media | public | `handleGetProfilePhoto` | system/handler.js:1913 |
| setpp | — | !menu media | owner | `handleSetBotProfilePhoto` | system/handler.js:1920 |
| vv | hey, revealonce, retrieve, viewonce | !menu media | public | `handleVVCommand` | system/handler.js:1931 |
| save | savestatus, downloadstatus | !menu media | public | `recovery.saveStatus` | system/handler.js:1924 |
| tovid | sticker2vid, tomp4 | !menu converter | public | `sendResult`, `downloadMediaBuffer`, `takeSticker`, `socket.sendMessage`, `convertToVideo`, `sourceCommands.react` | system/handler.js:1964 |
| take | steal | !menu sticker | public | `sendResult`, `downloadMediaBuffer`, `takeSticker`, `socket.sendMessage`, `convertToVideo`, `sourceCommands.react` | system/handler.js:1962 |
| toimg | sticker2img, img, toimage | !menu converter | public | `sendResult`, `downloadMediaBuffer`, `convertStickerToImage`, `socket.sendMessage` | system/handler.js:1982 |
| convert | converter | !menu converter | public | `sendResult` | system/handler.js:2006 |
| tts | — | !menu converter | public | `handleTTSCommand` | system/handler.js:2021 |
| qr | qrcode | !menu converter | public | `handleQRCommand` | system/handler.js:2025 |
| tourl | uploader, url, imgtourl, imageurl | !menu upload | public | `handleTourlCommand` | system/handler.js:2031 |
| ai | ask, ia, groq, loveai, love, dark | !menu ai | public | `handleAiCommand` | system/handler.js:2043 |
| translate | tr, trans | !menu ai | public | `handleTranslateCommand` | system/handler.js:2050 |
| image | aiimage, imagine | !menu ai | public | `imageGeneration.handleImageCommand` | system/handler.js:2057 |
| ephoto | ephoto360 | !menu ai | public | `imageGeneration.handleEphotoCommand` | system/handler.js:2063 |
| imgedit | imageedit, aiedit | !menu ai | public | `imageGeneration.handleImageEditCommand` | system/handler.js:2068 |
| jid | chatid | !menu tools | public | `socket.groupMetadata`, `sendResult` | system/handler.js:2079 |
| idch | cekidch | !menu tools | public | `socket.newsletterMetadata`, `sendResult`, `socket.sendMessage` | system/handler.js:2096 |
| calc | calculate, math | !menu tools | public | `handleCalcCommand` | system/handler.js:2135 |
| ss | screenshot | !menu tools | public | `handleSSCommand` | system/handler.js:2141 |
| short | shorten, tinyurl | !menu tools | public | `handleShortCommand` | system/handler.js:2146 |
| uid | — | !menu tools | public | `sendResult` | system/handler.js:2553 |
| tools | utils | !menu tools | public | `sendResult` | system/handler.js:2152 |
| hidetag | ht, tag | !menu group | admin | `requireGroupAdmin`, `socket.groupMetadata`, `socket.profilePictureUrl`, `socket.sendMessage` | system/handler.js:2170 |
| tagall | everyone | !menu group | admin | `requireGroupAdmin`, `socket.groupMetadata`, `socket.profilePictureUrl`, `socket.sendMessage` | system/handler.js:2173 |
| greet | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2198 |
| welcome | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2196 |
| goodbye | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2197 |
| group | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2205 |
| gname | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2206 |
| gdesc | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2207 |
| add | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2208 |
| kick | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2209 |
| promote | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2210 |
| demote | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2211 |
| lock | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2212 |
| unlock | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2213 |
| grouplink | linkgc | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2214 |
| warn | warning | !menu group | admin | `requireGroupAdmin`, `handleWarnCommand` | system/handler.js:2222 |
| unwarn | delwarn | !menu group | admin | `requireGroupAdmin`, `handleUnwarnCommand` | system/handler.js:2230 |
| warns | warnings | !menu group | admin | `requireGroupAdmin`, `handleWarnsCommand` | system/handler.js:2238 |
| antilink | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2249 |
| antispam | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2250 |
| antimention | antigroupmention | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2251 |
| antitag | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2252 |
| antidelete | antisupp | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2255 |
| autoreact | autoreaction | !menu automation | admin | `requireGroupAdmin`, `sendResult`, `handleAutomationToggle` | system/handler.js:2274 |
| autowrite | autotype, fakewrite | !menu automation | public | `requireGroupAdmin`, `sendResult`, `handleAutomationToggle` | system/handler.js:2275 |
| autostatus | autostatusview, autostatusreact | !menu automation | owner | `handleAutomationToggle` | system/handler.js:2286 |
| purge | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2772 |
| autopromote | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2777 |
| antidemote | — | !menu anti | admin | `requireGroupAdmin`, `automationStore.setChat`, `sendResult`, `automationStore.getChat` | system/handler.js:2802 |
| antipromote | — | !menu anti | admin | `requireGroupAdmin`, `automationStore.setChat`, `sendResult`, `automationStore.getChat` | system/handler.js:2803 |
| sticker | s, stiker | !menu sticker | public | `sendResult`, `downloadMediaBuffer`, `socket.sendMessage` | system/handler.js:1938 |
| dice | roll | !menu games | public | `handleDiceCommand` | system/handler.js:2291 |
| coin | flip | !menu games | public | `handleCoinCommand` | system/handler.js:2296 |
| rps | — | !menu games | public | `handleRPSCommand` | system/handler.js:2301 |
| guess | guessthenumber | !menu games | public | `sendResult`, `socket.sendMessage` | system/handler.js:2511 |
| balance | bal, wallet | !menu rpg | public | `handleBalanceCommand` | system/handler.js:2306 |
| daily | claim | !menu rpg | public | `handleDailyCommand` | system/handler.js:2312 |
| work | earn | !menu rpg | public | `handleWorkCommand` | system/handler.js:2317 |
| give | — | !menu rpg | public | `handleGiveCommand` | system/handler.js:2322 |
| rpg | economy | !menu rpg | public | `sendResult` | system/handler.js:2326 |
| restart | rst | !menu owner | owner | `requireOwner`, `sendResult` | system/handler.js:2385 |
| setname | — | !menu owner | owner | `requireOwner`, `handleSetNameCommand` | system/handler.js:2398 |
| setprefix | — | !menu owner | owner | `requireOwner`, `handleSetPrefixCommand` | system/handler.js:2404 |
| broadcast | bc | !menu owner | owner | `requireOwner`, `handleBroadcastCommand` | system/handler.js:2410 |
| sudo | addsudo, makesudo | !menu sudo | owner | `requireOwner`, `handleSudoCommand` | system/handler.js:2420 |
| delsudo | removesudo, unsudo | !menu sudo | owner | `requireOwner`, `handleDelsudoCommand` | system/handler.js:2428 |
| sudolist | listsudo, sudos | !menu sudo | sudo | `requireSudoOrOwner`, `handleSudolistCommand` | system/handler.js:2434 |
| addprem | — | !menu premium | owner | `requireOwner`, `socket.sendMessage`, `premiumStore.add`, `sendResult` | system/handler.js:2443 |
| delprem | — | !menu premium | owner | `requireOwner`, `socket.sendMessage`, `premiumStore.remove`, `sendResult` | system/handler.js:2462 |
| listprem | — | !menu premium | owner | `requireOwner`, `premiumStore.list`, `sendResult` | system/handler.js:2481 |
| premium | — | !menu premium | public | `handlePremiumCommand` | system/handler.js:2495 |
| alive | — | !menu info | public | `sourceCommands.alive` | system/handler.js:2350 |
| status | runtime, st | !menu info | public | `sendResult` | system/handler.js:2353 |
| owner | creator | !menu info | public | `sendOwnerCard` | system/handler.js:2369 |
| sessions | — | !menu sessions | public | `handleSessionsCommand` | system/handler.js:2500 |
| stopsession | stop | !menu sessions | owner | `requireOwner`, `handleStopSessionCommand` | system/handler.js:2504 |
| pairing | tgpair | !menu telegram | public | `sendResult` | system/handler.js:2374 |
| telegram | tg | !menu telegram | public | `sendResult` | system/handler.js:2376 |
| anime | ani | !menu anime | public | `handleAnimeCommand` | system/handler.js:2560 |
| manga | — | !menu anime | public | `handleMangaCommand` | system/handler.js:2565 |
| character | char | !menu anime | public | `handleCharacterCommand` | system/handler.js:2569 |
| waifu | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2587 |
| husbando | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2588 |
| dailywaifu | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2589 |
| animequote | quote | !menu anime | public | `handleQuoteCommand` | system/handler.js:2575 |
| animevs | — | !menu anime | public | `handleAnimevsCommand` | system/handler.js:2579 |
| profile | otakuprofile | !menu anime | public | `handleProfileCommand` | system/handler.js:2593 |
| badges | badge | !menu anime | public | `handleBadgesCommand` | system/handler.js:2598 |
| leaderboard | lb, topplayers | !menu anime | public | `handleLeaderboardCommand` | system/handler.js:2603 |
| quizjoin | — | !menu quiz | public | `quizModule.joinQuiz`, `socket.sendMessage` | system/handler.js:2626 |
| quizstop | — | !menu quiz | public | `quizModule.stopQuiz` | system/handler.js:2632 |
| kickall | kickall2 | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2773 |
| demoteall | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2775 |
| promoteall | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2776 |
| opentime | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `socket.sendMessage`, `socket.groupSettingUpdate` | system/handler.js:2813 |
| closetime | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `socket.sendMessage`, `socket.groupSettingUpdate` | system/handler.js:2840 |
| quiz | startquiz | !menu quiz | public | `quizModule.stopQuiz`, `quizModule.joinQuiz`, `socket.sendMessage`, `quizModule.startQuiz` | system/handler.js:2613 |
| couple | lovemeter | !menu funextra | public | `handleCoupleCommand` | system/handler.js:2735 |
| ship | — | !menu funextra | public | `handleShipCommand` | system/handler.js:2583 |
| truth | — | !menu funextra | public | `handleTruthCommand` | system/handler.js:2740 |
| dare | — | !menu funextra | public | `handleDareCommand` | system/handler.js:2744 |
| fact | randomfact | !menu funextra | public | `handleFactCommand` | system/handler.js:2748 |
| pickup | pickupline | !menu funextra | public | `handlePickupCommand` | system/handler.js:2753 |
| meteo | weather | !menu funextra | public | `handleMeteoCommand` | system/handler.js:2758 |
| lyrics | lyric | !menu funextra | public | `handleLyricsCommand` | system/handler.js:2763 |
| tiktok | tt, ttdl, tk | !menu downloader | public | `handleTiktokCommand` | system/handler.js:2640 |
| facebook | fb, fbdl, fbvideo | !menu downloader | public | `handleFacebookCommand` | system/handler.js:2647 |
| twitter | xdl, twdl, x, tw | !menu downloader | public | `handleXdlCommand` | system/handler.js:2656 |
| instagram | ig, igdl, insta | !menu downloader | public | `handleInstagramCommand` | system/handler.js:2664 |
| pinterest | pin, pindl | !menu downloader | public | `handlePinterestCommand` | system/handler.js:2670 |
| soundcloud | scdl, sc | !menu downloader | public | `handleSoundcloudCommand` | system/handler.js:2675 |
| mediafire | mfdl, mf | !menu downloader | public | `handleMediafireCommand` | system/handler.js:2681 |
| gdrive | gddl, gd, drive | !menu downloader | public | `handleGdriveCommand` | system/handler.js:2687 |
| terabox | tbdl, tb, tera | !menu downloader | public | `handleTeraboxCommand` | system/handler.js:2694 |
| movie | film, moviesearch, mv | !menu downloader | public | `handleMovieSearchCommand` | system/handler.js:2705 |
| movielatest | latestmovies, newmovies | !menu downloader | public | `handleMovieLatestCommand` | system/handler.js:2712 |
| series | tv, tvseries, srs | !menu downloader | public | `handleSeriesSearchCommand` | system/handler.js:2718 |
| serieslatest | latestseries, newseries | !menu downloader | public | `handleSeriesLatestCommand` | system/handler.js:2725 |
| hvideo | hv, hvid | !menu downloader | public | `hiddenVideo.handleHvideoCommand` | system/handler.js:1906 |
