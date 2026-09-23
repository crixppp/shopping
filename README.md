# Shopping

A tiny static shopping-list PWA designed for GitHub Pages.

## What it does

- Imports a copied shopping list from the clipboard in one tap when the browser allows it.
- Falls back to a focused paste box when clipboard permissions are restricted.
- Parses common quantities such as `2kg chicken`, `2 packets rice`, `½ kg tomatoes`, and `2x avocados`.
- Shows large tappable cards, a subtle progress line, unlimited persistent undo, reordering, dark mode, safe-area support, wake lock support, and offline caching.
- Restores the latest removed item when you swipe upward from the bottom edge, with threshold haptics and a springy release animation.
- Uses only static files: HTML, CSS, JavaScript, a web app manifest, and a service worker.

## Run locally

Any static file server works. For example:

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

Opening `index.html` directly is enough for basic rendering, but a local server is better for testing clipboard access, the service worker, and PWA behavior.

## Clipboard permissions

The normal flow is one tap on **Import list** after copying a shopping list. Browsers may block direct clipboard reads unless the page is served from HTTPS or localhost and the action follows a user gesture.

When direct clipboard access is blocked, the app shows a temporary paste field, focuses it, and imports from there. The field disappears after import.

## Offline and PWA behavior

The service worker caches the app shell after the first successful load. Existing lists, completion, undo, reordering, and manual paste import all continue to work offline because the list is stored in `localStorage`.

The manifest uses `display: standalone`, relative paths, and repository-subpath-safe URLs so it can be added to the home screen from GitHub Pages.

## Browser limitations

Clipboard, Wake Lock, and Vibration APIs are optional browser features. The app treats them as progressive enhancements:

- Clipboard failure falls back to manual paste.
- Wake Lock failure does not block list use.
- Vibration failure is silent.

Recent Safari on iPhone, Chrome on Android, Safari on macOS, Chrome, and Edge are the main targets.

## GitHub Pages

This repository can be deployed directly from the root of the `main` branch:

1. Open the repository settings on GitHub.
2. Go to **Pages**.
3. Set the source to **Deploy from a branch**.
4. Choose `main` and `/root`.

All asset paths are relative so the app works from the repository subpath used by GitHub Pages.

## Customising

Most visual tuning lives in the CSS custom properties at the top of `styles.css`. Adjust the background, surface, accent, radius, shadow, or maximum card width there.
