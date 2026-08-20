'use strict';

const { randomInt } = require('node:crypto');

const IMAGE_SOURCE = 'https://wallpapercat.com/black-clover-wallpapers';

/**
 * Remote image metadata only: no image bytes are loaded when the bot starts.
 * Baileys downloads only the one URL selected for an image-enabled response.
 * Source collection lists these Black Clover wallpapers at 2K/4K resolutions.
 */
const IMAGE_SETS = Object.freeze({
  menu: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/f/6/1/29141-3840x2160-desktop-4k-black-clover-wallpaper-image.jpg',
      title: 'Asta — Black Bulls anti-magic aura',
      width: 3840,
      height: 2160
    }),
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/1/0/b/80918-3840x2160-desktop-4k-black-clover-background.jpg',
      title: 'Asta — Demon-Dweller sword action pose',
      width: 3840,
      height: 2160
    })
  ]),
  help: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/a/c/5/79944-3840x2160-desktop-4k-black-clover-background-photo.jpg',
      title: 'Asta and Yami — Magic Knights ensemble',
      width: 3840,
      height: 2160
    })
  ]),
  ping: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/8/3/a/81302-3840x2160-desktop-4k-black-clover-background-image.jpg',
      title: 'Asta — Demon-Dweller sword battle',
      width: 3840,
      height: 2160
    }),
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/e/6/2/80205-3840x2160-desktop-4k-black-clover-wallpaper.jpg',
      title: 'Asta — demon form at sunset',
      width: 3840,
      height: 2160
    })
  ]),
  status: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/6/a/6/81239-3840x2160-desktop-4k-black-clover-wallpaper-image.jpg',
      title: 'Yuno Grinberryall — wind magic',
      width: 3840,
      height: 2160
    }),
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/0/4/2/79880-2048x1152-desktop-hd-black-clover-background-image.jpg',
      title: 'Asta and Yuno — horizon',
      width: 2048,
      height: 1152
    })
  ]),
  owner: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/5/a/1/80629-1440x2560-samsung-hd-black-clover-wallpaper.jpg',
      title: 'Yami Sukehiro — Black Bulls captain',
      width: 1440,
      height: 2560
    })
  ]),
  creator: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/d/6/0/81095-2560x1700-desktop-hd-black-clover-background-image.jpg',
      title: 'Asta and Yami — Black Bulls squad',
      width: 2560,
      height: 1700
    })
  ]),
  public: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/e/8/d/81337-3840x2160-desktop-4k-black-clover-wallpaper-image.jpg',
      title: 'Asta — devil-union form',
      width: 3840,
      height: 2160
    })
  ]),
  self: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/0/a/0/80041-2560x1700-desktop-hd-black-clover-wallpaper.jpg',
      title: 'Asta — anti-magic wing',
      width: 2560,
      height: 1700
    })
  ]),
  hidetag: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/5/5/e/80859-1440x2560-mobile-hd-black-clover-background-photo.jpg',
      title: 'Asta and Yami — Black Bulls battle',
      width: 1440,
      height: 2560
    })
  ]),
  tagall: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/6/3/1/80950-3840x2160-desktop-4k-black-clover-wallpaper.jpg',
      title: 'Magna Swing — Black Bulls member',
      width: 3840,
      height: 2160
    })
  ]),
  channelInfo: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/5/5/d/81046-3840x2160-desktop-4k-black-clover-background-image.jpg',
      title: 'Zora Ideale — masked magic knight',
      width: 3840,
      height: 2160
    })
  ]),
  premiumAdd: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/8/0/4/79908-3554x1999-desktop-hd-black-clover-background-image.jpg',
      title: 'Asta — Black Clover hero portrait',
      width: 3554,
      height: 1999
    })
  ]),
  premiumDelete: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/a/1/2/29126-2560x1440-desktop-hd-black-clover-wallpaper.jpg',
      title: 'Asta — demon form aura',
      width: 2560,
      height: 1440
    })
  ]),
  premiumList: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/b/2/0/81196-3840x2160-desktop-4k-black-clover-wallpaper.jpg',
      title: 'Zagred — high-magic adversary',
      width: 3840,
      height: 2160
    })
  ]),
  report: Object.freeze([
    Object.freeze({
      url: 'https://wallpapercat.com/w/full/0/e/c/80390-1125x2436-iphone-hd-black-clover-wallpaper-photo.jpg',
      title: 'Asta — Black Bulls crimson aura',
      width: 1125,
      height: 2436
    })
  ])
});

function validateImageSets() {
  const seenUrls = new Set();

  for (const [key, images] of Object.entries(IMAGE_SETS)) {
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error(`Image set "${key}" must contain at least one image.`);
    }

    for (const image of images) {
      const parsed = new URL(image.url);
      if (parsed.protocol !== 'https:') throw new Error(`Image "${key}" must use HTTPS.`);
      if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || Math.max(image.width, image.height) < 2048) {
        throw new Error(`Image "${key}" does not meet the configured 2K minimum.`);
      }
      if (seenUrls.has(image.url)) throw new Error(`Image URL is assigned more than once: ${image.url}`);
      seenUrls.add(image.url);
    }
  }
}

function selectImage(key) {
  const images = IMAGE_SETS[key];
  if (!images) throw new Error(`No image set is configured for "${key}".`);
  return images[randomInt(images.length)];
}

validateImageSets();

module.exports = {
  IMAGE_SETS,
  IMAGE_SOURCE,
  selectImage,
  validateImageSets
};
