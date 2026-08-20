# Black Clover ♣️ Image Credits

The bot references remote wallpaper URLs from the [WallpaperCat Black Clover collection](https://wallpapercat.com/black-clover-wallpapers). Image bytes are **not** copied into this repository or loaded at startup. The collection page identifies the image license as [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); retain this attribution when redistributing or adapting the image configuration.

Each entry below is defined in [`system/images.js`](system/images.js). The source collection lists the recorded resolution.

| Image set | Subject | Resolution |
| --- | --- | --- |
| `menu` | Asta / Black Bulls anti-magic visuals | 3840×2160 (two selectable images) |
| `help` | Asta and Yami ensemble | 3840×2160 |
| `ping` | Asta action visuals | 3840×2160 (two selectable images) |
| `status` | Yuno and Asta/Yuno activity visuals | 3840×2160 or 2048×1152 |
| `owner` | Yami Sukehiro | 1440×2560 |
| `creator` | Asta and Yami / Black Bulls | 2560×1700 |
| `public` | Asta devil-union form | 3840×2160 |
| `self` | Asta anti-magic wing | 2560×1700 |
| `hidetag` | Asta and Yami / Black Bulls | 1440×2560 |
| `tagall` | Magna Swing | 3840×2160 |
| `channelInfo` | Zora Ideale | 3840×2160 |
| `premiumAdd` | Asta portrait | 3554×1999 |
| `premiumDelete` | Asta demon-form aura | 2560×1440 |
| `premiumList` | Zagred | 3840×2160 |
| `report` | Asta / Black Bulls crimson aura | 1125×2436 |

`system/images.js` validates that every configured image is HTTPS, unique, and has at least one 2K-or-higher dimension. Remote hosts can change availability independently of this project. A failed remote image upload falls back to the original text response so bot commands remain available.
