# Your connection video

Place your own authorized Gojo/anime video at `media/connection/welcome.mp4`.
The file is intentionally not supplied or committed. Use an MP4 with H.264 video
and AAC audio, ideally short and small (the local-file guard is 50 MiB).

`config.js → connectionWelcomeVideo` controls this independently of Telegram's
optional Anime Library. Missing/empty/invalid files fall back to the existing
welcome image/text/menu. Only the authenticated socket's own private JID receives
this welcome. No conversion is performed by the new helper.
