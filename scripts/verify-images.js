'use strict';

const { IMAGE_SETS, validateImageSets } = require('../system/images');

const timeoutMs = 15_000;

async function verifyRemoteImage(key, image) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(image.url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: controller.signal
    });

    const contentType = response.headers.get('content-type') || '';
    await response.body?.cancel();

    if (!response.ok || !contentType.startsWith('image/')) {
      throw new Error(`HTTP ${response.status}; content type: ${contentType || 'missing'}`);
    }

    console.log(`OK ${key}: ${response.status} ${contentType} ${image.width}x${image.height}`);
    return true;
  } catch (error) {
    console.error(`FAIL ${key}: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  validateImageSets();
  let allValid = true;

  for (const [key, images] of Object.entries(IMAGE_SETS)) {
    for (const image of images) {
      if (!(await verifyRemoteImage(key, image))) allValid = false;
    }
  }

  if (!allValid) process.exitCode = 1;
}

void main();
