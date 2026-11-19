# Copper Shutter assets

The Glasgow rev C3 board fixture comes from the Glasgow project, under 0BSD.

The assembled faces use silk reel's transparent WebGL renderer with available KiCad STEP models. The source faces use the same camera, omit component bodies and show the front routes. All imagery comes from board data.

Render settings: seed 42, 30 fps, automatic duration, final frame, preview map scale 1.6. Desktop dimensions are 1920 × 1080. Portrait dimensions are 1080 × 1920.

The desktop camera uses tilt 0.91 radians and yaw −0.13 radians. It centres the board and fits its points within NDC bounds ±0.88 horizontally and ±0.85 vertically. Portrait faces use the release film's final camera.

The source palette uses background `#06121d`, silk `#e9443b`, copper `#ded9b9` and active routes `#ff6552`. Front net groups have start time zero.

The responsive hero stills capture the page's WebGL canvas at 1440 × 900 and 390 × 844. Face textures use lossless WebP. Hero stills use WebP quality 92.

The renders and browser captures ran on the Mac mini. Local reproduction inputs and capture scripts are in `.context/copper-repair/`. The current fallback stills use captures from `.context/board-journey/current/`. These assets serve the website hero. The release films retain their existing files.

The net files (`glasgow-16x9-nets.json`, `glasgow-9x16-nets.json`) hold each routed net of the same board in the films' plane, the parts that stand on it, and the view-projection matrix of the camera above. `packages/site/scripts/nets.mts` writes them from the board fixture and the timelines the faces were rendered from (`.context/copper-repair/assets/`). Net names are the board's own.
