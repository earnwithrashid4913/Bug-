# WhatsApp public command mapping

Generated from the existing registry and dispatcher. Manual-only commands are intentionally omitted.
Route checks prove registration/mapping, not external API availability or live WhatsApp delivery.

| Command | Valid aliases | Category/menu | Permission | Handler route (awaited calls) | Dispatcher line |
| --- | --- | --- | --- | --- | --- |
| fancy | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1783 |
| encrypt | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1784 |
| encrypt2 | — | !menu tools | public | `sourceCommands.tools` | system/handler.js:1785 |
| tempmail | — | !menu tools | public | `tempMail.handleTempMailCommand` | system/handler.js:1790 |
| getmail | — | !menu tools | public | `tempMail.handleGetMailCommand` | system/handler.js:1794 |
| upload | mirror, host | !menu upload | public | `sourceCommands.upload` | system/handler.js:1806 |
| store | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1797 |
| ad | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1798 |
| vd | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1799 |
| list | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1800 |
| del | — | !menu media | owner | `requireOwner`, `storedMedia` | system/handler.js:1801 |
| menu | help, m, cmds | !menu general | public | `handleMenuCommand` | system/handler.js:1812 |
| ping | p | !menu general | public | `sourceCommands.ping` | system/handler.js:1819 |
| request | reportbug | !menu general | public | `handleReport` | system/handler.js:1825 |
| public | — | !menu mode | owner | `requireOwner`, `modeStore.set`, `sendResult` | system/handler.js:1831 |
| self | private | !menu mode | owner | `requireOwner`, `modeStore.set`, `sendResult` | system/handler.js:1833 |
| mode | botmode | !menu mode | owner | `requireOwner`, `handleModeCommand` | system/handler.js:1845 |
| play | song, music | !menu downloader | public | `sourceCommands.download` | system/handler.js:1855 |
| ytmp3 | audio, mp3, yta, ytaudio | !menu downloader | public | `sourceCommands.download` | system/handler.js:1861 |
| video | ytmp4, mp4, ytvideo, yt, youtube, ytv | !menu downloader | public | `sourceCommands.download` | system/handler.js:1869 |
| spotify | sp, spot | !menu downloader | public | `handleSpotifyCommand` | system/handler.js:1879 |
| media | download, dl | !menu downloader | public | `handleMediaCommand` | system/handler.js:1885 |
| aio | allinone, alldownload, alldl, anydl | !menu downloader | public | `handleAioCommand` | system/handler.js:1891 |
| getpp | pp, profilepic, avatar | !menu media | public | `handleGetProfilePhoto` | system/handler.js:1907 |
| setpp | — | !menu media | owner | `handleSetBotProfilePhoto` | system/handler.js:1914 |
| vv | hey, revealonce, retrieve, viewonce | !menu media | public | `handleVVCommand` | system/handler.js:1925 |
| save | savestatus, downloadstatus | !menu media | public | `recovery.saveStatus` | system/handler.js:1918 |
| tovid | sticker2vid, tomp4 | !menu converter | public | `sendResult`, `downloadMediaBuffer`, `takeSticker`, `socket.sendMessage`, `convertToVideo`, `sourceCommands.react` | system/handler.js:1958 |
| take | steal | !menu sticker | public | `sendResult`, `downloadMediaBuffer`, `takeSticker`, `socket.sendMessage`, `convertToVideo`, `sourceCommands.react` | system/handler.js:1956 |
| toimg | sticker2img, img, toimage | !menu converter | public | `sendResult`, `downloadMediaBuffer`, `convertStickerToImage`, `socket.sendMessage` | system/handler.js:1976 |
| convert | converter | !menu converter | public | `sendResult` | system/handler.js:2000 |
| tts | — | !menu converter | public | `handleTTSCommand` | system/handler.js:2015 |
| qr | qrcode | !menu converter | public | `handleQRCommand` | system/handler.js:2019 |
| tourl | uploader, url, imgtourl, imageurl | !menu upload | public | `handleTourlCommand` | system/handler.js:2025 |
| ai | ask, ia, groq, loveai, love, dark | !menu ai | public | `handleAiCommand` | system/handler.js:2037 |
| translate | tr, trans | !menu ai | public | `handleTranslateCommand` | system/handler.js:2044 |
| image | aiimage, imagine | !menu ai | public | `imageGeneration.handleImageCommand` | system/handler.js:2051 |
| ephoto | ephoto360 | !menu ai | public | `imageGeneration.handleEphotoCommand` | system/handler.js:2057 |
| imgedit | imageedit, aiedit | !menu ai | public | `imageGeneration.handleImageEditCommand` | system/handler.js:2062 |
| jid | chatid | !menu tools | public | `socket.groupMetadata`, `sendResult` | system/handler.js:2073 |
| idch | cekidch | !menu tools | public | `socket.newsletterMetadata`, `sendResult`, `socket.sendMessage` | system/handler.js:2090 |
| calc | calculate, math | !menu tools | public | `handleCalcCommand` | system/handler.js:2129 |
| ss | screenshot | !menu tools | public | `handleSSCommand` | system/handler.js:2135 |
| short | shorten, tinyurl | !menu tools | public | `handleShortCommand` | system/handler.js:2140 |
| uid | — | !menu tools | public | `sendResult` | system/handler.js:2547 |
| tools | utils | !menu tools | public | `sendResult` | system/handler.js:2146 |
| hidetag | ht, tag | !menu group | admin | `requireGroupAdmin`, `socket.groupMetadata`, `socket.profilePictureUrl`, `socket.sendMessage` | system/handler.js:2164 |
| tagall | everyone | !menu group | admin | `requireGroupAdmin`, `socket.groupMetadata`, `socket.profilePictureUrl`, `socket.sendMessage` | system/handler.js:2167 |
| greet | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2192 |
| welcome | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2190 |
| goodbye | — | !menu group | admin | `requireGroupAdmin`, `handleGreetingSettings` | system/handler.js:2191 |
| group | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2199 |
| gname | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2200 |
| gdesc | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2201 |
| add | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2202 |
| kick | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2203 |
| promote | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2204 |
| demote | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2205 |
| lock | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2206 |
| unlock | — | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2207 |
| grouplink | linkgc | !menu group | admin | `requireGroupAdmin`, `handleGroupManagement` | system/handler.js:2208 |
| warn | warning | !menu group | admin | `requireGroupAdmin`, `handleWarnCommand` | system/handler.js:2216 |
| unwarn | delwarn | !menu group | admin | `requireGroupAdmin`, `handleUnwarnCommand` | system/handler.js:2224 |
| warns | warnings | !menu group | admin | `requireGroupAdmin`, `handleWarnsCommand` | system/handler.js:2232 |
| antilink | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2243 |
| antispam | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2244 |
| antimention | antigroupmention | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2245 |
| antitag | — | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2246 |
| antidelete | antisupp | !menu anti | admin | `requireOwner`, `automationStore.setGlobal`, `sendResult`, `automationStore.getGlobal`, `requireGroupAdmin`, `handleAntiToggleCommand` | system/handler.js:2249 |
| autoreact | autoreaction | !menu automation | admin | `requireGroupAdmin`, `sendResult`, `handleAutomationToggle` | system/handler.js:2268 |
| autowrite | autotype, fakewrite | !menu automation | public | `requireGroupAdmin`, `sendResult`, `handleAutomationToggle` | system/handler.js:2269 |
| autostatus | autostatusview, autostatusreact | !menu automation | owner | `handleAutomationToggle` | system/handler.js:2280 |
| purge | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2766 |
| autopromote | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2771 |
| antidemote | — | !menu anti | admin | `requireGroupAdmin`, `automationStore.setChat`, `sendResult`, `automationStore.getChat` | system/handler.js:2796 |
| antipromote | — | !menu anti | admin | `requireGroupAdmin`, `automationStore.setChat`, `sendResult`, `automationStore.getChat` | system/handler.js:2797 |
| sticker | s, stiker | !menu sticker | public | `sendResult`, `downloadMediaBuffer`, `socket.sendMessage` | system/handler.js:1932 |
| dice | roll | !menu games | public | `handleDiceCommand` | system/handler.js:2285 |
| coin | flip | !menu games | public | `handleCoinCommand` | system/handler.js:2290 |
| rps | — | !menu games | public | `handleRPSCommand` | system/handler.js:2295 |
| guess | guessthenumber | !menu games | public | `sendResult`, `socket.sendMessage` | system/handler.js:2505 |
| balance | bal, wallet | !menu rpg | public | `handleBalanceCommand` | system/handler.js:2300 |
| daily | claim | !menu rpg | public | `handleDailyCommand` | system/handler.js:2306 |
| work | earn | !menu rpg | public | `handleWorkCommand` | system/handler.js:2311 |
| give | — | !menu rpg | public | `handleGiveCommand` | system/handler.js:2316 |
| rpg | economy | !menu rpg | public | `sendResult` | system/handler.js:2320 |
| restart | rst | !menu owner | owner | `requireOwner`, `sendResult` | system/handler.js:2379 |
| setname | — | !menu owner | owner | `requireOwner`, `handleSetNameCommand` | system/handler.js:2392 |
| setprefix | — | !menu owner | owner | `requireOwner`, `handleSetPrefixCommand` | system/handler.js:2398 |
| broadcast | bc | !menu owner | owner | `requireOwner`, `handleBroadcastCommand` | system/handler.js:2404 |
| sudo | addsudo, makesudo | !menu sudo | owner | `requireOwner`, `handleSudoCommand` | system/handler.js:2414 |
| delsudo | removesudo, unsudo | !menu sudo | owner | `requireOwner`, `handleDelsudoCommand` | system/handler.js:2422 |
| sudolist | listsudo, sudos | !menu sudo | sudo | `requireSudoOrOwner`, `handleSudolistCommand` | system/handler.js:2428 |
| addprem | — | !menu premium | owner | `requireOwner`, `socket.sendMessage`, `premiumStore.add`, `sendResult` | system/handler.js:2437 |
| delprem | — | !menu premium | owner | `requireOwner`, `socket.sendMessage`, `premiumStore.remove`, `sendResult` | system/handler.js:2456 |
| listprem | — | !menu premium | owner | `requireOwner`, `premiumStore.list`, `sendResult` | system/handler.js:2475 |
| premium | — | !menu premium | public | `handlePremiumCommand` | system/handler.js:2489 |
| alive | — | !menu info | public | `sourceCommands.alive` | system/handler.js:2344 |
| status | runtime, st | !menu info | public | `sendResult` | system/handler.js:2347 |
| owner | creator | !menu info | public | `sendOwnerCard` | system/handler.js:2363 |
| sessions | — | !menu sessions | public | `handleSessionsCommand` | system/handler.js:2494 |
| stopsession | stop | !menu sessions | owner | `requireOwner`, `handleStopSessionCommand` | system/handler.js:2498 |
| pairing | tgpair | !menu telegram | public | `sendResult` | system/handler.js:2368 |
| telegram | tg | !menu telegram | public | `sendResult` | system/handler.js:2370 |
| anime | ani | !menu anime | public | `handleAnimeCommand` | system/handler.js:2554 |
| manga | — | !menu anime | public | `handleMangaCommand` | system/handler.js:2559 |
| character | char | !menu anime | public | `handleCharacterCommand` | system/handler.js:2563 |
| waifu | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2581 |
| husbando | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2582 |
| dailywaifu | — | !menu anime | public | `handleWaifuCommand` | system/handler.js:2583 |
| animequote | quote | !menu anime | public | `handleQuoteCommand` | system/handler.js:2569 |
| animevs | — | !menu anime | public | `handleAnimevsCommand` | system/handler.js:2573 |
| profile | otakuprofile | !menu anime | public | `handleProfileCommand` | system/handler.js:2587 |
| badges | badge | !menu anime | public | `handleBadgesCommand` | system/handler.js:2592 |
| leaderboard | lb, topplayers | !menu anime | public | `handleLeaderboardCommand` | system/handler.js:2597 |
| quizjoin | — | !menu quiz | public | `quizModule.joinQuiz`, `socket.sendMessage` | system/handler.js:2620 |
| quizstop | — | !menu quiz | public | `quizModule.stopQuiz` | system/handler.js:2626 |
| kickall | kickall2 | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2767 |
| demoteall | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2769 |
| promoteall | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `sendResult`, `socket.groupParticipantsUpdate`, `sourceCommands.react` | system/handler.js:2770 |
| opentime | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `socket.sendMessage`, `socket.groupSettingUpdate` | system/handler.js:2807 |
| closetime | — | !menu group | admin | `requireGroupAdmin`, `requireBotAdmin`, `socket.sendMessage`, `socket.groupSettingUpdate` | system/handler.js:2834 |
| quiz | startquiz | !menu quiz | public | `quizModule.stopQuiz`, `quizModule.joinQuiz`, `socket.sendMessage`, `quizModule.startQuiz` | system/handler.js:2607 |
| couple | lovemeter | !menu funextra | public | `handleCoupleCommand` | system/handler.js:2729 |
| ship | — | !menu funextra | public | `handleShipCommand` | system/handler.js:2577 |
| truth | — | !menu funextra | public | `handleTruthCommand` | system/handler.js:2734 |
| dare | — | !menu funextra | public | `handleDareCommand` | system/handler.js:2738 |
| fact | randomfact | !menu funextra | public | `handleFactCommand` | system/handler.js:2742 |
| pickup | pickupline | !menu funextra | public | `handlePickupCommand` | system/handler.js:2747 |
| meteo | weather | !menu funextra | public | `handleMeteoCommand` | system/handler.js:2752 |
| lyrics | lyric | !menu funextra | public | `handleLyricsCommand` | system/handler.js:2757 |
| tiktok | tt, ttdl, tk | !menu downloader | public | `handleTiktokCommand` | system/handler.js:2634 |
| facebook | fb, fbdl, fbvideo | !menu downloader | public | `handleFacebookCommand` | system/handler.js:2641 |
| twitter | xdl, twdl, x, tw | !menu downloader | public | `handleXdlCommand` | system/handler.js:2650 |
| instagram | ig, igdl, insta | !menu downloader | public | `handleInstagramCommand` | system/handler.js:2658 |
| pinterest | pin, pindl | !menu downloader | public | `handlePinterestCommand` | system/handler.js:2664 |
| soundcloud | scdl, sc | !menu downloader | public | `handleSoundcloudCommand` | system/handler.js:2669 |
| mediafire | mfdl, mf | !menu downloader | public | `handleMediafireCommand` | system/handler.js:2675 |
| gdrive | gddl, gd, drive | !menu downloader | public | `handleGdriveCommand` | system/handler.js:2681 |
| terabox | tbdl, tb, tera | !menu downloader | public | `handleTeraboxCommand` | system/handler.js:2688 |
| movie | film, moviesearch, mv | !menu downloader | public | `handleMovieSearchCommand` | system/handler.js:2699 |
| movielatest | latestmovies, newmovies | !menu downloader | public | `handleMovieLatestCommand` | system/handler.js:2706 |
| series | tv, tvseries, srs | !menu downloader | public | `handleSeriesSearchCommand` | system/handler.js:2712 |
| serieslatest | latestseries, newseries | !menu downloader | public | `handleSeriesLatestCommand` | system/handler.js:2719 |
| hvideo | hv, hvid | !menu downloader | public | `hiddenVideo.handleHvideoCommand` | system/handler.js:1900 |
